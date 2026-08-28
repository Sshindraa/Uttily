import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput as CreateBookingDraftInput } from '../booking-drafts/types';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

let orgId: string;
let locationId: string;
let user1Id: string;
let user2Id: string;
let categoryId: string;
let productId: string;
let variantId: string;
let singleItemId: string;
let seedCount = 0;

const STD_START = new Date('2026-11-10T09:00:00.000Z');
const STD_END = new Date('2026-11-12T17:00:00.000Z');

beforeAll(async () => {
  if (shouldSkipIntegrationTests()) return;
  context = await setupIntegrationTestDb('anti_overbooking');
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
      refunds,
      outbox_effects,
      outbox_events,
      booking_fulfillment_events,
      booking_items,
      booking_lines,
      bookings,
      payment_webhook_events,
      payment_attempts,
      payments,
      organization_payment_accounts,
      allocations,
      booking_draft_lines,
      booking_drafts,
      maintenance_cases,
      inventory_blocks,
      inventory_movements,
      inventory_items,
      product_variants,
      product_photos,
      products,
      categories,
      location_schedule_exceptions,
      location_opening_hours,
      locations,
      organization_invitations,
      organization_memberships,
      organizations,
      users,
      idempotency_records
      RESTART IDENTITY CASCADE`,
  );

  const orgRow = await rawSql`
    INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
    VALUES ('Anti Overbooking Org', ${`org-aob-${suffix}`}, true, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  orgId = orgRow.id;

  const user1Row = await rawSql`
    INSERT INTO users (email)
    VALUES (${`cust1-aob-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  user1Id = user1Row.id;

  const user2Row = await rawSql`
    INSERT INTO users (email)
    VALUES (${`cust2-aob-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  user2Id = user2Row.id;

  const locRow = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgId}, 'Location AOB', ${`loc-aob-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  locationId = locRow.id;

  const catRow = await rawSql`
    INSERT INTO categories (name, slug)
    VALUES ('Vélos', ${`cat-aob-${suffix}`})
    RETURNING id
  `.then((r) => r[0]!);
  categoryId = catRow.id;

  const prodRow = await rawSql`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${orgId}, ${categoryId}, 'Vélo Unique', ${`unique-${suffix}`}, 'DRAFT')
    RETURNING id
  `.then((r) => r[0]!);
  productId = prodRow.id;

  for (let pi = 0; pi < 3; pi++) {
    await rawSql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${orgId}, ${productId}, ${`product-photos/${suffix}-${pi}`},
        'image/jpeg', 102400, 800, 600, ${('000' + pi).repeat(16).slice(0, 64)},
        ${pi}, 'AVAILABLE'
      )
    `;
  }
  await rawSql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${productId}`;

  const varRow = await rawSql`
    INSERT INTO product_variants (product_id, name, is_active, daily_price_amount_minor, currency)
    VALUES (${productId}, 'Taille Unique', true, 6000, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  variantId = varRow.id;

  // UN SEUL exemplaire disponible en base
  const itemRow = await rawSql`
    INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, status)
    VALUES (${orgId}, ${variantId}, ${locationId}, ${`SKU-AOB-${suffix}`}, 'ACTIVE')
    RETURNING id
  `.then((r) => r[0]!);
  singleItemId = itemRow.id;
});

