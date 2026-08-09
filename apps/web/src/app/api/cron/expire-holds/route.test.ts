import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import postgres from 'postgres';
import { createDatabase, runMigrations, assertLocalhost } from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import { createBookingDraftWithHold } from '@uttily/core';
import type {
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  LegacyCreateBookingDraftInput,
} from '@uttily/core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : getDb.
//
// Le route handler dépend du singleton `getDb()`. On le mocke pour brancher
// une base de test PostgreSQL réelle.
// ---------------------------------------------------------------------------

// `getDb` est mocké pour retourner le client de test. On l'injecte via
// une variable mutable afin de pouvoir la réinitialiser entre les tests.
let testDb: DatabaseClient | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

// Importe le route handler APRÈS les mocks pour qu'il utilise la version mockée.
const { GET } = await import('./route');

// ---------------------------------------------------------------------------
// Setup base de test (réplique minimale de setupIntegrationTestDb).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttily_test_cron_expire';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
function shouldSkipIntegrationTests(): boolean {
  if (isCi) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

let adminUrl: string | null = null;
let testUrl: string | null = null;
let adminSql: ReturnType<typeof postgres> | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

const CRON_SECRET = 'test-cron-secret-for-vitest';

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET;

  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isCi) throw new Error("CI: DATABASE_URL est requise pour les tests d'action.");
    return;
  }

  // Vérifie la connectivité.
  adminSql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await adminSql`SELECT 1`;
  } catch {
    await adminSql.end();
    adminSql = null;
    if (isCi) throw new Error('CI: base PostgreSQL non joignable.');
    // DATABASE_URL défini mais base injoignable en local : échec explicite,
    // pas de faux vert (skip silencieux).
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  adminUrl = url;

  // Crée la base de test.
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
    adminSql = null;
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);

  testDb = createDatabase(testUrl);
  rawSql = postgres(testUrl, { max: 5 });
});

afterAll(async () => {
  delete process.env.CRON_SECRET;

  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (testDb) {
    await testDb.$client.end();
    testDb = null;
  }
  if (adminUrl) {
    const cleanupSql = postgres(adminUrl, { max: 1 });
    try {
      await cleanupSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
      );
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    } finally {
      await cleanupSql.end();
    }
  }
});

beforeEach(async () => {
  // Garde de sécurité : ne devrait plus être atteint car describe.skipIf
  // (shouldSkipIntegrationTests) skipe toute la suite quand la base est absente
  // ou SKIP_INTEGRATION_TESTS=1, et le setup throw si la base est injoignable.
  // Conservé par défense en profondeur.
  if (!testDb) return;
  // TRUNCATE réinitialise les tables (RESTART IDENTITY). Les catégories
  // seedées ne sont pas tronquées.
  await testDb.execute(
    sql`TRUNCATE TABLE allocations, booking_draft_lines, booking_drafts, inventory_blocks, inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users, idempotency_records RESTART IDENTITY CASCADE`,
  );
});

