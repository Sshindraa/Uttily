import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { claimRefundRequestBatch } from './claim-refund-request-batch';
import { executeRefundRequestBatch } from './execute-refund-request-batch';
import { MAX_ATTEMPTS } from './scheduling';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { PaymentProviderError } from '../payments/errors';
import type {
  CreateRefundParams,
  RefundResult,
  RefundStatus,
  StripeEnvironment,
} from '../payments/types';

const DATABASE_URL = process.env['DATABASE_URL'];

interface RefundFixture {
  organizationId: string;
  otherOrganizationId: string;
  userId: string;
  locationId: string;
  paymentId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  bookingId: string;
  amendmentId: string;
  refundId: string;
  outboxEventId: string;
}

type ProviderBehavior =
  | { kind: 'result'; status: RefundStatus; id?: string; amountMinor?: number; currency?: string }
  | { kind: 'error'; error: PaymentProviderError }
  | { kind: 'lease-loss' }
  | { kind: 'lock-probe' };

class RecordingRefundProvider extends FakeStripeAdapter {
  readonly calls: CreateRefundParams[] = [];
  readonly behavior: ProviderBehavior;
  readonly rawSql: postgres.Sql | null;
  readonly outboxEventId: string | null;
  readonly lockProbeSql: postgres.Sql | null;
  readonly lockProbeIds: Pick<
    RefundFixture,
    'outboxEventId' | 'refundId' | 'paymentId' | 'amendmentId' | 'paymentAttemptId'
  > | null;
  lockProbeCount = 0;
  lockProbeCompleted = false;

  constructor(
    environment: StripeEnvironment,
    behavior: ProviderBehavior = { kind: 'result', status: 'succeeded' },
    rawSql: postgres.Sql | null = null,
    outboxEventId: string | null = null,
    lockProbeSql: postgres.Sql | null = null,
    lockProbeIds: RecordingRefundProvider['lockProbeIds'] = null,
  ) {
    super({ environment });
    this.behavior = behavior;
    this.rawSql = rawSql;
    this.outboxEventId = outboxEventId;
    this.lockProbeSql = lockProbeSql;
    this.lockProbeIds = lockProbeIds;
  }

  override async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    this.calls.push(params);
    if (this.behavior.kind === 'error') throw this.behavior.error;
    if (this.rawSql && this.behavior.kind === 'lease-loss' && this.outboxEventId) {
      await this.rawSql`
        UPDATE outbox_events
        SET lease_until = now() - interval '1 second'
        WHERE id = ${this.outboxEventId}
      `;
    }
    if (this.rawSql && this.behavior.kind === 'lock-probe') {
      throw new Error('Le lock probe doit utiliser une connexion PostgreSQL concurrente');
    }
    if (this.lockProbeSql && this.behavior.kind === 'lock-probe' && this.lockProbeIds) {
      this.lockProbeCount += 1;
      await this.lockProbeSql.begin(async (probeTx) => {
        await probeTx`SET LOCAL lock_timeout = '250ms'`;
        const rows = await Promise.all([
          probeTx`
            SELECT id FROM outbox_events
            WHERE id = ${this.lockProbeIds!.outboxEventId}::uuid
            FOR UPDATE
          `,
          probeTx`
            SELECT id FROM refunds
            WHERE id = ${this.lockProbeIds!.refundId}::uuid
            FOR UPDATE
          `,
          probeTx`
            SELECT id FROM payments
            WHERE id = ${this.lockProbeIds!.paymentId}::uuid
            FOR UPDATE
          `,
          probeTx`
            SELECT id FROM booking_amendments
            WHERE id = ${this.lockProbeIds!.amendmentId}::uuid
            FOR UPDATE
          `,
          probeTx`
            SELECT id FROM payment_attempts
            WHERE id = ${this.lockProbeIds!.paymentAttemptId}::uuid
            FOR UPDATE
          `,
        ]);
        expect(rows.every((rowsForTable) => rowsForTable.length === 1)).toBe(true);
      });
      this.lockProbeCompleted = true;
    }
    if (this.behavior.kind === 'result') {
      return {
        id: this.behavior.id ?? 're_g7m_b2b2a_dedicated',
        status: this.behavior.status,
        amountMinor: this.behavior.amountMinor ?? params.amountMinor,
        currency: this.behavior.currency ?? 'EUR',
      };
    }
    return {
      id: 're_g7m_b2b2a_dedicated',
      status: 'succeeded',
      amountMinor: params.amountMinor,
      currency: 'EUR',
    };
  }
}

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: postgres.Sql | null = null;

