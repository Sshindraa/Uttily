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
      const adminUser = firstRow(await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`admin-${suffix}@uttily.com`}, 'Support Agent', true)
        RETURNING id, email
      `);

      // Customer User
      const customerUser = firstRow(await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`client-${suffix}@example.com`}, 'Jean Dupont', false)
        RETURNING id, email
      `);

      // Pro Owner User
      const proUser = firstRow(await rawSql<{ id: string; email: string }[]>`
        INSERT INTO users (email, display_name, is_platform_admin)
        VALUES (${`pro-${suffix}@location-velos.fr`}, 'Pierre Loueur', false)
        RETURNING id, email
      `);

      // Organization
      const org = firstRow(await rawSql<{ id: string; legal_name: string; slug: string }[]>`
        INSERT INTO organizations (legal_name, slug, public_display_name, status)
        VALUES (${`Cycles Alpes ${suffix}`}, ${`cycles-alpes-${suffix}`}, 'Alpes Vélo Expérience', 'ACTIVE')
        RETURNING id, legal_name, slug
      `);

      // Membership
      await rawSql`
        INSERT INTO organization_memberships (organization_id, user_id, role, status)
        VALUES (${org.id}, ${proUser.id}, 'OWNER', 'ACTIVE')
      `;

      // Location
      const location = firstRow(await rawSql<{ id: string; name: string; city: string }[]>`
        INSERT INTO locations (organization_id, name, slug, operating_currency, address_line1, city, postal_code, country_code, time_zone, pickup_enabled, geo_point)
        VALUES (${org.id}, 'Boutique Annecy Centre', ${`boutique-annecy-${suffix}`}, 'EUR', '10 Rue du Lac', 'Annecy', '74000', 'FR', 'Europe/Paris', true, ST_SetSRID(ST_MakePoint(6.129384, 45.899247), 4326))
        RETURNING id, name, city
      `);

      // Category
      const catRows = await rawSql<{ id: string }[]>`
        INSERT INTO categories (id, name, slug, is_active)
        VALUES (gen_random_uuid(), ${`Vélos Électriques ${suffix}`}, ${`vae-${suffix}`}, true)
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      const catId = catRows[0]?.id ?? (await rawSql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`)[0]!.id;

      // Product
      const product = firstRow(await rawSql<{ id: string; name: string }[]>`
        INSERT INTO products (organization_id, category_id, name, slug, description, publication_status)
        VALUES (${org.id}, ${catId}, 'Moustache Samedi 28', ${`moustache-samedi-28-${suffix}`}, 'Super VAE urbain', 'DRAFT')
        RETURNING id, name
      `);

      // Product Variant
      const variant = firstRow(await rawSql<{ id: string; name: string }[]>`
        INSERT INTO product_variants (product_id, name, is_active)
        VALUES (${product.id}, 'Standard Taille M', true)
        RETURNING id, name
      `);

      // Inventory Item
      const item = firstRow(await rawSql<{ id: string; internal_sku: string }[]>`
        INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, serial_number, status, condition)
        VALUES (${org.id}, ${variant.id}, ${location.id}, 'VAE-001', 'SN-MOUSTACHE-999', 'ACTIVE', 'NEW')
        RETURNING id, internal_sku
      `);

      // Draft & Booking
      const pickupDate = new Date(Date.now() + 86400000);
      const returnDate = new Date(Date.now() + 86400000 * 3);

      const draft = firstRow(await rawSql<{ id: string }[]>`
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
      `);

      await rawSql`
        INSERT INTO booking_draft_lines (draft_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
        VALUES (${draft.id}, ${variant.id}, 1, 6000, 2, 12000, '{"name":"Standard"}'::jsonb)
      `;

      // Payment
      const payment = firstRow(await rawSql<{ id: string }[]>`
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
      `);

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

      const booking = firstRow(await rawSql<{ id: string; status: string }[]>`
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
      `);

      const line = firstRow(await rawSql<{ id: string }[]>`
        INSERT INTO booking_lines (booking_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
        VALUES (${booking.id}, ${variant.id}, 1, 6000, 2, 12000, '{"name":"Standard"}'::jsonb)
        RETURNING id
      `);

      const block = firstRow(await rawSql<{ id: string }[]>`
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
      `);

      await rawSql`
        INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, booking_block_id)
        VALUES (${booking.id}, ${line.id}, ${item.id}, ${block.id})
      `;

      // Notification FAILED
      const failedNotif = firstRow(await rawSql<{ id: string; status: string }[]>`
        INSERT INTO notifications (
          organization_id, booking_id, channel, template, recipient,
          status, failure_code, attempt_count, idempotency_key
        )
        VALUES (
          ${org.id}, ${booking.id}, 'EMAIL', 'BOOKING_CONFIRMED_CUSTOMER',
          ${customerUser.email}, 'FAILED', 'PROVIDER_RATE_LIMIT', 3,
          ${`booking_confirmed_customer:${booking.id}`}
        )
        RETURNING id, status
      `);

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

    it('relance une notification en échec et consigne l\u2019action dans le journal d\u2019audit', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      // 1. Relance de la notification
      const result = await retryNotificationSupport(db, {
        notificationId: f.failedNotif.id,
        actorUserId: f.adminUser.id,
        reason: 'Client nous a contacté par téléphone',
      });
      expect(result.ok).toBe(true);

      // 2. Vérifier que la notification est revenue en PENDING sans failure_code
      const updatedNotif = firstRow(await rawSql<{ status: string; failure_code: string | null; requires_manual_review: boolean }[]>`
        SELECT status, failure_code, requires_manual_review FROM notifications WHERE id = ${f.failedNotif.id}
      `);
      expect(updatedNotif.status).toBe('PENDING');
      expect(updatedNotif.failure_code).toBeNull();
      expect(updatedNotif.requires_manual_review).toBe(false);

      // 3. Vérifier la trace dans audit_log
      const auditEntry = firstRow(await rawSql<{ action: string; target_type: string; target_id: string; actor_user_id: string; metadata: any }[]>`
        SELECT action, target_type, target_id, actor_user_id, metadata FROM audit_log WHERE target_id = ${f.failedNotif.id}
      `);
      expect(auditEntry.action).toBe('SUPPORT_NOTIFICATION_RETRY');
      expect(auditEntry.target_type).toBe('notification');
      expect(auditEntry.actor_user_id).toBe(f.adminUser.id);
      expect(auditEntry.metadata.reason).toBe('Client nous a contacté par téléphone');

      // 4. Consultation via listAuditLogsSupport
      const auditList = await listAuditLogsSupport(db, { targetId: f.failedNotif.id });
      expect(auditList).toHaveLength(1);
      expect(auditList[0]?.actorEmail).toBe(f.adminUser.email);
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

      const cancelledNotif = firstRow(await rawSql<{ status: string }[]>`
        SELECT status FROM notifications WHERE id = ${f.failedNotif.id}
      `);
      expect(cancelledNotif.status).toBe('CANCELLED');

      const auditEntry = firstRow(await rawSql<{ action: string; target_id: string }[]>`
        SELECT action, target_id FROM audit_log WHERE target_id = ${f.failedNotif.id}
      `);
      expect(auditEntry.action).toBe('SUPPORT_NOTIFICATION_CANCEL');
    });

    it('renvoie une notification d\u2019invitation d\u2019équipe sans exposer de secret', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const f = await createFullFixture();

      const invitation = firstRow(await rawSql<{ id: string }[]>`
        INSERT INTO organization_invitations (organization_id, email, role, token_hash, status, expires_at)
        VALUES (${f.org.id}, 'nouveau-membre@location-velos.fr', 'STAFF', 'hash-fictif', 'PENDING', now() + interval '5 days')
        RETURNING id
      `);

      const result = await resendInvitationNotificationSupport(db, {
        invitationId: invitation.id,
        actorUserId: f.adminUser.id,
        reason: 'Loueur a redemandé l’invitation',
      });
      expect(result.ok).toBe(true);

      const notif = firstRow(await rawSql<{ id: string; template: string; recipient: string; status: string }[]>`
        SELECT id, template, recipient, status FROM notifications WHERE idempotency_key = ${`invitation:${invitation.id}`}
      `);
      expect(notif.template).toBe('ORGANIZATION_INVITATION');
      expect(notif.recipient).toBe('nouveau-membre@location-velos.fr');
      expect(notif.status).toBe('PENDING');

      // Vérifier que la liste des notifications ne contient aucun token secret
      const notifList = await listNotificationsSupport(db, { recipient: 'nouveau-membre' });
      expect(notifList).toHaveLength(1);
      expect((notifList[0] as any).token).toBeUndefined();
      expect((notifList[0] as any).tokenHash).toBeUndefined();
    });
  },
);
