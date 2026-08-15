import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { FakeStripeAdapter } from '@uttily/core';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = 'uttily_test_g7m_c5c_act';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

let db: DatabaseClient | null = null;
let sql: Sql | null = null;
let testUrl: string | null = null;

const fakeAdapter = new FakeStripeAdapter({ environment: 'TEST' });

vi.mock('@/lib/db', () => ({
  getDb: () => db,
}));

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => fakeAdapter,
}));

let currentMockUser: { id: string; email: string } | null = null;

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(async () => currentMockUser),
}));

const { initiateSupplementPaymentAction } = await import('./booking-amendments');

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

async function seedFixture(
  client: Sql,
  options?: { createdAt?: Date; holdDeadline?: Date },
): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const org = await client`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'Org ' + suffix}, ${'org-' + suffix}) RETURNING id
  `.then((rows) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Boutique Test', ${'loc-' + suffix}, 'Europe/Paris', 'EUR') RETURNING id, time_zone
  `.then((rows) => rows[0]!);
  const customer = await client`
    INSERT INTO users (email) VALUES (${'customer-' + suffix + '@example.com'}) RETURNING id
  `.then((rows) => rows[0]!);
  const otherCustomer = await client`
    INSERT INTO users (email) VALUES (${'other-' + suffix + '@example.com'}) RETURNING id
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
      '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
      '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', 'Europe/Paris',
      30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500,
      'DAY', 2, ${client.json({ code: 'C5C' })}
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
      'acct_test', 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST', now()
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
      '2026-06-01 09:00:00+00', '2026-06-03 17:00:00+00',
      '2026-06-01 08:30:00+00', '2026-06-03 17:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
      10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 'DAY', 2,
      ${client.json({ code: 'C5C' })}, ${client.json({ accepted: true })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);

  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const createdAt = options?.createdAt ?? new Date(nowMs);
  const holdDeadline = options?.holdDeadline ?? new Date(nowMs + 10 * 60_000);
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
  `.then((rows) => rows[0]!);
  const amendmentPayment = await client`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id, amount_minor,
      currency, environment, connected_account_id, on_behalf_of_account_id,
      charge_model, settlement_merchant_mode, status
    ) VALUES (
      ${org.id}, ${booking.id}, ${amendment.id}, ${customer.id}, 5000, 'EUR', 'TEST',
      'acct_test', 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
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

describe.skipIf(shouldSkip)(
  'initiateSupplementPaymentAction — PostgreSQL réel et FakeStripe',
  () => {
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
      process.env.STRIPE_ENVIRONMENT = 'TEST';
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

    it('1. utilisateur lié seulement → initiation réussie et retour READY + clientSecret', async () => {
      const fixture = await seedFixture(sql!);
      currentMockUser = { id: fixture.customerId, email: 'cust@example.com' };

      const result = await initiateSupplementPaymentAction({
        amendmentId: fixture.amendmentId,
      });

      expect(result.kind).toBe('READY');
      if (result.kind === 'READY') {
        expect(typeof result.clientSecret).toBe('string');
        expect(result.clientSecret.length).toBeGreaterThan(10);
        expect((result as Record<string, unknown>).bookingId).toBeUndefined();
        expect((result as Record<string, unknown>).organizationId).toBeUndefined();
        expect((result as Record<string, unknown>).customerUserId).toBeUndefined();
        expect((result as Record<string, unknown>).amendmentPaymentId).toBeUndefined();
      }
    });

    it('2. autre utilisateur → NOT_FOUND sans fuite', async () => {
      const fixture = await seedFixture(sql!);
      currentMockUser = { id: fixture.otherCustomerId, email: 'other@example.com' };

      const result = await initiateSupplementPaymentAction({
        amendmentId: fixture.amendmentId,
      });

      expect(result).toEqual({
        kind: 'ERROR',
        code: 'NOT_FOUND',
        message: 'Paiement introuvable ou non autorisé.',
      });
    });

    it('3. expiration sans appel provider', async () => {
      const nowMs = Math.floor(Date.now() / 1000) * 1000;
      const createdAt = new Date(nowMs - 15 * 60_000);
      const holdDeadline = new Date(nowMs - 5 * 60_000);

      const fixture = await seedFixture(sql!, { createdAt, holdDeadline });
      currentMockUser = { id: fixture.customerId, email: 'cust@example.com' };

      const result = await initiateSupplementPaymentAction({
        amendmentId: fixture.amendmentId,
      });

      expect(result).toEqual({
        kind: 'ERROR',
        code: 'EXPIRED',
        message: 'Le délai de paiement a expiré.',
      });
    });

    it('4. clientSecret absent de la base, de l outbox et des tables persistées', async () => {
      const fixture = await seedFixture(sql!);
      currentMockUser = { id: fixture.customerId, email: 'cust@example.com' };

      const result = await initiateSupplementPaymentAction({
        amendmentId: fixture.amendmentId,
      });

      expect(result.kind).toBe('READY');
      const clientSecret = (result as Record<string, unknown>).clientSecret;

      const paymentRows = await sql!`
      SELECT * FROM amendment_payments WHERE amendment_id = ${fixture.amendmentId}
    `;
      expect(JSON.stringify(paymentRows)).not.toContain(clientSecret);

      const attemptRows = await sql!`
      SELECT * FROM amendment_payment_attempts WHERE amendment_payment_id = ${fixture.amendmentPaymentId}
    `;
      expect(JSON.stringify(attemptRows)).not.toContain(clientSecret);

      const outboxRows = await sql!`SELECT * FROM outbox_events`;
      expect(JSON.stringify(outboxRows)).not.toContain(clientSecret);
    });
  },
);
