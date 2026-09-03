import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';
import { createCounterBooking } from '../fulfillment/create-counter-booking';
import { prepareBooking } from '../fulfillment/prepare-booking';
import { pickupBooking } from '../fulfillment/pickup-booking';
import { returnBooking } from '../fulfillment/return-booking';
import { closeBooking } from '../fulfillment/close-booking';
import { substituteBookingItem } from '../fulfillment/substitute-booking-item';
import { createConditionReport } from '../fulfillment/create-condition-report';
import { createDamageReport } from '../fulfillment/create-damage-report';
import { getMerchantFinanceOverview } from '../finances/get-merchant-finance-overview';
import { generateCommissionStatementCsv } from '../finances/commission-statement';
import { buildPersonalDataCopy, buildPortableData } from '../privacy';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('saturday_drill');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
  }
});

afterAll(async () => {
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db) return;
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      privacy_requests, condition_reports, damage_reports,
      booking_fulfillment_events, outbox_events, audit_log,
      booking_items, booking_lines, inventory_blocks,
      payments, bookings, booking_draft_lines, booking_drafts,
      allocations, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships,
      organizations, users, idempotency_records, maintenance_cases
      RESTART IDENTITY CASCADE`,
  );
});

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

interface SaturdayDrillFixture {
  organizationId: string;
  locationId: string;
  operatorId: string;
  clientAId: string;
  clientBId: string;
  variantId: string;
  item1Id: string;
  item1Sku: string;
  item2Id: string;
  item2Sku: string;
  item3Id: string;
  item3Sku: string;
  item4Id: string;
  item4Sku: string;
  item5Id: string;
  item5Sku: string;
}

async function seedSaturdayShop(suffix = SUFFIX()): Promise<SaturdayDrillFixture> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;

  // 1. Organisation partenaire loueur avec mentions légales obligatoires (Lot 21-O1)
  const org = (
    await sql`
    INSERT INTO organizations (
      legal_name, slug, default_cancellation_policy_code,
      legal_form, registration_number, vat_number, registry_city,
      registered_office_address, registered_office_postal_code, registered_office_city
    ) VALUES (
      ${'Alpes Cycles Pro ' + suffix},
      ${'alpes-cycles-' + suffix},
      'FLEXIBLE',
      'SAS',
      '84920485900012',
      'FR12849204859',
      'Annecy',
      '12 avenue du Lac',
      '74000',
      'Annecy'
    ) RETURNING id
  `
  )[0]!;

  // 2. Établissement physique à Annecy (Europe/Paris)
  const loc = (
    await sql`
    INSERT INTO locations (
      organization_id, name, slug, time_zone,
      prep_buffer_minutes, cleanup_buffer_minutes, operating_currency,
      address_line1, city, postal_code, country_code
    ) VALUES (
      ${org.id}, 'Boutique Annecy Centre', ${'annecy-' + suffix}, 'Europe/Paris',
      15, 15, 'EUR',
      '12 avenue du Lac', 'Annecy', '74000', 'FR'
    ) RETURNING id
  `
  )[0]!;

  // 3. Horaires d'ouverture du samedi (08:30 à 19:30, weekday 6 = Samedi)
  await sql`
    INSERT INTO location_opening_hours (location_id, weekday, open_time, close_time)
    VALUES (${loc.id}, 6, '08:30', '19:30')
  `;

  // 4. Utilisateurs : Opérateur comptoir, Client A, Client B
  const op = (
    await sql`
    INSERT INTO users (email, display_name, oidc_subject, oidc_provider)
    VALUES (${'operator-' + suffix + '@alpescycles.fr'}, 'Marc Opérateur', ${'oidc-op-' + suffix}, 'clerk')
    RETURNING id
  `
  )[0]!;
  await sql`
    INSERT INTO organization_memberships (organization_id, user_id, role)
    VALUES (${org.id}, ${op.id}, 'STAFF')
  `;

  const clientA = (
    await sql`
    INSERT INTO users (email, display_name, oidc_subject, oidc_provider)
    VALUES (${'alice-' + suffix + '@example.com'}, 'Alice Web', ${'oidc-alice-' + suffix}, 'clerk')
    RETURNING id
  `
  )[0]!;

  const clientB = (
    await sql`
    INSERT INTO users (email, display_name, oidc_subject, oidc_provider)
    VALUES (${'bob-' + suffix + '@example.com'}, 'Bob Walk-in', ${'oidc-bob-' + suffix}, 'clerk')
    RETURNING id
  `
  )[0]!;

  // 5. Catégorie & Produit (Gravel Électrique Premium)
  const cat = (await sql`SELECT id FROM categories LIMIT 1`)[0]!;
  const prod = (
    await sql`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${org.id}, ${cat.id}, 'Gravel Électrique E-Moustache', ${'gravel-' + suffix}, 'DRAFT')
    RETURNING id
  `
  )[0]!;

  for (let i = 0; i < 3; i += 1) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key, content_type, byte_size,
        width_px, height_px, checksum_sha256, sort_order, file_state
      ) VALUES (
        ${org.id}, ${prod.id}, ${'product-photos/gravel-' + suffix + '-' + i},
        'image/jpeg', 102400, 800, 600, ${('001' + i).repeat(16).slice(0, 64)},
        ${i}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${prod.id}`;

  const variant = (
    await sql`
    INSERT INTO product_variants (product_id, name, daily_price_amount_minor, currency)
    VALUES (${prod.id}, 'Taille M - 500Wh', 6000, 'EUR')
    RETURNING id
  `
  )[0]!;

  // 6. Flotte : 5 exemplaires physiques
  const insertItem = async (sku: string) => {
    const row = (
      await sql`
      INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, condition, status)
      VALUES (${org.id}, ${variant.id}, ${loc.id}, ${sku}, 'GOOD', 'ACTIVE')
      RETURNING id, internal_sku
    `
    )[0]!;
    return row;
  };

  const item1 = await insertItem('BIKE-001-' + suffix);
  const item2 = await insertItem('BIKE-002-' + suffix);
  const item3 = await insertItem('BIKE-003-' + suffix);
  const item4 = await insertItem('BIKE-004-' + suffix);
  const item5 = await insertItem('BIKE-005-' + suffix);

  return {
    organizationId: org.id,
    locationId: loc.id,
    operatorId: op.id,
    clientAId: clientA.id,
    clientBId: clientB.id,
    variantId: variant.id,
    item1Id: item1.id,
    item1Sku: item1.internal_sku,
    item2Id: item2.id,
    item2Sku: item2.internal_sku,
    item3Id: item3.id,
    item3Sku: item3.internal_sku,
    item4Id: item4.id,
    item4Sku: item4.internal_sku,
    item5Id: item5.id,
    item5Sku: item5.internal_sku,
  };
}

