import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createCounterBooking } from './create-counter-booking';
import { getCounterAvailableItems } from './get-counter-available-items';
import { CatalogError } from '../catalog/errors';

import type { AuthenticatedUser } from '../identity/types';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('counter_booking_integration');
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
      condition_reports, damage_reports,
      booking_fulfillment_events, outbox_events, audit_log,
      booking_items, booking_lines, inventory_blocks,
      payments, bookings, booking_draft_lines, booking_drafts,
      allocations, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships,
      organizations, users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

interface SeedShop {
  organizationId: string;
  locationId: string;
  operator: AuthenticatedUser;
  item1Id: string;
  item1Sku: string;
  item2Id: string;
  item2Sku: string;
  brokenItemId: string;
}

async function seedShop(suffix = SUFFIX()): Promise<SeedShop> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;

  const org = await sql`
    INSERT INTO organizations (legal_name, slug, default_cancellation_policy_code)
    VALUES (${'Shop Org ' + suffix}, ${'shop-' + suffix}, 'FLEXIBLE')
    RETURNING id
  `.then((rows) => rows[0]!);

  const location = await sql`
    INSERT INTO locations (organization_id, name, slug, time_zone, prep_buffer_minutes, cleanup_buffer_minutes, operating_currency)
    VALUES (${org.id}, 'Chamonix Desk', ${'chamonix-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);

  const operatorUser = await sql`
    INSERT INTO users (email, display_name)
    VALUES (${'operator-' + suffix + '@uttily.test'}, 'Jean Responsable')
    RETURNING id
  `.then((rows) => rows[0]!);

  await sql`
    INSERT INTO organization_memberships (organization_id, user_id, role, status)
    VALUES (${org.id}, ${operatorUser.id}, 'STAFF', 'ACTIVE')
  `;

  const category = await sql`
    SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1
  `.then((rows) => rows[0]!);

  const product = await sql`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${org.id}, ${category.id}, 'VTT Electrique', ${'vtt-' + suffix}, 'DRAFT')
    RETURNING id
  `.then((rows) => rows[0]!);

  for (let index = 0; index < 3; index += 1) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key, content_type, byte_size,
        width_px, height_px, checksum_sha256, sort_order, file_state
      ) VALUES (
        ${org.id}, ${product.id}, ${'product-photos/vtt-' + suffix + '-' + index},
        'image/jpeg', 102400, 800, 600, ${('001' + index).repeat(16).slice(0, 64)},
        ${index}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${product.id}`;

  const variant = await sql`
    INSERT INTO product_variants (product_id, name, is_active, daily_price_amount_minor, currency, attributes)
    VALUES (${product.id}, 'Taille L', true, 6000, 'EUR', ${JSON.stringify({ size: 'L' })})
    RETURNING id
  `.then((rows) => rows[0]!);

  const item1 = await sql`
    INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id, condition, status)
    VALUES (${org.id}, ${variant.id}, ${'VTT-01-' + suffix}, ${location.id}, 'NEW', 'ACTIVE')
    RETURNING id, internal_sku
  `.then((rows) => rows[0]!);

  const item2 = await sql`
    INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id, condition, status)
    VALUES (${org.id}, ${variant.id}, ${'VTT-02-' + suffix}, ${location.id}, 'GOOD', 'ACTIVE')
    RETURNING id, internal_sku
  `.then((rows) => rows[0]!);

  const brokenItem = await sql`
    INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id, condition, status)
    VALUES (${org.id}, ${variant.id}, ${'VTT-BROKEN-' + suffix}, ${location.id}, 'BROKEN', 'ACTIVE')
    RETURNING id
  `.then((rows) => rows[0]!);

  return {
    organizationId: org.id,
    locationId: location.id,
    operator: {
      id: operatorUser.id,
      email: 'operator-' + suffix + '@uttily.test',
      emailVerified: true,
      isPlatformAdmin: false,
      oidcSubject: 'oidc-' + suffix,
    },
    item1Id: item1.id,
    item1Sku: item1.internal_sku,
    item2Id: item2.id,
    item2Sku: item2.internal_sku,
    brokenItemId: brokenItem.id,
  };
}

