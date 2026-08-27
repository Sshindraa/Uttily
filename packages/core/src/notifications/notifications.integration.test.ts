import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import {
  rescheduleBookingReminders,
  scheduleBookingCancelledNotifications,
  scheduleBookingConfirmedNotifications,
  scheduleRefundConfirmedNotification,
  scheduleRefundActionRequiredNotification,
} from './scheduling';
import { processDueNotifications } from './process-due-notifications';
import { FakeNotificationEmailSender } from './sender';
import { NotificationSendError } from './types';

const isSkipped = shouldSkipIntegrationTests();

describe.skipIf(isSkipped)(
  'Chantier 13.1 — Notifications Delivery Production-Grade (Intégration PostgreSQL)',
  () => {
    let ctx: IntegrationTestContext | null = null;
    let db: DatabaseClient | null = null;
    let rawSql: postgres.Sql | null = null;

    beforeAll(async () => {
      ctx = await setupIntegrationTestDb();
      if (!ctx) throw new Error('Contexte de test PostgreSQL non disponible');
      db = createDatabase(ctx.databaseUrl);
      rawSql = postgres(ctx.databaseUrl);
    });

    afterAll(async () => {
      if (rawSql) await rawSql.end();
      if (db) await db.$client.end();
      if (ctx) await ctx.cleanup();
    });

    beforeEach(async () => {
      if (rawSql) {
        await rawSql`DELETE FROM notifications`;
        await rawSql`DELETE FROM booking_cancellations`;
        await rawSql`DELETE FROM booking_lines`;
        await rawSql`DELETE FROM booking_items`;
        await rawSql`DELETE FROM bookings`;
        await rawSql`DELETE FROM refunds`;
        await rawSql`DELETE FROM payment_attempts`;
        await rawSql`DELETE FROM payments`;
        await rawSql`DELETE FROM booking_drafts`;
      }
    });

    async function createBookingFixture() {
      if (!rawSql) throw new Error('DB non initialisée');
      const suffix = Math.random().toString(36).slice(2, 10);
      const org = await rawSql`
      INSERT INTO organizations (legal_name, slug)
      VALUES (${'Notif Org ' + suffix}, ${'notif-org-' + suffix})
      RETURNING id, legal_name
    `.then((rows) => rows[0]!);

      const ownerUser = await rawSql`
      INSERT INTO users (email)
      VALUES (${'owner-' + suffix + '@example.com'})
      RETURNING id, email
    `.then((rows) => rows[0]!);

      await rawSql`
      INSERT INTO organization_memberships (organization_id, user_id, role)
      VALUES (${org.id}, ${ownerUser.id}, 'OWNER')
    `;

      const customerUser = await rawSql`
      INSERT INTO users (email)
      VALUES (${'customer-' + suffix + '@example.com'})
      RETURNING id, email
    `.then((rows) => rows[0]!);

      const location = await rawSql`
      INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
      VALUES (${org.id}, 'Lyon Centre', ${'notif-loc-' + suffix}, 'Europe/Paris', 'EUR')
      RETURNING id, name
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
        ${org.id}, ${location.id}, ${customerUser.id}, 'CONVERTED',
        '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
        '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00',
        'Europe/Paris', 30, 30, 10000, 0, 10000,
        'NOT_APPLICABLE', 0, NULL, 1000, 'DAY', 2, 'EUR',
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
        ${org.id}, ${draft.id}, ${customerUser.id}, 'SUCCEEDED', 10000, 'EUR',
        'NOT_APPLICABLE', 0, 1000, 'v1', 'v1',
        ${rawSql.json({ version: 'v1', user_id: customerUser.id, accepted_at: '2026-01-01T00:00:00Z' })},
        'acct_notif', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST'::payment_environment, now()
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
        ${org.id}, ${location.id}, ${customerUser.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
        '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
        '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
        10000, 0, 10000, 'NOT_APPLICABLE', 0, NULL, 1000, 'DAY', 2,
        ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
        ${rawSql.json({ version: 'v1', user_id: customerUser.id, accepted_at: '2026-01-01T00:00:00Z' })}, now()
      ) RETURNING id
    `.then((rows) => rows[0]!);

      return {
        org,
        ownerUser,
        customerUser,
        location,
        draft,
        payment,
        booking,
      };
    }

    it('planifie les notifications immédiates et les rappels lors de la confirmation', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const now = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now });

      const rows = await rawSql`
      SELECT template, recipient, status, scheduled_for, idempotency_key
      FROM notifications
      WHERE booking_id = ${fixture.booking.id}
      ORDER BY template ASC
    `;

      expect(rows).toHaveLength(4);

      const customerConfirmed = rows.find((r) => r.template === 'BOOKING_CONFIRMED_CUSTOMER')!;
      expect(customerConfirmed.recipient).toBe(fixture.customerUser.email);
      expect(customerConfirmed.status).toBe('PENDING');

      const merchantConfirmed = rows.find((r) => r.template === 'BOOKING_CONFIRMED_MERCHANT')!;
      expect(merchantConfirmed.recipient).toBe(fixture.ownerUser.email);
      expect(merchantConfirmed.status).toBe('PENDING');

      const pickupReminder = rows.find((r) => r.template === 'PICKUP_REMINDER_CUSTOMER')!;
      expect(pickupReminder.recipient).toBe(fixture.customerUser.email);
      expect(new Date(pickupReminder.scheduled_for).toISOString()).toBe('2026-09-09T09:00:00.000Z');

      const returnReminder = rows.find((r) => r.template === 'RETURN_REMINDER_CUSTOMER')!;
      expect(returnReminder.recipient).toBe(fixture.customerUser.email);
      expect(new Date(returnReminder.scheduled_for).toISOString()).toBe('2026-09-12T16:00:00.000Z');
    });

    it('l’annulation de réservation annule les rappels et crée les notifications d’annulation', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const confirmTime = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now: confirmTime });

      const cancellation = await rawSql`
      INSERT INTO booking_cancellations (
        organization_id, booking_id, cancelled_by_user_id,
        actor_reason, policy_code, policy_snapshot,
        gross_paid_minor, refund_amount_minor, retained_amount_minor,
        original_commission_minor, commission_refunded_minor,
        final_commission_minor, final_merchant_revenue_minor,
        currency, explanation_code, inventory_released
      ) VALUES (
        ${fixture.org.id}, ${fixture.booking.id}, ${fixture.ownerUser.id},
        'MERCHANT_CANCELLATION', 'FLEXIBLE',
        ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1' })},
        10000, 10000, 0, 1000, 1000, 0, 0,
        'EUR', 'FULL_REFUND_MERCHANT', true
      ) RETURNING id
    `.then((rows) => rows[0]!);

      const cancelTime = new Date('2026-09-02T14:00:00Z');
      await scheduleBookingCancelledNotifications(db, fixture.booking.id, cancellation.id, {
        now: cancelTime,
      });

      const rows = await rawSql`
      SELECT template, recipient, status, idempotency_key
      FROM notifications
      WHERE booking_id = ${fixture.booking.id}
      ORDER BY template ASC
    `;

      expect(rows).toHaveLength(6);

      const pickupReminder = rows.find((r) => r.template === 'PICKUP_REMINDER_CUSTOMER')!;
      expect(pickupReminder.status).toBe('CANCELLED');

      const returnReminder = rows.find((r) => r.template === 'RETURN_REMINDER_CUSTOMER')!;
      expect(returnReminder.status).toBe('CANCELLED');
    });

    it('reprend et envoie une notification bloquée après expiration du lease (crash worker)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const now = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now });

      // Simuler un crash pendant l'envoi : la notification est SENDING mais son lease est expiré
      await rawSql`
      UPDATE notifications
      SET status = 'SENDING',
          lease_token = 'stale_token_123',
          lease_until = '2026-09-01 09:59:00+00',
          attempt_count = 1
      WHERE booking_id = ${fixture.booking.id} AND template = 'BOOKING_CONFIRMED_CUSTOMER'
    `;

      const fakeEmailSender = new FakeNotificationEmailSender();
      const result = await processDueNotifications(
        { db, emailSender: fakeEmailSender },
        { now, batchLimit: 10 },
      );

      expect(result.claimedCount).toBe(2); // La notification réclamée expirée + le merchant email
      expect(result.sentCount).toBe(2);

      const updated = await rawSql`
      SELECT status, lease_token, lease_until, provider_message_id
      FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'BOOKING_CONFIRMED_CUSTOMER'
    `;
      expect(updated[0]!.status).toBe('SENT');
      expect(updated[0]!.lease_token).toBeNull();
      expect(updated[0]!.provider_message_id).toBeDefined();
    });

    it('send-time eligibility check : annule le rappel avant envoi si le booking est annulé pendant claim', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const pickupTime = new Date('2026-09-09T09:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, {
        now: new Date('2026-09-01T10:00:00Z'),
      });

      // Marquer la réservation comme CANCELLED
      await rawSql`
      UPDATE bookings
      SET status = 'CANCELLED'
      WHERE id = ${fixture.booking.id}
    `;

      const fakeEmailSender = new FakeNotificationEmailSender();
      // Exécuter à l'heure du rappel de départ
      const result = await processDueNotifications(
        { db, emailSender: fakeEmailSender },
        { now: pickupTime, batchLimit: 10 },
      );

      expect(result.cancelledCount).toBeGreaterThanOrEqual(1);

      const sentPickup = fakeEmailSender.sentEmails.find((e) =>
        e.subject.includes('débute bientôt'),
      );
      expect(sentPickup).toBeUndefined();

      const notifRow = await rawSql`
      SELECT status FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'PICKUP_REMINDER_CUSTOMER'
    `;
      expect(notifRow[0]!.status).toBe('CANCELLED');
    });

    it('rescheduleBookingReminders met à jour les dates des rappels après amendement', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const now = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now });

      // Nouvelles dates (décalage de 3 jours) : 13 sept -> 15 sept
      const newStartAt = new Date('2026-09-13T09:00:00Z');
      const newEndAt = new Date('2026-09-15T18:00:00Z');

      await rescheduleBookingReminders(db, fixture.booking.id, newStartAt, newEndAt, { now });

      const pickupReminder = await rawSql`
      SELECT scheduled_for, status FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'PICKUP_REMINDER_CUSTOMER'
    `.then((rows) => rows[0]!);

      // 13 sept 09:00 - 24h = 12 sept 09:00
      expect(new Date(pickupReminder.scheduled_for).toISOString()).toBe('2026-09-12T09:00:00.000Z');
      expect(pickupReminder.status).toBe('PENDING');

      const returnReminder = await rawSql`
      SELECT scheduled_for, status FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'RETURN_REMINDER_CUSTOMER'
    `.then((rows) => rows[0]!);

      // 15 sept 18:00 - 2h = 15 sept 16:00
      expect(new Date(returnReminder.scheduled_for).toISOString()).toBe('2026-09-15T16:00:00.000Z');
    });

    it('gère les erreurs transitoires avec programmation de retry (next_attempt_at)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const now = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now });

      const fakeEmailSender = new FakeNotificationEmailSender();
      fakeEmailSender.nextError = new NotificationSendError(
        'TRANSIENT',
        'RATE_LIMITED',
        '429 Rate limited',
      );

      const result = await processDueNotifications(
        { db, emailSender: fakeEmailSender },
        { now, batchLimit: 1 },
      );

      expect(result.retriedCount).toBe(1);
      expect(result.sentCount).toBe(0);

      const updated = await rawSql`
      SELECT status, next_attempt_at, failure_code, attempt_count, lease_token
      FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'BOOKING_CONFIRMED_CUSTOMER'
    `;
      expect(updated[0]!.status).toBe('PENDING');
      expect(updated[0]!.next_attempt_at).not.toBeNull();
      expect(updated[0]!.failure_code).toBe('RATE_LIMITED');
      expect(updated[0]!.lease_token).toBeNull();
    });

    it('gère les erreurs déterminites en marquant FAILED immédiatement', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const now = new Date('2026-09-01T10:00:00Z');
      await scheduleBookingConfirmedNotifications(db, fixture.booking.id, { now });

      const fakeEmailSender = new FakeNotificationEmailSender();
      fakeEmailSender.nextError = new NotificationSendError(
        'DETERMINISTIC',
        'INVALID_RECIPIENT',
        'Adresse invalide',
      );

      const result = await processDueNotifications(
        { db, emailSender: fakeEmailSender },
        { now, batchLimit: 1 },
      );

      expect(result.failedCount).toBe(1);
      expect(result.sentCount).toBe(0);

      const updated = await rawSql`
      SELECT status, failure_code, failed_at, lease_token
      FROM notifications
      WHERE booking_id = ${fixture.booking.id} AND template = 'BOOKING_CONFIRMED_CUSTOMER'
    `;
      expect(updated[0]!.status).toBe('FAILED');
      expect(updated[0]!.failure_code).toBe('INVALID_RECIPIENT');
      expect(updated[0]!.failed_at).not.toBeNull();
      expect(updated[0]!.lease_token).toBeNull();
    });

    it('planifie les notifications de remboursement (SUCCEEDED client et FAILED loueur)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createBookingFixture();

      const refund = await rawSql`
        INSERT INTO refunds (
          organization_id, payment_id, reason, status,
          amount_minor, currency, provider_idempotency_key,
          reverse_transfer, refund_application_fee, requested_at
        ) VALUES (
          ${fixture.org.id}, ${fixture.payment.id}, 'MERCHANT_CANCELLATION', 'SUCCEEDED',
          10000, 'EUR', 'refund_notif_test',
          true, true, now()
        ) RETURNING id
      `.then((rows) => rows[0]!);

      await scheduleRefundConfirmedNotification(db, refund.id);

      const customerNotifs = await rawSql`
        SELECT template, recipient, status FROM notifications
        WHERE refund_id = ${refund.id} AND template = 'REFUND_CONFIRMED_CUSTOMER'
      `;
      expect(customerNotifs).toHaveLength(1);
      expect(customerNotifs[0]!.recipient).toBe(fixture.customerUser.email);
      expect(customerNotifs[0]!.status).toBe('PENDING');

      // Test d'échec nécessitant une action
      const failedRefund = await rawSql`
        INSERT INTO refunds (
          organization_id, payment_id, reason, status,
          amount_minor, currency, provider_idempotency_key,
          reverse_transfer, refund_application_fee, requested_at
        ) VALUES (
          ${fixture.org.id}, ${fixture.payment.id}, 'MERCHANT_CANCELLATION', 'FAILED_REQUIRES_MANUAL_ACTION',
          10000, 'EUR', 'refund_notif_fail_test',
          true, true, now()
        ) RETURNING id
      `.then((rows) => rows[0]!);

      await scheduleRefundActionRequiredNotification(db, failedRefund.id, 'account_closed');

      const merchantNotifs = await rawSql`
        SELECT template, recipient, status, failure_code FROM notifications
        WHERE refund_id = ${failedRefund.id} AND template = 'REFUND_ACTION_REQUIRED_MERCHANT'
      `;
      expect(merchantNotifs).toHaveLength(1);
      expect(merchantNotifs[0]!.recipient).toBe(fixture.ownerUser.email);
      expect(merchantNotifs[0]!.failure_code).toBe('account_closed');
    });
  },
);
