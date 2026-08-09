import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold, BookingDraftError } from './index';
import type {
  CreateBookingDraftFailure,
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  LegacyCreateBookingDraftInput,
} from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('booking_drafts');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 5 });
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
  }
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!ctx || !db) return;
  await db.execute(
    (await import('drizzle-orm'))
      .sql`TRUNCATE TABLE allocations, booking_draft_lines, booking_drafts, inventory_blocks, inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users, idempotency_records RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  itemIds: string[];
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

/**
 * Crée les données de base : organisation (FLEXIBLE), lieu (Europe/Paris,
 * buffers 30 min), utilisateur, catégorie, produit PUBLISHED, variante
 * (prix 5000, EUR, active), 3 exemplaires (NEW/GOOD/FAIR, ACTIVE).
 */
async function seedBaseData(suffix = SUFFIX()): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + _pi},
        'image/jpeg', 102400, 800, 600, ${('000' + _pi).repeat(16).slice(0, 64)},
        ${_pi}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix + '-' + i}, ${location.id}, ${cond}, 'ACTIVE')
      RETURNING "id"
    `.then((r) => r[0]!);
    itemIds.push(item.id);
  }
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemIds,
  };
}

/** Période standard : 10–12 février 2026 (3 jours civils Europe/Paris). */
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

function makeInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function expectSuccess(
  result: CreateBookingDraftResult,
): asserts result is CreateBookingDraftSuccess {
  expect(result.kind).toBe('SUCCESS');
  if (result.kind !== 'SUCCESS') throw new Error('Résultat SUCCESS attendu.');
}

