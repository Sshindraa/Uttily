import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import type { CreatePaymentIntentParams, PaymentIntentResult } from '../payments/types';
import { initiateSupplementPayment } from './initiate-supplement-payment';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = 'uttily_test_g7m_c2';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

let db: DatabaseClient | null = null;
let sql: postgres.Sql | null = null;
let testUrl: string | null = null;

interface Fixture {
  orgId: string;
  customerId: string;
  otherCustomerId: string;
  bookingId: string;
  amendmentId: string;
  amendmentPaymentId: string;
  amendmentPaymentAttemptId: string;
  holdDeadline: Date;
}

class RecordingProvider extends FakeStripeAdapter {
  readonly createCalls: CreatePaymentIntentParams[] = [];
  readonly retrieveCalls: string[] = [];
  private readonly createOverride:
    ((result: PaymentIntentResult) => PaymentIntentResult) | undefined;
  private readonly createError: Error | undefined;
  private readonly afterCreate: ((result: PaymentIntentResult) => Promise<void>) | undefined;
  private readonly lockProbe: (() => Promise<void>) | undefined;

  constructor(options?: {
    createOverride?: (result: PaymentIntentResult) => PaymentIntentResult;
    afterCreate?: (result: PaymentIntentResult) => Promise<void>;
    lockProbe?: () => Promise<void>;
    artificialDelayMs?: number;
    environment?: 'TEST' | 'LIVE';
    createError?: Error;
  }) {
    super({
      ...(options?.artificialDelayMs === undefined
        ? {}
        : { artificialDelayMs: options.artificialDelayMs }),
      ...(options?.environment === undefined ? {} : { environment: options.environment }),
    });
    this.createOverride = options?.createOverride;
    this.createError = options?.createError;
    this.afterCreate = options?.afterCreate;
    this.lockProbe = options?.lockProbe;
  }

  override async createPaymentIntent(
    params: CreatePaymentIntentParams,
  ): Promise<PaymentIntentResult> {
    this.createCalls.push(params);
    if (this.lockProbe) await this.lockProbe();
    if (this.createError) throw this.createError;
    const result = await super.createPaymentIntent(params);
    const projected = this.createOverride ? this.createOverride(result) : result;
    if (this.afterCreate) await this.afterCreate(projected);
    return projected;
  }

  override async retrievePaymentIntent(id: string): Promise<PaymentIntentResult> {
    this.retrieveCalls.push(id);
    return super.retrievePaymentIntent(id);
  }
}

