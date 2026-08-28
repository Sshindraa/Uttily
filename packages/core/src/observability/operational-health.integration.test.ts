import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { getOperationalHealth } from './operational-health';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

let orgId: string;
let customerId: string;
let locationId: string;
let draftId: string;
let paymentId: string;
let bookingId: string;
let amendmentId: string;
let amendmentPaymentId: string;
let seedCount = 0;

beforeAll(async () => {
  if (shouldSkipIntegrationTests()) return;
  context = await setupIntegrationTestDb('operational_health');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
  }
});

afterAll(async () => {
  if (db) await db.$client.end();
  if (rawSql) await rawSql.end();
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db || !rawSql) return;

  seedCount++;
  const suffix = `${seedCount}-${Date.now().toString(36)}`;

  await db.execute(
    sql`TRUNCATE TABLE
      notification_deliveries,
      notifications,
      outbox_effects,
      outbox_events,
      refunds,
      amendment_payment_attempts,
      amendment_payments,
      booking_amendments,
      payment_attempts,
      payments,
      bookings,
      booking_drafts,
      locations,
      organizations,
      users
      RESTART IDENTITY CASCADE`,
  );

  const orgRow = await rawSql`
    INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
    VALUES ('Test Org', ${`org-${suffix}`}, true, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  orgId = orgRow.id;

  const userRow = await rawSql`
    INSERT INTO users (email)
    VALUES (${`customer-${suffix}@example.invalid`})
    RETURNING id
  `.then((rows) => rows[0]!);
  customerId = userRow.id;

  const locRow = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgId}, 'Test Location', ${`loc-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  locationId = locRow.id;

  const draftRow = await rawSql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
      billable_unit, billable_unit_count, currency, cancellation_policy_snapshot
    ) VALUES (
      ${orgId}, ${locationId}, ${customerId}, 'CONVERTED',
      '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
      '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00',
      'Europe/Paris', 30, 30, 10000, 0, 10000,
      'NOT_APPLICABLE', 0, NULL, 1000, 'DAY', 2, 'EUR',
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  draftId = draftRow.id;

  const paymentRow = await rawSql`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status,
      amount_minor, currency, tax_status, tax_amount_minor,
      commission_amount_minor, financial_terms_version, legal_terms_version,
      terms_acceptance_snapshot, connected_account_id, charge_model,
      settlement_merchant_mode, environment
    ) VALUES (
      ${orgId}, ${draftId}, ${customerId}, 'PROCESSING', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 1000, 'v1', 'v1',
      ${rawSql.json({ version: 'v1', user_id: customerId, accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  paymentId = paymentRow.id;

  const bookingRow = await rawSql`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id,
      status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, commission_amount_minor,
      currency, cancellation_policy_snapshot, terms_acceptance_snapshot,
      confirmed_at
    ) VALUES (
      ${orgId}, ${locationId}, ${customerId}, ${draftId}, ${paymentId},
      'CONFIRMED', '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
      '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00',
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, 1000,
      'EUR',
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${rawSql.json({ version: 'v1', user_id: customerId, accepted_at: '2026-01-01T00:00:00Z' })},
      now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  bookingId = bookingRow.id;

  const amendmentRow = await rawSql`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at,
      hold_deadline, created_by, financial_snapshot_before, financial_snapshot_after,
      created_at
    ) VALUES (
      ${orgId}, ${bookingId}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
      '2026-09-10 09:00:00+00', '2026-09-13 18:00:00+00',
      '2026-09-10 08:30:00+00', '2026-09-13 18:30:00+00',
      '2026-09-01 10:10:00+00',
      ${customerId},
      ${rawSql.json({ totalAmountMinor: 10000, commissionAmountMinor: 500 })},
      ${rawSql.json({ totalAmountMinor: 12000, supplementAmountMinor: 2000 })},
      '2026-09-01 10:00:00+00'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  amendmentId = amendmentRow.id;

  const amendmentPaymentRow = await rawSql`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id, amount_minor,
      currency, environment, connected_account_id, charge_model, settlement_merchant_mode, status
    ) VALUES (
      ${orgId}, ${bookingId}, ${amendmentId}, ${customerId}, 2000, 'EUR', 'TEST',
      'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  amendmentPaymentId = amendmentPaymentRow.id;
});

