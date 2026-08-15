import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { getSupplementCheckoutSummary } from './get-supplement-checkout-summary';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = 'uttily_test_g7m_c5c_sum';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

let db: DatabaseClient | null = null;
let sql: Sql | null = null;
let testUrl: string | null = null;

interface Fixture {
  orgId: string;
  locationId: string;
  locationTimeZone: string;
  customerId: string;
  otherCustomerId: string;
  bookingId: string;
  amendmentId: string;
  amendmentPaymentId: string;
  amendmentPaymentAttemptId: string;
  holdDeadline: Date;
}

async function seedFixture(client: Sql): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const org = await client`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'Org ' + suffix}, ${'org-' + suffix}) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Boutique Test', ${'loc-' + suffix}, 'Europe/Paris', 'EUR') RETURNING id, time_zone
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
  const customer = await client`
    INSERT INTO users (email) VALUES (${'customer-' + suffix + '@example.com'}) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
  const otherCustomer = await client`
    INSERT INTO users (email) VALUES (${'other-' + suffix + '@example.com'}) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);

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
      '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
      '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', 'Europe/Paris',
      30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500,
      'DAY', 2, ${client.json({ code: 'C5C' })}
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
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
      'acct_test', 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST', now()
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
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
      '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
      '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
      10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 'DAY', 2,
      ${client.json({ code: 'C5C' })}, ${client.json({ accepted: true })}, now()
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);

  const createdAt = new Date('2026-06-01T10:00:00.000Z');
  const holdDeadline = new Date('2026-06-01T10:10:00.000Z');
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
      '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
      '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', ${holdDeadline}, ${customer.id},
      ${createdAt}
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
  const amendmentPayment = await client`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id, amount_minor,
      currency, environment, connected_account_id, on_behalf_of_account_id,
      charge_model, settlement_merchant_mode, status
    ) VALUES (
      ${org.id}, ${booking.id}, ${amendment.id}, ${customer.id}, 5000, 'EUR', 'TEST',
      'acct_test', 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);
  const attempt = await client`
    INSERT INTO amendment_payment_attempts (
      organization_id, amendment_payment_id, attempt_number, status,
      provider_idempotency_key
    ) VALUES (
      ${org.id}, ${amendmentPayment.id}, 1, 'PENDING_PROVIDER',
      ${'pi_amendment_' + amendmentPayment.id + '_1'}
    ) RETURNING id
  `.then((rows: Record<string, unknown>[]) => rows[0]!);

  return {
    orgId: String(org.id),
    locationId: String(location.id),
    locationTimeZone: String(location.time_zone),
    customerId: String(customer.id),
    otherCustomerId: String(otherCustomer.id),
    bookingId: String(booking.id),
    amendmentId: String(amendment.id),
    amendmentPaymentId: String(amendmentPayment.id),
    amendmentPaymentAttemptId: String(attempt.id),
    holdDeadline,
  };
}