// ---------------------------------------------------------------------------
// Helpers de test.
// ---------------------------------------------------------------------------

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
  const s = rawSql;
  const org = await s`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await s`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await s`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await s`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await s`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await s`
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
  await s`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  const variant = await s`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await s`
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
): Promise<{ draftId: string; blockIds: string[] }> {
  if (!testDb || !rawSql) throw new Error('testDb or rawSql not initialized');
  const startAt = new Date(STD_START.getTime() + periodOffsetDays * 24 * 60 * 60 * 1000);
  const endAt = new Date(STD_END.getTime() + periodOffsetDays * 24 * 60 * 60 * 1000);
  const result = await createBookingDraftWithHold(
    testDb,
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

  return { draftId, blockIds };
}

/**
 * Crée un objet Request avec le header Authorization optionnel.
 */
function makeRequest(secret?: string): Request {
  const headers = new Headers();
  if (secret) {
    headers.set('Authorization', `Bearer ${secret}`);
  }
  return new Request('http://localhost/api/cron/expire-holds', { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'GET /api/cron/expire-holds — intégration PostgreSQL',
  () => {
    // 1. Unauthorized — pas de header Authorization
    it('1. retourne 401 sans header Authorization', async () => {
      const response = await GET(makeRequest());
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    // 2. Unauthorized — secret incorrect
    it('2. retourne 401 avec un secret incorrect', async () => {
      const response = await GET(makeRequest('wrong-secret'));
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    // 3. Batch vide — auth valide, aucun brouillon expiré
    it('3. retourne 200 avec tous les compteurs à 0 quand aucun brouillon expiré', async () => {
      if (!testDb) return;
      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.processedCount).toBe(0);
      expect(body.expiredCount).toBe(0);
      expect(body.anomalyCount).toBe(0);
      expect(body.batchLimit).toBe(10);
    });

    // 4. Succès — un brouillon expiré est traité
    it('4. retourne 200 avec expiredCount=1 quand un brouillon expiré existe', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId } = await createExpiredDraft(ids, 'success');

      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.processedCount).toBe(1);
      expect(body.expiredCount).toBe(1);
      expect(body.anomalyCount).toBe(0);
      expect(body.batchLimit).toBe(10);

      // Aucune donnée sensible (draftId) ne doit être dans la réponse.
      expect(JSON.stringify(body)).not.toContain(draftId);

      // Vérifier en base que le draft est bien EXPIRED.
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('EXPIRED');
    });

    // 5. Anomalie — un bloc n'est plus ACTIVE
    it('5. retourne 200 avec anomalyCount=1 et expiredCount=0 quand un bloc est RELEASED', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, blockIds } = await createExpiredDraft(ids, 'anomaly');

      // Mettre un bloc en RELEASED (non-ACTIVE, non-PAYMENT_PROCESSING pour
      // passer la clause WHERE d'exclusion).
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${blockIds[0]!}`;

      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.processedCount).toBe(1);
      expect(body.expiredCount).toBe(0);
      expect(body.anomalyCount).toBe(1);
      expect(body.batchLimit).toBe(10);

      // Aucune donnée sensible (draftId) ne doit être dans la réponse.
      expect(JSON.stringify(body)).not.toContain(draftId);

      // Le brouillon est encore HELD (anomalie → skip, pas de mutation).
      const drafts = await rawSql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(drafts[0]!.status).toBe('HELD');
    });

    // 6. Erreur technique — getDb retourne null → 500
    it("6. retourne 500 en cas d'erreur technique (db indisponible)", async () => {
      if (!testDb) return;
      const originalDb = testDb;
      testDb = null as unknown as DatabaseClient; // Force une erreur
      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal Server Error');
      } finally {
        testDb = originalDb;
      }
    });

    // 7. Fail-closed — CRON_SECRET absent de l'environnement
    it('7. retourne 401 quand CRON_SECRET est absent (fail-closed)', async () => {
      if (!testDb) return;
      const savedSecret = process.env.CRON_SECRET;
      delete process.env.CRON_SECRET;
      try {
        // Envoyer un header ressemblant à un secret valide : le handler doit
        // quand même refuser car le secret de référence est absent.
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
      } finally {
        process.env.CRON_SECRET = savedSecret;
      }
    });

    // 8. Logs structurés — vérifie le format JSON et les métriques ADR-009
    it('8. logue des événements structurés avec durationMs et expiredHoldCount', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      await createExpiredDraft(ids, 'logging');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Log de succès présent.
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logCall = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(logCall.event).toBe('cron.expire-holds');
        expect(logCall.durationMs).toBeGreaterThanOrEqual(0);
        expect(logCall.expiredDraftCount).toBe(1);
        expect(logCall.expiredHoldCount).toBeGreaterThanOrEqual(1);
        expect(logCall.processedCount).toBe(1);
        expect(logCall.anomalyCount).toBe(0);
        expect(logCall.batchLimit).toBe(10);

        // Pas de warn d'anomalie ni d'erreur.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    // 9. Log d'anomalie — warn quand anomalyCount > 0
    it('9. logue un warn structuré quand anomalyCount > 0', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { blockIds } = await createExpiredDraft(ids, 'anomaly-log');

      // Corrompre un bloc pour provoquer une anomalie.
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${blockIds[0]!}`;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Log de succès présent.
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logCall = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(logCall.event).toBe('cron.expire-holds');
        expect(logCall.anomalyCount).toBe(1);
        expect(logCall.expiredDraftCount).toBe(0);
        expect(logCall.expiredHoldCount).toBe(0);

        // Warn d'anomalie présent.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warnCall = JSON.parse(warnSpy.mock.calls[0]![0] as string);
        expect(warnCall.event).toBe('cron.expire-holds.anomalies');
        expect(warnCall.anomalyCount).toBe(1);
        expect(warnCall.reasons).toEqual(['BLOCK_NOT_ACTIVE']);
        expect(warnCall.durationMs).toBeGreaterThanOrEqual(0);

        // Pas d'erreur.
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    // 10. Log d'erreur — error quand le batch échoue
    it("10. logue une erreur structurée en cas d'échec technique", async () => {
      if (!testDb) return;
      const originalDb = testDb;
      testDb = null as unknown as DatabaseClient;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(500);

        // Error log présent.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const errorCall = JSON.parse(errorSpy.mock.calls[0]![0] as string);
        expect(errorCall.event).toBe('cron.expire-holds.error');
        expect(errorCall.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof errorCall.error).toBe('string');

        // Pas de log de succès ni de warn.
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        testDb = originalDb;
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  },
);