describe.skipIf(shouldSkipIntegrationTests())(
  '18.1 — operational health PostgreSQL integration',
  () => {
    describe('Notifications', () => {
      it('classe un pending futur comme OK et non dû', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, scheduled_for
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'PENDING',
          ${crypto.randomUUID()}, now() + interval '1 hour'
        )
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('OK');
        expect(notifSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
          failedCount: 0,
          activeLeaseCount: 0,
          expiredLeaseCount: 0,
        });
      });

      it('laisse un SENDING avec lease actif en état OK', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, scheduled_for, lease_until
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'SENDING',
          ${crypto.randomUUID()}, now() - interval '5 minutes', now() + interval '5 minutes'
        )
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('OK');
        expect(notifSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
          activeLeaseCount: 1,
          expiredLeaseCount: 0,
        });
      });

      it('escalade en Action requise quand une notification est réellement due', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, scheduled_for
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'PENDING',
          ${crypto.randomUUID()}, now() - interval '5 minutes'
        )
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('Action requise');
        expect(notifSignal.counts.dueCount).toBe(1);
      });

      it('escalade en Action requise pour un lease SENDING expiré', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, scheduled_for, lease_until
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'SENDING',
          ${crypto.randomUUID()}, now() - interval '10 minutes', now() - interval '2 minutes'
        )
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('Action requise');
        expect(notifSignal.counts.dueCount).toBe(1);
        expect(notifSignal.counts.expiredLeaseCount).toBe(1);
      });

      it('escalade en Action requise pour FAILED ou requires_manual_review', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, failure_code, requires_manual_review
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'FAILED',
          ${crypto.randomUUID()}, 'MAX_RETRIES_EXCEEDED', true
        )
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('Action requise');
        expect(notifSignal.counts.failedCount).toBe(1);
        expect(notifSignal.counts.manualReviewCount).toBe(1);
      });

      it('ne compte pas une notification SENT ou CANCELLED comme incident', async () => {
        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key
        ) VALUES
          (${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'SENT', ${crypto.randomUUID()}),
          (${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'user@example.invalid', 'CANCELLED', ${crypto.randomUUID()})
      `;

        const health = await getOperationalHealth(db!);
        const notifSignal = health.signals.find((s) => s.key === 'notifications')!;

        expect(notifSignal.status).toBe('OK');
        expect(notifSignal.counts).toMatchObject({
          pendingCount: 0,
          dueCount: 0,
          failedCount: 0,
          manualReviewCount: 0,
        });
      });
    });

    describe('Paiements (Initial + Amendment)', () => {
      it('laisse un paiement non-terminal avec reconcile_after futur en état OK', async () => {
        await rawSql!`
        INSERT INTO payment_attempts (
          id, payment_id, organization_id, attempt_number, status,
          provider_idempotency_key, reconcile_after
        ) VALUES (
          ${crypto.randomUUID()}, ${paymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}, now() + interval '10 minutes'
        )
      `;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('OK');
        expect(paymentSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
          failedCount: 0,
          activeLeaseCount: 0,
        });
      });

      it('unionne les tentatives amendment_payment_attempts avec reconcile_after futur', async () => {
        const attemptId = crypto.randomUUID();
        await rawSql!`
        INSERT INTO amendment_payment_attempts (
          id, amendment_payment_id, organization_id, attempt_number, status,
          provider_idempotency_key, reconcile_after
        ) VALUES (
          ${attemptId}, ${amendmentPaymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}, now() + interval '10 minutes'
        )
      `;
        await rawSql!`UPDATE amendment_payment_attempts SET status = 'PROCESSING' WHERE id = ${attemptId}`;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('OK');
        expect(paymentSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
        });
      });

      it('laisse un lease de réconciliation actif en état OK (non bloqué)', async () => {
        const attemptId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        await rawSql!`
        INSERT INTO payment_attempts (
          id, payment_id, organization_id, attempt_number, status,
          provider_idempotency_key, reconcile_after,
          reconcile_lease_until, reconcile_lease_token
        ) VALUES (
          ${attemptId}, ${paymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}, now() - interval '5 minutes',
          now() + interval '2 minutes', ${leaseToken}
        )
      `;
        await rawSql!`UPDATE payment_attempts SET status = 'PROCESSING' WHERE id = ${attemptId}`;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('OK');
        expect(paymentSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
          activeLeaseCount: 1,
          expiredLeaseCount: 0,
        });
      });

      it('escalade en Action requise pour une tentative initial réellement due (sans lease)', async () => {
        const attemptId = crypto.randomUUID();
        await rawSql!`
        INSERT INTO payment_attempts (
          id, payment_id, organization_id, attempt_number, status,
          provider_idempotency_key, reconcile_after
        ) VALUES (
          ${attemptId}, ${paymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}, now() - interval '5 minutes'
        )
      `;
        await rawSql!`UPDATE payment_attempts SET status = 'REQUIRES_PAYMENT_METHOD' WHERE id = ${attemptId}`;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('Action requise');
        expect(paymentSignal.counts.dueCount).toBe(1);
      });

      it('escalade en Action requise pour une tentative amendment avec lease expiré', async () => {
        const attemptId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        await rawSql!`
        INSERT INTO amendment_payment_attempts (
          id, amendment_payment_id, organization_id, attempt_number, status,
          provider_idempotency_key, reconcile_after,
          reconcile_lease_until, reconcile_lease_token
        ) VALUES (
          ${attemptId}, ${amendmentPaymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}, now() - interval '5 minutes',
          now() - interval '1 minute', ${leaseToken}
        )
      `;
        await rawSql!`UPDATE amendment_payment_attempts SET status = 'REQUIRES_ACTION' WHERE id = ${attemptId}`;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('Action requise');
        expect(paymentSignal.counts.dueCount).toBe(1);
        expect(paymentSignal.counts.expiredLeaseCount).toBe(1);
      });

      it('prouve qu’un ancien FAILED historique résolu ne rend pas la santé rouge indéfiniment', async () => {
        const attemptId1 = crypto.randomUUID();
        const attemptId2 = crypto.randomUUID();

        await rawSql!`
        INSERT INTO payment_attempts (
          id, payment_id, organization_id, attempt_number, status,
          provider_idempotency_key
        ) VALUES (
          ${attemptId1}, ${paymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}
        )
      `;
        await rawSql!`UPDATE payment_attempts SET status = 'FAILED' WHERE id = ${attemptId1}`;

        await rawSql!`
        INSERT INTO amendment_payment_attempts (
          id, amendment_payment_id, organization_id, attempt_number, status,
          provider_idempotency_key
        ) VALUES (
          ${attemptId2}, ${amendmentPaymentId}, ${orgId}, 1, 'PENDING_PROVIDER',
          ${crypto.randomUUID()}
        )
      `;
        await rawSql!`UPDATE amendment_payment_attempts SET status = 'FAILED' WHERE id = ${attemptId2}`;

        const health = await getOperationalHealth(db!);
        const paymentSignal = health.signals.find((s) => s.key === 'paymentReconciliation')!;

        expect(paymentSignal.status).toBe('OK');
        expect(paymentSignal.counts).toMatchObject({
          pendingCount: 0,
          dueCount: 0,
          failedCount: 0,
          manualReviewCount: 0,
        });
      });
    });

    describe('Refunds, Outbox & Transactional Emails', () => {
      it('gère outbox pending non-dû vs dû et lease actif', async () => {
        const leaseToken = crypto.randomUUID();

        await rawSql!`
        INSERT INTO outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, status,
          available_at, idempotency_key
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, 'BOOKING', ${crypto.randomUUID()}, 'BOOKING_CONFIRMED', 'v1',
          '{}', 'PENDING', now() + interval '1 hour', ${crypto.randomUUID()}
        )
      `;

        await rawSql!`
        INSERT INTO outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, status,
          available_at, lease_until, lease_token, idempotency_key
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, 'BOOKING', ${crypto.randomUUID()}, 'BOOKING_CONFIRMED', 'v1',
          '{}', 'PROCESSING', now() - interval '5 minutes', now() + interval '5 minutes', ${leaseToken}, ${crypto.randomUUID()}
        )
      `;

        let health = await getOperationalHealth(db!);
        let outboxSignal = health.signals.find((s) => s.key === 'outbox')!;

        expect(outboxSignal.status).toBe('OK');
        expect(outboxSignal.counts).toMatchObject({
          pendingCount: 2,
          dueCount: 0,
          activeLeaseCount: 1,
        });

        await rawSql!`
        INSERT INTO outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, status,
          available_at, idempotency_key
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, 'BOOKING', ${crypto.randomUUID()}, 'BOOKING_CONFIRMED', 'v1',
          '{}', 'PENDING', now() - interval '5 minutes', ${crypto.randomUUID()}
        )
      `;

        health = await getOperationalHealth(db!);
        outboxSignal = health.signals.find((s) => s.key === 'outbox')!;

        expect(outboxSignal.status).toBe('Action requise');
        expect(outboxSignal.counts.dueCount).toBe(1);
      });

      it('reflète la santé des remboursements (pending non dû, dû, et FAILED_REQUIRES_MANUAL_ACTION)', async () => {
        const refundId = crypto.randomUUID();

        await rawSql!`
        INSERT INTO refunds (
          id, organization_id, payment_id, reason, status, amount_minor, currency,
          provider_idempotency_key, requested_at
        ) VALUES (
          ${refundId}, ${orgId}, ${paymentId}, 'CUSTOMER_CANCELLATION', 'PENDING',
          5000, 'EUR', ${crypto.randomUUID()}, now()
        )
      `;

        await rawSql!`
        INSERT INTO outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, status,
          available_at, idempotency_key
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED', 'v1',
          '{}', 'PENDING', now() + interval '1 hour', ${crypto.randomUUID()}
        )
      `;

        let health = await getOperationalHealth(db!);
        let refundSignal = health.signals.find((s) => s.key === 'refunds')!;

        expect(refundSignal.status).toBe('OK');
        expect(refundSignal.counts).toMatchObject({
          pendingCount: 1,
          dueCount: 0,
          failedCount: 0,
          manualReviewCount: 0,
        });

        const manualRefundId = crypto.randomUUID();
        await rawSql!`
        INSERT INTO refunds (
          id, organization_id, payment_id, reason, status, amount_minor, currency,
          provider_idempotency_key, requested_at
        ) VALUES (
          ${manualRefundId}, ${orgId}, ${paymentId}, 'CUSTOMER_CANCELLATION', 'FAILED_REQUIRES_MANUAL_ACTION',
          5000, 'EUR', ${crypto.randomUUID()}, now()
        )
      `;

        health = await getOperationalHealth(db!);
        refundSignal = health.signals.find((s) => s.key === 'refunds')!;

        expect(refundSignal.status).toBe('Action requise');
        expect(refundSignal.counts.failedCount).toBe(1);
        expect(refundSignal.counts.manualReviewCount).toBe(1);
      });
    });

    describe("Étanchéité des données et absence d'exposition", () => {
      it("ne retourne que des compteurs sûrs et n'expose aucun identifiant ni donnée sensible", async () => {
        const outboxId = crypto.randomUUID();

        await rawSql!`
        INSERT INTO outbox_events (
          id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, status,
          available_at, idempotency_key
        ) VALUES (
          ${outboxId}, ${orgId}, 'BOOKING', ${crypto.randomUUID()}, 'BOOKING_CONFIRMED', 'v1',
          '{"sensitive_token": "SUPER_SECRET_123"}', 'PENDING', now() - interval '1 minute',
          ${crypto.randomUUID()}
        )
      `;

        await rawSql!`
        INSERT INTO notifications (
          organization_id, template, recipient, status, idempotency_key, scheduled_for
        ) VALUES (
          ${orgId}, 'BOOKING_CONFIRMED_CUSTOMER', 'sensitive-customer@domain.invalid', 'PENDING',
          ${crypto.randomUUID()}, now() + interval '1 hour'
        )
      `;

        const health = await getOperationalHealth(db!);
        const serialized = JSON.stringify(health);

        expect(health.readAt).toBeDefined();
        expect(health.signals).toHaveLength(5);

        expect(serialized).not.toContain(orgId);
        expect(serialized).not.toContain(outboxId);
        expect(serialized).not.toContain(draftId);
        expect(serialized).not.toContain(paymentId);
        expect(serialized).not.toContain(amendmentPaymentId);
        expect(serialized).not.toContain('SUPER_SECRET_123');
        expect(serialized).not.toContain('sensitive-customer@domain.invalid');
        expect(serialized).not.toContain('domain.invalid');
        expect(serialized).not.toContain('@');
      });
    });
  },
);