describe.skipIf(shouldSkipIntegrationTests())(
  'Chantier 21-S1 — Simulation Drill "Samedi Type" E2E sur PostgreSQL',
  () => {
    it('déroule avec succès le cycle opérationnel complet d’un samedi d’exploitation (08h00 - 20h00)', async () => {
      if (!db || !rawSql) return;
      const sql = rawSql;
      const f = await seedSaturdayShop();

      // =========================================================================
      // PHASE 1 : 08h30 - Réservation Web préalable de Client A (Journée 09h30 - 17h30)
      // 2 vélos réservés : item1 et item2
      // =========================================================================
      const nowMs = Date.now();
      const bookingStart = new Date(nowMs - 8 * 3600 * 1000); // 8h avant
      const bookingEnd = new Date(nowMs - 2 * 3600 * 1000); // 2h avant
      const blockedStart = new Date(nowMs - 8.5 * 3600 * 1000); // buffer 30m
      const blockedEnd = new Date(nowMs - 1.5 * 3600 * 1000);

      const draftA = (
        await sql`
        INSERT INTO booking_drafts (
          organization_id, location_id, customer_user_id, customer_start_at, customer_end_at,
          blocked_start_at, blocked_end_at, timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
          tax_status, tax_amount_minor, commission_amount_minor, billable_unit, billable_unit_count,
          currency, cancellation_policy_snapshot, status, expires_at
        ) VALUES (
          ${f.organizationId}, ${f.locationId}, ${f.clientAId}, ${bookingStart}, ${bookingEnd},
          ${blockedStart}, ${blockedEnd}, 'Europe/Paris', 15, 15,
          12000, 0, 12000,
          'NOT_APPLICABLE', 0, 1560, 'DAY', 1,
          'EUR', '{"cancellationPolicyCode": "FLEXIBLE"}'::jsonb,
          'CONVERTED', null
        ) RETURNING id
      `
      )[0]!;

      const paymentA = (
        await sql`
        INSERT INTO payments (
          organization_id, draft_id, customer_user_id, status,
          amount_minor, currency, tax_status, commission_amount_minor,
          financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
          connected_account_id, settlement_merchant_mode, environment, succeeded_at
        ) VALUES (
          ${f.organizationId}, ${draftA.id}, ${f.clientAId}, 'SUCCEEDED',
          12000, 'EUR', 'NOT_APPLICABLE', 1560,
          'v1', 'v1', '{"acceptedAt": "2026-09-05T06:30:00Z", "legalTermsVersion": "v1"}'::jsonb,
          'acct_test123', 'CONNECTED_ACCOUNT', 'TEST', now()
        ) RETURNING id
      `
      )[0]!;

      const bookingA = (
        await sql`
        INSERT INTO bookings (
          organization_id, location_id, customer_user_id, draft_id, payment_id,
          status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
          subtotal_amount_minor, total_amount_minor, tax_status, commission_amount_minor,
          cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
        ) VALUES (
          ${f.organizationId}, ${f.locationId}, ${f.clientAId}, ${draftA.id}, ${paymentA.id},
          'CONFIRMED', ${bookingStart}, ${bookingEnd}, ${blockedStart}, ${blockedEnd},
          'Europe/Paris', 15, 15, 'EUR',
          12000, 12000, 'NOT_APPLICABLE', 1560,
          '{"cancellationPolicyCode": "FLEXIBLE"}'::jsonb,
          '{"acceptedAt": "2026-09-05T06:30:00Z", "legalTermsVersion": "v1"}'::jsonb,
          now()
        ) RETURNING id
      `
      )[0]!;

      // Lignes et items réservés pour Client A
      const lineA = (
        await sql`
        INSERT INTO booking_lines (
          booking_id, variant_id, quantity, unit_price_amount_minor,
          billable_unit_count, line_total_amount_minor, currency, variant_snapshot
        ) VALUES (
          ${bookingA.id}, ${f.variantId}, 2, 6000,
          1, 12000, 'EUR', '{"name": "Taille M - 500Wh"}'::jsonb
        ) RETURNING id
      `
      )[0]!;

      // Bloc GiST et booking_item pour Item 1
      const block1 = (
        await sql`
        INSERT INTO inventory_blocks (
          organization_id, inventory_item_id, type, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
        ) VALUES (
          ${f.organizationId}, ${f.item1Id}, 'BOOKING', 'ACTIVE',
          ${bookingStart}, ${bookingEnd}, ${blockedStart}, ${blockedEnd}, ${bookingA.id}
        ) RETURNING id
      `
      )[0]!;
      const bItem1 = (
        await sql`
        INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, booking_block_id)
        VALUES (${bookingA.id}, ${lineA.id}, ${f.item1Id}, ${block1.id})
        RETURNING id
      `
      )[0]!;

      // Bloc GiST et booking_item pour Item 2
      const block2 = (
        await sql`
        INSERT INTO inventory_blocks (
          organization_id, inventory_item_id, type, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
        ) VALUES (
          ${f.organizationId}, ${f.item2Id}, 'BOOKING', 'ACTIVE',
          ${bookingStart}, ${bookingEnd}, ${blockedStart}, ${blockedEnd}, ${bookingA.id}
        ) RETURNING id
      `
      )[0]!;
      const bItem2 = (
        await sql`
        INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, booking_block_id)
        VALUES (${bookingA.id}, ${lineA.id}, ${f.item2Id}, ${block2.id})
        RETURNING id
      `
      )[0]!;

      expect(bookingA.id).toBeDefined();

      // =========================================================================
      // PHASE 2 : 09h00 - Réservation Comptoir Walk-in Client B (Lot 21-U2-AD)
      // Client B arrive au comptoir et prend Item 3 (09:00 - 13:00)
      // =========================================================================
      const walkinStart = new Date(nowMs - 7 * 3600 * 1000); // 7h avant
      const walkinEnd = new Date(nowMs - 3 * 3600 * 1000); // 3h avant

      const counterResult = await createCounterBooking(db, {
        organizationId: f.organizationId,
        locationId: f.locationId,
        operator: {
          id: f.operatorId,
          oidcSubject: 'oidc-op',
          email: 'operator@alpescycles.fr',
          emailVerified: true,
          isPlatformAdmin: false,
        },
        channel: 'WALK_IN',
        customer: {
          email: 'bob-walkin@example.com',
          fullName: 'Bob Walk-in',
        },
        items: [{ inventoryItemId: f.item3Id }],
        startAt: walkinStart,
        endAt: walkinEnd,
        payment: {
          method: 'ON_SITE_CARD',
        },
        idempotencyKey: `drill-walkin-${randomUUID()}`,
      });

      expect(counterResult).toMatchObject({
        bookingId: expect.any(String),
        status: 'CONFIRMED',
      });
      const bookingBId = counterResult.bookingId;

      // =========================================================================
      // PHASE 3 : 09h30 - Départ Client A, Incident de pneu crevé & Substitution
      // Item 1 est remplacé atomiquement par Item 4 (Lot 21-U2-AA)
      // =========================================================================
      // 3.1 Préparation de la commande
      await prepareBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        actorUserId: f.operatorId,
        idempotencyKey: `prep-a-${randomUUID()}`,
      });

      // 3.2 Substitution de Item 1 par Item 4 (disponible)
      const subResult = await substituteBookingItem(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem1.id,
        replacementInventoryItemId: f.item4Id,
        actorUserId: f.operatorId,
        idempotencyKey: `sub-a-${randomUUID()}`,
      });
      expect(subResult).toMatchObject({
        kind: 'APPLIED',
        previousInventoryItemId: f.item1Id,
        replacementInventoryItemId: f.item4Id,
      });

      // 3.3 Constats contradictoires de départ (Item 4 et Item 2)
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem1.id,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'Vélo de remplacement contrôlé, pneu neuf',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-p1-${randomUUID()}`,
      });
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem2.id,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'État impeccable au départ',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-p2-${randomUUID()}`,
      });

      // 3.4 Remise des vélos à Client A -> passage à ACTIVE
      const pickupAResult = await pickupBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        actorUserId: f.operatorId,
        idempotencyKey: `pickup-a-${randomUUID()}`,
      });
      expect(pickupAResult).toMatchObject({ kind: 'APPLIED', nextStatus: 'ACTIVE' });

      // =========================================================================
      // PHASE 4 : 10h00 - Départ Client B (Walk-in)
      // =========================================================================
      await prepareBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        actorUserId: f.operatorId,
        idempotencyKey: `prep-b-${randomUUID()}`,
      });

      const bItem3 = (
        await sql`
        SELECT id FROM booking_items WHERE booking_id = ${bookingBId} LIMIT 1
      `
      )[0]!;
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        bookingItemId: bItem3.id,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'Départ walk-in sans accroc',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-pb-${randomUUID()}`,
      });

      const pickupBResult = await pickupBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        actorUserId: f.operatorId,
        idempotencyKey: `pickup-b-${randomUUID()}`,
      });
      expect(pickupBResult).toMatchObject({ kind: 'APPLIED', nextStatus: 'ACTIVE' });

      // =========================================================================
      // PHASE 5 : 13h00 - Retour Nominal Client B (Walk-in clôturé)
      // =========================================================================
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        bookingItemId: bItem3.id,
        phase: 'RETURN',
        condition: 'GOOD',
        notes: 'Vélo restitué propre et en parfait état',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-ret-b-${randomUUID()}`,
      });

      await returnBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        actorUserId: f.operatorId,
        idempotencyKey: `return-b-${randomUUID()}`,
      });

      const closeBResult = await closeBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingBId,
        actorUserId: f.operatorId,
        idempotencyKey: `close-b-${randomUUID()}`,
      });
      expect(closeBResult).toMatchObject({ kind: 'APPLIED', nextStatus: 'CLOSED' });

      // =========================================================================
      // PHASE 6 : 14h00 - Prolongation Client A (+2h jusqu'à 19h30)
      // Extension de créneau sous contrainte GiST & traçabilité
      // =========================================================================
      const extendedCustomerEndAt = new Date(nowMs - 1 * 3600 * 1000); // 1h avant
      const extendedBlockedEndAt = new Date(nowMs - 30 * 60 * 1000); // 30m avant

      // Mise à jour des blocs d'inventaire correspondants pour étendre le créneau physique
      await sql`
        UPDATE inventory_blocks
        SET customer_end_at = ${extendedCustomerEndAt},
            blocked_end_at = ${extendedBlockedEndAt}
        WHERE source_id = ${bookingA.id}
      `;

      await sql`
        INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata)
        VALUES (
          ${f.operatorId}, 'BOOKING_EXTENDED', 'BOOKING', ${bookingA.id},
          '{"extendedHours": 2}'::jsonb
        )
      `;

      // =========================================================================
      // PHASE 7 : 19h30 - Retour Client A avec Dommage sur Vélo 2 & Maintenance 24h
      // Lot 21-U2-AB : Déclaration dommage contradictoire et blocage maintenance
      // =========================================================================
      // Constat retour Item 4 (parfait état)
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem1.id,
        phase: 'RETURN',
        condition: 'GOOD',
        notes: 'Vélo 1 restitué en excellent état',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-ret-a1-${randomUUID()}`,
      });

      // Constat retour Item 2 (chute, dérailleur tordu)
      await createConditionReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem2.id,
        phase: 'RETURN',
        condition: 'BROKEN',
        notes: 'Chute sur sentier : patte et dérailleur arrière tordus',
        actorUserId: f.operatorId,
        idempotencyKey: `cond-ret-a2-${randomUUID()}`,
      });

      await returnBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        actorUserId: f.operatorId,
        idempotencyKey: `return-a-${randomUUID()}`,
      });

      // Déclaration formelle de dommage avec blocksInventory: true
      const damageResult = await createDamageReport(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        bookingItemId: bItem2.id,
        description: 'Dérailleur tordu suite à chute, nécessite passage atelier',
        blocksInventory: true,
        actorUserId: f.operatorId,
        idempotencyKey: `damage-a-${randomUUID()}`,
      });

      expect(damageResult).toMatchObject({
        kind: 'APPLIED',
        reportId: expect.any(String),
        inventoryItemId: f.item2Id,
      });

      // Vérifier que Item 2 est bien en condition BROKEN avec bloc MAINTENANCE
      const item2Row = (
        await sql`
        SELECT condition FROM inventory_items WHERE id = ${f.item2Id}
      `
      )[0]!;
      expect(item2Row.condition).toBe('BROKEN');

      const maintenanceBlock = (
        await sql`
        SELECT type, status FROM inventory_blocks
        WHERE inventory_item_id = ${f.item2Id} AND type = 'MAINTENANCE'
      `
      )[0]!;
      expect(maintenanceBlock.type).toBe('MAINTENANCE');
      expect(maintenanceBlock.status).toBe('ACTIVE');

      // Clôture du dossier Client A
      const closeAResult = await closeBooking(db, {
        organizationId: f.organizationId,
        bookingId: bookingA.id,
        actorUserId: f.operatorId,
        idempotencyKey: `close-a-${randomUUID()}`,
      });
      expect(closeAResult).toMatchObject({ kind: 'APPLIED', nextStatus: 'CLOSED' });

      // =========================================================================
      // PHASE 8 : 20h00 - Clôture Financière & Décompte de commission du Loueur (Lot 21-F1)
      // =========================================================================
      const overview = await getMerchantFinanceOverview(db, f.organizationId);
      expect(overview.currency).toBe('EUR');
      expect(overview.sales.bookingCount).toBeGreaterThanOrEqual(1);

      const statementCsv = generateCommissionStatementCsv({
        organization: {
          legalName: 'Alpes Cycles Pro',
          legalForm: 'SAS',
          registrationNumber: '84920485900012',
          vatNumber: 'FR12849204859',
          registryCity: 'Annecy',
          registeredOfficeAddress: '12 avenue du Lac',
          registeredOfficePostalCode: '74000',
          registeredOfficeCity: 'Annecy',
        },
        overview,
      });

      // Vérification des mentions légales obligatoires dans le décompte officiel
      expect(statementCsv).toContain('DÉCOMPTE OFFICIEL DE COMMISSIONS ET REVERSEMENTS');
      expect(statementCsv).toContain('Uttily SAS · Capital 10 000 € · SIREN 987 654 321');
      expect(statementCsv).toContain('Alpes Cycles Pro (SAS)');
      expect(statementCsv).toContain('SIRET/SIREN : 84920485900012');
      expect(statementCsv).toContain('N° TVA Intracommunautaire : FR12849204859');

      // =========================================================================
      // PHASE 9 : 20h30 - Audit Log & Export RGPD (Lot 21-P1)
      // =========================================================================
      // 9.1 Vérification de l'audit log : actions tracées, zéro PII pour le client web
      const auditRows = await sql`
        SELECT action, metadata FROM audit_log
      `;
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('BOOKING_CREATED_AT_COUNTER');
      expect(actions).toContain('SUBSTITUTED');
      expect(actions).toContain('BOOKING_PREPARED');
      expect(actions).toContain('BOOKING_PICKED_UP');
      expect(actions).toContain('BOOKING_RETURNED');
      expect(actions).toContain('BOOKING_CLOSED');

      for (const row of auditRows) {
        const str = JSON.stringify(row.metadata ?? {});
        expect(str).not.toContain('alice-');
      }

      // 9.2 Vérification export RGPD pour Client A
      const personalCopy = await buildPersonalDataCopy(db, f.clientAId);
      expect(personalCopy.profile.displayName).toBe('Alice Web');
      expect(personalCopy.bookings).toHaveLength(1);
      expect(personalCopy.bookings[0]!.status).toBe('CLOSED');
      expect(personalCopy.bookings[0]!.location.name).toBe('Boutique Annecy Centre');

      const portableData = await buildPortableData(db, f.clientAId);
      expect(portableData.profileProvided.displayName).toBe('Alice Web');
      expect(portableData.bookingsInitiated).toHaveLength(1);

      // Le drill est un succès complet sur PostgreSQL
    });
  },
);
