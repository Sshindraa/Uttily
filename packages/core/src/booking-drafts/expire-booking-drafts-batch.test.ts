import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold, expireBookingDraftsBatch, BookingDraftError } from './index';
import type {
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  LegacyCreateBookingDraftInput,
} from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('booking_drafts_expire');
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

interface ExpiredDraftInfo {
  draftId: string;
  blockIds: string[];
  allocationIds: string[];
}

/**
 * Crée un brouillon HELD réel via `createBookingDraftWithHold`, puis passe
 * son `expires_at` dans le passé pour le rendre éligible à l'expiration batch.
 *
 * @param periodOffset décalage en jours pour éviter les conflits de chevauchement
 *   entre plusieurs brouillons sur les mêmes exemplaires.
 */
async function createExpiredDraft(
  ids: BaseIds,
  keySuffix: string,
  periodOffsetDays: number = 0,
): Promise<ExpiredDraftInfo> {
  if (!db || !rawSql) throw new Error('db or rawSql not initialized');
  const startAt = new Date(STD_START.getTime() + periodOffsetDays * 24 * 60 * 60 * 1000);
  const endAt = new Date(STD_END.getTime() + periodOffsetDays * 24 * 60 * 60 * 1000);
  const result = await createBookingDraftWithHold(
    db,
    makeInput(ids, {
      idempotencyKey: 'expire-' + keySuffix,
      customerStartAt: startAt,
      customerEndAt: endAt,
    }),
  );
  expectSuccess(result);
  const draftId = result.body.draftId;

  // Passer expires_at dans le passé pour le rendre éligible.
  // Utiliser une seule valeur partagée pour le draft et les blocs afin que
  // l'invariant « block.expires_at === draft.expires_at » soit respecté.
  await rawSql`
    WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
    UPDATE "booking_drafts" SET "expires_at" = (SELECT ts FROM shared_ts) WHERE "id" = ${draftId}
  `;
  await rawSql`
    WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
    UPDATE "inventory_blocks" SET "expires_at" = (SELECT "expires_at" FROM shared_ts) WHERE "source_id" = ${draftId}
  `;

  const blocks = await rawSql`SELECT "id" FROM "inventory_blocks" WHERE "source_id" = ${draftId}`;
  const blockIds = blocks.map((b) => b.id);

  const allocs = await rawSql`
    SELECT a."id" FROM "allocations" a
    INNER JOIN "inventory_blocks" ib ON a."inventory_block_id" = ib."id"
    WHERE ib."source_id" = ${draftId}
  `;
  const allocationIds = allocs.map((a) => a.id);

  return { draftId, blockIds, allocationIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'expireBookingDraftsBatch — intégration PostgreSQL',
  () => {
    // 1. Batch vide
    it('1. retourne un résultat vide quand aucun brouillon expiré', async () => {
      if (!db || !rawSql) return;
      const result = await expireBookingDraftsBatch(db);
      expect(result.expired).toEqual([]);
      expect(result.anomalies).toEqual([]);
      expect(result.processedCount).toBe(0);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(0);
      expect(result.batchLimit).toBe(10);
    });

    // 2. Expiration nominale
    it('2. expire un brouillon HELD expiré : draft EXPIRED, blocs EXPIRED, allocations RELEASED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds, allocationIds } = await createExpiredDraft(ids, 'nominal');

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(1);
      expect(result.anomalyCount).toBe(0);
      expect(result.processedCount).toBe(1);
      expect(result.expired).toHaveLength(1);
      expect(result.expired[0]!.draftId).toBe(draftId);
      expect(result.expired[0]!.blockIds).toEqual(blockIds);
      expect(result.expired[0]!.allocationIds).toEqual(allocationIds);

      // Vérifier en base.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('EXPIRED');

      for (const blockId of blockIds) {
        const blocks =
          await rawSql`SELECT "status" FROM "inventory_blocks" WHERE "id" = ${blockId}`;
        expect(blocks[0]!.status).toBe('EXPIRED');
      }

      for (const allocId of allocationIds) {
        const allocs = await rawSql`SELECT "status" FROM "allocations" WHERE "id" = ${allocId}`;
        expect(allocs[0]!.status).toBe('RELEASED');
      }
    });

    // 3. Batch de 10
    it('3. expire au plus 10 brouillons avec la limite par défaut', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer 12 brouillons expirés (chacun avec quantity 1, périodes décalées
      // pour éviter les conflits de chevauchement sur les 3 exemplaires).
      const created: string[] = [];
      for (let i = 0; i < 12; i++) {
        const info = await createExpiredDraft(ids, `batch10-${i}`, i * 10);
        created.push(info.draftId);
      }

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(10);
      expect(result.processedCount).toBe(10);
      expect(result.anomalyCount).toBe(0);

      // Les 2 restants sont encore HELD.
      const expiredIds = new Set(result.expired.map((e) => e.draftId));
      const remaining = created.filter((id) => !expiredIds.has(id));
      expect(remaining).toHaveLength(2);

      for (const id of remaining) {
        const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${id}`;
        expect(drafts[0]!.status).toBe('HELD');
      }
    });

    // 4. Respect du batchLimit
    it('4. respecte un batchLimit personnalisé inférieur au nombre de candidats', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const info = await createExpiredDraft(ids, `limit-${i}`, i * 10);
        created.push(info.draftId);
      }

      const result = await expireBookingDraftsBatch(db, 3);
      expect(result.expiredCount).toBe(3);
      expect(result.processedCount).toBe(3);
      expect(result.batchLimit).toBe(3);

      const expiredIds = new Set(result.expired.map((e) => e.draftId));
      const remaining = created.filter((id) => !expiredIds.has(id));
      expect(remaining).toHaveLength(2);

      for (const id of remaining) {
        const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${id}`;
        expect(drafts[0]!.status).toBe('HELD');
      }
    });

    // 5. Exclusion PAYMENT_PROCESSING
    it('5. exclut les brouillons dont un bloc est PAYMENT_PROCESSING', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'pp-exclude');

      // Mettre un bloc en PAYMENT_PROCESSING.
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'PAYMENT_PROCESSING' WHERE "id" = ${blockIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.processedCount).toBe(0);
      expect(result.anomalyCount).toBe(0);

      // Le brouillon est encore HELD (exclu par la clause WHERE).
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 6. Draft non-HELD exclu par la clause WHERE
    // NB : l'invariant DRAFT_NOT_HELD dans le code est un contrôle défensif qui
    // ne peut pas être déclenché par concurrence externe : le verrou FOR UPDATE
    // sur la sélection empêche toute modification concurrente du statut entre la
    // sélection et la validation. Il ne peut être atteint que par un bug interne
    // à la même transaction. On teste donc ici le comportement réel observable :
    // un draft non-HELD est exclu par la clause WHERE status = 'HELD'.
    it('6. exclut les brouillons non-HELD de la sélection (WHERE status = HELD)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId } = await createExpiredDraft(ids, 'anomaly-held');

      // Changer le statut du brouillon en CANCELLED.
      await rawSql`UPDATE "booking_drafts" SET "status" = 'CANCELLED' WHERE "id" = ${draftId}`;

      const result = await expireBookingDraftsBatch(db);
      // Le draft n'est plus HELD, donc la clause WHERE l'exclut du batch.
      expect(result.expiredCount).toBe(0);
      expect(result.processedCount).toBe(0);
      expect(result.anomalyCount).toBe(0);

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('CANCELLED');
    });

    // 7. Anomalie: block not ACTIVE
    it('7. enregistre une anomalie si un bloc n’est plus ACTIVE (RELEASED)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly-block');

      // Mettre un bloc en RELEASED (non-ACTIVE, non-PAYMENT_PROCESSING pour
      // passer la clause WHERE d'exclusion).
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${blockIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('BLOCK_NOT_ACTIVE');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 8. Anomalie: allocation not ALLOCATED
    it('8. enregistre une anomalie si une allocation n’est plus ALLOCATED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, allocationIds } = await createExpiredDraft(ids, 'anomaly-alloc');

      // Mettre une allocation en RELEASED.
      await rawSql`UPDATE "allocations" SET "status" = 'RELEASED' WHERE "id" = ${allocationIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('ALLOCATION_NOT_ALLOCATED');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 9. Anomalie: block expires_at mismatch
    it('9. enregistre une anomalie si l’échéance d’un bloc ne correspond pas au draft', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly-expiry');

      // Changer l'échéance d'un bloc pour qu'elle ne corresponde plus au draft.
      await rawSql`UPDATE "inventory_blocks" SET "expires_at" = now() - interval '5 minutes' WHERE "id" = ${blockIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('BLOCK_EXPIRES_AT_MISMATCH');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 9b. Anomalie: aucun bloc associé au brouillon
    it('9b. enregistre une anomalie si le brouillon n’a aucun bloc associé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly-no-blocks');

      // Supprimer tous les blocs du brouillon (soft delete pour éviter les FK).
      // La requête de verrouillage filtre sur deleted_at IS NULL, donc les blocs
      // soft-deletés ne seront pas verrouillés et lockedBlocks sera vide.
      for (const blockId of blockIds) {
        await rawSql`UPDATE "inventory_blocks" SET "deleted_at" = now() WHERE "id" = ${blockId}`;
      }

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('NO_BLOCKS');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 9c. Anomalie: bloc avec un type incorrect (non-HOLD)
    it('9c. enregistre une anomalie si un bloc n’est pas de type HOLD', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly-type');

      // Changer le type d'un bloc en BOOKING (et expires_at NULL pour respecter
      // la contrainte inventory_blocks_expires_at_hold_only).
      await rawSql`UPDATE "inventory_blocks" SET "type" = 'BOOKING', "expires_at" = NULL WHERE "id" = ${blockIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('BLOCK_NOT_HOLD');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 9d. Anomalie: bloc avec expires_at NULL
    it('9d. enregistre une anomalie si un bloc a expires_at NULL', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly-null-expiry');

      // La contrainte inventory_blocks_expires_at_hold_only impose expires_at
      // NOT NULL pour les HOLD. On la drop temporairement pour simuler un état
      // incohérent (bug de migration / corruption) que l'invariant doit détecter.
      await rawSql`ALTER TABLE "inventory_blocks" DROP CONSTRAINT IF EXISTS "inventory_blocks_expires_at_hold_only"`;
      try {
        // Mettre expires_at NULL sur un bloc (toujours de type HOLD).
        await rawSql`UPDATE "inventory_blocks" SET "expires_at" = NULL WHERE "id" = ${blockIds[0]!}`;

        const result = await expireBookingDraftsBatch(db);
        expect(result.expiredCount).toBe(0);
        expect(result.anomalyCount).toBe(1);
        expect(result.processedCount).toBe(1);
        expect(result.anomalies[0]!.draftId).toBe(draftId);
        expect(result.anomalies[0]!.reason).toBe('BLOCK_EXPIRES_AT_NULL');

        // Le brouillon n'a pas été muté.
        const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
        expect(drafts[0]!.status).toBe('HELD');
      } finally {
        // Restaurer expires_at sur le bloc corrompu puis rétablir la contrainte.
        await rawSql`
          WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
          UPDATE "inventory_blocks" SET "expires_at" = (SELECT "expires_at" FROM shared_ts) WHERE "id" = ${blockIds[0]!}
        `;
        await rawSql`ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_expires_at_hold_only" CHECK ("type" = 'HOLD' AND "expires_at" IS NOT NULL OR "type" <> 'HOLD' AND "expires_at" IS NULL)`;
      }
    });

    // 10. Concurrence: deux workers avec barrière déterministe
    it('10. deux workers simultanés ne traitent pas les mêmes brouillons (SKIP LOCKED déterministe)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const info = await createExpiredDraft(ids, `concurrent-${i}`, i * 10);
        created.push(info.draftId);
      }

      // Trigger qui bloque worker A en acquérant un verrou advisory
      // TRANSACTIONNEL (pg_advisory_xact_lock). Contrairement à
      // pg_advisory_lock (session-level), pg_advisory_xact_lock est
      // automatiquement libéré au COMMIT/ROLLBACK de la transaction du worker,
      // ce qui évite la contamination de la connexion remise au pool.
      const advisoryKey = Math.floor(Math.random() * 2000000000) + 1;
      await rawSql!.unsafe(`
        CREATE OR REPLACE FUNCTION test_concurrent_barrier()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await rawSql!.unsafe(`
        CREATE TRIGGER test_concurrent_barrier_trigger
        BEFORE UPDATE OF status ON inventory_blocks
        FOR EACH ROW
        WHEN (NEW.status = 'EXPIRED' AND NEW.source_id = '${created[0]!}'::uuid)
        EXECUTE FUNCTION test_concurrent_barrier()
      `);

      const db2 = createDatabase(ctx!.databaseUrl);
      // Connexion dédiée (max: 1) pour le propriétaire de la barrière.
      // Garantit que pg_advisory_lock et pg_advisory_unlock s'exécutent sur
      // la même session PostgreSQL.
      const barrierConn = postgres(ctx!.databaseUrl, { max: 1 });
      try {
        // Acquérir le verrou advisory de session depuis la connexion dédiée.
        // Le trigger du worker A appellera pg_advisory_xact_lock avec la même
        // clé et bloquera jusqu'à ce que barrierConn libère le verrou.
        await barrierConn`SELECT pg_advisory_lock(${advisoryKey})`;

        // Lancer worker A. Il sélectionne les 5 brouillons (FOR UPDATE SKIP
        // LOCKED), les verrouille, puis bloque sur le trigger advisory lock
        // lors de la mise à jour du premier bloc du premier brouillon.
        const workerAPromise = expireBookingDraftsBatch(db);

        // Attendre que worker A soit bloqué sur le verrou advisory en
        // interrogeant pg_locks pour un advisory lock en attente (granted=false).
        let isBlocked = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const locks = await barrierConn`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory'
              AND objid = ${advisoryKey}
              AND granted = false
          `;
          if (locks[0]!.n > 0) {
            isBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(isBlocked).toBe(true);

        // Worker A est bloqué et détient les verrous FOR UPDATE sur les 5
        // brouillons. Lancer worker B : SKIP LOCKED doit ignorer tous les
        // brouillons verrouillés par A.
        const resultB = await expireBookingDraftsBatch(db2);
        expect(resultB.expiredCount).toBe(0);
        expect(resultB.processedCount).toBe(0);

        // Libérer le verrou advisory pour débloquer worker A.
        // Vérifier que pg_advisory_unlock retourne true (le verrou était bien
        // détenu par cette session).
        const unlockResult =
          await barrierConn`SELECT pg_advisory_unlock(${advisoryKey}) AS unlocked`;
        expect(unlockResult[0]!.unlocked).toBe(true);

        // Worker A peut maintenant terminer.
        const resultA = await workerAPromise;
        expect(resultA.expiredCount).toBe(5);
        expect(resultA.anomalyCount).toBe(0);

        // Vérifier que tous les brouillons sont expirés.
        for (const id of created) {
          const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${id}`;
          expect(drafts[0]!.status).toBe('EXPIRED');
        }
      } finally {
        // Garantir la libération du verrou même en cas d'erreur.
        await barrierConn`SELECT pg_advisory_unlock(${advisoryKey})`.catch(() => {});
        await db2.$client.end();
        await barrierConn.end();
        await rawSql`DROP TRIGGER IF EXISTS test_concurrent_barrier_trigger ON inventory_blocks`;
        await rawSql`DROP FUNCTION IF EXISTS test_concurrent_barrier()`;
      }
    });

    // 11. Rollback/interruption
    it('11. rollback complet en cas d’erreur technique : aucun brouillon muté', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const created: string[] = [];
      for (let i = 0; i < 3; i++) {
        const info = await createExpiredDraft(ids, `rollback-${i}`, i * 10);
        created.push(info.draftId);
      }

      // Créer un trigger qui lève une exception lors d'un UPDATE sur
      // inventory_blocks avec status = 'EXPIRED', pour le 2e brouillon.
      // On utilise rawSql.unsafe() car le corps de la fonction contient $$
      // qui entre en conflit avec le système de paramètres de postgres.js.
      await rawSql!.unsafe(`
        CREATE OR REPLACE FUNCTION test_rollback_expire()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.status = 'EXPIRED' AND NEW.source_id = '${created[1]!}'::uuid THEN
            RAISE EXCEPTION 'Simulated technical error for rollback test';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await rawSql`
        CREATE TRIGGER test_rollback_expire_trigger
        BEFORE UPDATE OF status ON inventory_blocks
        FOR EACH ROW
        EXECUTE FUNCTION test_rollback_expire()
      `;

      try {
        await expect(expireBookingDraftsBatch(db)).rejects.toThrow();

        // Tous les brouillons sont encore HELD (rollback complet).
        for (const id of created) {
          const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${id}`;
          expect(drafts[0]!.status).toBe('HELD');
        }
      } finally {
        // Nettoyer le trigger.
        await rawSql`DROP TRIGGER IF EXISTS test_rollback_expire_trigger ON inventory_blocks`;
        await rawSql`DROP FUNCTION IF EXISTS test_rollback_expire()`;
      }
    });

    // 12. Idempotence
    it('12. est idempotent : un second run n’expire rien', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId } = await createExpiredDraft(ids, 'idempotent');

      const result1 = await expireBookingDraftsBatch(db);
      expect(result1.expiredCount).toBe(1);

      const result2 = await expireBookingDraftsBatch(db);
      expect(result2.expiredCount).toBe(0);
      expect(result2.processedCount).toBe(0);

      // Le brouillon est bien EXPIRED.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('EXPIRED');
    });

    // 13. Validation batchLimit
    it('13. rejette un batchLimit invalide (0, négatif, > 10, non-entier)', async () => {
      if (!db) return;
      await expect(expireBookingDraftsBatch(db, 0)).rejects.toThrow(BookingDraftError);
      await expect(expireBookingDraftsBatch(db, -1)).rejects.toThrow(BookingDraftError);
      await expect(expireBookingDraftsBatch(db, 11)).rejects.toThrow(BookingDraftError);
      await expect(expireBookingDraftsBatch(db, 1.5)).rejects.toThrow(BookingDraftError);
    });

    // 14. Batch mixte : un brouillon valide + une anomalie
    it('14. traite un batch mixte : un brouillon expiré + une anomalie, sans interruption', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const validInfo = await createExpiredDraft(ids, 'mix-valid', 0);
      const anomalyInfo = await createExpiredDraft(ids, 'mix-anomaly', 10);

      // Corrompre le 2e brouillon : mettre une allocation en RELEASED.
      await rawSql`UPDATE "allocations" SET "status" = 'RELEASED' WHERE "id" = ${anomalyInfo.allocationIds[0]!}`;

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(1);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(2);

      // Le brouillon valide est EXPIRED.
      const validDraft =
        await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${validInfo.draftId}`;
      expect(validDraft[0]!.status).toBe('EXPIRED');

      // Le brouillon anomalie est encore HELD.
      const anomalyDraft =
        await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${anomalyInfo.draftId}`;
      expect(anomalyDraft[0]!.status).toBe('HELD');

      // L'anomalie est enregistrée avec la bonne raison.
      expect(result.anomalies[0]!.draftId).toBe(anomalyInfo.draftId);
      expect(result.anomalies[0]!.reason).toBe('ALLOCATION_NOT_ALLOCATED');
    });

    // 14b. Brouillon multi-exemplaires : tous les blocs et allocations sont expirés
    it('14b. expire correctement un brouillon avec plusieurs blocs (quantity > 1)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un brouillon avec quantity 3 (3 exemplaires → 3 blocs → 3 allocations)
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          idempotencyKey: 'multi-block-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      if (result.kind !== 'SUCCESS') throw new Error('Draft creation failed');
      const draftId = result.body.draftId;

      // Set expires_at to past on both draft and blocks (use the draft's
      // expires_at as the single source of truth to avoid millisecond drift
      // between separate now() calls, which would trigger BLOCK_EXPIRES_AT_MISMATCH).
      await rawSql`
        WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
        UPDATE booking_drafts SET expires_at = (SELECT ts FROM shared_ts) WHERE id = ${draftId}
      `;
      await rawSql`
        WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
        UPDATE inventory_blocks SET expires_at = (SELECT "expires_at" FROM shared_ts) WHERE source_id = ${draftId}
      `;

      const batchResult = await expireBookingDraftsBatch(db);
      expect(batchResult.expiredCount).toBe(1);
      expect(batchResult.anomalyCount).toBe(0);
      expect(batchResult.expired[0]!.blockIds).toHaveLength(3);
      expect(batchResult.expired[0]!.allocationIds).toHaveLength(3);

      // Verify all blocks are EXPIRED
      const blocks = await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId}`;
      expect(blocks).toHaveLength(3);
      for (const b of blocks) expect(b.status).toBe('EXPIRED');

      // Verify draft is EXPIRED
      const drafts = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(drafts[0]!.status).toBe('EXPIRED');
    });

    // 15. Brouillon multi-exemplaires avec un bloc PAYMENT_PROCESSING → exclu
    it('15. exclut un brouillon multi-exemplaires si un bloc est PAYMENT_PROCESSING', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un brouillon avec quantity 3
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          idempotencyKey: 'pp-multi-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      if (result.kind !== 'SUCCESS') throw new Error('Draft creation failed');
      const draftId = result.body.draftId;

      // Set expires_at to past
      await rawSql`
        WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
        UPDATE booking_drafts SET expires_at = (SELECT ts FROM shared_ts) WHERE id = ${draftId}
      `;
      await rawSql`
        WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
        UPDATE inventory_blocks SET expires_at = (SELECT "expires_at" FROM shared_ts) WHERE source_id = ${draftId}
      `;

      // Mettre un seul bloc en PAYMENT_PROCESSING
      const blocks =
        await rawSql`SELECT "id" FROM "inventory_blocks" WHERE "source_id" = ${draftId} LIMIT 1`;
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'PAYMENT_PROCESSING' WHERE "id" = ${blocks[0]!.id}`;

      const batchResult = await expireBookingDraftsBatch(db);
      expect(batchResult.expiredCount).toBe(0);
      expect(batchResult.processedCount).toBe(0); // Excluded by WHERE clause
      expect(batchResult.anomalyCount).toBe(0);

      // Le brouillon est encore HELD
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 16. Un bloc soft-deleted parmi plusieurs → anomalie de compte
    it('16. un bloc soft-deleted parmi plusieurs provoque une anomalie BLOCK_COUNT_MISMATCH', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un brouillon avec quantity 3 (3 blocs, 3 allocations)
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          idempotencyKey: 'soft-del-multi-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      if (result.kind !== 'SUCCESS') throw new Error('Draft creation failed');
      const draftId = result.body.draftId;

      // Set expires_at to past
      await rawSql`
        WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
        UPDATE booking_drafts SET expires_at = (SELECT ts FROM shared_ts) WHERE id = ${draftId}
      `;
      await rawSql`
        WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
        UPDATE inventory_blocks SET expires_at = (SELECT "expires_at" FROM shared_ts) WHERE source_id = ${draftId}
      `;

      // Soft-delete un seul bloc parmi les 3
      const blocks =
        await rawSql`SELECT "id" FROM "inventory_blocks" WHERE "source_id" = ${draftId} ORDER BY "id" LIMIT 1`;
      await rawSql`UPDATE "inventory_blocks" SET "deleted_at" = now() WHERE "id" = ${blocks[0]!.id}`;

      const batchResult = await expireBookingDraftsBatch(db);
      expect(batchResult.expiredCount).toBe(0);
      expect(batchResult.anomalyCount).toBe(1);
      expect(batchResult.processedCount).toBe(1);
      expect(batchResult.anomalies[0]!.draftId).toBe(draftId);
      expect(batchResult.anomalies[0]!.reason).toBe('BLOCK_COUNT_MISMATCH');

      // Le brouillon n'a pas été muté
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 17. Une allocation manquante parmi plusieurs → anomalie ALLOCATION_COUNT_MISMATCH
    it('17. une allocation manquante parmi plusieurs provoque une anomalie ALLOCATION_COUNT_MISMATCH', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un brouillon avec quantity 3 (3 blocs, 3 allocations)
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          idempotencyKey: 'missing-alloc-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      if (result.kind !== 'SUCCESS') throw new Error('Draft creation failed');
      const draftId = result.body.draftId;

      // Set expires_at to past
      await rawSql`
        WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
        UPDATE booking_drafts SET expires_at = (SELECT ts FROM shared_ts) WHERE id = ${draftId}
      `;
      await rawSql`
        WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
        UPDATE inventory_blocks SET expires_at = (SELECT "expires_at" FROM shared_ts) WHERE source_id = ${draftId}
      `;

      // Supprimer une allocation (delete hard — la FK est sur inventory_blocks,
      // pas de cascade, donc on peut supprimer l'allocation directement).
      const allocs =
        await rawSql`SELECT "id" FROM "allocations" WHERE "inventory_block_id" IN (SELECT "id" FROM "inventory_blocks" WHERE "source_id" = ${draftId}) ORDER BY "id" LIMIT 1`;
      await rawSql`DELETE FROM "allocations" WHERE "id" = ${allocs[0]!.id}`;

      const batchResult = await expireBookingDraftsBatch(db);
      expect(batchResult.expiredCount).toBe(0);
      expect(batchResult.anomalyCount).toBe(1);
      expect(batchResult.processedCount).toBe(1);
      expect(batchResult.anomalies[0]!.draftId).toBe(draftId);
      expect(batchResult.anomalies[0]!.reason).toBe('ALLOCATION_COUNT_MISMATCH');

      // Le brouillon n'a pas été muté
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 18. Anomalie: brouillon sans lignes
    it('18. enregistre une anomalie si le brouillon n’a aucune ligne', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId } = await createExpiredDraft(ids, 'anomaly-no-lines');

      // Supprimer les allocations puis les lignes (FK draft_line_id).
      // Le trigger d'immutabilité conditionnelle (0033) rejette DELETE de
      // draft_lines quand le parent est HELD. On désactive temporairement le
      // trigger pour simuler une anomalie (lignes manquantes).
      await rawSql`ALTER TABLE "booking_draft_lines" DISABLE TRIGGER "before_check_draft_line_immutability"`;
      try {
        await rawSql`DELETE FROM "allocations" WHERE "draft_line_id" IN (SELECT "id" FROM "booking_draft_lines" WHERE "draft_id" = ${draftId})`;
        await rawSql`DELETE FROM "booking_draft_lines" WHERE "draft_id" = ${draftId}`;
      } finally {
        await rawSql`ALTER TABLE "booking_draft_lines" ENABLE TRIGGER "before_check_draft_line_immutability"`;
      }

      const result = await expireBookingDraftsBatch(db);
      expect(result.expiredCount).toBe(0);
      expect(result.anomalyCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.anomalies[0]!.draftId).toBe(draftId);
      expect(result.anomalies[0]!.reason).toBe('NO_LINES');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 19. Anomalie: distribution d'allocations incohérente par ligne
    it('19. détecte une distribution 3/0 pour des quantités attendues 2/1 (LINE_ALLOCATION_COUNT_MISMATCH)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Créer un brouillon avec quantity 3 (1 ligne, 3 blocs, 3 allocations).
      // createBookingDraftWithHold agrège les lignes de même variante, donc on
      // obtient une seule ligne avec quantity 3 et 3 allocations.
      const result = await createBookingDraftWithHold(
        db,
        makeInput(ids, {
          idempotencyKey: 'line-mismatch-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      if (result.kind !== 'SUCCESS') throw new Error('Draft creation failed');
      const draftId = result.body.draftId;

      // Set expires_at to past
      await rawSql`
        WITH shared_ts AS (SELECT now() - interval '1 minute' AS ts)
        UPDATE booking_drafts SET expires_at = (SELECT ts FROM shared_ts) WHERE id = ${draftId}
      `;
      await rawSql`
        WITH shared_ts AS (SELECT "expires_at" FROM "booking_drafts" WHERE "id" = ${draftId})
        UPDATE inventory_blocks SET expires_at = (SELECT "expires_at" FROM shared_ts) WHERE source_id = ${draftId}
      `;

      // La ligne originale a quantity 3 et 3 allocations. On la scinde en
      // deux lignes : ligne A (quantity 2) et ligne B (quantity 1), sans
      // déplacer d'allocations. Résultat : ligne A a 3 allocations (au lieu
      // de 2), ligne B a 0 (au lieu de 1). Total global inchangé : 3 blocs,
      // 3 allocations, chaque bloc couvert. Les contrôles globaux passent,
      // mais la distribution par ligne est incohérente.
      const originalLines =
        await rawSql`SELECT * FROM "booking_draft_lines" WHERE "draft_id" = ${draftId}`;
      expect(originalLines).toHaveLength(1);
      const originalLine = originalLines[0]!;
      const lineAId = originalLine.id;

      // Réduire la quantité de la ligne A à 2.
      // Le trigger d'immutabilité conditionnelle (0033) rejette UPDATE de
      // draft_lines quand le parent est HELD. On désactive temporairement le
      // trigger pour simuler une anomalie (distribution incohérente).
      await rawSql`ALTER TABLE "booking_draft_lines" DISABLE TRIGGER "before_check_draft_line_immutability"`;
      try {
        await rawSql`UPDATE "booking_draft_lines" SET "quantity" = 2 WHERE "id" = ${lineAId}`;

        // Insérer une nouvelle ligne B avec quantity 1 (même variante, mêmes
        // champs NOT NULL copiés depuis la ligne originale).
        await rawSql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot"
          )
          VALUES (
            ${draftId}, ${originalLine.variant_id}, 1,
            ${originalLine.unit_price_amount_minor}, ${originalLine.billable_unit_count},
            ${originalLine.line_total_amount_minor}, ${originalLine.currency},
            ${originalLine.variant_snapshot}
          )
        `;
      } finally {
        await rawSql`ALTER TABLE "booking_draft_lines" ENABLE TRIGGER "before_check_draft_line_immutability"`;
      }

      // Vérifier l'état initial : ligne A a 3 allocations, ligne B en a 0.
      const allocsA =
        await rawSql`SELECT "id" FROM "allocations" WHERE "draft_line_id" = ${lineAId}`;
      expect(allocsA).toHaveLength(3);

      const batchResult = await expireBookingDraftsBatch(db);
      expect(batchResult.expiredCount).toBe(0);
      expect(batchResult.anomalyCount).toBe(1);
      expect(batchResult.processedCount).toBe(1);
      expect(batchResult.anomalies[0]!.draftId).toBe(draftId);
      expect(batchResult.anomalies[0]!.reason).toBe('LINE_ALLOCATION_COUNT_MISMATCH');

      // Le brouillon n'a pas été muté.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // Note opérationnelle : une anomalie persistante sur un brouillon ne
    // l'empêche pas d'être re-sélectionné à chaque batch (il reste HELD et
    // expiré). Le brouillon anomalie sera re-sélectionné à chaque invocation
    // jusqu'à résolution manuelle. Un volume élevé d'anomalies peut masquer
    // silencieusement des brouillons valides plus récents si le batch est
    // systématiquement saturé par des anomalies (starvation). Mitigation :
    // surveiller anomalyCount et alerter si > 0 de façon répétée.
  },
);
