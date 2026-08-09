import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import { deleteProductPhoto } from '../photos/delete-product-photo';

/**
 * Tests de concurrence PostgreSQL pour les photos (G7F-A2, ADR-020 §C.5).
 *
 * Vérifie :
 * - Deux suppressions concurrentes 4→3, jamais 4→2 (deux connexions PostgreSQL).
 * - Publication concurrente avec suppression.
 *
 * Les tests utilisent deux connexions PostgreSQL indépendantes (postgres avec
 * max: 1) pour simuler une vraie concurrence, avec des transactions BEGIN/COMMIT
 * explicites et des barrières pg_advisory_lock pour contrôler l'ordre.
 */

const TEST_DB_NAME = 'uttily_test_g7f_concurrency';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests de concurrence photos.');
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
}

async function seedBaseData(sql: postgres.Sql, slugSuffix?: string): Promise<BaseIds> {
  const suffix = slugSuffix ?? Math.random().toString(36).slice(2, 10);
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  return { orgId: org.id, productId: product.id };
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

describe.skipIf(shouldSkipIntegrationTests())('Photos concurrence', () => {
  it('deux suppressions concurrentes 4→3, jamais 4→2 (deux connexions)', async () => {
    if (!testUrl) return;
    const sql1 = postgres(testUrl, { max: 1 });
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql1, 'conc-4-2');
      const photoIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql1,
            ids.orgId,
            ids.productId,
            fakeChecksum(101 + i),
            `conc-4-2-${i}`,
          ),
        );
      }
      await sql1`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

      await sql1`BEGIN`;
      await sql2`BEGIN`;

      // sql1 supprime photo 0 (4→3, OK).
      await sql1`
        UPDATE product_photos
        SET file_state = 'DELETED', deleted_at = now()
        WHERE id = ${photoIds[0]!}
      `;

      // sql2 tente de supprimer photo 1 simultanément.
      // Le trigger fait SELECT FOR UPDATE sur products → bloqué par sql1.
      const delete2 = sql2`
        UPDATE product_photos
        SET file_state = 'DELETED', deleted_at = now()
        WHERE id = ${photoIds[1]!}
      `;
      // Attendre un peu pour que sql2 se bloque.
      await Promise.race([
        delete2,
        new Promise<void>((_, reject) => setTimeout(reject, 200)),
      ]).catch(() => {});

      // sql1 commit → sql2 obtient le verrou.
      await sql1`COMMIT`;

      // sql2 devrait maintenant voir count=3, après=2 → rejet.
      let sql2Error: unknown = null;
      try {
        await delete2;
      } catch (e) {
        sql2Error = e;
      }
      expect(sql2Error).toBeTruthy();
      expect(String(sql2Error)).toMatch(/seuil de 3/);
      await sql2`ROLLBACK`;

      // Vérifier : 3 photos valides restantes (jamais 4→2).
      const count = await sql1`
        SELECT count_valid_product_photos(${ids.productId}) AS count
      `.then((r) => r[0]!.count);
      expect(Number(count)).toBe(3);
    } finally {
      await sql1.end();
      await sql2.end();
    }
  });

  it('publication concurrente avec suppression', async () => {
    if (!testUrl) return;
    const sql1 = postgres(testUrl, { max: 1 });
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql1, 'conc-pub-del');
      const photoIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql1,
            ids.orgId,
            ids.productId,
            fakeChecksum(201 + i),
            `conc-pub-del-${i}`,
          ),
        );
      }

      await sql1`BEGIN`;
      await sql2`BEGIN`;

      // sql1 publie le produit (4 photos, OK).
      await sql1`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

      // sql2 tente de supprimer une photo simultanément.
      // Le trigger fait SELECT FOR UPDATE sur products → bloqué par sql1
      // (le CONSTRAINT TRIGGER DEFERRABLE a un verrou sur products).
      const delete2 = sql2`
        UPDATE product_photos
        SET file_state = 'DELETED', deleted_at = now()
        WHERE id = ${photoIds[0]!}
      `;
      await Promise.race([
        delete2,
        new Promise<void>((_, reject) => setTimeout(reject, 200)),
      ]).catch(() => {});

      // sql1 commit → publication confirmée.
      await sql1`COMMIT`;

      // sql2 obtient le verrou, compte=4, après=3 → OK.
      await delete2;
      await sql2`COMMIT`;

      const count = await sql1`
        SELECT count_valid_product_photos(${ids.productId}) AS count
      `.then((r) => r[0]!.count);
      expect(Number(count)).toBe(3);
    } finally {
      await sql1.end();
      await sql2.end();
    }
  });

  it('deux deleteProductPhoto concurrents 4→3, jamais 4→2 (via Core)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    const ids = await seedBaseData(sql, 'conc-core-4-2');
    const photoIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      photoIds.push(
        await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(301 + i),
          `conc-core-4-2-${i}`,
        ),
      );
    }
    await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
    await sql.end();

    // Deux clients Drizzle indépendants pour simuler la concurrence.
    const db1 = createDatabase(testUrl);
    const db2 = createDatabase(testUrl);
    try {
      // Lancer deux deleteProductPhoto en parallèle.
      const [r1, r2] = await Promise.allSettled([
        deleteProductPhoto(db1, ids.orgId, photoIds[0]!),
        deleteProductPhoto(db2, ids.orgId, photoIds[1]!),
      ]);

      // Au moins une doit réussir (4→3). L'autre doit échouer (3→2).
      const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
      const failed = [r1, r2].filter((r) => r.status === 'rejected');
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);

      // Vérifier : 3 photos valides restantes.
      const sql2 = postgres(testUrl, { max: 1 });
      try {
        const count = await sql2`
          SELECT count_valid_product_photos(${ids.productId}) AS count
        `.then((r) => r[0]!.count);
        expect(Number(count)).toBe(3);
      } finally {
        await sql2.end();
      }
    } finally {
      await db1.$client.end();
      await db2.$client.end();
    }
  });
});
