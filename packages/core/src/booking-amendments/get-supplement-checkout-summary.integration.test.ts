import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { getSupplementCheckoutSummary } from './get-supplement-checkout-summary';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_g7m_c5c_checkout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)('getSupplementCheckoutSummary — PostgreSQL réel (G7M-C5-C)', () => {
  let db: DatabaseClient | null = null;
  let sql: postgres.Sql | null = null;
  let testUrl: string | null = null;

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

  async function seedFixture(
    s: postgres.Sql,
    opts?: {
      locationTimeZone?: string;
      amendmentStatus?: 'HOLD_PENDING' | 'READY_TO_APPLY' | 'APPLIED' | 'EXPIRED' | 'CANCELLED';
      paymentStatus?:
        | 'PENDING_PROVIDER'
        | 'REQUIRES_PAYMENT_METHOD'
        | 'REQUIRES_ACTION'
        | 'PROCESSING'
        | 'SUCCEEDED'
        | 'FAILED';
      attemptStatus?:
        | 'PENDING_PROVIDER'
        | 'REQUIRES_PAYMENT_METHOD'
        | 'REQUIRES_ACTION'
        | 'PROCESSING'
        | 'SUCCEEDED'
        | 'FAILED';
      providerPaymentIntentId?: string | null;
      providerStatus?: string | null;
    },
  ) {
    const timeZone = opts?.locationTimeZone ?? 'Europe/Paris';
    const amendStatus = opts?.amendmentStatus ?? 'HOLD_PENDING';
    const payStatus = opts?.paymentStatus ?? 'PENDING_PROVIDER';
    const attStatus = opts?.attemptStatus ?? 'PENDING_PROVIDER';
    const provPi = opts?.providerPaymentIntentId ?? null;
    const provStat = opts?.providerStatus ?? null;
    const suffix = Math.random().toString(36).slice(2, 8).toLowerCase();

    const org = await s`
      INSERT INTO organizations (legal_name, slug)
      VALUES (${'Loueur ' + suffix}, ${'org-' + suffix})
      RETURNING id
    `.then((rows) => rows[0]!);

    const loc = await s`
      INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
      VALUES (${org.id as string}, 'Agence Test', ${'loc-' + suffix}, ${timeZone}, 'EUR')
      RETURNING id
    `.then((rows) => rows[0]!);

    const customer = await s`
      INSERT INTO users (email)
      VALUES (${'customer_' + suffix + '@test.com'})
      RETURNING id
    `.then((rows) => rows[0]!);

    const otherCustomer = await s`
      INSERT INTO users (email)
      VALUES (${'other_' + suffix + '@test.com'})
      RETURNING id
    `.then((rows) => rows[0]!);

    const draft = await s`
      INSERT INTO booking_drafts (
        organization_id, location_id, customer_user_id, status,
        customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
        timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
        subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
        tax_status, tax_amount_minor, commission_amount_minor, billable_unit,
        billable_unit_count, cancellation_policy_snapshot
      ) VALUES (
        ${org.id as string}, ${loc.id as string}, ${customer.id as string}, 'DRAFT',
        '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
        '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00',
        ${timeZone === 'Invalid/TimeZone' ? 'UTC' : timeZone},
        30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500,
        'DAY', 2, ${s.json({ code: 'C2' })}
      ) RETURNING id
    `.then((rows) => rows[0]!);

    const initialPayment = await s`
      INSERT INTO payments (
        organization_id, draft_id, customer_user_id, status, amount_minor, currency,
        tax_status, tax_amount_minor, commission_amount_minor, financial_terms_version,
        legal_terms_version, terms_acceptance_snapshot, connected_account_id,
        on_behalf_of_account_id, charge_model, settlement_merchant_mode, environment,
        succeeded_at
      ) VALUES (
        ${org.id as string}, ${draft.id as string}, ${customer.id as string}, 'SUCCEEDED', 10000, 'EUR',
        'NOT_APPLICABLE', 0, 500, 'v1', 'v1', ${s.json({ accepted: true })},
        'acct_c2', 'acct_c2', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST', now()
      ) RETURNING id
    `.then((rows) => rows[0]!);

    const booking = await s`
      INSERT INTO bookings (
        organization_id, location_id, customer_user_id, draft_id, payment_id, status,
        customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, timezone,
        prep_buffer_minutes, cleanup_buffer_minutes, currency, subtotal_amount_minor,
        mandatory_fees_amount_minor, total_amount_minor, tax_status, tax_amount_minor,
        commission_amount_minor, billable_unit, billable_unit_count,
        cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
      ) VALUES (
        ${org.id as string}, ${loc.id as string}, ${customer.id as string}, ${draft.id as string}, ${initialPayment.id as string}, 'CONFIRMED',
        '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
        '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00',
        ${timeZone === 'Invalid/TimeZone' ? 'UTC' : timeZone},
        30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 'DAY', 2,
        ${s.json({ code: 'C2' })}, ${s.json({ accepted: true })}, now()
      ) RETURNING id
    `.then((rows) => rows[0]!);

    const amendment = await s`
      INSERT INTO booking_amendments (
        organization_id, booking_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at,
        new_blocked_end_at, hold_deadline, created_by, created_at
      ) VALUES (
        ${org.id as string}, ${booking.id as string}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
        ${s.json({ totalAmountMinor: 10000, currency: 'EUR' })},
        ${s.json({ totalAmountMinor: 15000, currency: 'EUR' })},
        '2026-06-01 09:00:00+00', '2026-06-04 17:00:00+00',
        '2026-06-01 08:30:00+00', '2026-06-04 17:30:00+00',
        now() + interval '10 minutes', ${customer.id as string}, now()
      ) RETURNING id, hold_deadline
    `.then((rows) => rows[0]!);

    if (amendStatus === 'EXPIRED') {
      await s`
        UPDATE booking_amendments
        SET status = 'EXPIRED', expired_at = now()
        WHERE id = ${amendment.id as string}
      `;
    } else if (amendStatus === 'CANCELLED') {
      await s`
        UPDATE booking_amendments
        SET status = 'CANCELLED', cancelled_at = now()
        WHERE id = ${amendment.id as string}
      `;
    } else if (amendStatus === 'READY_TO_APPLY') {
      await s`
        UPDATE booking_amendments
        SET status = 'READY_TO_APPLY'
        WHERE id = ${amendment.id as string}
      `;
    } else if (amendStatus === 'APPLIED') {
      await s`
        UPDATE booking_amendments
        SET status = 'READY_TO_APPLY'
        WHERE id = ${amendment.id as string}
      `;
      await s`
        UPDATE booking_amendments
        SET status = 'APPLIED', applied_at = now()
        WHERE id = ${amendment.id as string}
      `;
    }

    const payment = await s`
      INSERT INTO amendment_payments (
        organization_id, booking_id, amendment_id, customer_user_id,
        amount_minor, currency, environment, connected_account_id,
        charge_model, settlement_merchant_mode, status
      ) VALUES (
        ${org.id as string}, ${booking.id as string}, ${amendment.id as string}, ${customer.id as string},
        5000, 'EUR', 'TEST', 'acct_test123',
        'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
      ) RETURNING id
    `.then((rows) => rows[0]!);

    const attempt = await s`
      INSERT INTO amendment_payment_attempts (
        organization_id, amendment_payment_id, attempt_number,
        status, provider_payment_intent_id, provider_status,
        provider_idempotency_key
      ) VALUES (
        ${org.id as string}, ${payment.id as string}, 1,
        'PENDING_PROVIDER', NULL, NULL,
        ${'amendment_payment_attempt_' + (payment.id as string) + '_1'}
      ) RETURNING id
    `.then((rows) => rows[0]!);

    if (provPi || provStat || attStatus !== 'PENDING_PROVIDER') {
      await s`
        UPDATE amendment_payment_attempts
        SET status = ${attStatus},
            provider_payment_intent_id = ${provPi},
            provider_status = ${provStat}
        WHERE id = ${attempt.id as string}
      `;
    }

    if (payStatus !== 'PENDING_PROVIDER') {
      if (payStatus === 'SUCCEEDED') {
        await s`
          UPDATE amendment_payments
          SET status = ${payStatus},
              succeeded_at = now()
          WHERE id = ${payment.id as string}
        `;
      } else {
        await s`
          UPDATE amendment_payments
          SET status = ${payStatus}
          WHERE id = ${payment.id as string}
        `;
      }
    }

    return {
      orgId: org.id as string,
      locId: loc.id as string,
      customerId: customer.id as string,
      otherCustomerId: otherCustomer.id as string,
      bookingId: booking.id as string,
      amendmentId: amendment.id as string,
      amendmentPaymentId: payment.id as string,
      attemptId: attempt.id as string,
      holdDeadline: new Date(amendment.hold_deadline as string | Date),
      locationTimeZone: timeZone,
    };
  }

  it('1. PENDING_PROVIDER sans données provider → PAYABLE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);
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
      timeZone: 'Europe/Paris',
    });
  });

  it('2. PENDING_PROVIDER avec données provider → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'PENDING_PROVIDER',
      attemptStatus: 'PENDING_PROVIDER',
      providerPaymentIntentId: 'pi_unexpected_123',
      providerStatus: 'requires_payment_method',
    });
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );

    expect(result).toEqual({ kind: 'INVALID_STATE' });
  });

  it('3. REQUIRES_PAYMENT_METHOD cohérent → PAYABLE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'REQUIRES_PAYMENT_METHOD',
      attemptStatus: 'REQUIRES_PAYMENT_METHOD',
      providerPaymentIntentId: 'pi_method_123',
      providerStatus: 'requires_payment_method',
    });
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
      timeZone: 'Europe/Paris',
    });
  });

  it('4. REQUIRES_ACTION cohérent → PAYABLE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'REQUIRES_ACTION',
      attemptStatus: 'REQUIRES_ACTION',
      providerPaymentIntentId: 'pi_action_123',
      providerStatus: 'requires_action',
    });
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
      timeZone: 'Europe/Paris',
    });
  });

  it('5. REQUIRES_ACTION sans PaymentIntent ou avec providerStatus différent → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'REQUIRES_ACTION',
      attemptStatus: 'REQUIRES_ACTION',
      providerPaymentIntentId: null,
      providerStatus: null,
    });
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );

    expect(result).toEqual({ kind: 'INVALID_STATE' });
  });

  it('6. PROCESSING sans provider → PROCESSING', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'PROCESSING',
      attemptStatus: 'PROCESSING',
      providerPaymentIntentId: null,
      providerStatus: null,
    });
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );

    expect(result).toEqual({ kind: 'PROCESSING' });
  });

  it('7. PROCESSING avec provider requires_payment_method / requires_action → PAYABLE (reprise)', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      paymentStatus: 'PROCESSING',
      attemptStatus: 'PROCESSING',
      providerPaymentIntentId: 'pi_test_reprise_123',
      providerStatus: 'requires_payment_method',
    });
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
      timeZone: 'Europe/Paris',
    });
  });

  it('8. EXPIRED même avec paiement SUCCEEDED → EXPIRED', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      amendmentStatus: 'EXPIRED',
      paymentStatus: 'SUCCEEDED',
      attemptStatus: 'SUCCEEDED',
      providerPaymentIntentId: 'pi_late_123',
      providerStatus: 'succeeded',
    });

    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: fixture.customerId,
    });

    expect(result).toEqual({ kind: 'EXPIRED' });
  });

  it('9. HOLD_PENDING avec payment.status SUCCEEDED → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      amendmentStatus: 'HOLD_PENDING',
      paymentStatus: 'SUCCEEDED',
      attemptStatus: 'SUCCEEDED',
      providerPaymentIntentId: 'pi_test_123',
      providerStatus: 'succeeded',
    });
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );

    expect(result).toEqual({ kind: 'INVALID_STATE' });
  });

  it('10. APPLIED avec payment et attempt SUCCEEDED cohérents → PAID', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      amendmentStatus: 'APPLIED',
      paymentStatus: 'SUCCEEDED',
      attemptStatus: 'SUCCEEDED',
      providerPaymentIntentId: 'pi_terminal_123',
      providerStatus: 'succeeded',
    });

    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: fixture.customerId,
    });

    expect(result).toEqual({ kind: 'PAID' });
  });

  it('11. APPLIED sans tentative SUCCEEDED cohérente → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, {
      amendmentStatus: 'APPLIED',
      paymentStatus: 'SUCCEEDED',
      attemptStatus: 'FAILED',
      providerPaymentIntentId: null,
      providerStatus: null,
    });

    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: fixture.customerId,
    });

    expect(result).toEqual({ kind: 'INVALID_STATE' });
  });

  it('12. zéro attempt actif ou attempt terminal seul pour HOLD_PENDING → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    await s`DELETE FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;

    const resZero = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );
    expect(resZero).toEqual({ kind: 'INVALID_STATE' });

    await s`
      INSERT INTO amendment_payment_attempts (
        organization_id, amendment_payment_id, attempt_number,
        status, provider_idempotency_key
      ) VALUES
      (${fixture.orgId}, ${fixture.amendmentPaymentId}, 1, 'PENDING_PROVIDER', 'key_terminal')
    `;
    await s`
      UPDATE amendment_payment_attempts
      SET status = 'FAILED'
      WHERE amendment_payment_id = ${fixture.amendmentPaymentId}
    `;

    const resTerminalOnly = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );
    expect(resTerminalOnly).toEqual({ kind: 'INVALID_STATE' });
  });

  it('13. timezone IANA différent de Paris préservé exactement', async () => {
    const s = sql!;
    const fixture = await seedFixture(s, { locationTimeZone: 'America/New_York' });
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
      timeZone: 'America/New_York',
    });
  });

  it('14. timezone invalide → INVALID_STATE', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);
    await s`UPDATE locations SET time_zone = 'Invalid/TimeZone' WHERE id = ${fixture.locId}`;
    const asOf = new Date(fixture.holdDeadline.getTime() - 5 * 60_000);

    const result = await getSupplementCheckoutSummary(
      db!,
      { amendmentId: fixture.amendmentId, customerUserId: fixture.customerId },
      { asOf },
    );
    expect(result).toEqual({ kind: 'INVALID_STATE' });
  });

  it('15. autre utilisateur → aucune fuite (NOT_FOUND)', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);
    const result = await getSupplementCheckoutSummary(db!, {
      amendmentId: fixture.amendmentId,
      customerUserId: fixture.otherCustomerId,
    });
    expect(result).toEqual({ kind: 'NOT_FOUND' });
  });

  it('16. limite exacte asOf === holdDeadline expirée (EXPIRED)', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);

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

  it('17. zéro écriture du read model prouvé par comptage des tables', async () => {
    const s = sql!;
    const fixture = await seedFixture(s);
    const asOf = new Date(fixture.holdDeadline.getTime() - 60_000);

    const getCounts = async () => {
      const rows = await s`
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
