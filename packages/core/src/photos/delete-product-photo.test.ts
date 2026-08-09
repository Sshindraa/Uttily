import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import { deleteProductPhoto } from './delete-product-photo';
import { PhotoError } from './errors';

/**
 * Tests d'intégration PostgreSQL de deleteProductPhoto (G7F-A2, ADR-020 §C.4).
 *
 * Vérifie :
 * - PUBLISHED avec 3 photos → erreur PHOTO_DELETION_WOULD_BREAK_PUBLICATION.
 * - PUBLISHED avec 4 photos → succès (reste 3).
 * - ARCHIVED avec 3 photos → succès.
 * - Aucun outbox event émis.
 * - Trigger defense-in-depth rejette aussi.
 * - Idempotence : double delete → OK.
 * - Multi-tenant : photo d'une autre org → PHOTO_NOT_FOUND.
 */

const TEST_DB_NAME = 'uttily_test_g7f_delete';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test deleteProductPhoto.');
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

async function seedSecondOrg(sql: postgres.Sql): Promise<{ orgId: string; productId: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Other Org ' + suffix}, ${'other-org-' + suffix}, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Other Kayak', ${'other-kayak-' + suffix})
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

describe.skipIf(shouldSkipIntegrationTests())('deleteProductPhoto', () => {
  it('PUBLISHED avec 3 photos → erreur PHOTO_DELETION_WOULD_BREAK_PUBLICATION', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-3');
      const photoIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(101 + i),
            `del-3-${i}`,
          ),
        );
      }
      await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

      const db = createDatabase(testUrl);
      try {
        await expect(deleteProductPhoto(db, ids.orgId, photoIds[0]!)).rejects.toThrow(PhotoError);
        try {
          await deleteProductPhoto(db, ids.orgId, photoIds[0]!);
        } catch (e) {
          expect(e).toBeInstanceOf(PhotoError);
          expect((e as PhotoError).code).toBe('PHOTO_DELETION_WOULD_BREAK_PUBLICATION');
        }
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('PUBLISHED avec 4 photos → succès (reste 3)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-4');
      const photoIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(201 + i),
            `del-4-${i}`,
          ),
        );
      }
      await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

      const db = createDatabase(testUrl);
      try {
        await deleteProductPhoto(db, ids.orgId, photoIds[0]!);
        // Vérifier que la photo est soft-deleted.
        const photo =
          await sql`SELECT file_state, deleted_at FROM product_photos WHERE id = ${photoIds[0]!}`.then(
            (r) => r[0]!,
          );
        expect(photo.file_state).toBe('DELETED');
        expect(photo.deleted_at).not.toBeNull();
        // 3 photos valides restantes.
        const count = await sql`
          SELECT count_valid_product_photos(${ids.productId}) AS count
        `.then((r) => r[0]!.count);
        expect(Number(count)).toBe(3);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('ARCHIVED avec 3 photos → succès', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-arch');
      const photoIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(301 + i),
            `del-arch-${i}`,
          ),
        );
      }
      // D'abord publier, puis archiver.
      await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
      await sql`UPDATE products SET publication_status = 'ARCHIVED' WHERE id = ${ids.productId}`;

      const db = createDatabase(testUrl);
      try {
        await deleteProductPhoto(db, ids.orgId, photoIds[0]!);
        const photo =
          await sql`SELECT file_state FROM product_photos WHERE id = ${photoIds[0]!}`.then(
            (r) => r[0]!,
          );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('aucun outbox event émis', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-outbox');
      const photoId = await insertAvailablePhoto(
        sql,
        ids.orgId,
        ids.productId,
        fakeChecksum(401),
        'del-outbox-1',
      );

      const db = createDatabase(testUrl);
      try {
        await deleteProductPhoto(db, ids.orgId, photoId);
      } finally {
        await db.$client.end();
      }

      const events = await sql`
        SELECT count(*) AS count FROM outbox_events
        WHERE event_type = 'photo_object_cleanup'
      `.then((r) => r[0]!.count);
      expect(Number(events)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('trigger defense-in-depth rejette aussi (SQL direct)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-trigger');
      const photoIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(501 + i),
            `del-trigger-${i}`,
          ),
        );
      }
      await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

      // SQL direct : le trigger guard_product_photo_deletion doit rejeter.
      await expect(
        sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoIds[0]!}
        `,
      ).rejects.toThrow(/seuil de 3/);
    } finally {
      await sql.end();
    }
  });

  it('idempotence : double delete → OK', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-idem');
      const photoId = await insertAvailablePhoto(
        sql,
        ids.orgId,
        ids.productId,
        fakeChecksum(601),
        'del-idem-1',
      );

      const db = createDatabase(testUrl);
      try {
        // Premier delete.
        await deleteProductPhoto(db, ids.orgId, photoId);
        // Second delete (idempotence) → pas d'erreur.
        await deleteProductPhoto(db, ids.orgId, photoId);
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('multi-tenant : photo d\u2019une autre org → PHOTO_NOT_FOUND', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'del-mt-a');
      const other = await seedSecondOrg(sql);
      const photoId = await insertAvailablePhoto(
        sql,
        ids.orgId,
        ids.productId,
        fakeChecksum(701),
        'del-mt-1',
      );

      const db = createDatabase(testUrl);
      try {
        // Tenter de supprimer la photo de org A avec org B → PHOTO_NOT_FOUND.
        await expect(deleteProductPhoto(db, other.orgId, photoId)).rejects.toThrow(PhotoError);
        try {
          await deleteProductPhoto(db, other.orgId, photoId);
        } catch (e) {
          expect(e).toBeInstanceOf(PhotoError);
          expect((e as PhotoError).code).toBe('PHOTO_NOT_FOUND');
        }
        // La photo n'a pas été supprimée.
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('AVAILABLE');
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });
});
