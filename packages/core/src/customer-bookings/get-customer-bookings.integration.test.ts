import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { getCustomerBooking, listCustomerBookings } from './get-customer-bookings';

const isSkipped = shouldSkipIntegrationTests();

describe.skipIf(isSkipped)(
  'Chantier 14 — Customer Bookings Read-Model (Intégration PostgreSQL)',
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
        await rawSql`TRUNCATE TABLE product_photos, booking_cancellations, booking_lines, booking_items, bookings, refunds, payment_attempts, payments, booking_drafts, product_variants, products, categories, locations, users, organizations CASCADE`;
      }
    });

    async function createCustomerBookingFixture(options: { split?: boolean } = {}) {
      if (!rawSql) throw new Error('DB non initialisée');
      const marketplaceFeeSnapshot = options.split
        ? {
            ruleVersion: 'split-13-7-v1',
            roundingRule: 'HALF_UP_PER_COMPONENT',
            marketplaceFeeBaseAmountMinor: 7500,
            merchantRateBps: 1300,
            merchantFeeAmountMinor: 975,
            customerRateBps: 700,
            customerServiceFeeAmountMinor: 525,
            customerTotalAmountMinor: 8025,
            merchantNetAmountMinor: 6525,
            platformApplicationFeeAmountMinor: 1500,
          }
        : null;
      const suffix = Math.random().toString(36).slice(2, 10);
      const org = await rawSql`
        INSERT INTO organizations (legal_name, slug)
        VALUES (${'Customer Org ' + suffix}, ${'customer-org-' + suffix})
        RETURNING id, legal_name
      `.then((rows) => rows[0]!);

      const customerA = await rawSql`
        INSERT INTO users (email)
        VALUES (${'customer-a-' + suffix + '@example.com'})
        RETURNING id, email
      `.then((rows) => rows[0]!);

      const customerB = await rawSql`
        INSERT INTO users (email)
        VALUES (${'customer-b-' + suffix + '@example.com'})
        RETURNING id, email
      `.then((rows) => rows[0]!);

      const location = await rawSql`
        INSERT INTO locations (
          organization_id, name, slug, time_zone, operating_currency,
          address_line1, city, postal_code
        ) VALUES (
          ${org.id}, 'Lyon Centre', ${'loc-' + suffix}, 'Europe/Paris', 'EUR',
          '12 rue Carnot', 'Lyon', '69002'
        ) RETURNING id, name
      `.then((rows) => rows[0]!);

      const category = await rawSql`
        INSERT INTO categories (name, slug)
        VALUES (${'Cat ' + suffix}, ${'cat-' + suffix})
        RETURNING id
      `.then((rows) => rows[0]!);

      const product = await rawSql`
        INSERT INTO products (organization_id, category_id, name, slug)
        VALUES (${org.id}, ${category.id}, 'Canyon Roadlite M', ${'canyon-roadlite-' + suffix})
        RETURNING id, name
      `.then((rows) => rows[0]!);

      const variant = await rawSql`
        INSERT INTO product_variants (product_id, name, attributes)
        VALUES (${product.id}, 'Taille M', ${rawSql.json({ size: 'M' })})
        RETURNING id, name
      `.then((rows) => rows[0]!);

      const photo = await rawSql`
        INSERT INTO product_photos (
          organization_id, product_id, storage_key, file_state, sort_order,
          content_type, byte_size, width_px, height_px, checksum_sha256
        ) VALUES (
          ${org.id}, ${product.id}, ${'product-photos/roadlite-' + suffix + '.jpg'}, 'AVAILABLE', 0,
          'image/jpeg', 1024, 800, 600, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        ) RETURNING id, public_id
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
          ${org.id}, ${location.id}, ${customerA.id}, 'CONVERTED',
          '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
          '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00',
          'Europe/Paris', 30, 30, 7500, 0, 7500,
          'NOT_APPLICABLE', 0, NULL, 750, 'DAY', 2, 'EUR',
          ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
        ) RETURNING id
      `.then((rows) => rows[0]!);

      const paymentA = await rawSql`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status, amount_minor, currency,
          tax_status, tax_amount_minor, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, charge_model, settlement_merchant_mode, environment,
          succeeded_at, marketplace_fee_snapshot
        ) VALUES (
          ${org.id}, ${draft.id}, ${customerA.id}, 'SUCCEEDED', ${marketplaceFeeSnapshot ? 8025 : 7500}, 'EUR',
          'NOT_APPLICABLE', 0, 750, 'v1', 'v1',
          ${rawSql.json({ version: 'v1', user_id: customerA.id })},
          'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST'::payment_environment, now(),
          ${marketplaceFeeSnapshot ? rawSql.json(marketplaceFeeSnapshot) : null}
        ) RETURNING id
      `.then((rows) => rows[0]!);

      const bookingA = await rawSql`
        INSERT INTO bookings (
          organization_id, location_id, customer_user_id, draft_id, payment_id,
          status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
          subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
          customer_total_amount_minor, marketplace_fee_snapshot,
          tax_status, tax_amount_minor, commission_amount_minor,
          billable_unit, billable_unit_count, cancellation_policy_snapshot,
          terms_acceptance_snapshot, confirmed_at
        ) VALUES (
          ${org.id}, ${location.id}, ${customerA.id}, ${draft.id}, ${paymentA.id}, 'CONFIRMED',
          '2026-09-10 09:00:00+00', '2026-09-12 18:00:00+00',
          '2026-09-10 08:30:00+00', '2026-09-12 18:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
          7500, 0, 7500, ${marketplaceFeeSnapshot ? 8025 : 7500},
          ${marketplaceFeeSnapshot ? rawSql.json(marketplaceFeeSnapshot) : null},
          'NOT_APPLICABLE', 0, 750, 'DAY', 2,
          ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1' })},
          ${rawSql.json({ version: 'v1', user_id: customerA.id })}, now()
        ) RETURNING id
      `.then((rows) => rows[0]!);

      await rawSql`
        INSERT INTO booking_lines (
          booking_id, variant_id, quantity,
          unit_price_amount_minor, billable_unit_count, line_total_amount_minor,
          variant_snapshot
        ) VALUES (
          ${bookingA.id}, ${variant.id}, 1,
          7500, 2, 7500,
          ${rawSql.json({ name: 'Taille M' })}
        )
      `;

      return {
        org,
        customerA,
        customerB,
        location,
        product,
        variant,
        photo,
        draft,
        paymentA,
        bookingA,
      };
    }

    it('permet au client A de voir sa réservation A et son détail', async () => {
      if (!db) throw new Error('DB non initialisée');
      const fixture = await createCustomerBookingFixture();

      const detail = await getCustomerBooking(db, fixture.customerA.id, fixture.bookingA.id);
      expect(detail).not.toBeNull();
      expect(detail?.id).toBe(fixture.bookingA.id);
      expect(detail?.organizationName).toBe(fixture.org.legal_name);
      expect(detail?.productName).toBe('Canyon Roadlite M');
      expect(detail?.status).toBe('CONFIRMED');
      expect(detail?.heroPhotoUrl).toBe(`/api/public/product-photos/${fixture.photo.public_id}`);
      expect(detail?.locationName).toBe('Lyon Centre');
      expect(detail?.locationAddress).toContain('12 rue Carnot');
      expect(detail?.locationPhone).toBeNull(); // Pas de faux numéro inventé
      expect(detail?.locationInstructions).toBeNull(); // Pas de fausse consigne inventée
      expect(detail?.items).toHaveLength(1);
      expect(detail?.items[0]!.productName).toBe('Canyon Roadlite M');
      expect(detail?.payment?.amountPaidMinor).toBe(7500);
      expect(detail?.payment?.status).toBe('PAID');
      expect(detail?.cancellation.allowed).toBe(true);
    });

    it('masque l’annulation en ligne pour une réservation avec frais marketplace split', async () => {
      if (!db) throw new Error('DB non initialisée');
      const fixture = await createCustomerBookingFixture({ split: true });

      const detail = await getCustomerBooking(db, fixture.customerA.id, fixture.bookingA.id);
      expect(detail).not.toBeNull();
      expect(detail?.cancellation.allowed).toBe(false);
      expect(detail?.cancellation.reasonCode).toBe('SPLIT_REFUND_UNRESOLVED');
    });

    it('vérité paiement fail-closed : si le statut payment n’est pas SUCCEEDED, status est PENDING', async () => {
      if (!db || !rawSql) throw new Error('DB non initialisée');
      const fixture = await createCustomerBookingFixture();

      await rawSql`
        UPDATE payments
        SET status = 'REQUIRES_PAYMENT_METHOD', succeeded_at = NULL
        WHERE id = ${fixture.paymentA.id}
      `;

      const detail = await getCustomerBooking(db, fixture.customerA.id, fixture.bookingA.id);
      expect(detail).not.toBeNull();
      expect(detail?.payment?.status).toBe('PENDING');
      expect(detail?.payment?.paidAt).toBeNull();
    });

    it('IDOR Protection : le client B ne peut JAMAIS charger la réservation du client A', async () => {
      if (!db) throw new Error('DB non initialisée');
      const fixture = await createCustomerBookingFixture();

      // Client B tente d'accéder au booking de Client A -> retourne null (404)
      const detailB = await getCustomerBooking(db, fixture.customerB.id, fixture.bookingA.id);
      expect(detailB).toBeNull();
    });

    it('liste et regroupe correctement les réservations du locataire', async () => {
      if (!db) throw new Error('DB non initialisée');
      const fixture = await createCustomerBookingFixture();

      const groupedA = await listCustomerBookings(db, fixture.customerA.id);
      expect(groupedA.upcoming).toHaveLength(1);
      expect(groupedA.upcoming[0]!.id).toBe(fixture.bookingA.id);
      expect(groupedA.active).toHaveLength(0);
      expect(groupedA.past).toHaveLength(0);

      // Client B a une liste vide
      const groupedB = await listCustomerBookings(db, fixture.customerB.id);
      expect(groupedB.upcoming).toHaveLength(0);
      expect(groupedB.active).toHaveLength(0);
      expect(groupedB.past).toHaveLength(0);
    });
  },
);