describe.skipIf(shouldSkipIntegrationTests())(
  'Fulfillment — Réservation comptoir (Lot 21-U2-AD)',
  () => {
    it('crée avec succès une réservation walk-in avec paiement par carte au comptoir', async () => {
      if (!db) throw new Error('db not initialized');
      const shop = await seedShop();

      const startAt = new Date('2026-09-10T09:00:00Z');
      const endAt = new Date('2026-09-10T17:00:00Z');

      const result = await createCounterBooking(db, {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        channel: 'WALK_IN',
        customer: {
          fullName: 'Marc Dupont',
          email: 'marc.dupont@example.com',
          phone: '+33612345678',
        },
        startAt,
        endAt,
        items: [{ inventoryItemId: shop.item1Id }],
        payment: {
          method: 'ON_SITE_CARD',
          reference: 'TPE-TX-8492',
        },
        notes: 'Client au comptoir, départ direct',
        idempotencyKey: 'test-idemp-walkin-1',
      });

      expect(result.bookingId).toBeDefined();
      expect(result.bookingReference).toMatch(/^#UT-[0-9A-F]{6}$/);
      expect(result.status).toBe('CONFIRMED');
      expect(result.totalAmountMinor).toBeGreaterThan(0);

      // Vérifier l'insertion en base
      const raw = rawSql!;
      const [booking] = await raw`SELECT * FROM bookings WHERE id = ${result.bookingId}`;
      expect(booking).toBeDefined();
      if (!booking) throw new Error('booking not found');
      expect(booking.status).toBe('CONFIRMED');
      expect(booking.organization_id).toBe(shop.organizationId);
      expect(booking.location_id).toBe(shop.locationId);

      // Vérifier la création du bloc d'inventaire BOOKING / ACTIVE
      const [block] = await raw`
      SELECT * FROM inventory_blocks
      WHERE inventory_item_id = ${shop.item1Id}
        AND type = 'BOOKING'
        AND status = 'ACTIVE'
    `;
      expect(block).toBeDefined();
      if (!block) throw new Error('block not found');
      expect(block.source_id).toBeDefined();

      // Vérifier l'audit log
      const [audit] = await raw`
      SELECT * FROM audit_log
      WHERE action = 'BOOKING_CREATED_AT_COUNTER'
        AND target_id = ${result.bookingId}
    `;
      expect(audit).toBeDefined();
      if (!audit) throw new Error('audit not found');
      expect(audit.metadata.channel).toBe('WALK_IN');
      expect(audit.metadata.paymentMethod).toBe('ON_SITE_CARD');
      expect(audit.metadata.customerEmail).toBe('marc.dupont@example.com');
    });

    it('rejette avec CONFLICT_BLOCK si un équipement chevauche une réservation existante', async () => {
      if (!db) throw new Error('db not initialized');
      const shop = await seedShop();

      const startAt = new Date('2026-09-12T10:00:00Z');
      const endAt = new Date('2026-09-12T16:00:00Z');

      // 1. Première réservation au comptoir
      await createCounterBooking(db, {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        channel: 'PHONE',
        customer: {
          fullName: 'Alice Client',
          email: 'alice@example.com',
        },
        startAt,
        endAt,
        items: [{ inventoryItemId: shop.item1Id }],
        payment: {
          method: 'PAY_LATER',
        },
        idempotencyKey: 'test-idemp-first-booking',
      });

      // 2. Deuxième tentative sur le même créneau pour le même équipement -> doit échouer
      await expect(
        createCounterBooking(db, {
          organizationId: shop.organizationId,
          locationId: shop.locationId,
          operator: shop.operator,
          channel: 'WALK_IN',
          customer: {
            fullName: 'Bob Autre',
            email: 'bob@example.com',
          },
          startAt: new Date('2026-09-12T14:00:00Z'),
          endAt: new Date('2026-09-12T18:00:00Z'),
          items: [{ inventoryItemId: shop.item1Id }],
          payment: { method: 'ON_SITE_CASH' },
          idempotencyKey: 'test-idemp-conflict',
        }),
      ).rejects.toThrow(CatalogError);
    });

    it('rejette si un équipement est en état BROKEN', async () => {
      if (!db) throw new Error('db not initialized');
      const shop = await seedShop();

      await expect(
        createCounterBooking(db, {
          organizationId: shop.organizationId,
          locationId: shop.locationId,
          operator: shop.operator,
          channel: 'WALK_IN',
          customer: {
            fullName: 'Test Client',
            email: 'test@example.com',
          },
          startAt: new Date('2026-09-15T10:00:00Z'),
          endAt: new Date('2026-09-15T14:00:00Z'),
          items: [{ inventoryItemId: shop.brokenItemId }],
          payment: { method: 'ON_SITE_CASH' },
          idempotencyKey: 'test-broken-item',
        }),
      ).rejects.toThrow(/ne peut pas être loué/);
    });

    it('est idempotent sur rejeu avec la même clé d’idempotence', async () => {
      if (!db) throw new Error('db not initialized');
      const shop = await seedShop();

      const input = {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        channel: 'WALK_IN' as const,
        customer: {
          fullName: 'Claire Martin',
          email: 'claire@example.com',
        },
        startAt: new Date('2026-09-20T09:00:00Z'),
        endAt: new Date('2026-09-20T12:00:00Z'),
        items: [{ inventoryItemId: shop.item2Id }],
        payment: { method: 'ON_SITE_CASH' as const },
        idempotencyKey: 'idemp-replay-key-1',
      };

      const first = await createCounterBooking(db, input);
      const second = await createCounterBooking(db, input);

      expect(second.bookingId).toBe(first.bookingId);
      expect(second.alreadyExisted).toBe(true);
    });

    it('getCounterAvailableItems exclut le matériel réservé et retourne le matériel disponible', async () => {
      if (!db) throw new Error('db not initialized');
      const shop = await seedShop();

      const startAt = new Date('2026-09-25T09:00:00Z');
      const endAt = new Date('2026-09-25T17:00:00Z');

      // Au départ : item1 et item2 disponibles, brokenItem exclu car BROKEN
      const initial = await getCounterAvailableItems(db, {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        startAt,
        endAt,
      });

      const initialSkus = initial.items.map((i) => i.internalSku);
      expect(initialSkus).toContain(shop.item1Sku);
      expect(initialSkus).toContain(shop.item2Sku);
      expect(initial.items.some((i) => i.id === shop.brokenItemId)).toBe(false);

      // Réserver item1
      await createCounterBooking(db, {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        channel: 'WALK_IN',
        customer: { fullName: 'Marc', email: 'marc@test.com' },
        startAt,
        endAt,
        items: [{ inventoryItemId: shop.item1Id }],
        payment: { method: 'ON_SITE_CARD' },
        idempotencyKey: 'idemp-avail-check',
      });

      // Après réservation : item1 doit avoir disparu de la disponibilité sur ce créneau !
      const after = await getCounterAvailableItems(db, {
        organizationId: shop.organizationId,
        locationId: shop.locationId,
        operator: shop.operator,
        startAt,
        endAt,
      });

      const afterSkus = after.items.map((i) => i.internalSku);
      expect(afterSkus).not.toContain(shop.item1Sku);
      expect(afterSkus).toContain(shop.item2Sku);
    });
  },
);
