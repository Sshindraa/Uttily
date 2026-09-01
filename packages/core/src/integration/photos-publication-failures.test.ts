import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import {
  collectPublicationFailures,
  archiveProduct,
  restoreArchivedProduct,
} from '../catalog/products';

/**
 * Tests d'intégration PostgreSQL de collectPublicationFailures avec photos
 * (G7F-A2, ADR-020 §C.2).
 *
 * Vérifie :
 * - < 3 photos valides → échec.
 * - >= 3 photos valides → pas d'échec lié aux photos.
 * - 3 photos dont doublons → échec (checksums distincts < 3).
 */

const TEST_DB_NAME = 'uttily_test_g7f_collect';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  if (!url) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(dbUrl: string): Promise<boolean> {
  try {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

let testUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci)
      throw new Error('CI: DATABASE_URL est requise pour le test collectPublicationFailures.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
});

afterAll(async () => {
  if (!url || !testUrl) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    await cleanupSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  } finally {
    await cleanupSql.end();
  }
});

interface BaseIds {
  orgId: string;
  productId: string;
  variantId: string;
}

async function seedBaseData(sql: postgres.Sql, slugSuffix?: string): Promise<BaseIds> {
  const suffix = slugSuffix ?? Math.random().toString(36).slice(2, 10);
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'kayak' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak Test', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return { orgId: org.id, productId: product.id, variantId: variant.id };
}

function fakeChecksum(seed: number): string {
  const hex = seed.toString(16).padStart(4, '0');
  return (hex + '0').repeat(32).slice(0, 64);
}

async function insertAvailablePhoto(
  sql: postgres.Sql,
  orgId: string,
  productId: string,
  checksum: string,
  storageKeySuffix?: string,
): Promise<string> {
  const suffix = storageKeySuffix ?? Math.random().toString(36).slice(2, 10);
  const photo = await sql`
    INSERT INTO product_photos (
      organization_id, product_id, storage_key,
      content_type, byte_size, width_px, height_px, checksum_sha256,
      sort_order, file_state
    )
    VALUES (
      ${orgId}, ${productId}, ${'product-photos/' + suffix},
      'image/jpeg', 102400, 800, 600, ${checksum},
      0, 'AVAILABLE'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return photo.id;
}

describe.skipIf(shouldSkipIntegrationTests())('collectPublicationFailures avec photos', () => {
  it('< 3 photos valides → échec', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'collect-0');
      // 2 photos seulement.
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(101), 'collect-0-1');
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(102), 'collect-0-2');

      const db = createDatabase(testUrl);
      try {
        const failures = await collectPublicationFailures(db, ids.productId);
        expect(failures).toContain('Au moins 3 photos valides sont requises pour la publication.');
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('>= 3 photos valides → pas d\u2019échec lié aux photos', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'collect-3');
      for (let i = 0; i < 3; i++) {
        await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(201 + i),
          `collect-3-${i}`,
        );
      }

      const db = createDatabase(testUrl);
      try {
        const failures = await collectPublicationFailures(db, ids.productId);
        expect(failures).not.toContain(
          'Au moins 3 photos valides sont requises pour la publication.',
        );
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('3 photos dont doublons → échec (checksums distincts < 3)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'collect-dup');
      // L'index unique partiel empêche 2 photos AVAILABLE avec le même checksum
      // sur le même produit. On insère donc 1 AVAILABLE + 2 PENDING.
      // Le compte distinct de checksums AVAILABLE = 1 < 3.
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(301), 'collect-dup-1');
      for (let i = 0; i < 2; i++) {
        await sql`
          INSERT INTO product_photos (
            organization_id, product_id, storage_key, file_state
          )
          VALUES (
            ${ids.orgId}, ${ids.productId}, ${'product-photos/collect-dup-p-' + i}, 'PENDING_UPLOAD'
          )
        `;
      }

      const db = createDatabase(testUrl);
      try {
        const failures = await collectPublicationFailures(db, ids.productId);
        expect(failures).toContain('Au moins 3 photos valides sont requises pour la publication.');
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });
});

/**
 * Trou de couverture P1 (Reviewer 2, lot G7F-A2) :
 * Le test « archivage produit réversible » dans catalog.test.ts utilise
 * createProductForOrg qui insère automatiquement 3 photos. Il ne vérifie
 * donc PAS le scénario critique d'un produit PUBLISHED historique sans
 * photos (existant en base avant G7F-A2) dont la restauration
 * ARCHIVED → PUBLISHED doit échouer.
 *
 * Ce test dédié crée un produit PUBLISHED sans photos en désactivant
 * temporairement les triggers (SET session_replication_role = replica),
 * puis vérifie que restoreArchivedProduct échoue avec l'erreur photo.
 */
describe.skipIf(shouldSkipIntegrationTests())(
  'ARCHIVED → PUBLISHED sans photos (produit historique pré-G7F-A2)',
  () => {
    it('restoreArchivedProduct échoue si le produit archivé n\u2019a pas 3 photos valides', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, 'restore-no-photos');

        // 1. Vérifie qu'aucune photo n'existe pour ce produit.
        const [photoRow] = await sql`
          SELECT count(*)::integer AS cnt FROM product_photos WHERE product_id = ${ids.productId}
        `;
        expect(Number(photoRow?.cnt ?? 0)).toBe(0);

        // 2. Bypass du trigger check_product_publication_photos pour simuler
        //    un produit PUBLISHED historique (pré-G7F-A2) sans photos.
        //    session_replication_role = replica désactive les triggers utilisateur.
        await sql`SET session_replication_role = replica`;
        try {
          await sql`
            UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}
          `;
        } finally {
          await sql`SET session_replication_role = origin`;
        }

        // 3. Vérifie que le produit est bien PUBLISHED en base.
        const [pubRow] = await sql`
          SELECT publication_status FROM products WHERE id = ${ids.productId}
        `;
        expect(pubRow?.publication_status).toBe('PUBLISHED');

        // 4. Archive le produit via l'API applicative.
        const db = createDatabase(testUrl);
        try {
          const archived = await archiveProduct(db, ids.orgId, ids.productId);
          expect(archived.publicationStatus).toBe('ARCHIVED');

          // 5. Tente restoreArchivedProduct → doit échouer avec l'erreur photo.
          await expect(restoreArchivedProduct(db, ids.orgId, ids.productId)).rejects.toThrow(
            /Au moins 3 photos valides/,
          );

          // 6. Le produit doit rester ARCHIVED en base après l'échec.
          const [finalRow] = await sql`
            SELECT publication_status FROM products WHERE id = ${ids.productId}
          `;
          expect(finalRow?.publication_status).toBe('ARCHIVED');

          // 7. Aucune photo n'a été créée par la tentative de restauration.
          const [finalPhotoRow] = await sql`
            SELECT count(*)::integer AS cnt FROM product_photos WHERE product_id = ${ids.productId}
          `;
          expect(Number(finalPhotoRow?.cnt ?? 0)).toBe(0);
        } finally {
          await db.$client.end();
        }
      } finally {
        await sql.end();
      }
    });
  },
);