describe.skipIf(shouldSkip)('getSupplementCheckoutSummary — PostgreSQL réel', () => {
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
    sql = postgres(testUrl, { max: 5 });
    db = createDatabase(testUrl);
  });

  afterAll(async () => {
    if (db) await db.$client.end();
    if (sql) await sql.end();
    if (sourceUrl) {
      const admin = postgres(sourceUrl, { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
      await admin.end();
    }
  });

  it('1. client lié → PAYABLE avec montant, devise, échéance et fuseau', async () => {
    const fixture = await seedFixture(sql!);
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );

    expect(result).toEqual({
      kind: 'PAYABLE',
      amountMinor: 5000,
      currency: 'EUR',
      holdDeadline: fixture.holdDeadline.toISOString(),
      timeZone: fixture.locationTimeZone,
    });
  });

  it('2. autre utilisateur → aucune fuite (NOT_FOUND)', async () => {
    const fixture = await seedFixture(sql!);
    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: fixture.otherCustomerId,
    });
    expect(result).toEqual({ kind: 'NOT_FOUND' });
  });

  it('3. autre tenant → aucune fuite (NOT_FOUND)', async () => {
    const fixture = await seedFixture(sql!);
    const randomUser = '99999999-9999-4999-8999-999999999999';
    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: randomUser,
    });
    expect(result).toEqual({ kind: 'NOT_FOUND' });
  });

  it('4. amendement non-SUPPLEMENT refusé (NOT_FOUND)', async () => {
    const fixture = await seedFixture(sql!);
    // Passer l'amendement initial à CANCELLED pour clore l'amendement actif
    await sql!`UPDATE booking_amendments SET status = 'CANCELLED', cancelled_at = now() WHERE id = ${fixture.amendmentId}`;

    const neutralAmendment = await sql!`
      INSERT INTO booking_amendments (
        organization_id, booking_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at,
        new_blocked_end_at, hold_deadline, created_by, created_at
      ) VALUES (
        ${fixture.orgId}, ${fixture.bookingId}, 2, 'NEUTRAL', 'READY_TO_APPLY',
        ${sql!.json({ totalAmountMinor: 10000, currency: 'EUR' })},
        ${sql!.json({ totalAmountMinor: 10000, currency: 'EUR' })},
        '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
        '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', NULL, ${fixture.customerId},
        now()
      ) RETURNING id
    `.then((rows: Record<string, unknown>[]) => rows[0]!);

    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: neutralAmendment.id,
      customerUserId: fixture.customerId,
    });
    expect(result).toEqual({ kind: 'NOT_FOUND' });
  });

  it('5. limite exacte asOf === holdDeadline expirée (EXPIRED)', async () => {
    const fixture = await seedFixture(sql!);

    const resultExact = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf: fixture.holdDeadline },
    );
    expect(resultExact).toEqual({ kind: 'EXPIRED' });

    const resultAfter = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf: new Date(fixture.holdDeadline.getTime() + 1000) },
    );
    expect(resultAfter).toEqual({ kind: 'EXPIRED' });
  });

  it('6. états du cycle de vie : HOLD_PENDING, READY_TO_APPLY, APPLIED, EXPIRED, CANCELLED, FAILED', async () => {
    const beforeDeadline = new Date('2026-06-01T10:05:00.000Z');

    // READY_TO_APPLY → PAID
    const fix1 = await seedFixture(sql!);
    await sql!`UPDATE booking_amendments SET status = 'READY_TO_APPLY' WHERE id = ${fix1.amendmentId}`;
    const resReady = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fix1.amendmentId, customerUserId: fix1.customerId },
      { asOf: beforeDeadline },
    );
    expect(resReady).toEqual({ kind: 'PAID' });

    // APPLIED → PAID
    const fix2 = await seedFixture(sql!);
    await sql!`UPDATE booking_amendments SET status = 'READY_TO_APPLY' WHERE id = ${fix2.amendmentId}`;
    await sql!`UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${fix2.amendmentId}`;
    const resApplied = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fix2.amendmentId, customerUserId: fix2.customerId },
      { asOf: beforeDeadline },
    );
    expect(resApplied).toEqual({ kind: 'PAID' });

    // EXPIRED → EXPIRED
    const fix3 = await seedFixture(sql!);
    await sql!`UPDATE booking_amendments SET status = 'EXPIRED', expired_at = now() WHERE id = ${fix3.amendmentId}`;
    const resExpired = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fix3.amendmentId, customerUserId: fix3.customerId },
      { asOf: beforeDeadline },
    );
    expect(resExpired).toEqual({ kind: 'EXPIRED' });

    // CANCELLED → INVALID_STATE
    const fix4 = await seedFixture(sql!);
    await sql!`UPDATE booking_amendments SET status = 'CANCELLED', cancelled_at = now() WHERE id = ${fix4.amendmentId}`;
    const resCancelled = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fix4.amendmentId, customerUserId: fix4.customerId },
      { asOf: beforeDeadline },
    );
    expect(resCancelled).toEqual({ kind: 'INVALID_STATE' });

    // FAILED → INVALID_STATE
    const fix5 = await seedFixture(sql!);
    await sql!`UPDATE booking_amendments SET status = 'READY_TO_APPLY' WHERE id = ${fix5.amendmentId}`;
    await sql!`UPDATE booking_amendments SET status = 'FAILED', failed_at = now() WHERE id = ${fix5.amendmentId}`;
    const resFailed = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fix5.amendmentId, customerUserId: fix5.customerId },
      { asOf: beforeDeadline },
    );
    expect(resFailed).toEqual({ kind: 'INVALID_STATE' });
  });

  it('7. tuple payment/attempt incohérent → INVALID_STATE', async () => {
    const fixture = await seedFixture(sql!);
    const beforeDeadline = new Date(fixture.holdDeadline.getTime() - 60_000);

    await sql!`DELETE FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
    await sql!`DELETE FROM amendment_payments WHERE amendment_id = ${fixture.amendmentId}`;

    const resNoPayment = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf: beforeDeadline },
    );
    expect(resNoPayment).toEqual({ kind: 'INVALID_STATE' });
  });

  it('8. zéro écriture du read model prouvé par comptage des tables', async () => {
    const fixture = await seedFixture(sql!);
    const asOf = new Date(fixture.holdDeadline.getTime() - 60_000);

    const getCounts = async () => {
      const rows = await sql!`
        SELECT
          (SELECT count(*)::int FROM booking_amendments) AS ba_count,
          (SELECT count(*)::int FROM amendment_payments) AS ap_count,
          (SELECT count(*)::int FROM amendment_payment_attempts) AS apa_count,
          (SELECT count(*)::int FROM bookings) AS b_count,
          (SELECT count(*)::int FROM inventory_blocks) AS ib_count,
          (SELECT count(*)::int FROM outbox_events) AS oe_count,
          (SELECT count(*)::int FROM idempotency_records) AS ik_count
      `;
      return rows[0]!;
    };

    const countsBefore = await getCounts();

    await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );
    await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.otherCustomerId },
      { asOf },
    );
    await getSupplementCheckoutSummary(
      db!,
      { amendmentId: '99999999-9999-4999-8999-999999999999', customerUserId: fixture.customerId },
      { asOf },
    );

    const countsAfter = await getCounts();
    expect(countsAfter).toEqual(countsBefore);
  });
});
