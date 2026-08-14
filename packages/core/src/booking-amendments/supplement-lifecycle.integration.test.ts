import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import type { PaymentIntentResult } from '../payments/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import {
  BOOKING_AMENDMENT_EXPIRED_EVENT_TYPE,
  expireSupplementAmendmentsBatch,
} from './expire-supplement-amendments';
import { retryFailedSupplementPayment } from './retry-supplement-payment';
import {
  reconcileSupplementPaymentsBatch,
  claimSupplementPaymentBatch,
} from './reconcile-supplement-payments-batch';

const sourceUrl = process.env.DATABASE_URL;
const testDbName = 'uttily_test_g7m_c4a_lifecycle';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

let db: DatabaseClient | null = null;
let sql: postgres.Sql | null = null;
let testUrl: string | null = null;

interface Fixture {
  organizationId: string;
  bookingId: string;
  amendmentId: string;
  paymentId: string;
  attemptId: string;
  holdBlockId: string;
  segmentId: string;
  allocationId: string;
}

interface FixtureOptions {
  readonly organizationId?: string;
  readonly holdDeadline?: string;
  readonly amendmentStatus?: 'HOLD_PENDING' | 'READY_TO_APPLY' | 'EXPIRED';
  readonly paymentStatus?: 'PENDING_PROVIDER' | 'FAILED' | 'SUCCEEDED' | 'CANCELLED' | 'PROCESSING';
  readonly attemptStatus?: 'PENDING_PROVIDER' | 'FAILED' | 'SUCCEEDED' | 'CANCELLED' | 'PROCESSING';
  readonly providerPaymentIntentId?: string | null;
  readonly reconcileAfter?: string | null;
  readonly environment?: 'TEST' | 'LIVE';
}

function iso(value: string): Date {
  return new Date(value);
}