function expectFailure(
  result: CreateBookingDraftResult,
): asserts result is CreateBookingDraftFailure {
  expect(result.kind).toBe('FAILURE');
  if (result.kind !== 'FAILURE') throw new Error('Résultat FAILURE attendu.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'createBookingDraftWithHold — intégration PostgreSQL',
  () => {
    // 1. Création nominale
    it('1. crée un brouillon HELD avec 1 ligne, 1 bloc, 1 allocation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      expect(result.body.status).toBe('HELD');
      expect(result.body.draftId).toBe(result.resourceId);
      expect(result.body.lines).toHaveLength(1);
      expect(result.body.lines[0]!.allocations).toHaveLength(1);
      expect(result.body.lines[0]!.quantity).toBe(1);
      expect(result.body.lines[0]!.unitPriceAmountMinor).toBe(5000);
      // 3 jours civils × 5000 × 1 = 15000
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(15000);
      expect(result.body.subtotalAmountMinor).toBe(15000);
      expect(result.body.totalAmountMinor).toBe(15000);
      expect(result.body.billableUnitCount).toBe(3);
      expect(result.body.currency).toBe('EUR');
      expect(result.body.taxStatus).toBe('UNDETERMINED');
      expect(result.body.taxAmountMinor).toBeNull();
      expect(result.body.commissionAmountMinor).toBeNull();

      // Vérifier en base.
      const drafts = await rawSql`SELECT * FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.status).toBe('HELD');
      const lines =
        await rawSql`SELECT * FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}`;
      expect(lines).toHaveLength(1);
      const blocks =
        await rawSql`SELECT * FROM inventory_blocks WHERE source_id = ${result.body.draftId}`;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('HOLD');
      expect(blocks[0]!.status).toBe('ACTIVE');
      const allocs = await rawSql`SELECT * FROM allocations WHERE draft_line_id = ${lines[0]!.id}`;
      expect(allocs).toHaveLength(1);
    });

    // 2. Plusieurs variantes — allocation déterministe (ORDER BY)
    it('2. alloue plusieurs variantes avec un ordre déterministe', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await rawSql`
        UPDATE "inventory_items"
        SET "internal_sku" = CASE "id"
          WHEN ${ids.itemIds[0]!}::uuid THEN 'ZZZ-1'
          WHEN ${ids.itemIds[1]!}::uuid THEN 'AAA-2'
        END
        WHERE "id" IN (${ids.itemIds[0]!}, ${ids.itemIds[1]!})
      `;
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[2]!}`;
      const variant2 = await rawSql`
        INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
        VALUES (${ids.productId}, 'Premium', true, 8000, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      await rawSql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
        VALUES
          (${ids.orgId}, ${variant2.id}, 'MMM-3', ${ids.locationId}, 'NEW', 'ACTIVE'),
          (${ids.orgId}, ${variant2.id}, 'BBB-4', ${ids.locationId}, 'NEW', 'ACTIVE')
      `;
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          lines: [
            { variantId: variant2.id, quantity: 2 },
            { variantId: ids.variantId, quantity: 2 },
          ],
        }),
      );
      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      expect(result.body.lines).toHaveLength(2);
      const sortedVariantIds = [ids.variantId, variant2.id].sort();
      expect(result.body.lines.map((line) => line.variantId)).toEqual(sortedVariantIds);

      const baseLine = result.body.lines.find((line) => line.variantId === ids.variantId)!;
      expect(baseLine.allocations.map((allocation) => allocation.internalSku)).toEqual([
        'AAA-2',
        'ZZZ-1',
      ]);
      const variant2Line = result.body.lines.find((line) => line.variantId === variant2.id)!;
      expect(variant2Line.allocations.map((allocation) => allocation.internalSku)).toEqual([
        'BBB-4',
        'MMM-3',
      ]);
    });

    // 3. Snapshot catalogue exact
    it('3. persiste le variantSnapshot exact (productName, variantName, skuSuffix, attributes)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Mettre à jour la variante avec un skuSuffix et des attributes.
      await rawSql`
      UPDATE "product_variants" SET "sku_suffix" = 'STD', "attributes" = ${rawSql.json({ color: 'red', size: 'M' })} WHERE "id" = ${ids.variantId}
    `;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      const snap = result.body.lines[0]!.variantSnapshot;
      expect(snap.productName).toBe('Kayak');
      expect(snap.variantName).toBe('Standard');
      expect(snap.skuSuffix).toBe('STD');
      expect(snap.attributes).toEqual({ color: 'red', size: 'M' });
    });

    // 4. Snapshot politique/version/fuseau/marges
    it('4. persiste cancellationPolicySnapshot, prepBufferMinutes, cleanupBufferMinutes', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.body.cancellationPolicySnapshot).toEqual({
        policy_code: 'FLEXIBLE',
        policy_version: 'v1',
        timezone: 'Europe/Paris',
      });
      // Vérifier en base les marges.
      const drafts =
        await rawSql`SELECT prep_buffer_minutes, cleanup_buffer_minutes, timezone FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.prep_buffer_minutes).toBe(30);
      expect(drafts[0]!.cleanup_buffer_minutes).toBe(30);
      expect(drafts[0]!.timezone).toBe('Europe/Paris');
    });

    // 5. Prix et jours civils persistés
    it('5. persiste subtotalAmountMinor, totalAmountMinor, billableUnitCount', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.body.billableUnitCount).toBe(3);
      expect(result.body.subtotalAmountMinor).toBe(15000);
      expect(result.body.mandatoryFeesAmountMinor).toBe(0);
      expect(result.body.totalAmountMinor).toBe(15000);
      const drafts =
        await rawSql`SELECT subtotal_amount_minor, total_amount_minor, billable_unit_count FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(Number(drafts[0]!.subtotal_amount_minor)).toBe(15000);
      expect(Number(drafts[0]!.total_amount_minor)).toBe(15000);
      expect(drafts[0]!.billable_unit_count).toBe(3);
    });

    // 6. Produit non publié refusé
    it('6. refuse un produit non publié (DRAFT)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await rawSql`UPDATE "products" SET "publication_status" = 'DRAFT' WHERE "id" = ${ids.productId}`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ error: 'VALIDATION' });
      // Aucun brouillon créé.
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
    });

    // 7. Variante inactive refusée
    it('7. refuse une variante inactive', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer une 2e variante active pour éviter le trigger "dernière variante active".
      await rawSql`
      INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
      VALUES (${ids.productId}, 'Pro', true, 6000, 'EUR')
    `;
      await rawSql`UPDATE "product_variants" SET "is_active" = false WHERE "id" = ${ids.variantId}`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ error: 'VALIDATION' });
    });

    // 8. Variante supprimée refusée
    it('8. refuse une variante supprimée (deletedAt non null)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer une 2e variante active pour éviter le trigger "dernière variante active".
      await rawSql`
      INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
      VALUES (${ids.productId}, 'Pro', true, 6000, 'EUR')
    `;
      await rawSql`UPDATE "product_variants" SET "deleted_at" = now() WHERE "id" = ${ids.variantId}`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body.error).toBe('NOT_FOUND');
    });

    // 9. Variante sans prix refusée
    it('9. refuse une variante sans prix (dailyPriceAmountMinor = null)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await rawSql`UPDATE "product_variants" SET "daily_price_amount_minor" = NULL WHERE "id" = ${ids.variantId}`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ error: 'VALIDATION' });
    });

    // 10. Variante non-EUR refusée
    it('10. refuse une variante avec devise non EUR', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // La contrainte CHECK product_variants_currency_eur empêche USD en base.
      // On lève temporairement la contrainte pour insérer une variante USD,
      // puis on la restaure. Le code de validation application-level doit
      // détecter la devise non EUR et rejeter.
      await rawSql`ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_currency_eur"`;
      try {
        await rawSql`
        UPDATE "product_variants" SET "currency" = 'USD' WHERE "id" = ${ids.variantId}
      `;
        const result = await createBookingDraftWithHold(db, makeInput(ids));
        expectFailure(result);
        expect(result.statusCode).toBe(400);
        expect(result.body).toMatchObject({ error: 'VALIDATION' });
      } finally {
        // Restaurer la contrainte et la valeur.
        await rawSql`UPDATE "product_variants" SET "currency" = 'EUR' WHERE "id" = ${ids.variantId}`;
        await rawSql`ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_currency_eur" CHECK ("currency" = 'EUR')`;
      }
    });

    // 11. Organisation incohérente refusée
    it('11. refuse un lieu appartenant à une autre organisation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer une 2e org et un lieu.
      const org2 = await rawSql`
      INSERT INTO "organizations" ("legal_name", "slug")
      VALUES (${'Other Org ' + SUFFIX()}, ${'other-' + SUFFIX()})
      RETURNING "id"
    `.then((r) => r[0]!);
      const loc2 = await rawSql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
      VALUES (${org2.id}, 'Other', ${'other-loc-' + SUFFIX()}, 'Europe/Paris', 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
      const result = await createBookingDraftWithHold(db, makeInput(ids, { locationId: loc2.id }));
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ error: 'VALIDATION' });
    });

    // 12. Conditions POOR et BROKEN exclues
    it('12. exclut les exemplaires en condition POOR et BROKEN', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Mettre tous les exemplaires en POOR/BROKEN.
      await rawSql`UPDATE "inventory_items" SET "condition" = 'POOR' WHERE "id" = ${ids.itemIds[0]!}`;
      await rawSql`UPDATE "inventory_items" SET "condition" = 'BROKEN' WHERE "id" = ${ids.itemIds[1]!}`;
      await rawSql`UPDATE "inventory_items" SET "condition" = 'POOR' WHERE "id" = ${ids.itemIds[2]!}`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
    });

    // 13. Exemplaire inactif exclu
    it('13. exclut les exemplaires inactifs (status = RETIRED)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await rawSql`UPDATE "inventory_items" SET "status" = 'RETIRED' WHERE "id" IN (${ids.itemIds[0]!}, ${ids.itemIds[1]!}, ${ids.itemIds[2]!})`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
    });

    // 14. Exemplaire supprimé exclu
    it('14. exclut les exemplaires supprimés (deletedAt non null)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await rawSql`UPDATE "inventory_items" SET "deleted_at" = now() WHERE "id" IN (${ids.itemIds[0]!}, ${ids.itemIds[1]!}, ${ids.itemIds[2]!})`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
    });

    // 15. Exemplaire dans un autre lieu exclu
    it('15. exclut les exemplaires situés dans un autre lieu', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un 2e lieu dans la même org.
      const loc2 = await rawSql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
      VALUES (${ids.orgId}, 'Other Shop', ${'other-shop-' + SUFFIX()}, 'Europe/Paris', 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
      await rawSql`UPDATE "inventory_items" SET "current_location_id" = ${loc2.id} WHERE "id" IN (${ids.itemIds[0]!}, ${ids.itemIds[1]!}, ${ids.itemIds[2]!})`;
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
    });

    // 16. Stock insuffisant — aucun brouillon/ligne/bloc/allocation créé
    it('16. refuse un stock insuffisant sans créer aucun brouillon/ligne/bloc/allocation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, { lines: [{ variantId: ids.variantId, quantity: 5 }] }),
      );
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
      expect(result.resourceId).toBeNull();
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
      const lines = await rawSql`SELECT count(*)::int AS n FROM booking_draft_lines`;
      expect(lines[0]!.n).toBe(0);
      const blocks =
        await rawSql`SELECT count(*)::int AS n FROM inventory_blocks WHERE "type" = 'HOLD'`;
      expect(blocks[0]!.n).toBe(0);
      const allocs = await rawSql`SELECT count(*)::int AS n FROM allocations`;
      expect(allocs[0]!.n).toBe(0);
    });

    // 17. Échec métier persisté puis replay exact
    it('17. persiste un échec métier puis rejoue la même réponse au replay', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'fail-replay-' + SUFFIX();
      const input = makeInput(ids, {
        idempotencyKey: key,
        lines: [{ variantId: ids.variantId, quantity: 5 }],
      });
      const result1 = await createBookingDraftWithHold(db, input);
      expectFailure(result1);
      expect(result1.statusCode).toBe(409);
      // Replay avec la même clé et le même payload.
      const result2 = await createBookingDraftWithHold(db, input);
      expectFailure(result2);
      expect(result2.statusCode).toBe(result1.statusCode);
      expect(result2.body).toEqual(result1.body);
      expect(result2.resourceId).toBeNull();
    });

    // 18. Même clé + même requête séquentielle — un seul brouillon, mêmes IDs
    it('18. rejoue exactement le même brouillon (mêmes IDs) avec la même clé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'seq-replay-' + SUFFIX();
      const input = makeInput(ids, { idempotencyKey: key });
      const result1 = await createBookingDraftWithHold(db, input);
      expectSuccess(result1);
      expect(result1.statusCode).toBe(201);
      const result2 = await createBookingDraftWithHold(db, input);
      expectSuccess(result2);
      expect(result2.statusCode).toBe(201);
      expect(result2.body.draftId).toBe(result1.body.draftId);
      expect(result2.body).toEqual(result1.body);
      // Un seul brouillon en base.
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
    });

    // 19. Même clé + requête différente — 409 CONFLICT_IDEMPOTENCY
    it('19. rejette la même clé avec un payload différent (CONFLICT_IDEMPOTENCY)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'conflict-' + SUFFIX();
      const input1 = makeInput(ids, { idempotencyKey: key });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      expect(result1.statusCode).toBe(201);
      // Requête différente : même clé, dates différentes.
      const input2 = makeInput(ids, {
        idempotencyKey: key,
        customerStartAt: new Date('2026-03-10T09:00:00.000Z'),
        customerEndAt: new Date('2026-03-12T17:00:00.000Z'),
      });
      await expect(createBookingDraftWithHold(db, input2)).rejects.toThrow(BookingDraftError);
      try {
        await createBookingDraftWithHold(db, input2);
      } catch (err) {
        expect(err).toBeInstanceOf(BookingDraftError);
        expect((err as BookingDraftError).code).toBe('CONFLICT_IDEMPOTENCY');
        expect((err as BookingDraftError).statusCode).toBe(409);
      }
      // Aucun doublon.
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
    });

    // 20. Deux appels simultanés, même clé et même requête — un seul brouillon
    it("20. deux appels simultanés avec la même clé ne créent qu'un seul brouillon", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'concurrent-same-' + SUFFIX();
      const input = makeInput(ids, { idempotencyKey: key });
      // Deux clients drizzle séparés pour la concurrence.
      // createDatabase utilise postgres(url, { max: 10 }) : suffisant pour
      // exécuter deux transactions concurrentes sans deadlock de pool.
      const db2 = createDatabase(ctx!.databaseUrl);
      try {
        const [r1, r2] = await Promise.all([
          createBookingDraftWithHold(db, input),
          createBookingDraftWithHold(db2, input),
        ]);
        // Au moins un doit être 201, l'autre doit être identique (replay ou même création).
        expectSuccess(r1);
        expectSuccess(r2);
        expect(r1.body.draftId).toBe(r2.body.draftId);
        expect(r1.body).toEqual(r2.body);
        // Un seul brouillon en base.
        const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
        expect(drafts[0]!.n).toBe(1);
        // Un seul ensemble de blocs.
        const blocks =
          await rawSql`SELECT count(*)::int AS n FROM inventory_blocks WHERE "type" = 'HOLD'`;
        expect(blocks[0]!.n).toBe(1);
      } finally {
        await db2.$client.end();
      }
    });

    // 21. Deux clés différentes en concurrence pour le même exemplaire
    it("21. deux clés différentes en concurrence : un seul succès, l'autre CONFLICT_BLOCK", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Ne laisser qu'un seul exemplaire disponible.
      await rawSql`DELETE FROM "inventory_items" WHERE "id" IN (${ids.itemIds[1]!}, ${ids.itemIds[2]!})`;
      const input1 = makeInput(ids, { idempotencyKey: 'compete-1-' + SUFFIX() });
      const input2 = makeInput(ids, { idempotencyKey: 'compete-2-' + SUFFIX() });
      // createDatabase utilise postgres(url, { max: 10 }) : permet deux
      // transactions concurrentes sur des clients séparés.
      const db2 = createDatabase(ctx!.databaseUrl);
      try {
        const results: CreateBookingDraftResult[] = await Promise.all([
          createBookingDraftWithHold(db, input1),
          createBookingDraftWithHold(db2, input2),
        ]);
        const successes = results.filter(
          (result): result is CreateBookingDraftSuccess => result.kind === 'SUCCESS',
        );
        const failures = results.filter(
          (result): result is CreateBookingDraftFailure => result.kind === 'FAILURE',
        );

        expect(successes).toHaveLength(1);
        expect(successes[0]!.statusCode).toBe(201);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.statusCode).toBe(409);
        expect(failures[0]!.body.error).toBe('CONFLICT_BLOCK');

        // Une requête perdante ne laisse aucune donnée métier partielle.
        const activeBlocks =
          await rawSql`SELECT count(*)::int AS n FROM inventory_blocks WHERE "type" = 'HOLD' AND "status" = 'ACTIVE'`;
        expect(activeBlocks[0]!.n).toBe(1);
        const blocks = await rawSql`SELECT count(*)::int AS n FROM inventory_blocks`;
        expect(blocks[0]!.n).toBe(1);
        const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
        expect(drafts[0]!.n).toBe(1);
        const lines = await rawSql`SELECT count(*)::int AS n FROM booking_draft_lines`;
        expect(lines[0]!.n).toBe(1);
        const allocations = await rawSql`SELECT count(*)::int AS n FROM allocations`;
        expect(allocations[0]!.n).toBe(1);
      } finally {
        await db2.$client.end();
      }
    });

    // 22. Égalité exacte expires_at
    it('22. booking_drafts.expires_at = tous les inventory_blocks.expires_at du brouillon', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      const draft =
        await rawSql`SELECT expires_at FROM booking_drafts WHERE id = ${result.body.draftId}`;
      const draftExpiresAt = draft[0]!.expires_at as Date;
      const blocks =
        await rawSql`SELECT expires_at FROM inventory_blocks WHERE source_id = ${result.body.draftId}`;
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(b.expires_at.getTime()).toBe(draftExpiresAt.getTime());
      }
    });

    // 23. Intégrité multi-tenant (triggers)
    it('23. les triggers de cohérence multi-tenant sont actifs', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Tenter d'insérer un brouillon avec un lieu d'une autre org → trigger.
      const org2 = await rawSql`
      INSERT INTO "organizations" ("legal_name", "slug")
      VALUES (${'Tenant Org ' + SUFFIX()}, ${'tenant-' + SUFFIX()})
      RETURNING "id"
    `.then((r) => r[0]!);
      const loc2 = await rawSql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
      VALUES (${org2.id}, 'Other', ${'tenant-loc-' + SUFFIX()}, 'Europe/Paris', 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
      await expect(
        rawSql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot", "status", "expires_at"
        )
        VALUES (
          ${ids.orgId}, ${loc2.id}, ${ids.userId},
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
          'Europe/Paris', 30, 30,
          15000, 0, 15000,
          'DAY', 3,
          'EUR', ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: 'v1', timezone: 'Europe/Paris' })}, 'HELD', now() + interval '10 minutes'
        )
      `,
      ).rejects.toThrow();
    });

    // 24. Cohérence allocation ↔ ligne ↔ variante ↔ bloc ↔ exemplaire
    it('24. vérifie la cohérence des FK allocation ↔ ligne ↔ variante ↔ bloc ↔ exemplaire', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeInput(ids));
      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      const line = result.body.lines[0]!;
      const alloc = line.allocations[0]!;
      // Vérifier la ligne.
      const lines = await rawSql`SELECT * FROM booking_draft_lines WHERE id = ${line.lineId}`;
      expect(lines[0]!.variant_id).toBe(ids.variantId);
      expect(Number(lines[0]!.quantity)).toBe(1);
      // Vérifier l'allocation.
      const allocs = await rawSql`SELECT * FROM allocations WHERE id = ${alloc.allocationId}`;
      expect(allocs[0]!.draft_line_id).toBe(line.lineId);
      expect(allocs[0]!.inventory_block_id).toBe(alloc.inventoryBlockId);
      expect(allocs[0]!.status).toBe('ALLOCATED');
      // Vérifier le bloc.
      const blocks =
        await rawSql`SELECT * FROM inventory_blocks WHERE id = ${alloc.inventoryBlockId}`;
      expect(blocks[0]!.inventory_item_id).toBe(alloc.inventoryItemId);
      expect(blocks[0]!.type).toBe('HOLD');
      expect(blocks[0]!.source_id).toBe(result.body.draftId);
      // Vérifier l'exemplaire.
      const items = await rawSql`SELECT * FROM inventory_items WHERE id = ${alloc.inventoryItemId}`;
      expect(items[0]!.product_variant_id).toBe(ids.variantId);
      expect(items[0]!.current_location_id).toBe(ids.locationId);
    });

    // 25. Erreur SQL inattendue → rollback complet, idempotency reste PENDING
    it("25. une erreur technique laisse l'idempotency en PENDING (rollback complet)", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'tech-error-' + SUFFIX();
      // Simuler une erreur technique : supprimer la table de destination pendant
      // la transaction n'est pas faisable proprement. À la place, on provoque
      // une erreur en passant un organizationId qui n'existe pas — mais cela
      // donne NOT_FOUND (erreur métier). Pour une vraie erreur technique, on
      // peut dropper une contrainte ou utiliser un trigger qui lève une exception
      // non gérée. Approche : créer un trigger BEFORE INSERT sur booking_drafts
      // qui lève une exception SQL non 23P01.
      await rawSql`
      CREATE OR REPLACE FUNCTION temp_raise_tech_error()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Simulated technical error' USING ERRCODE = 'P0001';
      END;
      $$ LANGUAGE plpgsql
    `;
      await rawSql`
      CREATE TRIGGER temp_tech_error_trigger
      BEFORE INSERT ON "booking_drafts"
      FOR EACH ROW EXECUTE FUNCTION temp_raise_tech_error()
    `;
      try {
        await expect(
          createBookingDraftWithHold(db, makeInput(ids, { idempotencyKey: key })),
        ).rejects.toThrow();
        // L'idempotency doit rester PENDING (pas FAILED ni COMPLETED).
        const records = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
        expect(records[0]!.status).toBe('PENDING');
        // Aucun brouillon créé.
        const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
        expect(drafts[0]!.n).toBe(0);
      } finally {
        await rawSql`DROP TRIGGER IF EXISTS temp_tech_error_trigger ON "booking_drafts"`;
        await rawSql`DROP FUNCTION IF EXISTS temp_raise_tech_error()`;
      }
    });

    // 26. Stock insuffisant (tous exemplaires bloqués) → CONFLICT_BLOCK persisté comme FAILED
    //
    // Couvre le chemin normal : NOT EXISTS exclut le stock indisponible, puis
    // l'échec INSUFFICIENT_STOCK est persisté comme FAILED et rejoué.
    it('26. Stock insuffisant (tous exemplaires bloqués) → CONFLICT_BLOCK persisté comme FAILED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Bloquer manuellement les 3 exemplaires avec un bloc HOLD chevauchant
      // la période demandée. La sous-requête NOT EXISTS exclut alors tous les
      // exemplaires → INSUFFICIENT_STOCK.
      for (const itemId of ids.itemIds) {
        await rawSql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at"
        )
        VALUES (
          ${ids.orgId}, ${itemId}, 'HOLD', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', now() + interval '10 minutes'
        )
      `;
      }
      const key = 'exclusion-' + SUFFIX();
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, { idempotencyKey: key, lines: [{ variantId: ids.variantId, quantity: 1 }] }),
      );
      // Tous les exemplaires ont un bloc chevauchant → la sous-requête NOT EXISTS
      // les exclut tous → INSUFFICIENT_STOCK.
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: 'CONFLICT_BLOCK',
        details: { reason: 'INSUFFICIENT_STOCK' },
      });
      // L'échec est persisté comme FAILED.
      const records =
        await rawSql`SELECT status, response_status_code FROM idempotency_records WHERE key = ${key}`;
      expect(records[0]!.status).toBe('FAILED');
      expect(records[0]!.response_status_code).toBe(409);
    });

    // 27. Organisation inexistante avant reserveKey
    it("27. refuse une organisation inexistante sans réserver de clé d'idempotence", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'missing-org-' + SUFFIX();
      const input = makeInput(ids, { organizationId: randomUUID(), idempotencyKey: key });

      await expect(createBookingDraftWithHold(db, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        statusCode: 404,
        responseBody: { error: 'NOT_FOUND', message: 'Organisation introuvable.' },
      });
      const records =
        await rawSql`SELECT count(*)::int AS n FROM idempotency_records WHERE key = ${key}`;
      expect(records[0]!.n).toBe(0);
    });

    // 28. PricingError timezone → FAILED rejouable
    it('28. persiste puis rejoue un PricingError de fuseau IANA invalide', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'invalid-timezone-' + SUFFIX();
      await rawSql`UPDATE locations SET time_zone = 'Invalid/Timezone' WHERE id = ${ids.locationId}`;
      const input = makeInput(ids, { idempotencyKey: key });

      const result1 = await createBookingDraftWithHold(db, input);
      expectFailure(result1);
      expect(result1).toMatchObject({
        statusCode: 400,
        resourceId: null,
        body: { error: 'VALIDATION' },
      });
      const records =
        await rawSql`SELECT status, response_status_code FROM idempotency_records WHERE key = ${key}`;
      expect(records[0]).toMatchObject({ status: 'FAILED', response_status_code: 400 });

      const result2 = await createBookingDraftWithHold(db, input);
      expectFailure(result2);
      expect(result2).toEqual(result1);
    });

    // 29. PricingError overflow → FAILED rejouable avant l'allocation
    it('29. persiste puis rejoue un overflow pricing avant de créer des données métier', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'pricing-overflow-' + SUFFIX();
      await rawSql`
        UPDATE product_variants
        SET daily_price_amount_minor = ${Number.MAX_SAFE_INTEGER}
        WHERE id = ${ids.variantId}
      `;
      const input = makeInput(ids, {
        idempotencyKey: key,
        lines: [{ variantId: ids.variantId, quantity: Number.MAX_SAFE_INTEGER }],
      });

      const result1 = await createBookingDraftWithHold(db, input);
      expectFailure(result1);
      expect(result1).toMatchObject({
        statusCode: 400,
        resourceId: null,
        body: { error: 'VALIDATION', details: { pricingErrorCode: 'VALIDATION' } },
      });
      const records = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
      expect(records[0]!.status).toBe('FAILED');
      for (const table of [
        'booking_drafts',
        'booking_draft_lines',
        'inventory_blocks',
        'allocations',
      ]) {
        const count = await rawSql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
        expect(count[0]!.n).toBe(0);
      }

      const result2 = await createBookingDraftWithHold(db, input);
      expectFailure(result2);
      expect(result2).toEqual(result1);
    });

    // 30. Chemin applicatif 23P01 → FAILED rejouable
    it('30. traduit un 23P01 applicatif en CONFLICT_BLOCK FAILED et le rejoue', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'application-23p01-' + SUFFIX();
      const targetItemId = ids.itemIds[0]!;
      await rawSql.unsafe(`
        CREATE FUNCTION temp_inject_overlapping_block()
        RETURNS TRIGGER AS $$
        BEGIN
          IF current_setting('uttily.test.conflict_injected', true) IS DISTINCT FROM 'on' THEN
            PERFORM set_config('uttily.test.conflict_injected', 'on', true);
            INSERT INTO inventory_blocks (
              organization_id, inventory_item_id, type, status,
              customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, expires_at
            ) VALUES (
              NEW.organization_id, '${targetItemId}'::uuid, 'HOLD', 'ACTIVE',
              NEW.customer_start_at, NEW.customer_end_at,
              NEW.blocked_start_at, NEW.blocked_end_at,
              transaction_timestamp() + interval '10 minutes'
            );
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await rawSql`
        CREATE TRIGGER temp_inject_overlapping_block_trigger
        BEFORE INSERT ON booking_drafts
        FOR EACH ROW EXECUTE FUNCTION temp_inject_overlapping_block()
      `;

      try {
        const input = makeInput(ids, { idempotencyKey: key });
        const result1 = await createBookingDraftWithHold(db, input);
        expectFailure(result1);
        expect(result1).toMatchObject({
          statusCode: 409,
          resourceId: null,
          body: { error: 'CONFLICT_BLOCK' },
        });
        const records =
          await rawSql`SELECT status, response_status_code FROM idempotency_records WHERE key = ${key}`;
        expect(records[0]).toMatchObject({ status: 'FAILED', response_status_code: 409 });
        for (const table of ['booking_drafts', 'booking_draft_lines', 'allocations']) {
          const count = await rawSql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
          expect(count[0]!.n).toBe(0);
        }
        const blocks = await rawSql`SELECT count(*)::int AS n FROM inventory_blocks`;
        expect(blocks[0]!.n).toBe(0);

        const result2 = await createBookingDraftWithHold(db, input);
        expectFailure(result2);
        expect(result2).toEqual(result1);
      } finally {
        await rawSql`DROP TRIGGER IF EXISTS temp_inject_overlapping_block_trigger ON booking_drafts`;
        await rawSql`DROP FUNCTION IF EXISTS temp_inject_overlapping_block()`;
      }
    });

    // 31. Contrainte d'exclusion 23P01 (no_overlapping_blocks) — défense en profondeur
    //
    // Vérifie directement au niveau SQL que la contrainte d'exclusion
    // no_overlapping_blocks se déclenche (SQLSTATE 23P01) quand on tente
    // d'insérer deux blocs HOLD ACTIVE chevauchants sur le même exemplaire.
    // C'est cette erreur que isExclusionViolation (dans create-booking-draft.ts)
    // reconnaît et traduit en CONFLICT_BLOCK. Dans le flow normal de
    // createBookingDraftWithHold, la sous-requête NOT EXISTS exclut déjà les
    // exemplaires bloqués, donc le 23P01 est une défense en profondeur qui ne
    // se déclenche qu'en cas de race condition contournant la sélection.
    it('31. la contrainte no_overlapping_blocks déclenche un 23P01 sur chevauchement', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const itemId = ids.itemIds[0]!;
      const start = '2026-03-10 09:00:00+00';
      const end = '2026-03-12 17:00:00+00';
      const blockedStart = '2026-03-10 08:30:00+00';
      const blockedEnd = '2026-03-12 17:30:00+00';

      // Insère un premier bloc HOLD ACTIVE.
      await rawSql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${itemId}, 'HOLD', 'ACTIVE',
          ${start}, ${end},
          ${blockedStart}, ${blockedEnd}, now() + interval '10 minutes', null
        )
      `;

      // Tente d'insérer un second bloc chevauchant → doit échouer avec 23P01.
      try {
        await rawSql`
          INSERT INTO "inventory_blocks" (
            "organization_id", "inventory_item_id", "type", "status",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at", "expires_at"
          )
          VALUES (
            ${ids.orgId}, ${itemId}, 'HOLD', 'ACTIVE',
            ${start}, ${end},
            ${blockedStart}, ${blockedEnd}, now() + interval '10 minutes'
          )
        `;
        expect.fail('La contrainte no_overlapping_blocks aurait dû être violée (23P01).');
      } catch (err) {
        const pgErr = err as { code?: string; constraint_name?: string };
        expect(pgErr.code).toBe('23P01');
        expect(pgErr.constraint_name).toBe('no_overlapping_blocks');
      }

      // Vérifie qu'un seul bloc existe pour cet exemplaire.
      const blocks = await rawSql`
        SELECT count(*)::int AS n FROM "inventory_blocks"
        WHERE "inventory_item_id" = ${itemId} AND "deleted_at" IS NULL
      `;
      expect(blocks[0]!.n).toBe(1);
    });

    // 32. Lignes dupliquées agrégées et replay canonique
    it('32. agrège les lignes dupliquées et rejoue la même réponse dans l’ordre inverse', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const key = 'duplicate-lines-' + SUFFIX();
      const firstLine = { variantId: ids.variantId, quantity: 1 };
      const secondLine = { variantId: ids.variantId, quantity: 1 };
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, { idempotencyKey: key, lines: [firstLine, secondLine] }),
      );

      expectSuccess(result);
      expect(result.statusCode).toBe(201);
      expect(result.body.lines).toHaveLength(1);
      const line = result.body.lines[0]!;
      expect(line.quantity).toBe(2);
      expect(line.allocations).toHaveLength(2);
      expect(line.unitPriceAmountMinor).toBe(5000);
      expect(line.lineTotalAmountMinor).toBe(30000);
      expect(result.body.subtotalAmountMinor).toBe(30000);
      expect(result.body.totalAmountMinor).toBe(30000);

      const persistedLines = await rawSql`
        SELECT quantity, unit_price_amount_minor, line_total_amount_minor
        FROM booking_draft_lines
        WHERE draft_id = ${result.body.draftId}
      `;
      expect(persistedLines).toHaveLength(1);
      expect(Number(persistedLines[0]!.quantity)).toBe(2);
      expect(Number(persistedLines[0]!.unit_price_amount_minor)).toBe(5000);
      expect(Number(persistedLines[0]!.line_total_amount_minor)).toBe(30000);
      const blocks =
        await rawSql`SELECT count(*)::int AS n FROM inventory_blocks WHERE source_id = ${result.body.draftId}`;
      expect(blocks[0]!.n).toBe(2);
      const allocations = await rawSql`
        SELECT count(*)::int AS n FROM allocations WHERE draft_line_id = ${line.lineId}
      `;
      expect(allocations[0]!.n).toBe(2);

      const replay = await createBookingDraftWithHold(
        db,
        makeInput(ids, { idempotencyKey: key, lines: [secondLine, firstLine] }),
      );
      expectSuccess(replay);
      expect(replay).toEqual(result);

      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
      const replayedLines = await rawSql`SELECT count(*)::int AS n FROM booking_draft_lines`;
      expect(replayedLines[0]!.n).toBe(1);
      const replayedBlocks = await rawSql`SELECT count(*)::int AS n FROM inventory_blocks`;
      expect(replayedBlocks[0]!.n).toBe(2);
      const replayedAllocations = await rawSql`SELECT count(*)::int AS n FROM allocations`;
      expect(replayedAllocations[0]!.n).toBe(2);
    });
  },
);