describe.skipIf(shouldSkipIntegrationTests())(
  '19-C — Availability & Anti-Overbooking Concurrency Integration',
  () => {
    describe('Course à la Réservation sur le Dernier Exemplaire (1 stock)', () => {
      it('garantit que 2 tentatives concurrentes de hold ne créent qu’UN SEUL hold (0 surbooking)', async () => {
        const input1: CreateBookingDraftInput = {
          pricingMode: 'LEGACY',
          organizationId: orgId,
          locationId,
          customerUserId: user1Id,
          customerStartAt: STD_START,
          customerEndAt: STD_END,
          lines: [{ variantId, quantity: 1 }],
          idempotencyKey: `hold-race-1-${randomUUID()}`,
        };

        const input2: CreateBookingDraftInput = {
          pricingMode: 'LEGACY',
          organizationId: orgId,
          locationId,
          customerUserId: user2Id,
          customerStartAt: STD_START,
          customerEndAt: STD_END,
          lines: [{ variantId, quantity: 1 }],
          idempotencyKey: `hold-race-2-${randomUUID()}`,
        };

        // Exécution STRICTEMENT concurrente
        const [res1, res2] = await Promise.all([
          createBookingDraftWithHold(db!, input1),
          createBookingDraftWithHold(db!, input2),
        ]);

        const successCount = [res1, res2].filter((r) => r.kind === 'SUCCESS').length;
        const failureCount = [res1, res2].filter((r) => r.kind === 'FAILURE').length;

        // Invariant : EXACTEMENT 1 hold réussi, 1 refusé pour stock insuffisant
        expect(successCount).toBe(1);
        expect(failureCount).toBe(1);

        const failedRes = [res1, res2].find((r) => r.kind === 'FAILURE')!;
        if (failedRes.kind !== 'FAILURE') throw new Error('Expected failure');
        expect(['CONFLICT_BLOCK', 'INSUFFICIENT_STOCK', 'DRAFT_LINE_INSUFFICIENT_STOCK']).toContain(
          failedRes.body.error,
        );

        // Vérification en base : exactement 1 bloc actif et 1 allocation
        const activeBlocks = await rawSql!`
        SELECT * FROM inventory_blocks
        WHERE inventory_item_id = ${singleItemId}
          AND status = 'ACTIVE'
      `;
        expect(activeBlocks.length).toBe(1);

        const allocationsCount = await rawSql!`
        SELECT count(*) FROM allocations
        WHERE inventory_block_id = ${activeBlocks[0]!.id}
      `;
        expect(Number(allocationsCount[0]!.count)).toBe(1);
      });
    });

    describe('Concurrence Hold vs Maintenance Case', () => {
      it('empêche tout chevauchement entre un hold actif et une immobilisation de maintenance', async () => {
        // 1. Poser un hold actif sur l'unique exemplaire
        const inputHold: CreateBookingDraftInput = {
          pricingMode: 'LEGACY',
          organizationId: orgId,
          locationId,
          customerUserId: user1Id,
          customerStartAt: STD_START,
          customerEndAt: STD_END,
          lines: [{ variantId, quantity: 1 }],
          idempotencyKey: `hold-maint-${randomUUID()}`,
        };

        const holdRes = await createBookingDraftWithHold(db!, inputHold);
        expect(holdRes.kind).toBe('SUCCESS');

        // 2. Tenter d'insérer directement un bloc de maintenance chevauchant sur le même item
        // La contrainte d'exclusion GiST PostgreSQL doit lever une exception
        await expect(
          rawSql!`
          INSERT INTO inventory_blocks (
            organization_id, inventory_item_id, type, status,
            customer_start_at, customer_end_at, blocked_start_at, blocked_end_at
          ) VALUES (
            ${orgId}, ${singleItemId}, 'MAINTENANCE', 'ACTIVE',
            ${STD_START}, ${STD_END}, ${STD_START}, ${STD_END}
          )
        `,
        ).rejects.toThrow();
      });
    });

    describe('Intégrité des Périodes de Tampon (Prep / Cleanup Buffers)', () => {
      it('bloque une réservation concurrente sur la période de tampon même sans chevauchement client', async () => {
        // Établissement configuré avec 30min de buffer avant et après
        await rawSql!`
        UPDATE locations
        SET prep_buffer_minutes = 30, cleanup_buffer_minutes = 30
        WHERE id = ${locationId}
      `;

        // Hold 1 : 10:00 - 12:00 (blocked: 09:30 - 12:30)
        const slot1Start = new Date('2026-11-10T10:00:00.000Z');
        const slot1End = new Date('2026-11-10T12:00:00.000Z');

        const hold1 = await createBookingDraftWithHold(db!, {
          pricingMode: 'LEGACY',
          organizationId: orgId,
          locationId,
          customerUserId: user1Id,
          customerStartAt: slot1Start,
          customerEndAt: slot1End,
          lines: [{ variantId, quantity: 1 }],
          idempotencyKey: `buffer-hold-1-${randomUUID()}`,
        });
        expect(hold1.kind).toBe('SUCCESS');

        // Hold 2 : tente de réserver à 12:15 - 14:00 (pendant le buffer de cleanup du Hold 1 jusqu'à 12:30)
        const slot2Start = new Date('2026-11-10T12:15:00.000Z');
        const slot2End = new Date('2026-11-10T14:00:00.000Z');

        const hold2 = await createBookingDraftWithHold(db!, {
          pricingMode: 'LEGACY',
          organizationId: orgId,
          locationId,
          customerUserId: user2Id,
          customerStartAt: slot2Start,
          customerEndAt: slot2End,
          lines: [{ variantId, quantity: 1 }],
          idempotencyKey: `buffer-hold-2-${randomUUID()}`,
        });

        // Doit être rejeté pour conflit de disponibilité sur le tampon
        expect(hold2.kind).toBe('FAILURE');
        if (hold2.kind !== 'FAILURE') throw new Error('Expected failure');
        expect(['CONFLICT_BLOCK', 'INSUFFICIENT_STOCK', 'DRAFT_LINE_INSUFFICIENT_STOCK']).toContain(
          hold2.body.error,
        );
      });
    });
  },
);