async function seedFixture(client: postgres.Sql, suffix: string, options: FixtureOptions = {}) {
  const holdDeadline = options.holdDeadline ?? '2026-01-01 12:10:00+00';
  const amendmentCreatedAt = new Date(new Date(holdDeadline).getTime() - 10 * 60_000).toISOString();
  const environment = options.environment ?? 'TEST';

  let orgId: string;
  if (options.organizationId !== undefined) {
    orgId = options.organizationId;
  } else {
    const organization = await client`
      INSERT INTO organizations (legal_name, slug)
      VALUES (${`C4-A ${suffix}`}, ${`c4a-${suffix}`})
      RETURNING id
    `.then((rows) => rows[0]!);
    orgId = organization.id as string;
  }

  const user = await client`
    INSERT INTO users (email)
    VALUES (${`c4a-${suffix}@example.com`})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgId}, 'Annecy', ${`c4a-${suffix}`}, 'UTC', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const category = await client`SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1`.then(
    (rows) => rows[0]!,
  );
  const product = await client`
    INSERT INTO products (organization_id, category_id, name, slug)
    VALUES (${orgId}, ${category.id}, 'C4-A product', ${`c4a-product-${suffix}`})
    RETURNING id
  `.then((rows) => rows[0]!);
  const variant = await client`
    INSERT INTO product_variants (product_id, name, daily_price_amount_minor, currency)
    VALUES (${product.id}, 'Standard', 2000, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const item = await client`
    INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id)
    VALUES (${orgId}, ${variant.id}, ${`C4A-${suffix}`}, ${location.id})
    RETURNING id
  `.then((rows) => rows[0]!);
  const draft = await client`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, billable_unit, billable_unit_count,
      currency, cancellation_policy_snapshot
    ) VALUES (
      ${orgId}, ${location.id}, ${user.id},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      'UTC', 30, 30, 10000, 0, 10000, 'NOT_APPLICABLE', 0,
      'DAY', 2, 'EUR', ${client.json({ policy: 'C4-A' })}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const bookingPayment = await client`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status,
      amount_minor, currency, tax_status, tax_amount_minor,
      commission_amount_minor, financial_terms_version, legal_terms_version,
      terms_acceptance_snapshot, connected_account_id, settlement_merchant_mode,
      environment
    ) VALUES (
      ${orgId}, ${draft.id}, ${user.id}, 'PENDING_PROVIDER', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 500, '1', '1', ${client.json({ version: '1' })},
      'acct_booking', 'CONNECTED_ACCOUNT', ${environment}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await client`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id,
      status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, tax_status,
      tax_amount_minor, commission_amount_minor, total_amount_minor,
      cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${orgId}, ${location.id}, ${user.id}, ${draft.id}, ${bookingPayment.id},
      'CONFIRMED', '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', 30, 30, 'EUR',
      10000, 0, 'NOT_APPLICABLE', 0, 500, 10000,
      ${client.json({ policy: 'C4-A' })}, ${client.json({ accepted: true })},
      '2026-01-01 12:00:00+00'
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  const amendment = await client`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at,
      new_blocked_start_at, new_blocked_end_at, hold_deadline, created_by,
      created_at
    ) VALUES (
      ${orgId}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
      ${client.json({ totalAmountMinor: 10000, commissionAmountMinor: 500 })},
      ${client.json({ totalAmountMinor: 12000, supplementAmountMinor: 2000 })},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      ${holdDeadline}, ${user.id}, ${amendmentCreatedAt}
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  if (options.amendmentStatus === 'READY_TO_APPLY') {
    await client`
      UPDATE booking_amendments SET status = 'READY_TO_APPLY', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${amendment.id}
    `;
  } else if (options.amendmentStatus === 'EXPIRED') {
    await client`
      UPDATE booking_amendments SET status = 'EXPIRED', expired_at = '2026-01-01 12:00:00+00', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${amendment.id}
    `;
  }

  const line = await client`
    INSERT INTO booking_amendment_lines (
      amendment_id, organization_id, logical_line_id, origin_type, variant_id, action,
      before_quantity, before_unit_price_amount_minor, before_line_total_amount_minor,
      after_quantity, after_unit_price_amount_minor, after_line_total_amount_minor,
      pricing_snapshot, variant_snapshot
    ) VALUES (
      ${amendment.id}, ${orgId}, gen_random_uuid(), 'AMENDMENT', ${variant.id}, 'ADD',
      0, 0, 0, 1, 2000, 2000, ${client.json({ version: 'C4-A' })}, ${client.json({ name: 'Standard' })}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const allocation = await client`
    INSERT INTO booking_amendment_allocations (
      amendment_id, amendment_line_id, organization_id, inventory_item_id, action,
      effective_customer_start_at, effective_customer_end_at,
      effective_blocked_start_at, effective_blocked_end_at
    ) VALUES (
      ${amendment.id}, ${line.id}, ${orgId}, ${item.id}, 'ADD',
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const hold = await client`
    INSERT INTO inventory_blocks (
      organization_id, inventory_item_id, type, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      expires_at, source_id
    ) VALUES (
      ${orgId}, ${item.id}, 'HOLD', 'ACTIVE',
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      ${holdDeadline}, ${amendment.id}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const segment = await client`
    INSERT INTO booking_amendment_segments (
      allocation_id, organization_id, inventory_item_id, hold_block_id,
      delta_start_at, delta_end_at
    ) VALUES (
      ${allocation.id}, ${orgId}, ${item.id}, ${hold.id},
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00'
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  const payment = await client`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id,
      amount_minor, currency, environment, connected_account_id,
      charge_model, settlement_merchant_mode
    ) VALUES (
      ${orgId}, ${booking.id}, ${amendment.id}, ${user.id},
      2000, 'EUR', ${environment}, 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT'
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  const attempt = await client`
    INSERT INTO amendment_payment_attempts (
      organization_id, amendment_payment_id, attempt_number, status,
      provider_idempotency_key, reconcile_after
    ) VALUES (
      ${orgId}, ${payment.id}, 1, 'PENDING_PROVIDER',
      ${`pi_amendment_${payment.id}_1`}, ${options.reconcileAfter ?? null}
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  if (options.attemptStatus === 'FAILED') {
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'REQUIRES_PAYMENT_METHOD', provider_payment_intent_id = ${options.providerPaymentIntentId ?? `pi-failed-${suffix}`},
          provider_status = 'requires_payment_method', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'FAILED', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
  } else if (options.attemptStatus === 'SUCCEEDED') {
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'PROCESSING', provider_payment_intent_id = ${options.providerPaymentIntentId ?? `pi-succeeded-${suffix}`},
          provider_status = 'processing', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'SUCCEEDED', provider_status = 'succeeded', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
  } else if (options.attemptStatus === 'CANCELLED') {
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'PROCESSING', provider_payment_intent_id = ${options.providerPaymentIntentId ?? `pi-cancelled-${suffix}`},
          provider_status = 'processing', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'CANCELLED', provider_status = 'canceled', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
  } else if (options.attemptStatus === 'PROCESSING') {
    await client`
      UPDATE amendment_payment_attempts
      SET status = 'PROCESSING', provider_payment_intent_id = ${options.providerPaymentIntentId ?? `pi-processing-${suffix}`},
          provider_status = 'processing', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
  } else if (
    options.providerPaymentIntentId !== undefined &&
    options.providerPaymentIntentId !== null
  ) {
    await client`
      UPDATE amendment_payment_attempts
      SET provider_payment_intent_id = ${options.providerPaymentIntentId},
          provider_status = 'processing', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${attempt.id}
    `;
  }

  if (options.paymentStatus === 'FAILED') {
    await client`
      UPDATE amendment_payments
      SET status = 'FAILED', failed_at = '2026-01-01 12:00:00+00', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${payment.id}
    `;
  } else if (options.paymentStatus === 'SUCCEEDED') {
    await client`
      UPDATE amendment_payments
      SET status = 'SUCCEEDED', succeeded_at = '2026-01-01 12:00:00+00', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${payment.id}
    `;
  } else if (options.paymentStatus === 'CANCELLED') {
    await client`
      UPDATE amendment_payments
      SET status = 'PROCESSING', processing_started_at = '2026-01-01 12:00:00+00',
          processing_deadline_at = '2026-01-01 12:30:00+00', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${payment.id}
    `;
    await client`
      UPDATE amendment_payments
      SET status = 'CANCELLED', cancelled_at = '2026-01-01 12:00:00+00',
          processing_started_at = null, processing_deadline_at = null, updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${payment.id}
    `;
  } else if (options.paymentStatus === 'PROCESSING') {
    await client`
      UPDATE amendment_payments
      SET status = 'PROCESSING', processing_started_at = '2026-01-01 12:00:00+00',
          processing_deadline_at = '2026-01-01 12:30:00+00', updated_at = '2026-01-01 12:00:00+00'
      WHERE id = ${payment.id}
    `;
  }

  return {
    organizationId: orgId,
    bookingId: booking.id,
    amendmentId: amendment.id,
    paymentId: payment.id,
    attemptId: attempt.id,
    holdBlockId: hold.id,
    segmentId: segment.id,
    allocationId: allocation.id,
  } satisfies Fixture;
}

function providerResult(
  id: string,
  status: PaymentIntentResult['status'],
  fee = 100,
  environment: 'TEST' | 'LIVE' = 'TEST',
): PaymentIntentResult {
  return {
    id,
    status,
    clientSecret: 'secret_c4a',
    latestChargeId: null,
    amountMinor: 2000,
    currency: 'EUR',
    environment,
    connectedAccountId: 'acct_test',
    applicationFeeAmountMinor: fee,
    onBehalfOfAccountId: null,
  };
}

describe.skipIf(shouldSkip)('G7M-C4-A lifecycle PostgreSQL', () => {
  beforeAll(async () => {
    if (!sourceUrl) return;
    assertLocalhost(sourceUrl);
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDbName};`);
    await admin.unsafe(`CREATE DATABASE ${testDbName};`);
    await admin.end();
    const url = new URL(sourceUrl);
    url.pathname = `/${testDbName}`;
    testUrl = url.toString();
    await runMigrations(testUrl);
    db = createDatabase(testUrl);
    sql = postgres(testUrl, { max: 8 });
  }, 600000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (!sourceUrl) return;
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid();`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDbName};`);
    await admin.end();
  });

  // --------------------------------------------------------------------------
  // Expiration atomique des suppléments
  // --------------------------------------------------------------------------

  it('expirations exactes, zombie READY_TO_APPLY, libération atomique et outbox idempotente', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const at = await seedFixture(sql, 'expire-at');
    const zombie = await seedFixture(sql, 'expire-zombie', { amendmentStatus: 'READY_TO_APPLY' });
    const before = await seedFixture(sql, 'expire-before', {
      holdDeadline: '2026-01-01 12:11:00+00',
    });
    const beforeResult = await expireSupplementAmendmentsBatch(db, {
      asOf: iso('2026-01-01T12:09:59Z'),
      batchLimit: 10,
    });
    expect(beforeResult.expired.some((row) => row.amendmentId === before.amendmentId)).toBe(false);
    const result = await expireSupplementAmendmentsBatch(db, {
      asOf: iso('2026-01-01T12:10:00Z'),
      batchLimit: 10,
    });
    expect(result.expired.map((row) => row.amendmentId)).toEqual(
      expect.arrayContaining([at.amendmentId, zombie.amendmentId]),
    );
    const rows = await sql`
      SELECT ba.status AS amendment_status, ib.status AS block_status,
             bas.status AS segment_status, baa.status AS allocation_status,
             count(oe.id)::int AS outbox_count
      FROM booking_amendments ba
      JOIN inventory_blocks ib ON ib.source_id = ba.id
      JOIN booking_amendment_segments bas ON bas.hold_block_id = ib.id
      JOIN booking_amendment_allocations baa ON baa.id = bas.allocation_id
      LEFT JOIN outbox_events oe ON oe.idempotency_key = ('booking_amendment_expired_' || ba.id)
      WHERE ba.id = ANY(${sql.array([at.amendmentId, zombie.amendmentId])}::uuid[])
      GROUP BY ba.status, ib.status, bas.status, baa.status
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amendment_status: 'EXPIRED',
      block_status: 'EXPIRED',
      segment_status: 'EXPIRED',
      allocation_status: 'EXPIRED',
      outbox_count: 2,
    });
    const replay = await expireSupplementAmendmentsBatch(db, {
      asOf: iso('2026-01-01T12:10:01Z'),
    });
    expect(replay.expiredCount).toBe(0);
    const events = await sql`
      SELECT event_type, event_version FROM outbox_events
      WHERE event_type = ${BOOKING_AMENDMENT_EXPIRED_EVENT_TYPE}
        AND aggregate_type = 'BOOKING'
    `;
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.event_version === 'v1')).toBe(true);
  });

  it("limite et ordre déterministes du batch d'expiration", async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const first = await seedFixture(sql, 'batch-ord-1', { holdDeadline: '2026-01-01 10:00:00+00' });
    const second = await seedFixture(sql, 'batch-ord-2', {
      holdDeadline: '2026-01-01 10:05:00+00',
    });
    const third = await seedFixture(sql, 'batch-ord-3', { holdDeadline: '2026-01-01 10:10:00+00' });

    const batch1 = await expireSupplementAmendmentsBatch(db, {
      asOf: iso('2026-01-01T11:00:00Z'),
      batchLimit: 2,
    });
    expect(batch1.processedCount).toBe(2);
    expect(batch1.expiredCount).toBe(2);
    expect(batch1.expired[0]!.amendmentId).toBe(first.amendmentId);
    expect(batch1.expired[1]!.amendmentId).toBe(second.amendmentId);

    const batch2 = await expireSupplementAmendmentsBatch(db, {
      asOf: iso('2026-01-01T11:00:00Z'),
      batchLimit: 2,
    });
    expect(batch2.processedCount).toBe(1);
    expect(batch2.expiredCount).toBe(1);
    expect(batch2.expired[0]!.amendmentId).toBe(third.amendmentId);
  });

  it('expiration concurrente avec SKIP LOCKED sans conflit', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const e1 = await seedFixture(sql, 'conc-exp-1', { holdDeadline: '2026-01-01 09:00:00+00' });
    const e2 = await seedFixture(sql, 'conc-exp-2', { holdDeadline: '2026-01-01 09:01:00+00' });

    const [res1, res2] = await Promise.all([
      expireSupplementAmendmentsBatch(db, { asOf: iso('2026-01-01T10:00:00Z'), batchLimit: 1 }),
      expireSupplementAmendmentsBatch(db, { asOf: iso('2026-01-01T10:00:00Z'), batchLimit: 1 }),
    ]);
    const allExpired = [...res1.expired, ...res2.expired];
    expect(allExpired).toHaveLength(2);
    const expiredIds = allExpired.map((r) => r.amendmentId);
    expect(expiredIds).toContain(e1.amendmentId);
    expect(expiredIds).toContain(e2.amendmentId);
  });

  it("rollback atomique si l'outbox ou une mutation d'expiration échoue", async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'rollback-exp', {
      holdDeadline: '2026-01-01 08:00:00+00',
    });

    // Injecter un trigger d'erreur sur outbox_events
    await sql.unsafe(
      "CREATE OR REPLACE FUNCTION fail_outbox_test() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'SIMULATED_OUTBOX_FAILURE'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER trg_test_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_outbox_test();",
    );

    try {
      await expect(
        expireSupplementAmendmentsBatch(db, {
          asOf: iso('2026-01-01T09:00:00Z'),
          batchLimit: 1,
          organizationId: fixture.organizationId,
        }),
      ).rejects.toThrow('SIMULATED_OUTBOX_FAILURE');

      // Vérifier le rollback total : amendement, blocks et segments n'ont pas changé
      const amendment = await sql`
        SELECT status FROM booking_amendments WHERE id = ${fixture.amendmentId}
      `;
      expect(amendment[0]!.status).toBe('HOLD_PENDING');

      const block = await sql`
        SELECT status FROM inventory_blocks WHERE id = ${fixture.holdBlockId}
      `;
      expect(block[0]!.status).toBe('ACTIVE');

      const segment = await sql`
        SELECT status FROM booking_amendment_segments WHERE id = ${fixture.segmentId}
      `;
      expect(segment[0]!.status).toBe('PROPOSED');
    } finally {
      await sql.unsafe(
        'DROP TRIGGER IF EXISTS trg_test_fail_outbox ON outbox_events; DROP FUNCTION IF EXISTS fail_outbox_test();',
      );
    }
  });

  // --------------------------------------------------------------------------
  // Retry métier fail-closed et invariants
  // --------------------------------------------------------------------------

  it('isolation tenant fail-closed : autre tenant indistinguable de NOT_FOUND et aucune donnée étrangère modifiée', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const orgA = await seedFixture(sql, 'tenant-a', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'FAILED',
      attemptStatus: 'FAILED',
    });
    const orgB = await seedFixture(sql, 'tenant-b', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'FAILED',
      attemptStatus: 'FAILED',
    });

    // 1. Appeler retry sur org B avec le paymentId d'org A -> NOT_FOUND
    const foreignResult = await retryFailedSupplementPayment(db, {
      organizationId: orgB.organizationId,
      amendmentPaymentId: orgA.paymentId,
      now: iso('2098-01-01T12:00:00Z'),
    });
    expect(foreignResult).toEqual({ kind: 'NOT_FOUND' });

    // 2. Appeler retry sur org B avec un UUID aléatoire -> NOT_FOUND exactement identique
    const nonExistentResult = await retryFailedSupplementPayment(db, {
      organizationId: orgB.organizationId,
      amendmentPaymentId: '00000000-0000-4000-8000-000000000099',
      now: iso('2098-01-01T12:00:00Z'),
    });
    expect(nonExistentResult).toEqual({ kind: 'NOT_FOUND' });

    // 3. Vérifier qu'aucun attempt ni état n'a été modifié sur org A
    const attemptsA = await sql`
      SELECT count(*)::int AS count FROM amendment_payment_attempts
      WHERE amendment_payment_id = ${orgA.paymentId}
    `;
    expect(attemptsA[0]!.count).toBe(1);

    const paymentA = await sql`
      SELECT status FROM amendment_payments WHERE id = ${orgA.paymentId}
    `;
    expect(paymentA[0]!.status).toBe('FAILED');
  });

  it('retry exactement à la deadline refusé (HOLD_EXPIRED)', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'retry-exact-deadline', {
      holdDeadline: '2026-01-01 12:10:00+00',
      paymentStatus: 'FAILED',
      attemptStatus: 'FAILED',
    });

    const result = await retryFailedSupplementPayment(db, {
      organizationId: fixture.organizationId,
      amendmentPaymentId: fixture.paymentId,
      now: iso('2026-01-01T12:10:00Z'), // exactement à la deadline
    });
    expect(result).toEqual({ kind: 'HOLD_EXPIRED' });

    const attempts = await sql`
      SELECT count(*)::int AS count FROM amendment_payment_attempts
      WHERE amendment_payment_id = ${fixture.paymentId}
    `;
    expect(attempts[0]!.count).toBe(1);
  });

  it('retry depuis SUCCEEDED, CANCELLED ou état non FAILED refusé (NOT_RETRYABLE)', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const succeeded = await seedFixture(sql, 'retry-succeeded', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'SUCCEEDED',
      attemptStatus: 'SUCCEEDED',
    });
    const cancelled = await seedFixture(sql, 'retry-cancelled', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'CANCELLED',
      attemptStatus: 'CANCELLED',
    });
    const processing = await seedFixture(sql, 'retry-processing', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'PROCESSING',
      attemptStatus: 'PROCESSING',
    });

    const res1 = await retryFailedSupplementPayment(db, {
      organizationId: succeeded.organizationId,
      amendmentPaymentId: succeeded.paymentId,
      now: iso('2098-01-01T12:00:00Z'),
    });
    expect(res1).toEqual({ kind: 'NOT_RETRYABLE' });

    const res2 = await retryFailedSupplementPayment(db, {
      organizationId: cancelled.organizationId,
      amendmentPaymentId: cancelled.paymentId,
      now: iso('2098-01-01T12:00:00Z'),
    });
    expect(res2).toEqual({ kind: 'NOT_RETRYABLE' });

    const res3 = await retryFailedSupplementPayment(db, {
      organizationId: processing.organizationId,
      amendmentPaymentId: processing.paymentId,
      now: iso('2098-01-01T12:00:00Z'),
    });
    expect(res3).toEqual({ kind: 'NOT_RETRYABLE' });
  });

  it('retry concurrent sérialisé par le verrou : un seul attempt N+1 créé', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'retry-concurrent', {
      holdDeadline: '2099-01-01 12:10:00+00',
      paymentStatus: 'FAILED',
      attemptStatus: 'FAILED',
    });

    const results = await Promise.all([
      retryFailedSupplementPayment(db, {
        organizationId: fixture.organizationId,
        amendmentPaymentId: fixture.paymentId,
        now: iso('2098-01-01T12:00:00Z'),
      }),
      retryFailedSupplementPayment(db, {
        organizationId: fixture.organizationId,
        amendmentPaymentId: fixture.paymentId,
        now: iso('2098-01-01T12:00:00Z'),
      }),
    ]);
    expect(results.filter((r) => r.kind === 'RETRY_CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'NOT_RETRYABLE')).toHaveLength(1);

    const attempts = await sql`
      SELECT attempt_number, status, provider_idempotency_key
      FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.paymentId}
      ORDER BY attempt_number
    `;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attempt_number: 1, status: 'FAILED' });
    expect(attempts[1]).toMatchObject({
      attempt_number: 2,
      status: 'PENDING_PROVIDER',
      provider_idempotency_key: `pi_amendment_${fixture.paymentId}_2`,
    });
  });

  // --------------------------------------------------------------------------
  // Réconciliation et appels provider
  // --------------------------------------------------------------------------

  it(
    'create revendiqué avant deadline mais exécuté après deadline : zéro appel provider',
    { timeout: 15_000 },
    async () => {
      if (!db || !sql) throw new Error('database unavailable');

      // Capturer l'heure PostgreSQL réelle
      const rows = await sql<{ pg_now: Date }[]>`
        SELECT transaction_timestamp() AS pg_now
      `;
      const pgNow = new Date(rows[0]!.pg_now.getTime());

      // Premier attempt : deadline lointaine (+1h), reconcile_after dans le passé (-60s)
      const first = await seedFixture(sql, 'race-deadline-1', {
        holdDeadline: new Date(pgNow.getTime() + 3_600_000).toISOString(),
        reconcileAfter: new Date(pgNow.getTime() - 60_000).toISOString(),
        amendmentStatus: 'HOLD_PENDING',
      });

      // Second attempt : deadline courte mais future au claim (+5000ms), reconcile_after dans le passé (-30s)
      // Ordonné après le premier (reconcile_after first < reconcile_after second)
      const second = await seedFixture(sql, 'race-deadline-2', {
        holdDeadline: new Date(pgNow.getTime() + 5_000).toISOString(),
        reconcileAfter: new Date(pgNow.getTime() - 30_000).toISOString(),
        amendmentStatus: 'HOLD_PENDING',
      });

      let createCalls = 0;
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      adapter.createPaymentIntent = async () => {
        createCalls++;
        // Pendant le premier appel provider, attendre 6000ms pour franchir la deadline du second (5000ms)
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return providerResult('pi_first_success', 'succeeded');
      };

      const result = await reconcileSupplementPaymentsBatch(
        { db, provider: adapter },
        { environment: 'TEST' },
      );

      // 1. Les deux attempts ont été claimés dans le batch initial (processedCount = 2)
      expect(result.claimedCount).toBe(2);
      // 2. Le premier provider call a lieu et réussit
      expect(createCalls).toBe(1);
      expect(result.projectedCount).toBe(1);
      // 3. Le second createPaymentIntent n'a JAMAIS lieu
      expect(result.skippedExpiredCount).toBe(1);

      // 4. Premier attempt : projeté avec provider_status succeeded et lease libéré
      const [att1] = await sql`
      SELECT status, provider_status, provider_payment_intent_id, reconcile_lease_token
      FROM amendment_payment_attempts
      WHERE id = ${first.attemptId}
    `;
      expect(att1!.provider_status).toBe('succeeded');
      expect(att1!.provider_payment_intent_id).toBe('pi_first_success');
      expect(att1!.reconcile_lease_token).toBeNull();

      // 5. Second attempt : aucun provider call, lease libéré
      const [att2] = await sql`
      SELECT status, provider_status, provider_payment_intent_id, reconcile_lease_token
      FROM amendment_payment_attempts
      WHERE id = ${second.attemptId}
    `;
      expect(att2!.provider_status).toBeNull();
      expect(att2!.provider_payment_intent_id).toBeNull();
      expect(att2!.reconcile_lease_token).toBeNull();
    },
  );

  it('lease perdu avant appel provider : zéro appel provider et anomalie LEASE_LOST', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    // On crée 2 fixtures dans le même batch
    const first = await seedFixture(sql, 'lease-pre-1', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:00:00+00',
    });
    const second = await seedFixture(sql, 'lease-pre-2', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:05:00+00',
    });

    const probe = postgres(testUrl!, { max: 1 });
    let createCallsSecond = 0;
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.createPaymentIntent = async (params) => {
      if (params.idempotencyKey.includes(first.paymentId)) {
        // Pendant le 1er appel provider, voler le lease du second
        await probe`
          UPDATE amendment_payment_attempts
          SET reconcile_lease_token = gen_random_uuid()
          WHERE id = ${second.attemptId}
        `;
        return providerResult('pi-first', 'succeeded');
      }
      createCallsSecond++;
      return providerResult('pi-second', 'succeeded');
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST', batchLimit: 2 },
    );

    // Le 2nd n'a pas pu appeler le provider car son lease a été perdu avant son appel
    expect(createCallsSecond).toBe(0);
    expect(result.anomalyCount).toBe(1);
    expect(
      result.anomalies.some((a) => a.attemptId === second.attemptId && a.code === 'LEASE_LOST'),
    ).toBe(true);
    await probe.end();
  });

  it("lease perdu pendant l'appel provider : aucune projection et anomalie LEASE_LOST", async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'lease-lost-during-call', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
    });

    const probe = postgres(testUrl!, { max: 1 });
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.createPaymentIntent = async () => {
      // Pendant l'appel provider hors transaction, une autre transaction vole le lease
      await probe`
        UPDATE amendment_payment_attempts
        SET reconcile_lease_token = gen_random_uuid(),
            reconcile_lease_until = now() + interval '5 minutes'
        WHERE id = ${fixture.attemptId}
      `;
      return providerResult('pi-lost-during', 'succeeded');
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST' },
    );
    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]).toMatchObject({
      attemptId: fixture.attemptId,
      code: 'LEASE_LOST',
    });

    // Vérifier qu'aucune projection n'a eu lieu (pas de providerPaymentIntentId projeté)
    const attempt = await sql`
      SELECT provider_payment_intent_id, status FROM amendment_payment_attempts
      WHERE id = ${fixture.attemptId}
    `;
    expect(attempt[0]!.provider_payment_intent_id).toBeNull();
    await probe.end();
  });

  it('retrieve après deadline autorisé pour un PI existant et classifié IGNORED_LATE_SUCCESS si succeeded', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'retrieve-past-deadline', {
      holdDeadline: '2026-01-01 10:00:00+00', // deadline passée
      reconcileAfter: '2026-01-01 09:59:00+00',
      providerPaymentIntentId: 'pi-existing-late',
    });

    let retrieveCalls = 0;
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.retrievePaymentIntent = async (id) => {
      retrieveCalls++;
      return providerResult(id, 'succeeded');
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST' },
    );
    expect(retrieveCalls).toBe(1);
    expect(result.reconciledCount).toBe(1);
    expect(result.ignoredLateSuccessCount).toBe(1);
    expect(result.projectedCount).toBe(0);

    const attempt = await sql`
      SELECT provider_status, reconcile_lease_token FROM amendment_payment_attempts
      WHERE id = ${fixture.attemptId}
    `;
    expect(attempt[0]!.provider_status).toBe('succeeded');
    expect(attempt[0]!.reconcile_lease_token).toBeNull();
  });

  it('create après deadline interdit et skippedExpiredCount incrémenté', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'create-after-deadline', {
      holdDeadline: '2026-01-01 11:00:00+00', // déjà expiré
      reconcileAfter: '2026-01-01 10:50:00+00',
      amendmentStatus: 'EXPIRED',
    });

    let createCalls = 0;
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.createPaymentIntent = async () => {
      createCalls++;
      return providerResult('pi-impossible', 'succeeded');
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST' },
    );
    expect(createCalls).toBe(0);
    expect(result.skippedExpiredCount).toBe(1);
    const attempt = await sql`
      SELECT reconcile_lease_token FROM amendment_payment_attempts
      WHERE id = ${fixture.attemptId}
    `;
    expect(attempt[0]!.reconcile_lease_token).toBeNull();
  });

  it('isolation TEST/LIVE dans le claim et mismatch provider rejeté', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    await seedFixture(sql, 'env-test', {
      environment: 'TEST',
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
    });
    await seedFixture(sql, 'env-live', {
      environment: 'LIVE',
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
    });

    // 1. Reconcile avec TEST ne réclame pas LIVE
    const testAdapter = new FakeStripeAdapter({ environment: 'TEST' });
    const testResult = await reconcileSupplementPaymentsBatch(
      { db, provider: testAdapter },
      { environment: 'TEST' },
    );
    expect(testResult.claimedCount).toBe(1);

    // 2. Mismatch entre provider et options
    const liveAdapter = new FakeStripeAdapter({ environment: 'LIVE' });
    await expect(
      reconcileSupplementPaymentsBatch({ db, provider: liveAdapter }, { environment: 'TEST' }),
    ).rejects.toThrow('PROVIDER_ENVIRONMENT_MISMATCH');
  });

  it('erreur provider arbitraire avec secret sensible normalisée en code fermé sans fuite', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    await seedFixture(sql, 'sentinel-leak', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
    });

    const SENSITIVE_SENTINEL = 'sk_live_SECRET_KEY_EXPOSED_9999_PAYLOAD_LEAK';
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.createPaymentIntent = async () => {
      throw new Error(`Fatal Stripe error: ${SENSITIVE_SENTINEL}`);
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST' },
    );
    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]!.code).toBe('PROVIDER_CALL_FAILED');

    // Prouver l'absence absolue de la sentinelle dans toute la réponse
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk_live');
    expect(serialized).not.toContain('SECRET_KEY_EXPOSED');
    expect(serialized).not.toContain(SENSITIVE_SENTINEL);
  });

  it("provider probe lock prouve l'absence de verrou de transaction pendant l'appel provider", async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'probe-lock', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
      providerPaymentIntentId: 'pi-probe-lock',
    });

    const probe = postgres(testUrl!, { max: 1 });
    let lockAcquired = false;
    const adapter = new FakeStripeAdapter({ environment: 'TEST' });
    adapter.retrievePaymentIntent = async () => {
      // Si la réconciliation tenait une transaction avec verrou FOR UPDATE,
      // ce FOR UPDATE NOWAIT échouerait. Prouvons qu'il réussit sans blocage.
      await probe.begin(async (probeTx) => {
        const locked = await probeTx`
          SELECT id FROM amendment_payments WHERE id = ${fixture.paymentId} FOR UPDATE NOWAIT
        `;
        if (locked.length > 0) lockAcquired = true;
      });
      return providerResult('pi-probe-lock', 'processing');
    };

    const result = await reconcileSupplementPaymentsBatch(
      { db, provider: adapter },
      { environment: 'TEST' },
    );
    expect(lockAcquired).toBe(true);
    expect(result.projectedCount).toBe(1);
    await probe.end();
  });

  it('claim concurrent utilise SKIP LOCKED et évite les doublons de lease', async () => {
    if (!db || !sql) throw new Error('database unavailable');
    const fixture = await seedFixture(sql, 'skip-locked-batch', {
      holdDeadline: '2099-01-01 12:10:00+00',
      reconcileAfter: '2026-01-01 11:59:00+00',
    });
    const [first, second] = await Promise.all([
      claimSupplementPaymentBatch(db, 1, 'TEST'),
      claimSupplementPaymentBatch(db, 1, 'TEST'),
    ]);
    expect(first.length + second.length).toBe(1);
    expect([first, second].flat().every((row) => row.attemptId === fixture.attemptId)).toBe(true);
  });
});