async function seedFixture(
  client: postgres.Sql,
  suffix: string,
  environment = 'TEST',
): Promise<Fixture> {
  const org = await client`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'C2 Org ' + suffix}, ${'c2-org-' + suffix}) RETURNING id
  `.then((rows) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Annecy', ${'c2-location-' + suffix}, 'UTC', 'EUR') RETURNING id
  `.then((rows) => rows[0]!);
  const customer = await client`
    INSERT INTO users (email) VALUES (${'c2-customer-' + suffix + '@example.com'}) RETURNING id
  `.then((rows) => rows[0]!);
  const otherCustomer = await client`
    INSERT INTO users (email) VALUES (${'c2-other-' + suffix + '@example.com'}) RETURNING id
  `.then((rows) => rows[0]!);

  const draft = await client`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, commission_amount_minor, billable_unit,
      billable_unit_count, cancellation_policy_snapshot
    ) VALUES (
      ${org.id}, ${location.id}, ${customer.id}, 'DRAFT',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', 'UTC',
      30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500,
      'DAY', 2, ${client.json({ code: 'C2' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const initialPayment = await client`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status, amount_minor, currency,
      tax_status, tax_amount_minor, commission_amount_minor, financial_terms_version,
      legal_terms_version, terms_acceptance_snapshot, connected_account_id,
      on_behalf_of_account_id, charge_model, settlement_merchant_mode, environment,
      succeeded_at
    ) VALUES (
      ${org.id}, ${draft.id}, ${customer.id}, 'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 500, 'v1', 'v1', ${client.json({ accepted: true })},
      'acct_c2', 'acct_c2', 'DESTINATION', 'CONNECTED_ACCOUNT', ${environment}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await client`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, timezone,
      prep_buffer_minutes, cleanup_buffer_minutes, currency, subtotal_amount_minor,
      mandatory_fees_amount_minor, total_amount_minor, tax_status, tax_amount_minor,
      commission_amount_minor, billable_unit, billable_unit_count,
      cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${org.id}, ${location.id}, ${customer.id}, ${draft.id}, ${initialPayment.id}, 'CONFIRMED',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', 'UTC', 30, 30, 'EUR',
      10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 'DAY', 2,
      ${client.json({ code: 'C2' })}, ${client.json({ accepted: true })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);

  const holdDeadline = new Date('2026-04-01T10:10:00.000Z');
  const amendment = await client`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at, new_blocked_start_at,
      new_blocked_end_at, hold_deadline, created_by, created_at
    ) VALUES (
      ${org.id}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
      ${client.json({ totalAmountMinor: 10000, currency: 'EUR' })},
      ${client.json({ totalAmountMinor: 15000, supplementAmountMinor: 5000, currency: 'EUR' })},
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${holdDeadline}, ${customer.id},
      '2026-04-01 10:00:00+00'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const amendmentPayment = await client`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id, amount_minor,
      currency, environment, connected_account_id, on_behalf_of_account_id,
      charge_model, settlement_merchant_mode, status
    ) VALUES (
      ${org.id}, ${booking.id}, ${amendment.id}, ${customer.id}, 5000, 'EUR', ${environment},
      'acct_c2', 'acct_c2', 'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const attempt = await client`
    INSERT INTO amendment_payment_attempts (
      organization_id, amendment_payment_id, attempt_number, status,
      provider_idempotency_key
    ) VALUES (
      ${org.id}, ${amendmentPayment.id}, 1, 'PENDING_PROVIDER',
      ${'pi_amendment_' + amendmentPayment.id + '_1'}
    ) RETURNING id
  `.then((rows) => rows[0]!);

  return {
    orgId: String(org.id),
    customerId: String(customer.id),
    otherCustomerId: String(otherCustomer.id),
    bookingId: String(booking.id),
    amendmentId: String(amendment.id),
    amendmentPaymentId: String(amendmentPayment.id),
    amendmentPaymentAttemptId: String(attempt.id),
    holdDeadline,
  };
}

function input(
  fixture: Fixture,
  customerUserId = fixture.customerId,
  environment: 'TEST' | 'LIVE' = 'TEST',
) {
  return {
    organizationId: fixture.orgId,
    amendmentId: fixture.amendmentId,
    customerUserId,
    environment,
  };
}

function providerFor(fixture: Fixture, probeClient?: postgres.Sql): RecordingProvider {
  if (!probeClient) return new RecordingProvider();
  return new RecordingProvider({
    lockProbe: async () => {
      await probeClient.begin(async (probeTx) => {
        await probeTx`SET LOCAL statement_timeout = '2000ms'`;
        await probeTx`
          UPDATE bookings SET updated_at = updated_at WHERE id = ${fixture.bookingId}
        `;
      });
    },
  });
}

async function materialCounts(client: postgres.Sql, fixture: Fixture) {
  const rows = await client`
    SELECT
      (SELECT count(*)::int FROM inventory_blocks WHERE source_id = ${fixture.amendmentId}) AS holds,
      (SELECT count(*)::int FROM booking_amendment_allocations WHERE amendment_id = ${fixture.amendmentId}) AS allocations,
      (SELECT count(*)::int
       FROM booking_amendment_segments s
       JOIN booking_amendment_allocations a ON a.id = s.allocation_id
       WHERE a.amendment_id = ${fixture.amendmentId}) AS segments
  `;
  return rows[0]!;
}

describe.skipIf(shouldSkip)('initiateSupplementPayment — PostgreSQL réel', () => {
  beforeAll(async () => {
    if (!sourceUrl) return;
    assertLocalhost(sourceUrl);
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
    await admin.end();
    const parsed = new URL(sourceUrl);
    parsed.pathname = `/${testDatabase}`;
    testUrl = parsed.toString();
    await runMigrations(testUrl);
    db = createDatabase(testUrl);
    sql = postgres(testUrl, { max: 10 });
  }, 600000);

  afterAll(async () => {
    await db?.$client.end();
    await sql?.end();
    if (!sourceUrl || !testUrl) return;
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.end();
  });

  it('crée le PaymentIntent avec snapshots, metadata et commission exacts', async () => {
    const fixture = await seedFixture(sql!, 'happy');
    const beforeMaterial = await materialCounts(sql!, fixture);
    const probeClient = postgres(testUrl!, { max: 1 });
    const provider = providerFor(fixture, probeClient);
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:00:00.000Z'),
    });
    await probeClient.end();

    expect(result).toMatchObject({
      kind: 'SUCCESS',
      amendmentId: fixture.amendmentId,
      amendmentPaymentId: fixture.amendmentPaymentId,
      amendmentPaymentAttemptId: fixture.amendmentPaymentAttemptId,
      providerStatus: 'requires_payment_method',
    });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]).toMatchObject({
      amountMinor: 5000,
      currency: 'EUR',
      connectedAccountId: 'acct_c2',
      onBehalfOfAccountId: 'acct_c2',
      applicationFeeAmountMinor: 250,
      idempotencyKey: `pi_amendment_${fixture.amendmentPaymentId}_1`,
      metadata: {
        payment_type: 'AMENDMENT',
        amendment_payment_attempt_id: fixture.amendmentPaymentAttemptId,
        amendment_id: fixture.amendmentId,
        organization_id: fixture.orgId,
        environment: 'TEST',
        protocol_version: 'booking-amendment-payment-v1',
      },
    });
    const rows = await sql!`
      SELECT ap.status AS payment_status, apa.status AS attempt_status,
        apa.provider_payment_intent_id, apa.provider_status,
        ap.processing_started_at, ap.processing_deadline_at,
        to_jsonb(ap) ? 'client_secret' AS payment_has_secret,
        to_jsonb(apa) ? 'client_secret' AS attempt_has_secret,
        (SELECT count(*)::int FROM amendment_payments WHERE amendment_id = ${fixture.amendmentId}) AS payment_count,
        (SELECT count(*)::int FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}) AS attempt_count,
        (SELECT count(*)::int FROM outbox_events) AS outbox_count
      FROM amendment_payments ap
      JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
      WHERE ap.id = ${fixture.amendmentPaymentId}
    `;
    expect(rows[0]).toMatchObject({
      payment_status: 'PROCESSING',
      attempt_status: 'PROCESSING',
      provider_payment_intent_id: expect.stringMatching(/^pi_/),
      provider_status: 'requires_payment_method',
      payment_has_secret: false,
      attempt_has_secret: false,
      payment_count: 1,
      attempt_count: 1,
      outbox_count: 0,
    });
    expect(rows[0]!.processing_started_at).toBeTruthy();
    expect(rows[0]!.processing_deadline_at).toBeTruthy();
    expect(new Date(rows[0]!.processing_started_at).toISOString()).toBe('2026-04-01T10:00:00.000Z');
    expect(new Date(rows[0]!.processing_deadline_at).toISOString()).toBe(
      '2026-04-01T10:10:00.000Z',
    );
    const outbox = await sql!`
      SELECT count(*)::int AS count FROM outbox_events
      WHERE payload::text LIKE ${'%' + (result.kind === 'SUCCESS' ? result.clientSecret : '') + '%'}
    `;
    expect(outbox[0]!.count).toBe(0);
    expect(await materialCounts(sql!, fixture)).toEqual(beforeMaterial);
    if (result.kind === 'SUCCESS') expect(result.clientSecret).toContain('_secret_');
  });

  it('refuse un autre client avant tout appel provider', async () => {
    const fixture = await seedFixture(sql!, 'forbidden');
    const provider = providerFor(fixture);
    const result = await initiateSupplementPayment(
      db!,
      provider,
      input(fixture, fixture.otherCustomerId),
      {
        now: new Date('2026-04-01T10:00:00.000Z'),
      },
    );
    expect(result).toEqual({ kind: 'FORBIDDEN' });
    expect(provider.createCalls).toHaveLength(0);
    expect(provider.retrieveCalls).toHaveLength(0);
  });

  it('isole les organisations et les environnements', async () => {
    const fixture = await seedFixture(sql!, 'tenant');
    const other = await seedFixture(sql!, 'other-tenant');
    const provider = providerFor(fixture);
    await expect(
      initiateSupplementPayment(
        db!,
        provider,
        input({ ...fixture, orgId: other.orgId }, fixture.customerId),
        { now: new Date('2026-04-01T10:00:00.000Z') },
      ),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
    expect(provider.createCalls).toHaveLength(0);

    const environmentProvider = providerFor(fixture);
    await expect(
      initiateSupplementPayment(
        db!,
        environmentProvider,
        input(fixture, fixture.customerId, 'LIVE'),
        { now: new Date('2026-04-01T10:00:00.000Z') },
      ),
    ).resolves.toEqual({ kind: 'ENVIRONMENT_MISMATCH' });
    expect(environmentProvider.createCalls).toHaveLength(0);
  });

  it('refuse un hold expiré avant le provider', async () => {
    const fixture = await seedFixture(sql!, 'expired');
    const provider = providerFor(fixture);
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:10:00.000Z'),
    });
    expect(result).toEqual({ kind: 'HOLD_EXPIRED' });
    expect(provider.createCalls).toHaveLength(0);
  });

  it('refuse une date afterProviderNow invalide avant le provider', async () => {
    const fixture = await seedFixture(sql!, 'invalid-projection-clock');
    const provider = providerFor(fixture);
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:00:00.000Z'),
      afterProviderNow: new Date(Number.NaN),
    });

    expect(result).toEqual({ kind: 'INVALID_INPUT' });
    expect(provider.createCalls).toHaveLength(0);
    expect(provider.retrieveCalls).toHaveLength(0);
  });

  it('refuse une projection après expiration pendant lappel provider', async () => {
    const fixture = await seedFixture(sql!, 'expires-during-provider');
    const beforeMaterial = await materialCounts(sql!, fixture);
    const provider = new RecordingProvider({ artificialDelayMs: 20 });
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:09:00.000Z'),
      afterProviderNow: new Date('2026-04-01T10:10:00.000Z'),
    });

    expect(result).toEqual({ kind: 'HOLD_EXPIRED' });
    expect(provider.createCalls).toHaveLength(1);
    const rows = await sql!`
      SELECT ap.status AS payment_status, apa.status AS attempt_status,
        apa.provider_payment_intent_id, apa.provider_status,
        to_jsonb(ap) ? 'client_secret' AS payment_has_secret,
        to_jsonb(apa) ? 'client_secret' AS attempt_has_secret
      FROM amendment_payments ap
      JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
      WHERE ap.id = ${fixture.amendmentPaymentId}
    `;
    expect(rows[0]).toMatchObject({
      payment_status: 'PROCESSING',
      attempt_status: 'PROCESSING',
      provider_payment_intent_id: null,
      provider_status: null,
      payment_has_secret: false,
      attempt_has_secret: false,
    });
    expect(await materialCounts(sql!, fixture)).toEqual(beforeMaterial);
  });

  it('conserve une prise de contrôle récupérable après une erreur provider', async () => {
    const fixture = await seedFixture(sql!, 'provider-error');
    const beforeMaterial = await materialCounts(sql!, fixture);
    const rawMessage = 'stripe secret raw message must never escape';
    const provider = new RecordingProvider({ createError: new Error(rawMessage) });
    const options = { now: new Date('2026-04-01T10:00:00.000Z') };
    const first = await initiateSupplementPayment(db!, provider, input(fixture), options);
    const second = await initiateSupplementPayment(db!, provider, input(fixture), options);

    expect(first).toEqual({ kind: 'PROVIDER_ERROR' });
    expect(second).toEqual({ kind: 'IN_PROGRESS' });
    expect(JSON.stringify(first)).not.toContain(rawMessage);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]!.idempotencyKey).toBe(
      `pi_amendment_${fixture.amendmentPaymentId}_1`,
    );
    const rows = await sql!`
      SELECT ap.status AS payment_status, apa.status AS attempt_status,
        apa.provider_payment_intent_id, apa.provider_status,
        to_jsonb(ap) ? 'client_secret' AS payment_has_secret,
        to_jsonb(apa) ? 'client_secret' AS attempt_has_secret,
        (SELECT count(*)::int FROM amendment_payments WHERE amendment_id = ${fixture.amendmentId}) AS payment_count,
        (SELECT count(*)::int FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}) AS attempt_count,
        (SELECT count(*)::int FROM outbox_events) AS outbox_count,
        (SELECT count(*)::int FROM outbox_events WHERE payload::text LIKE ${'%' + rawMessage + '%'}) AS raw_message_count
      FROM amendment_payments ap
      JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
      WHERE ap.id = ${fixture.amendmentPaymentId}
    `;
    expect(rows[0]).toMatchObject({
      payment_status: 'PROCESSING',
      attempt_status: 'PROCESSING',
      provider_payment_intent_id: null,
      provider_status: null,
      payment_has_secret: false,
      attempt_has_secret: false,
      payment_count: 1,
      attempt_count: 1,
      outbox_count: 0,
      raw_message_count: 0,
    });
    expect(await materialCounts(sql!, fixture)).toEqual(beforeMaterial);
  });

  it('garde les statuts locaux non terminaux pour une réponse provider succeeded', async () => {
    const fixture = await seedFixture(sql!, 'sync-succeeded');
    const beforeMaterial = await materialCounts(sql!, fixture);
    const provider = new RecordingProvider({
      createOverride: (result) => ({ ...result, status: 'succeeded' }),
    });
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ kind: 'SUCCESS', providerStatus: 'succeeded' });
    const rows = await sql!`
      SELECT ba.status AS amendment_status, ap.status AS payment_status,
        apa.status AS attempt_status, apa.provider_status
      FROM booking_amendments ba
      JOIN amendment_payments ap ON ap.amendment_id = ba.id
      JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
      WHERE ba.id = ${fixture.amendmentId}
    `;
    expect(rows[0]).toEqual({
      amendment_status: 'HOLD_PENDING',
      payment_status: 'PROCESSING',
      attempt_status: 'PROCESSING',
      provider_status: 'succeeded',
    });
    expect(await materialCounts(sql!, fixture)).toEqual(beforeMaterial);
  });

  it('réussit réellement en LIVE avec les snapshots et metadata LIVE', async () => {
    const fixture = await seedFixture(sql!, 'live', 'LIVE');
    const provider = new RecordingProvider({ environment: 'LIVE' });
    const result = await initiateSupplementPayment(
      db!,
      provider,
      input(fixture, fixture.customerId, 'LIVE'),
      { now: new Date('2026-04-01T10:00:00.000Z') },
    );

    expect(result.kind).toBe('SUCCESS');
    expect(provider.createCalls[0]!.metadata).toMatchObject({ environment: 'LIVE' });
    const rows = await sql!`
      SELECT ap.environment, apa.provider_status
      FROM amendment_payments ap
      JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
      WHERE ap.id = ${fixture.amendmentPaymentId}
    `;
    expect(rows[0]).toEqual({ environment: 'LIVE', provider_status: 'requires_payment_method' });
  });

  it('retourne IN_PROGRESS pour le second appel concurrent et réutilise la même clé', async () => {
    const fixture = await seedFixture(sql!, 'concurrent');
    // Laisser assez de temps à la seconde transaction pour entrer dans A
    // même lorsque les autres suites PostgreSQL consomment le pool.
    const provider = new RecordingProvider({ artificialDelayMs: 1500 });
    const now = new Date('2026-04-01T10:00:00.000Z');
    const [first, second] = await Promise.all([
      initiateSupplementPayment(db!, provider, input(fixture), { now }),
      initiateSupplementPayment(db!, provider, input(fixture), { now }),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.kind === 'SUCCESS')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'IN_PROGRESS')).toHaveLength(1);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]!.idempotencyKey).toBe(
      `pi_amendment_${fixture.amendmentPaymentId}_1`,
    );
    const counts = await sql!`
      SELECT
        (SELECT count(*)::int FROM amendment_payments WHERE amendment_id = ${fixture.amendmentId}) AS payments,
        (SELECT count(*)::int FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}) AS attempts
    `;
    expect(counts[0]).toEqual({ payments: 1, attempts: 1 });
  });

  it('rejoue avec un provider ID via retrieve sans créer un second intent', async () => {
    const fixture = await seedFixture(sql!, 'retrieve');
    const provider = new RecordingProvider();
    const now = new Date('2026-04-01T10:00:00.000Z');
    const first = await initiateSupplementPayment(db!, provider, input(fixture), { now });
    const second = await initiateSupplementPayment(db!, provider, input(fixture), { now });
    expect(first.kind).toBe('SUCCESS');
    expect(second.kind).toBe('SUCCESS');
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.retrieveCalls).toHaveLength(1);
    expect(provider.retrieveCalls[0]).toBe(
      first.kind === 'SUCCESS' ? first.providerPaymentIntentId : '',
    );
  });

  it('rejette séparément chaque mismatch provider sans écraser la projection locale', async () => {
    const mismatchCases: ReadonlyArray<{
      name: string;
      override: (result: PaymentIntentResult) => PaymentIntentResult;
    }> = [
      {
        name: 'amount',
        override: (result) => ({ ...result, amountMinor: result.amountMinor + 1 }),
      },
      { name: 'currency', override: (result) => ({ ...result, currency: 'USD' }) },
      { name: 'environment', override: (result) => ({ ...result, environment: 'LIVE' }) },
      {
        name: 'connected-account',
        override: (result) => ({ ...result, connectedAccountId: 'acct_other' }),
      },
      {
        name: 'commission',
        override: (result) => ({
          ...result,
          applicationFeeAmountMinor: (result.applicationFeeAmountMinor ?? 0) + 1,
        }),
      },
      {
        name: 'on-behalf-of',
        override: (result) => ({ ...result, onBehalfOfAccountId: 'acct_other' }),
      },
    ];

    for (const mismatchCase of mismatchCases) {
      const fixture = await seedFixture(sql!, `mismatch-${mismatchCase.name}`);
      const provider = new RecordingProvider({ createOverride: mismatchCase.override });
      const result = await initiateSupplementPayment(db!, provider, input(fixture), {
        now: new Date('2026-04-01T10:00:00.000Z'),
      });
      expect(result, mismatchCase.name).toEqual({ kind: 'PROVIDER_STATE_INCONSISTENT' });
      const rows = await sql!`
        SELECT ap.status AS payment_status, apa.status AS attempt_status,
          apa.provider_payment_intent_id, apa.provider_status
        FROM amendment_payments ap
        JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
        WHERE ap.id = ${fixture.amendmentPaymentId}
      `;
      expect(rows[0]).toMatchObject({
        payment_status: 'PROCESSING',
        attempt_status: 'PROCESSING',
        provider_payment_intent_id: null,
        provider_status: null,
      });
    }
  });

  it('ne régresse pas une projection terminale arrivée pendant l’appel provider', async () => {
    const fixture = await seedFixture(sql!, 'terminal-race');
    const provider = new RecordingProvider({
      afterCreate: async (result) => {
        await sql!`
          UPDATE amendment_payment_attempts
          SET provider_payment_intent_id = ${result.id}, provider_status = 'succeeded',
              status = 'SUCCEEDED'
          WHERE id = ${fixture.amendmentPaymentAttemptId}
        `;
        await sql!`
          UPDATE amendment_payments
          SET status = 'SUCCEEDED', succeeded_at = now()
          WHERE id = ${fixture.amendmentPaymentId}
        `;
      },
    });
    const result = await initiateSupplementPayment(db!, provider, input(fixture), {
      now: new Date('2026-04-01T10:00:00.000Z'),
    });
    expect(result.kind).toBe('SUCCESS');
    const rows = await sql!`
      SELECT ap.status AS payment_status, a.status AS attempt_status,
             a.provider_payment_intent_id, a.provider_status
      FROM amendment_payments ap
      JOIN amendment_payment_attempts a ON a.amendment_payment_id = ap.id
      WHERE ap.id = ${fixture.amendmentPaymentId}
    `;
    expect(rows[0]).toMatchObject({
      payment_status: 'SUCCEEDED',
      attempt_status: 'SUCCEEDED',
      provider_payment_intent_id: expect.stringMatching(/^pi_/),
      provider_status: 'succeeded',
    });
  });
});
