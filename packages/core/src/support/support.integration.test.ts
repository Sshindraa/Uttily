import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { searchSupport } from './search';
import { getOrganizationSupportDetails } from './organization-support';
import { getBookingSupportDetails } from './booking-support';
import { listNotificationsSupport } from './notification-support';
import { listAuditLogsSupport } from './audit-support';
import { retryNotificationSupport } from './actions/retry-notification';
import { cancelNotificationSupport } from './actions/cancel-notification';
import { resendInvitationNotificationSupport } from './actions/resend-invitation-notification';
import { reconcilePaymentSupport } from './actions/reconcile-payment';

const isSkipped = shouldSkipIntegrationTests();

describe.skipIf(isSkipped)(
  'Chantier 16 — Back-office Uttily & Support V1 (Intégration PostgreSQL)',
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
        await rawSql`
          TRUNCATE TABLE
            audit_log, notifications, booking_cancellations, condition_reports,
            damage_reports, booking_fulfillment_events, booking_items, booking_lines,
            bookings, payment_attempts, payments, booking_draft_lines, booking_drafts,
            organization_payment_accounts, organization_invitations, organization_memberships,
            maintenance_cases, inventory_blocks, inventory_movements, inventory_items,
            product_photos, pricing_plans, product_variants, products,
            location_schedule_exceptions, location_opening_hours, locations,
            organizations, users
            RESTART IDENTITY CASCADE
        `;
      }
    });

    function firstRow<T>(rows: T[]): T {
      const r = rows[0];
      if (!r) throw new Error('Expected at least one row');
      return r;
    }

    async function createFullFixture() {
      if (!rawSql) throw new Error('DB non initialisée');
      const suffix = Math.random().toString(36).slice(2, 10);

      // Support Admin User
      const adminUser = firstRow(
        await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`admin-${suffix}@uttily.com`}, 'Support Agent', true)
        RETURNING id, email
      `,
      );

      // Customer User
      const customerUser = firstRow(
        await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`client-${suffix}@example.com`}, 'Jean Dupont', false)
        RETURNING id, email
      `,
      );

      // Pro Owner User
      const proUser = firstRow(
        await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`pro-${suffix}@location-velos.fr`}, 'Pierre Loueur', false)
        RETURNING id, email
      `,
      );

      // Organization
      const org = firstRow(
        await rawSql<{ id: string; legal_name: string; slug: string }[]>`
        INSERT INTO organizations (legal_name, slug, public_display_name, status)
        VALUES (${`Cycles Alpes ${suffix}`}, ${`cycles-alpes-${suffix}`}, 'Alpes Vélo Expérience', 'ACTIVE')
        RETURNING id, legal_name, slug
      `,
      );

      // Membership
      await rawSql`
        INSERT INTO organization_memberships (organization_id, user_id, role, status)
        VALUES (${org.id}, ${proUser.id}, 'OWNER', 'ACTIVE')
      `;

      // Location
      const location = firstRow(
        await rawSql<{ id: string; name: string; city: string }[]>`
        INSERT INTO locations (organization_id, name, slug, operating_currency, address_line1, city, postal_code, country_code, time_zone, pickup_enabled, geo_point)
        VALUES (${org.id}, 'Boutique Annecy Centre', ${`boutique-annecy-${suffix}`}, 'EUR', '10 Rue du Lac', 'Annecy', '74000', 'FR', 'Europe/Paris', true, ST_SetSRID(ST_MakePoint(6.129384, 45.899247), 4326))
        RETURNING id, name, city
      `,
      );

      // Category
      const catRows = await rawSql<{ id: string }[]>`
        INSERT INTO categories (id, name, slug, is_active)
        VALUES (gen_random_uuid(), ${`Vélos Électriques ${suffix}`}, ${`vae-${suffix}`}, true)
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      const catId =
        catRows[0]?.id ??
        (await rawSql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`)[0]!.id;

      // Product
      const product = firstRow(
        await rawSql<{ id: string; name: string }[]>`
        INSERT INTO products (organization_id, category_id, name, slug, description, publication_status)
        VALUES (${org.id}, ${catId}, 'Moustache Samedi 28', ${`moustache-samedi-28-${suffix}`}, 'Super VAE urbain', 'DRAFT')
        RETURNING id, name
      `,
      );

      // Product Variant
      const variant = firstRow(
        await rawSql<{ id: string; name: string }[]>`
        INSERT INTO product_variants (product_id, name, is_active)
        VALUES (${product.id}, 'Standard Taille M', true)
        RETURNING id, name
      `,
      );

      // Inventory Item
      const item = firstRow(
        await rawSql<{ id: string; internal_sku: string }[]>`
        INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, serial_number, status, condition)
        VALUES (${org.id}, ${variant.id}, ${location.id}, 'VAE-001', 'SN-MOUSTACHE-999', 'ACTIVE', 'NEW')
        RETURNING id, internal_sku
      `,
      );

      // Draft & Booking
      const pickupDate = new Date(Date.now() + 86400000);
      const returnDate = new Date(Date.now() + 86400000 * 3);

      const draft = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, status, pricing_snapshot_version,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, total_amount_minor, billable_unit_count,
          cancellation_policy_snapshot
        )
        VALUES (
          ${org.id}, ${location.id}, ${customerUser.id}, 'CONVERTED', 'legacy-daily-v1',
          ${pickupDate}, ${returnDate}, ${pickupDate}, ${returnDate},
          'Europe/Paris', 30, 30,
          12000, 12000, 2,
          '{"code":"FLEXIBLE"}'::jsonb
        )
        RETURNING id
      `,
      );

      await rawSql`
        INSERT INTO booking_draft_lines (draft_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
        VALUES (${draft.id}, ${variant.id}, 1, 6000, 2, 12000, '{"name":"Standard"}'::jsonb)
      `;

      // Payment
      const payment = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment,
          succeeded_at
        )
        VALUES (
          ${org.id}, ${draft.id}, ${customerUser.id}, 'SUCCEEDED',
          12000, 'EUR', 'NOT_APPLICABLE', 1200,
          'standard-v1', 'standard-v1', '{"accepted":true}'::jsonb,
          'acct_test_123', 'CONNECTED_ACCOUNT', 'TEST',
          now()
        )
        RETURNING id
      `,
      );

      // Payment Attempt
      await rawSql`
        INSERT INTO payment_attempts (
          organization_id, payment_id, attempt_number, status,
          provider_payment_intent_id, provider_idempotency_key, provider_status
        )
        VALUES (
          ${org.id}, ${payment.id}, 1, 'SUCCEEDED',
          ${`pi_test_${suffix}`}, ${`idem_${suffix}`}, 'succeeded'
        )
      `;

      const booking = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO bookings (
          organization_id, location_id, customer_user_id, draft_id, payment_id, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          currency, subtotal_amount_minor, tax_status, commission_amount_minor, total_amount_minor,
          cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
        )
        VALUES (
          ${org.id}, ${location.id}, ${customerUser.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
          ${pickupDate}, ${returnDate}, ${pickupDate}, ${returnDate},
          'Europe/Paris', 30, 30,
          'EUR', 12000, 'NOT_APPLICABLE', 1200, 12000,
          '{"code":"FLEXIBLE"}'::jsonb, '{"accepted":true}'::jsonb, now()
        )
        RETURNING id, status
      `,
      );

      const line = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_lines (booking_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
        VALUES (${booking.id}, ${variant.id}, 1, 6000, 2, 12000, '{"name":"Standard"}'::jsonb)
        RETURNING id
      `,
      );

      const block = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO inventory_blocks (
          organization_id, inventory_item_id, type, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          source_id
        )
        VALUES (
          ${org.id}, ${item.id}, 'BOOKING', 'ACTIVE',
          ${pickupDate}, ${returnDate}, ${pickupDate}, ${returnDate},
          ${booking.id}
        )
        RETURNING id
      `,
      );

      await rawSql`
        INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, booking_block_id)
        VALUES (${booking.id}, ${line.id}, ${item.id}, ${block.id})
      `;

      // Notification FAILED — cas nominal de relance manuelle sous politique fermée V1 :
      // MAX_RETRIES_EXCEEDED avec première tentative provider encore dans la fenêtre
      // d'idempotence (24 h) => relance autorisée avec motif obligatoire.
      const failedNotif = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO notifications (
          organization_id, booking_id, channel, template, recipient,
          status, failure_code, requires_manual_review, attempt_count, idempotency_key,
          provider_first_attempt_started_at
        )
        VALUES (
          ${org.id}, ${booking.id}, 'EMAIL', 'BOOKING_CONFIRMED_CUSTOMER',
          ${customerUser.email}, 'FAILED', 'MAX_RETRIES_EXCEEDED', true, 3,
          ${`booking_confirmed_customer:${booking.id}`},
          now() - interval '2 hours'
        )
        RETURNING id, status
      `,
      );

      return {
        adminUser,
        customerUser,
        proUser,
        org,
        location,
        product,
        variant,
        item,
        draft,
        booking,
        payment,
        paymentIntentId: `pi_test_${suffix}`,
        failedNotif,
      };
    }

    it('exécute la recherche support globale et retrouve les différentes entités', async () => {
      if (!db) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      // 1. Recherche organisation
      const searchOrg = await searchSupport(db, f.org.legal_name);
      expect(searchOrg.totalMatches).toBeGreaterThanOrEqual(1);
      expect(searchOrg.byCategory.organizations.some((o) => o.id === f.org.id)).toBe(true);

      // 2. Recherche réservation par ID exact
      const searchBooking = await searchSupport(db, f.booking.id);
      expect(searchBooking.byCategory.bookings.some((b) => b.id === f.booking.id)).toBe(true);

      // 3. Recherche client par email
      const searchClient = await searchSupport(db, f.customerUser.email);
      expect(searchClient.byCategory.users.some((u) => u.id === f.customerUser.id)).toBe(true);
      expect(searchClient.byCategory.bookings.some((b) => b.id === f.booking.id)).toBe(true);

      // 4. Recherche paiement par Intent Stripe
      const searchPayment = await searchSupport(db, f.paymentIntentId);
      expect(searchPayment.byCategory.payments.some((p) => p.id === f.payment.id)).toBe(true);
    });

    it('charge la fiche organisation support complète avec le statut de readiness et les alertes', async () => {
      if (!db) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const orgDetails = await getOrganizationSupportDetails(db, f.org.id);
      expect(orgDetails.id).toBe(f.org.id);
      expect(orgDetails.legalName).toBe(f.org.legal_name);
      expect(orgDetails.locations).toHaveLength(1);
      expect(orgDetails.locations[0]?.name).toBe('Boutique Annecy Centre');
      expect(orgDetails.members).toHaveLength(1);
      expect(orgDetails.members[0]?.email).toBe(f.proUser.email);
      expect(orgDetails.inventoryOverview.total).toBe(1);
      expect(orgDetails.inventoryOverview.active).toBe(1);
      expect(orgDetails.recentBookings).toHaveLength(1);
      expect(orgDetails.recentBookings[0]?.id).toBe(f.booking.id);
      expect(orgDetails.alerts.failedNotificationsCount).toBe(1);
    });

    it('charge la fiche réservation support avec la timeline et le diagnostic financier', async () => {
      if (!db) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const bookingDetails = await getBookingSupportDetails(db, f.booking.id);
      expect(bookingDetails.id).toBe(f.booking.id);
      expect(bookingDetails.customer.email).toBe(f.customerUser.email);
      expect(bookingDetails.financial.grossPaidMinor).toBe(12000);
      expect(bookingDetails.lines).toHaveLength(1);
      expect(bookingDetails.lines[0]?.allocations).toHaveLength(1);
      expect(bookingDetails.lines[0]?.allocations[0]?.serialNumber).toBe('SN-MOUSTACHE-999');
      expect(bookingDetails.payment?.status).toBe('SUCCEEDED');
      expect(bookingDetails.notifications).toHaveLength(1);
      expect(bookingDetails.notifications[0]?.status).toBe('FAILED');
      expect(bookingDetails.timeline.length).toBeGreaterThanOrEqual(2);
    });

    it('relance une notification en échec (FAILED) et réinitialise son cycle avec trace d’audit complète', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      // 1. Relance de la notification FAILED
      const result = await retryNotificationSupport(db, {
        notificationId: f.failedNotif.id,
        actorUserId: f.adminUser.id,
        reason: 'Client nous a contacté par téléphone',
      });
      expect(result.ok).toBe(true);

      // 2. Vérifier la réinitialisation explicite du cycle
      const updatedNotif = firstRow(
        await rawSql<
          {
            status: string;
            failure_code: string | null;
            failed_at: Date | null;
            requires_manual_review: boolean;
            provider_first_attempt_started_at: Date | null;
            attempt_count: number;
          }[]
        >`
        SELECT status, failure_code, failed_at, requires_manual_review, provider_first_attempt_started_at, attempt_count
        FROM notifications WHERE id = ${f.failedNotif.id}
      `,
      );
      expect(updatedNotif.status).toBe('PENDING');
      expect(updatedNotif.failure_code).toBeNull();
      expect(updatedNotif.failed_at).toBeNull();
      expect(updatedNotif.requires_manual_review).toBe(false);
      expect(updatedNotif.provider_first_attempt_started_at).toBeNull();
      expect(updatedNotif.attempt_count).toBe(0);

      // 3. Vérifier la trace dans audit_log avec les anciennes valeurs
      const auditEntry = firstRow(
        await rawSql<
          {
            action: string;
            target_type: string;
            target_id: string;
            actor_user_id: string;
            metadata: Record<string, unknown>;
          }[]
        >`
        SELECT action, target_type, target_id, actor_user_id, metadata FROM audit_log WHERE target_id = ${f.failedNotif.id}
      `,
      );
      expect(auditEntry.action).toBe('SUPPORT_NOTIFICATION_RETRY');
      expect(auditEntry.target_type).toBe('notification');
      expect(auditEntry.actor_user_id).toBe(f.adminUser.id);
      expect(auditEntry.metadata.reason).toBe('Client nous a contacté par téléphone');
      expect(auditEntry.metadata.previousStatus).toBe('FAILED');
      expect(auditEntry.metadata.previousFailureCode).toBe('MAX_RETRIES_EXCEEDED');
      expect(auditEntry.metadata.previousAttemptCount).toBe(3);

      // 4. Consultation via listAuditLogsSupport
      const auditList = await listAuditLogsSupport(db, { targetId: f.failedNotif.id });
      expect(auditList).toHaveLength(1);
      expect(auditList[0]?.actorEmail).toBe(f.adminUser.email);
    });

    it('refuse catégoriquement de relancer une notification si PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED (anti-doublon)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const uncertainNotif = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO notifications (
          organization_id, booking_id, channel, template, recipient,
          status, failure_code, requires_manual_review, attempt_count, idempotency_key
        )
        VALUES (
          ${f.org.id}, ${f.booking.id}, 'EMAIL', 'BOOKING_CONFIRMED_CUSTOMER',
          ${f.customerUser.email}, 'FAILED', 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED', true, 2,
          'booking_confirmed_customer_uncertain:123'
        )
        RETURNING id
      `,
      );

      await expect(
        retryNotificationSupport(db, {
          notificationId: uncertainNotif.id,
          actorUserId: f.adminUser.id,
          reason: 'Tentative de forçage',
        }),
      ).rejects.toThrow('Relance interdite : la fenêtre d’incertitude du provider est expirée');
    });

    it('refuse de relancer une notification avec statut non-FAILED (SENT, PENDING, CANCELLED)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const sentNotif = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO notifications (
          organization_id, booking_id, channel, template, recipient,
          status, attempt_count, idempotency_key, sent_at
        )
        VALUES (
          ${f.org.id}, ${f.booking.id}, 'EMAIL', 'BOOKING_CONFIRMED_CUSTOMER',
          ${f.customerUser.email}, 'SENT', 1, 'booking_confirmed_customer:sent_123', now()
        )
        RETURNING id
      `,
      );

      await expect(
        retryNotificationSupport(db, {
          notificationId: sentNotif.id,
          actorUserId: f.adminUser.id,
          reason: 'Client demande renvoi',
        }),
      ).rejects.toThrow('Seules les notifications en statut FAILED peuvent être relancées');
    });

    it('annule une notification en attente et consigne l\u2019action dans l\u2019audit', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const result = await cancelNotificationSupport(db, {
        notificationId: f.failedNotif.id,
        actorUserId: f.adminUser.id,
        reason: 'Doublon confirmé par le client',
      });
      expect(result.ok).toBe(true);

      const cancelledNotif = firstRow(
        await rawSql<{ status: string }[]>`
        SELECT status FROM notifications WHERE id = ${f.failedNotif.id}
      `,
      );
      expect(cancelledNotif.status).toBe('CANCELLED');

      const auditEntry = firstRow(
        await rawSql<{ action: string; target_id: string }[]>`
        SELECT action, target_id FROM audit_log WHERE target_id = ${f.failedNotif.id}
      `,
      );
      expect(auditEntry.action).toBe('SUPPORT_NOTIFICATION_CANCEL');
    });

    it('renvoie une notification d\u2019invitation en préservant l\u2019historique et en assurant l\u2019idempotence', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const invitation = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO organization_invitations (organization_id, email, role, token_hash, status, expires_at)
        VALUES (${f.org.id}, 'nouveau-membre@location-velos.fr', 'STAFF', 'hash-fictif', 'PENDING', now() + interval '5 days')
        RETURNING id
      `,
      );

      // Notification initiale historique déjà envoyée (SENT)
      const initialNotif = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO notifications (
          organization_id, channel, template, recipient, status, idempotency_key, sent_at
        )
        VALUES (
          ${f.org.id}, 'EMAIL', 'ORGANIZATION_INVITATION', 'nouveau-membre@location-velos.fr',
          'SENT', ${`invitation:${invitation.id}`}, now()
        )
        RETURNING id, status
      `,
      );

      // UUID stables : un par intention de renvoi (générés côté client en réel, 16.1.1).
      const supportRequestId1 = 'aaaaaaaa-1111-4222-8333-444444444444';
      const supportRequestId2 = 'bbbbbbbb-1111-4222-8333-444444444444';

      // 1. Premier renvoi avec supportRequestId
      const resend1 = await resendInvitationNotificationSupport(db, {
        invitationId: invitation.id,
        actorUserId: f.adminUser.id,
        reason: 'Loueur a redemandé l’invitation',
        supportRequestId: supportRequestId1,
      });
      expect(resend1.ok).toBe(true);
      expect(resend1.notificationId).not.toBe(initialNotif.id);

      // Vérifier que la notification historique initiale est TOUJOURS SENT et inchangée
      const historyNotif = firstRow(
        await rawSql<{ status: string }[]>`
        SELECT status FROM notifications WHERE id = ${initialNotif.id}
      `,
      );
      expect(historyNotif.status).toBe('SENT');

      // Vérifier que la NOUVELLE notification est créée en PENDING
      const newNotif = firstRow(
        await rawSql<
          {
            id: string;
            template: string;
            recipient: string;
            status: string;
            idempotency_key: string;
          }[]
        >`
        SELECT id, template, recipient, status, idempotency_key FROM notifications WHERE id = ${resend1.notificationId}
      `,
      );
      expect(newNotif.template).toBe('ORGANIZATION_INVITATION');
      expect(newNotif.recipient).toBe('nouveau-membre@location-velos.fr');
      expect(newNotif.status).toBe('PENDING');
      expect(newNotif.idempotency_key).toBe(
        `invitation_resend:${invitation.id}:${supportRequestId1}`,
      );

      // 2. Deuxième appel avec le MÊME supportRequestId => Doit retourner la même notification sans créer de doublon
      const resend2 = await resendInvitationNotificationSupport(db, {
        invitationId: invitation.id,
        actorUserId: f.adminUser.id,
        reason: 'Deuxième clic rapide',
        supportRequestId: supportRequestId1,
      });
      expect(resend2.notificationId).toBe(resend1.notificationId);

      const totalNotifsForInvitation = await rawSql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM notifications WHERE recipient = 'nouveau-membre@location-velos.fr'
      `;
      expect(Number(totalNotifsForInvitation[0]?.count)).toBe(2); // L'original SENT + la 1ère nouvelle PENDING

      // Preuve 16.1.1 : même invitationId + supportRequestId => UN SEUL audit (aucun nouvel audit au replay).
      const auditRowsAfterReplay = await rawSql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM audit_log
        WHERE action = 'SUPPORT_INVITATION_NOTIFICATION_RESEND' AND target_id = ${invitation.id}
      `;
      expect(Number(auditRowsAfterReplay[0]?.count)).toBe(1);

      // L'audit unique porte bien le requestId d'intention (UUID non-null) et la notification d'origine.
      const auditEntry = firstRow(
        await rawSql<{ metadata: Record<string, unknown> }[]>`
        SELECT metadata FROM audit_log
        WHERE action = 'SUPPORT_INVITATION_NOTIFICATION_RESEND' AND target_id = ${invitation.id}
      `,
      );
      expect(auditEntry.metadata.supportRequestId).toBe(supportRequestId1);
      expect(auditEntry.metadata.notificationId).toBe(resend1.notificationId);

      // 3. Appel avec un AUTRE supportRequestId => Crée une deuxième notification distincte + un nouvel audit
      const resend3 = await resendInvitationNotificationSupport(db, {
        invitationId: invitation.id,
        actorUserId: f.adminUser.id,
        reason: 'Nouvelle demande explicite le lendemain',
        supportRequestId: supportRequestId2,
      });
      expect(resend3.notificationId).not.toBe(resend1.notificationId);

      const auditRowsAfterNewIntention = await rawSql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM audit_log
        WHERE action = 'SUPPORT_INVITATION_NOTIFICATION_RESEND' AND target_id = ${invitation.id}
      `;
      expect(Number(auditRowsAfterNewIntention[0]?.count)).toBe(2);

      // Vérifier qu'aucun token ou hash secret n'est exposé dans la liste support
      const notifList = await listNotificationsSupport(db, { recipient: 'nouveau-membre' });
      expect(notifList.length).toBeGreaterThanOrEqual(2);
      for (const n of notifList) {
        expect('token' in n).toBe(false);
        expect('tokenHash' in n).toBe(false);
      }
    });

    it('exécute reconcilePaymentSupport de manière atomique et truthful avec PostgreSQL', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      // Créer un draft et un paiement avec une tentative en attente de réponse provider (PENDING_PROVIDER)
      const stuckDraft = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, status, pricing_snapshot_version,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, total_amount_minor, billable_unit_count,
          cancellation_policy_snapshot
        )
        VALUES (
          ${f.org.id}, ${f.location.id}, ${f.customerUser.id}, 'CONVERTED', 'legacy-daily-v1',
          now() + interval '1 day', now() + interval '3 days', now() + interval '1 day', now() + interval '3 days',
          'Europe/Paris', 30, 30,
          12000, 12000, 2,
          '{"code":"FLEXIBLE"}'::jsonb
        )
        RETURNING id
      `,
      );

      const stuckPayment = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment
        )
        VALUES (
          ${f.org.id}, ${stuckDraft.id}, ${f.customerUser.id}, 'PENDING_PROVIDER',
          12000, 'EUR', 'NOT_APPLICABLE', 1200,
          'standard-v1', 'standard-v1', '{"accepted":true}'::jsonb,
          'acct_test_123', 'CONNECTED_ACCOUNT', 'TEST'
        )
        RETURNING id, status
      `,
      );

      const attempt = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO payment_attempts (
          organization_id, payment_id, attempt_number, status,
          provider_payment_intent_id, provider_idempotency_key, provider_status,
          reconcile_after
        )
        VALUES (
          ${f.org.id}, ${stuckPayment.id}, 1, 'PENDING_PROVIDER',
          'pi_stuck_123', 'idem_stuck_123', 'processing',
          now() + interval '1 hour'
        )
        RETURNING id
      `,
      );

      // 1. Réconciliation réussie sur tentative éligible
      const reconcileResult = await reconcilePaymentSupport(db, {
        paymentId: stuckPayment.id,
        actorUserId: f.adminUser.id,
        reason: 'Client en attente, forçage réconciliation immédiate',
      });
      expect(reconcileResult.status).toBe('PENDING_PROVIDER');
      expect(reconcileResult.reconciledCount).toBe(1);

      // Vérifier que la tentative est immédiatement due pour le worker
      const updatedAttempt = firstRow(
        await rawSql<{ reconcile_after: Date }[]>`
        SELECT reconcile_after FROM payment_attempts WHERE id = ${attempt.id}
      `,
      );
      expect(updatedAttempt.reconcile_after.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      // Vérifier l'audit créé
      const auditLogRows = await rawSql<
        { action: string; target_id: string; metadata: Record<string, unknown> }[]
      >`
        SELECT action, target_id, metadata FROM audit_log WHERE target_id = ${stuckPayment.id}
      `;
      expect(auditLogRows).toHaveLength(1);
      expect(auditLogRows[0]?.action).toBe('SUPPORT_PAYMENT_RECONCILE_SCHEDULED');
      expect(auditLogRows[0]?.metadata.reconciledCount).toBe(1);

      // 2. Tentative de réconciliation sur paiement n'ayant aucune tentative éligible (ex: déjà SUCCEEDED)
      await expect(
        reconcilePaymentSupport(db, {
          paymentId: f.payment.id, // f.payment.id n'a qu'une tentative SUCCEEDED
          actorUserId: f.adminUser.id,
          reason: 'Demande sans tentative en cours',
        }),
      ).rejects.toThrow('Aucune tentative de paiement non-terminale éligible');

      // Vérifier qu'aucun faux audit n'a été inséré pour le paiement déjà SUCCEEDED
      const falseAuditRows = await rawSql<{ id: string }[]>`
        SELECT id FROM audit_log WHERE target_id = ${f.payment.id} AND action = 'SUPPORT_PAYMENT_RECONCILE_SCHEDULED'
      `;
      expect(falseAuditRows).toHaveLength(0);
    });

    it('refuse (fencing 16.1.1) de réconcilier une tentative sous lease actif et ne modifie strictement rien', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const fencedDraft = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, status, pricing_snapshot_version,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, total_amount_minor, billable_unit_count,
          cancellation_policy_snapshot
        )
        VALUES (
          ${f.org.id}, ${f.location.id}, ${f.customerUser.id}, 'CONVERTED', 'legacy-daily-v1',
          now() + interval '1 day', now() + interval '3 days', now() + interval '1 day', now() + interval '3 days',
          'Europe/Paris', 30, 30,
          12000, 12000, 2,
          '{"code":"FLEXIBLE"}'::jsonb
        )
        RETURNING id
      `,
      );

      const fencedPayment = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment
        )
        VALUES (
          ${f.org.id}, ${fencedDraft.id}, ${f.customerUser.id}, 'PENDING_PROVIDER',
          12000, 'EUR', 'NOT_APPLICABLE', 1200,
          'standard-v1', 'standard-v1', '{"accepted":true}'::jsonb,
          'acct_test_123', 'CONNECTED_ACCOUNT', 'TEST'
        )
        RETURNING id, status
      `,
      );

      // Tentative sous lease ACTIF (worker de réconciliation en vol) :
      // token + lease_until futur, reconcile_after déjà dû.
      const fencedAttempt = firstRow(
        await rawSql<
          {
            id: string;
            reconcile_after: Date;
            reconcile_lease_token: string;
            reconcile_lease_until: Date;
          }[]
        >`
        INSERT INTO payment_attempts (
          organization_id, payment_id, attempt_number, status,
          provider_payment_intent_id, provider_idempotency_key, provider_status,
          reconcile_after, reconcile_lease_token, reconcile_lease_until
        )
        VALUES (
          ${f.org.id}, ${fencedPayment.id}, 1, 'PENDING_PROVIDER',
          'pi_fenced_123', 'idem_fenced_123', 'processing',
          now() - interval '1 hour',
          'cccccccc-1111-4222-8333-444444444444'::uuid,
          now() + interval '10 minutes'
        )
        RETURNING id, reconcile_after, reconcile_lease_token, reconcile_lease_until
      `,
      );

      // L'action support doit être REFUSÉE : le lease appartient à un worker en vol.
      await expect(
        reconcilePaymentSupport(db, {
          paymentId: fencedPayment.id,
          actorUserId: f.adminUser.id,
          reason: 'Tentative de forçage pendant un worker en vol',
        }),
      ).rejects.toThrow('sous lease de réconciliation actif');

      // lease/token/reconcileAfter strictement inchangés (aucune écriture).
      const afterRefusal = firstRow(
        await rawSql<
          {
            reconcile_after: Date;
            reconcile_lease_token: string;
            reconcile_lease_until: Date;
          }[]
        >`
        SELECT reconcile_after, reconcile_lease_token, reconcile_lease_until
        FROM payment_attempts WHERE id = ${fencedAttempt.id}
      `,
      );
      expect(afterRefusal.reconcile_lease_token).toBe(fencedAttempt.reconcile_lease_token);
      expect(afterRefusal.reconcile_lease_until.getTime()).toBe(
        fencedAttempt.reconcile_lease_until.getTime(),
      );
      expect(afterRefusal.reconcile_after.getTime()).toBe(fencedAttempt.reconcile_after.getTime());

      // Aucun audit mensonger.
      const fencedAuditRows = await rawSql<{ id: string }[]>`
        SELECT id FROM audit_log WHERE target_id = ${fencedPayment.id} AND action = 'SUPPORT_PAYMENT_RECONCILE_SCHEDULED'
      `;
      expect(fencedAuditRows).toHaveLength(0);
    });

    it('réconcilie une tentative dont le lease est expiré, nettoie l’ancien lease et audite (16.1.1)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const staleDraft = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, status, pricing_snapshot_version,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, total_amount_minor, billable_unit_count,
          cancellation_policy_snapshot
        )
        VALUES (
          ${f.org.id}, ${f.location.id}, ${f.customerUser.id}, 'CONVERTED', 'legacy-daily-v1',
          now() + interval '1 day', now() + interval '3 days', now() + interval '1 day', now() + interval '3 days',
          'Europe/Paris', 30, 30,
          12000, 12000, 2,
          '{"code":"FLEXIBLE"}'::jsonb
        )
        RETURNING id
      `,
      );

      const stalePayment = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment
        )
        VALUES (
          ${f.org.id}, ${staleDraft.id}, ${f.customerUser.id}, 'PENDING_PROVIDER',
          12000, 'EUR', 'NOT_APPLICABLE', 1200,
          'standard-v1', 'standard-v1', '{"accepted":true}'::jsonb,
          'acct_test_123', 'CONNECTED_ACCOUNT', 'TEST'
        )
        RETURNING id, status
      `,
      );

      // Lease EXPIRÉ : l'ancien worker est mort, la tentative redevient réconciliable.
      const staleAttempt = firstRow(
        await rawSql<{ id: string; reconcile_lease_token: string; reconcile_lease_until: Date }[]>`
        INSERT INTO payment_attempts (
          organization_id, payment_id, attempt_number, status,
          provider_payment_intent_id, provider_idempotency_key, provider_status,
          reconcile_after, reconcile_lease_token, reconcile_lease_until
        )
        VALUES (
          ${f.org.id}, ${stalePayment.id}, 1, 'PENDING_PROVIDER',
          'pi_stale_lease_123', 'idem_stale_lease_123', 'processing',
          now() + interval '1 hour',
          'dddddddd-1111-4222-8333-444444444444'::uuid,
          now() - interval '5 minutes'
        )
        RETURNING id, reconcile_lease_token, reconcile_lease_until
      `,
      );

      const reconcileResult = await reconcilePaymentSupport(db, {
        paymentId: stalePayment.id,
        actorUserId: f.adminUser.id,
        reason: 'Lease expiré du worker mort, réconciliation sûre',
      });
      expect(reconcileResult.status).toBe('PENDING_PROVIDER');
      expect(reconcileResult.reconciledCount).toBe(1);

      // La tentative est immédiatement éligible : ancien lease nettoyé, due maintenant.
      const afterReconcile = firstRow(
        await rawSql<
          {
            reconcile_after: Date;
            reconcile_lease_token: string | null;
            reconcile_lease_until: Date | null;
          }[]
        >`
        SELECT reconcile_after, reconcile_lease_token, reconcile_lease_until
        FROM payment_attempts WHERE id = ${staleAttempt.id}
      `,
      );
      expect(afterReconcile.reconcile_lease_token).toBeNull();
      expect(afterReconcile.reconcile_lease_until).toBeNull();
      expect(afterReconcile.reconcile_after.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      // Audit présent et truthy.
      const staleAuditRows = await rawSql<{ action: string; metadata: Record<string, unknown> }[]>`
        SELECT action, metadata FROM audit_log WHERE target_id = ${stalePayment.id}
      `;
      expect(staleAuditRows).toHaveLength(1);
      expect(staleAuditRows[0]?.action).toBe('SUPPORT_PAYMENT_RECONCILE_SCHEDULED');
      expect(staleAuditRows[0]?.metadata.reconciledCount).toBe(1);
    });

    it('restaure exactement l’état initial si l’écriture d’audit échoue (preuve de rollback 16.1.1)', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const rollbackDraft = firstRow(
        await rawSql<{ id: string }[]>`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, status, pricing_snapshot_version,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, total_amount_minor, billable_unit_count,
          cancellation_policy_snapshot
        )
        VALUES (
          ${f.org.id}, ${f.location.id}, ${f.customerUser.id}, 'CONVERTED', 'legacy-daily-v1',
          now() + interval '1 day', now() + interval '3 days', now() + interval '1 day', now() + interval '3 days',
          'Europe/Paris', 30, 30,
          12000, 12000, 2,
          '{"code":"FLEXIBLE"}'::jsonb
        )
        RETURNING id
      `,
      );

      const rollbackPayment = firstRow(
        await rawSql<{ id: string; status: string }[]>`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment
        )
        VALUES (
          ${f.org.id}, ${rollbackDraft.id}, ${f.customerUser.id}, 'PENDING_PROVIDER',
          12000, 'EUR', 'NOT_APPLICABLE', 1200,
          'standard-v1', 'standard-v1', '{"accepted":true}'::jsonb,
          'acct_test_123', 'CONNECTED_ACCOUNT', 'TEST'
        )
        RETURNING id, status
      `,
      );

      // Tentative éligible (lease expiré) avec reconcile_after futur et lease/token d'origine.
      const rollbackAttempt = firstRow(
        await rawSql<
          {
            id: string;
            reconcile_after: Date;
            reconcile_lease_token: string;
            reconcile_lease_until: Date;
            updated_at: Date;
          }[]
        >`
        INSERT INTO payment_attempts (
          organization_id, payment_id, attempt_number, status,
          provider_payment_intent_id, provider_idempotency_key, provider_status,
          reconcile_after, reconcile_lease_token, reconcile_lease_until, updated_at
        )
        VALUES (
          ${f.org.id}, ${rollbackPayment.id}, 1, 'PENDING_PROVIDER',
          'pi_rollback_123', 'idem_rollback_123', 'processing',
          now() + interval '2 hours',
          'eeeeeeee-1111-4222-8333-444444444444'::uuid,
          now() - interval '10 minutes',
          now() - interval '15 minutes'
        )
        RETURNING id, reconcile_after, reconcile_lease_token, reconcile_lease_until, updated_at
      `,
      );

      // Provoque une erreur déterministe sur l'écriture d'audit : actor_user_id
      // inexistant => violation FK audit_log_actor_user_id_users_id_fk DANS la
      // transaction, APRÈS l'UPDATE des tentatives => rollback complet.
      const ghostActorId = '00000000-0000-0000-0000-0000000000ff';
      await expect(
        reconcilePaymentSupport(db, {
          paymentId: rollbackPayment.id,
          actorUserId: ghostActorId,
          reason: 'Échec d’audit provoqué pour preuve de rollback',
        }),
      ).rejects.toThrow();

      // Après rollback : reconcile_after, lease et token EXACTEMENT dans leur état initial.
      const afterRollback = firstRow(
        await rawSql<
          {
            reconcile_after: Date;
            reconcile_lease_token: string;
            reconcile_lease_until: Date;
            updated_at: Date;
          }[]
        >`
        SELECT reconcile_after, reconcile_lease_token, reconcile_lease_until, updated_at
        FROM payment_attempts WHERE id = ${rollbackAttempt.id}
      `,
      );
      expect(afterRollback.reconcile_after.getTime()).toBe(
        rollbackAttempt.reconcile_after.getTime(),
      );
      expect(afterRollback.reconcile_lease_token).toBe(rollbackAttempt.reconcile_lease_token);
      expect(afterRollback.reconcile_lease_until.getTime()).toBe(
        rollbackAttempt.reconcile_lease_until.getTime(),
      );
      expect(afterRollback.updated_at.getTime()).toBe(rollbackAttempt.updated_at.getTime());

      // Aucun audit résiduel : la tentative n'a jamais été déclarée réconciliée.
      const rollbackAuditRows = await rawSql<{ id: string }[]>`
        SELECT id FROM audit_log WHERE target_id = ${rollbackPayment.id} AND action = 'SUPPORT_PAYMENT_RECONCILE_SCHEDULED'
      `;
      expect(rollbackAuditRows).toHaveLength(0);
    });
  },
);