async function seedFixture(environment: StripeEnvironment = 'TEST'): Promise<RefundFixture> {
  if (!rawSql) throw new Error('PostgreSQL non initialisé');
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = await rawSql`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'B2B2A Org ' + suffix}, ${'b2b2a-org-' + suffix})
    RETURNING id
  `.then((rows) => rows[0]!);
  const otherOrg = await rawSql`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'B2B2A Other ' + suffix}, ${'b2b2a-other-' + suffix})
    RETURNING id
  `.then((rows) => rows[0]!);
  const user = await rawSql`
    INSERT INTO users (email)
    VALUES (${'b2b2a-' + suffix + '@example.com'})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'B2B2A', ${'b2b2a-' + suffix}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const draft = await rawSql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
      billable_unit, billable_unit_count, currency, cancellation_policy_snapshot
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, 'CONVERTED',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00',
      'Europe/Paris', 30, 30, 10000, 0, 10000,
      'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2, 'EUR',
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const payment = await rawSql`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status,
      amount_minor, currency, tax_status, tax_amount_minor,
      commission_amount_minor, financial_terms_version, legal_terms_version,
      terms_acceptance_snapshot, connected_account_id, charge_model,
      settlement_merchant_mode, environment, succeeded_at
    ) VALUES (
      ${org.id}, ${draft.id}, ${user.id}, 'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 500, 'v1', 'v1',
      ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_b2b2a', 'DESTINATION', 'CONNECTED_ACCOUNT', ${environment}::payment_environment, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await rawSql`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id,
      status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
      billable_unit, billable_unit_count, cancellation_policy_snapshot,
      terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
      10000, 0, 10000, 'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2,
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const amendment = await rawSql`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at,
      new_blocked_start_at, new_blocked_end_at, created_by, applied_at
    ) VALUES (
      ${org.id}, ${booking.id}, 1, 'REFUND', 'READY_TO_APPLY',
      ${rawSql.json({ total_amount_minor: 10000 })}, ${rawSql.json({ total_amount_minor: 0 })},
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${user.id}, NULL
    ) RETURNING id
  `.then((rows) => rows[0]!);
  await rawSql`
    UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendment.id}
  `;
  const refundId = crypto.randomUUID();
  const refund = await rawSql`
    INSERT INTO refunds (
      id, organization_id, payment_id, reason, status, amount_minor, currency,
      provider_idempotency_key, reverse_transfer, refund_application_fee, requested_at
    ) VALUES (
      ${refundId}, ${org.id}, ${payment.id}, 'BOOKING_MODIFICATION', 'PENDING', 10000, 'EUR',
      ${'refund_amendment_' + refundId}, true, true, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const paymentIntentId = 'pi_b2b2a_' + suffix;
  const paymentAttempt = await rawSql`
    INSERT INTO payment_attempts (
      organization_id, payment_id, attempt_number, status,
      provider_payment_intent_id, provider_idempotency_key, provider_status
    ) VALUES (
      ${org.id}, ${payment.id}, 1, 'SUCCEEDED', ${paymentIntentId},
      ${'attempt_b2b2a_' + suffix}, 'succeeded'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const outbox = await rawSql`
    INSERT INTO outbox_events (
      organization_id, aggregate_type, aggregate_id, event_type, event_version,
      payload, status, attempt_count, available_at, idempotency_key
    ) VALUES (
      ${org.id}, 'REFUND', ${refund.id}, 'REFUND_REQUESTED', 'v1',
      ${rawSql.json({
        organizationId: org.id,
        bookingId: booking.id,
        amendmentId: amendment.id,
        refundId: refund.id,
      })}, 'PENDING', 0, now(), ${'outbox_b2b2a_' + suffix}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  return {
    organizationId: org.id,
    otherOrganizationId: otherOrg.id,
    userId: user.id,
    locationId: location.id,
    paymentId: payment.id,
    paymentIntentId,
    paymentAttemptId: paymentAttempt.id,
    bookingId: booking.id,
    amendmentId: amendment.id,
    refundId: refund.id,
    outboxEventId: outbox.id,
  };
}

async function state(fixture: RefundFixture) {
  if (!rawSql) throw new Error('PostgreSQL non initialisé');
  const refund = await rawSql`
    SELECT status, provider_refund_id, failure_code FROM refunds WHERE id = ${fixture.refundId}
  `.then((rows) => rows[0]!);
  const outbox = await rawSql`
    SELECT status, attempt_count, available_at, lease_token, lease_until
    FROM outbox_events WHERE id = ${fixture.outboxEventId}
  `.then((rows) => rows[0]!);
  return { refund, outbox };
}

async function setRefundStatus(fixture: RefundFixture, status: string): Promise<void> {
  if (!rawSql) throw new Error('PostgreSQL non initialisé');
  if (status === 'SETTLED_OFF_PLATFORM') {
    await rawSql`
      UPDATE refunds
      SET status = 'FAILED_REQUIRES_MANUAL_ACTION', failed_at = now(), failure_code = 'MANUAL'
      WHERE id = ${fixture.refundId}
    `;
    await rawSql`
      UPDATE refunds
      SET status = ${status}::refund_status, settled_off_platform_at = now(),
          settled_off_platform_by = ${fixture.userId}, settlement_notes = 'settled for dedicated replay test'
      WHERE id = ${fixture.refundId}
    `;
  } else if (status === 'SUCCEEDED') {
    await rawSql`
      UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = ${fixture.refundId}
    `;
  } else if (status === 'FAILED_REQUIRES_MANUAL_ACTION') {
    await rawSql`
      UPDATE refunds SET status = 'FAILED_REQUIRES_MANUAL_ACTION', failed_at = now(), failure_code = 'MANUAL'
      WHERE id = ${fixture.refundId}
    `;
  } else {
    await rawSql`UPDATE refunds SET status = ${status}::refund_status WHERE id = ${fixture.refundId}`;
  }
}

describe.skipIf(shouldSkipIntegrationTests())('refund-request-execution — PostgreSQL réel', () => {
  beforeAll(async () => {
    ctx = await setupIntegrationTestDb('refund_request_execution');
    if (!ctx) throw new Error('PostgreSQL requis pour la matrice B2-B2A');
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 20 });
  });

  afterAll(async () => {
    if (db) await db.$client.end();
    if (rawSql) await rawSql.end();
    if (ctx) await ctx.cleanup();
  });

  beforeEach(async () => {
    if (!db) throw new Error('DB non initialisée');
    await db.execute(sql`
      TRUNCATE TABLE refunds, outbox_events, booking_amendments, bookings,
        payment_attempts, payments, booking_drafts, locations, organizations, users
      RESTART IDENTITY CASCADE
    `);
  });

  it('claim strictement REFUND_REQUESTED.v1/REFUND, respecte ordre et limite', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const first = await seedFixture();
    const second = await seedFixture();
    await rawSql`UPDATE outbox_events SET available_at = now() - interval '20 seconds' WHERE id = ${first.outboxEventId}`;
    await rawSql`UPDATE outbox_events SET available_at = now() - interval '10 seconds' WHERE id = ${second.outboxEventId}`;
    await rawSql`
      INSERT INTO outbox_events (
        organization_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, attempt_count, available_at, idempotency_key
      ) VALUES (
        ${first.organizationId}, 'PAYMENT', ${first.paymentId}, 'REFUND_REQUESTED', 'v1',
        ${rawSql.json({})}, 'PENDING', 0, now() - interval '30 seconds', ${'wrong_tuple_' + first.outboxEventId}
      )
    `;

    const claimed = await claimRefundRequestBatch(db, 1, 'TEST');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.outboxEventId).toBe(first.outboxEventId);
    expect(claimed[0]!.payloadValid).toBe(true);
    const next = await claimRefundRequestBatch(db, 1, 'TEST');
    expect(next).toHaveLength(1);
    expect(next[0]!.outboxEventId).toBe(second.outboxEventId);
  });

  it('isole TEST et LIVE au claim', async () => {
    if (!db) throw new Error('DB non initialisée');
    const testFixture = await seedFixture('TEST');
    await seedFixture('LIVE');
    const claimed = await claimRefundRequestBatch(db, 10, 'TEST');
    expect(claimed.map((event) => event.outboxEventId)).toEqual([testFixture.outboxEventId]);
  });

  it('payload malformé : échoue uniquement l’outbox sans appeler le provider ni modifier un refund', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await rawSql`UPDATE outbox_events SET payload = ${rawSql.json({ refundId: fixture.refundId })} WHERE id = ${fixture.outboxEventId}`;
    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1, submittedCount: 0 });
    expect(provider.calls).toHaveLength(0);
    const current = await state(fixture);
    expect(current.refund.status).toBe('PENDING');
    expect(current.outbox.status).toBe('FAILED');
  });

  it('payload forgé cross-tenant : ne modifie jamais le refund de l’autre organisation', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const owner = await seedFixture();
    const foreign = await seedFixture();
    await rawSql`
      UPDATE outbox_events
      SET aggregate_id = ${foreign.refundId},
          payload = ${rawSql.json({
            organizationId: owner.organizationId,
            bookingId: foreign.bookingId,
            amendmentId: foreign.amendmentId,
            refundId: foreign.refundId,
          })}
      WHERE id = ${owner.outboxEventId}
    `;
    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1 });
    expect(provider.calls).toHaveLength(0);
    const foreignState = await state(foreign);
    expect(foreignState.refund.status).toBe('PENDING');
    expect(foreignState.refund.provider_refund_id).toBeNull();
  });

  it.each([
    [
      'payment',
      async (fixture: RefundFixture) =>
        rawSql!`UPDATE payments SET status = 'FAILED' WHERE id = ${fixture.paymentId}`,
    ],
    [
      'amendment',
      async (fixture: RefundFixture) => {
        const invalidAmendmentId = crypto.randomUUID();
        await rawSql!`
          UPDATE outbox_events
          SET payload = jsonb_set(payload, '{amendmentId}', to_jsonb(${invalidAmendmentId}::text))
          WHERE id = ${fixture.outboxEventId}
        `;
      },
    ],
    [
      'attempt',
      async (fixture: RefundFixture) =>
        rawSql!`UPDATE payment_attempts SET status = 'FAILED' WHERE payment_id = ${fixture.paymentId}`,
    ],
  ])('incohérence %s : aucun appel provider, refund manuel', async (_label, mutate) => {
    if (!db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await mutate(fixture);
    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1 });
    expect(provider.calls).toHaveLength(0);
    expect((await state(fixture)).refund.status).toBe('FAILED_REQUIRES_MANUAL_ACTION');
  });

  it('refund legacy ou raison incohérente : outbox failed, refund inchangé', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await rawSql`UPDATE refunds SET reason = 'EXTERNAL_REFUND' WHERE id = ${fixture.refundId}`;
    const provider = new RecordingRefundProvider('TEST');
    await executeRefundRequestBatch({ db, provider }, { environment: 'TEST', batchLimit: 1 });
    expect(provider.calls).toHaveLength(0);
    expect((await state(fixture)).refund.status).toBe('PENDING');
    expect((await state(fixture)).outbox.status).toBe('FAILED');
  });

  it.each(['pending', 'requires_action', 'succeeded'] as const)(
    'provider %s : persistance locale maximale SUBMITTED et metadata exacte',
    async (status) => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await seedFixture();
      const provider = new RecordingRefundProvider('TEST', { kind: 'result', status }, rawSql);
      const result = await executeRefundRequestBatch(
        { db, provider },
        { environment: 'TEST', batchLimit: 1 },
      );
      expect(result).toMatchObject({ claimedCount: 1, submittedCount: 1, failedCount: 0 });
      expect(provider.calls[0]).toEqual({
        paymentIntentId: fixture.paymentIntentId,
        amountMinor: 10000,
        idempotencyKey: expect.stringMatching(/^refund_amendment_/),
        reverseTransfer: true,
        refundApplicationFee: true,
        metadata: {
          refund_id: fixture.refundId,
          organization_id: fixture.organizationId,
          protocol_version: 'refund-requested-v1',
        },
      });
      const current = await state(fixture);
      expect(current.refund.status).toBe('SUBMITTED');
      expect(current.outbox.status).toBe('PROCESSED');
    },
  );

  it('provider hors transaction : lock probe concurrent réussi avant le retour provider', async () => {
    if (!ctx || !db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    const probeSql = postgres(ctx.databaseUrl, { max: 1 });
    try {
      const provider = new RecordingRefundProvider(
        'TEST',
        { kind: 'lock-probe' },
        null,
        null,
        probeSql,
        fixture,
      );
      const result = await executeRefundRequestBatch(
        { db, provider },
        { environment: 'TEST', batchLimit: 1 },
      );
      expect(result).toMatchObject({ claimedCount: 1, submittedCount: 1, failedCount: 0 });
      expect(provider.calls).toHaveLength(1);
      expect(provider.lockProbeCount).toBe(1);
      expect(provider.lockProbeCompleted).toBe(true);
      expect(provider.calls[0]).toEqual({
        paymentIntentId: fixture.paymentIntentId,
        amountMinor: 10000,
        idempotencyKey: expect.stringMatching(/^refund_amendment_/),
        reverseTransfer: true,
        refundApplicationFee: true,
        metadata: {
          refund_id: fixture.refundId,
          organization_id: fixture.organizationId,
          protocol_version: 'refund-requested-v1',
        },
      });
      const current = await state(fixture);
      expect(current.refund.status).toBe('SUBMITTED');
      expect(current.outbox.status).toBe('PROCESSED');
    } finally {
      await probeSql.end();
    }
  });

  it.each([
    ['missing-id', { id: '' }],
    ['amount', { amountMinor: 9999 }],
    ['currency', { currency: 'USD' }],
    ['status', { status: 'failed' as RefundStatus }],
  ])('résultat provider invalide (%s) : refund manuel', async (_label, resultOverride) => {
    if (!db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    const provider = new RecordingRefundProvider('TEST', {
      kind: 'result',
      status: 'succeeded',
      ...resultOverride,
    });
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1 });
    expect((await state(fixture)).refund.status).toBe('FAILED_REQUIRES_MANUAL_ACTION');
  });

  it('erreur provider transitoire : retry avec backoff et refund toujours PENDING', async () => {
    if (!db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    const provider = new RecordingRefundProvider('TEST', {
      kind: 'error',
      error: new PaymentProviderError('UNKNOWN', 'timeout', 'timeout'),
    });
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, rescheduledCount: 1, failedCount: 0 });
    const current = await state(fixture);
    expect(current.refund.status).toBe('PENDING');
    expect(current.outbox.status).toBe('PENDING');
    expect(Number(current.outbox.attempt_count)).toBe(1);
    expect(new Date(current.outbox.available_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('erreur provider durable : échec manuel immédiat', async () => {
    if (!db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    const provider = new RecordingRefundProvider('TEST', {
      kind: 'error',
      error: new PaymentProviderError('UNKNOWN', 'invalid request', 'invalid_request_error'),
    });
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1, rescheduledCount: 0 });
    expect((await state(fixture)).refund.status).toBe('FAILED_REQUIRES_MANUAL_ACTION');
  });

  it('MAX_ATTEMPTS est terminal exactement au cinquième claim', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await rawSql`UPDATE outbox_events SET attempt_count = ${MAX_ATTEMPTS - 1} WHERE id = ${fixture.outboxEventId}`;
    const provider = new RecordingRefundProvider('TEST', {
      kind: 'error',
      error: new PaymentProviderError('UNKNOWN', 'timeout', 'timeout'),
    });
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, failedCount: 1, rescheduledCount: 0 });
    expect((await state(fixture)).outbox.attempt_count).toBe(MAX_ATTEMPTS - 1);
    expect((await state(fixture)).refund.failure_code).toBe('MAX_ATTEMPTS_EXCEEDED');
  });

  it.each([
    'SUBMITTED',
    'SUCCEEDED',
    'FAILED_REQUIRES_MANUAL_ACTION',
    'SETTLED_OFF_PLATFORM',
  ] as const)('replay %s : aucun appel provider et outbox processed', async (status) => {
    if (!db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await setRefundStatus(fixture, status);
    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, alreadyResolvedCount: 1, submittedCount: 0 });
    expect(provider.calls).toHaveLength(0);
    expect((await state(fixture)).outbox.status).toBe('PROCESSED');
  });

  it('perte de lease après appel provider : aucune mutation locale par l’ancien worker', async () => {
    if (!db || !rawSql) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    const provider = new RecordingRefundProvider(
      'TEST',
      { kind: 'lease-loss' },
      rawSql,
      fixture.outboxEventId,
    );
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, leaseLostCount: 1, submittedCount: 0 });
    const current = await state(fixture);
    expect(current.refund.status).toBe('PENDING');
    expect(current.refund.provider_refund_id).toBeNull();
    expect(current.outbox.status).toBe('PROCESSING');
  });

  it('reclaim une lease expirée et incrémente la tentative', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const fixture = await seedFixture();
    await rawSql`
      UPDATE outbox_events
      SET status = 'PROCESSING', lease_token = gen_random_uuid(), lease_until = now() - interval '1 second'
      WHERE id = ${fixture.outboxEventId}
    `;
    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, submittedCount: 1 });
    expect((await state(fixture)).outbox.status).toBe('PROCESSED');
  });

  it('exécute un remboursement issu d’une annulation (BOOKING_CANCELLATION)', async () => {
    if (!rawSql || !db) throw new Error('DB non initialisée');
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = await rawSql`
      INSERT INTO organizations (legal_name, slug)
      VALUES (${'Cancel Org ' + suffix}, ${'cancel-org-' + suffix})
      RETURNING id
    `.then((rows) => rows[0]!);
    const user = await rawSql`
      INSERT INTO users (email)
      VALUES (${'cancel-' + suffix + '@example.com'})
      RETURNING id
    `.then((rows) => rows[0]!);
    const location = await rawSql`
      INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
      VALUES (${org.id}, 'Cancel Loc', ${'cancel-loc-' + suffix}, 'Europe/Paris', 'EUR')
      RETURNING id
    `.then((rows) => rows[0]!);
    const draft = await rawSql`
      INSERT INTO booking_drafts (
        organization_id, location_id, customer_user_id, status,
        customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
        timezone, prep_buffer_minutes, cleanup_buffer_minutes,
        subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
        tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
        billable_unit, billable_unit_count, currency, cancellation_policy_snapshot
      ) VALUES (
        ${org.id}, ${location.id}, ${user.id}, 'CONVERTED',
        '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
        '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00',
        'Europe/Paris', 30, 30, 10000, 0, 10000,
        'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2, 'EUR',
        ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
      ) RETURNING id
    `.then((rows) => rows[0]!);
    const payment = await rawSql`
      INSERT INTO payments (
        organization_id, draft_id, customer_user_id, status,
        amount_minor, currency, tax_status, tax_amount_minor,
        commission_amount_minor, financial_terms_version, legal_terms_version,
        terms_acceptance_snapshot, connected_account_id, charge_model,
        settlement_merchant_mode, environment, succeeded_at
      ) VALUES (
        ${org.id}, ${draft.id}, ${user.id}, 'SUCCEEDED', 10000, 'EUR',
        'NOT_APPLICABLE', 0, 500, 'v1', 'v1',
        ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })},
        'acct_cancel', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST'::payment_environment, now()
      ) RETURNING id
    `.then((rows) => rows[0]!);
    await rawSql`
      INSERT INTO payment_attempts (
        organization_id, payment_id, attempt_number, status,
        amount_minor, currency, client_secret, provider_payment_intent_id,
        environment, succeeded_at
      ) VALUES (
        ${org.id}, ${payment.id}, 1, 'SUCCEEDED',
        10000, 'EUR', 'pi_secret_cancel', 'pi_intent_cancel_123',
        'TEST'::payment_environment, now()
      )
    `;
    const booking = await rawSql`
      INSERT INTO bookings (
        organization_id, location_id, customer_user_id, draft_id, payment_id,
        status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
        timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
        subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
        tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
        billable_unit, billable_unit_count, cancellation_policy_snapshot,
        terms_acceptance_snapshot, confirmed_at
      ) VALUES (
        ${org.id}, ${location.id}, ${user.id}, ${draft.id}, ${payment.id}, 'CANCELLED',
        '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
        '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
        10000, 0, 10000, 'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2,
        ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
        ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })}, now()
      ) RETURNING id
    `.then((rows) => rows[0]!);
    const refund = await rawSql`
      INSERT INTO refunds (
        organization_id, payment_id, reason, status,
        amount_minor, currency, provider_idempotency_key,
        reverse_transfer, refund_application_fee, requested_at
      ) VALUES (
        ${org.id}, ${payment.id}, 'MERCHANT_CANCELLATION', 'PENDING',
        10000, 'EUR', 'refund_placeholder',
        true, true, now()
      ) RETURNING id
    `.then((rows) => rows[0]!);
    await rawSql`
      UPDATE refunds
      SET provider_idempotency_key = ${'refund_' + refund.id}
      WHERE id = ${refund.id}
    `;
    const cancellation = await rawSql`
      INSERT INTO booking_cancellations (
        organization_id, booking_id, cancelled_by_user_id,
        actor_reason, policy_code, policy_snapshot,
        gross_paid_minor, refund_amount_minor, retained_amount_minor,
        original_commission_minor, commission_refunded_minor,
        final_commission_minor, final_merchant_revenue_minor,
        currency, explanation_code, inventory_released, refund_id
      ) VALUES (
        ${org.id}, ${booking.id}, ${user.id},
        'MERCHANT_CANCELLATION', 'FLEXIBLE',
        ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1' })},
        10000, 10000, 0, 500, 500, 0, 0,
        'EUR', 'FULL_REFUND_MERCHANT', true, ${refund.id}
      ) RETURNING id
    `.then((rows) => rows[0]!);
    const outbox = await rawSql`
      INSERT INTO outbox_events (
        organization_id, aggregate_type, aggregate_id,
        event_type, event_version, payload,
        status, attempt_count, available_at, idempotency_key
      ) VALUES (
        ${org.id}, 'REFUND', ${refund.id},
        'REFUND_REQUESTED', 'v2',
        ${rawSql.json({
          organizationId: org.id,
          bookingId: booking.id,
          refundId: refund.id,
          origin: 'BOOKING_CANCELLATION',
          cancellationId: cancellation.id,
        })},
        'PENDING', 0, now(), ${'refund_requested_' + refund.id}
      ) RETURNING id
    `.then((rows) => rows[0]!);

    const provider = new RecordingRefundProvider('TEST');
    const result = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(result).toMatchObject({ claimedCount: 1, submittedCount: 1, failedCount: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.paymentIntentId).toBe('pi_intent_cancel_123');
    expect(provider.calls[0]!.amountMinor).toBe(10000);
    expect(provider.calls[0]!.idempotencyKey).toBe('refund_' + refund.id);

    const updatedRefund =
      await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${refund.id}`.then(
        (rows) => rows[0]!,
      );
    expect(updatedRefund.status).toBe('SUBMITTED');
    expect(updatedRefund.provider_refund_id).not.toBeNull();

    const updatedOutbox =
      await rawSql`SELECT status FROM outbox_events WHERE id = ${outbox.id}`.then(
        (rows) => rows[0]!,
      );
    expect(updatedOutbox.status).toBe('PROCESSED');
  });

  it('SKIP LOCKED laisse le second événement avançable en concurrence réelle', async () => {
    if (!ctx || !rawSql || !db) throw new Error('DB non initialisée');
    const first = await seedFixture();
    const second = await seedFixture();
    const secondDb = createDatabase(ctx.databaseUrl);
    const blocker = postgres(ctx.databaseUrl, { max: 1 });
    try {
      await blocker.begin(async (locked) => {
        await locked`SELECT id FROM outbox_events WHERE id = ${first.outboxEventId} FOR UPDATE`;
        const claimed = await claimRefundRequestBatch(secondDb, 1, 'TEST');
        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.outboxEventId).toBe(second.outboxEventId);
      });
    } finally {
      await blocker.end();
      await secondDb.$client.end();
    }
  });
});

void DATABASE_URL;
