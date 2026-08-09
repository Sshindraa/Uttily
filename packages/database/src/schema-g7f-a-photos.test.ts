import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';
import { productPhotoFileState } from '../src/schema';

/**
 * Tests d'intégration PostgreSQL du schéma G7F-A2 — métadonnées photo produit
 * et gate de publication (ADR-020, migration 0034).
 *
 * Vérifie :
 * - La migration 0034 (enum, table product_photos, FK composite, contraintes
 *   CHECK, index, triggers, fonction de comptage).
 * - Le rejeu idempotent et le rollback (DROP tout).
 * - L'alignement enum PostgreSQL / schéma Drizzle.
 * - Les états PENDING_UPLOAD, AVAILABLE, REJECTED, DELETED et leurs invariants.
 * - Les transitions autorisées et interdites de la machine d'états.
 * - L'immutabilité des champs d'identité et des métadonnées après AVAILABLE.
 * - L'isolation multi-tenant (FK composite, trigger immutability).
 * - L'index unique partiel sur checksum.
 * - Le trigger de publication (CONSTRAINT TRIGGER DEFERRABLE).
 * - Le trigger de protection contre la suppression sous le seuil (court-circuit).
 * - La concurrence (deux connexions, 4→3 jamais 4→2).
 * - L'absence d'événement outbox photo_object_cleanup.
 * - Le journal de migrations (34 entrées).
 */

const TEST_DB_NAME = 'uttily_test_g7f_a_photos';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma G7F-A2.');
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function insertPendingPhoto(
  sql: postgres.Sql,
  orgId: string,
  productId: string,
  storageKeySuffix?: string,
): Promise<string> {
  const suffix = storageKeySuffix ?? Math.random().toString(36).slice(2, 10);
  const photo = await sql`
    INSERT INTO product_photos (
      organization_id, product_id, storage_key, file_state
    )
    VALUES (
      ${orgId}, ${productId}, ${'product-photos/' + suffix}, 'PENDING_UPLOAD'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return photo.id;
}

/** Génère un checksum SHA-256 hex valide de 64 caractères. */
function fakeChecksum(seed: number): string {
  const hex = seed.toString(16).padStart(4, '0');
  return (hex + '0').repeat(32).slice(0, 64);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('G7F-A2 — Photos et gate de publication', () => {
  // =========================================================================
  // A. Migration et journal
  // =========================================================================

  describe('A. Migration 0034', () => {
    it('A1 — la migration 0034 est appliquée (table product_photos existe)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const exists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_photos'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(exists).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('A2 — rejeu idempotent : runMigrations deux fois sans erreur', async () => {
      if (!testUrl) return;
      // runMigrations est déjà appelée dans beforeAll. Appeler à nouveau ne
      // doit pas échouer (Drizzle suit les migrations appliquées).
      await runMigrations(testUrl);
      const sql = postgres(testUrl, { max: 1 });
      try {
        const exists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_photos'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(exists).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('A3 — rollback : DROP tout (triggers, fonctions, index, table, type)', async () => {
      if (!testUrl || !url) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        // Exécuter les DROP dans l'ordre inverse.
        await sql`DROP TRIGGER IF EXISTS guard_product_photo_immutability ON product_photos`;
        await sql`DROP TRIGGER IF EXISTS guard_product_photo_deletion ON product_photos`;
        await sql`DROP TRIGGER IF EXISTS check_product_publication_photos ON products`;
        await sql`DROP FUNCTION IF EXISTS guard_product_photo_immutability()`;
        await sql`DROP FUNCTION IF EXISTS guard_product_photo_deletion()`;
        await sql`DROP FUNCTION IF EXISTS check_product_publication_photos()`;
        await sql`DROP FUNCTION IF EXISTS count_valid_product_photos(uuid)`;
        await sql`DROP INDEX IF EXISTS product_photos_storage_key_unique`;
        await sql`DROP INDEX IF EXISTS product_photos_product_id_checksum_unique`;
        await sql`DROP INDEX IF EXISTS product_photos_product_id_file_state_deleted_at_idx`;
        await sql`DROP INDEX IF EXISTS product_photos_organization_id_deleted_at_idx`;
        await sql`DROP INDEX IF EXISTS product_photos_product_id_deleted_at_idx`;
        await sql`DROP TABLE IF EXISTS product_photos`;
        await sql`DROP TYPE IF EXISTS product_photo_file_state`;

        // Vérifier que tout est supprimé.
        const tableExists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_photos'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(tableExists).toBe(false);

        const typeExists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_type WHERE typname = 'product_photo_file_state'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(typeExists).toBe(false);
      } finally {
        await sql.end();
      }

      // Restaurer l'état : recréer la base de test from scratch et ré-appliquer
      // toutes les migrations. Drizzle suit les migrations par hash ; tant que
      // le hash de 0034 est présent, le migrateur ne ré-appliquera pas 0034.
      // La solution la plus fiable est de recréer la base entièrement.
      const adminSql = postgres(url, { max: 1 });
      try {
        await adminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
        );
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
        await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
      } finally {
        await adminSql.end();
      }
      await runMigrations(testUrl);
    });

    it('A4 — enum et schéma Drizzle alignés', () => {
      expect(productPhotoFileState.enumValues).toEqual([
        'PENDING_UPLOAD',
        'AVAILABLE',
        'REJECTED',
        'DELETED',
      ]);
    });

    it('A5 — journal de migrations : __drizzle_migrations a 34 entrées, _journal.json a 34 entrées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(34);

        const __dirname = dirname(fileURLToPath(import.meta.url));
        const journalPath = join(__dirname, '..', 'drizzle', 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
        expect(journal.entries.length).toBe(34);
        expect(journal.entries[33]!.tag).toBe('0034_g7f_a_product_photos');
        expect(journal.entries[33]!.idx).toBe(33);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // B. Contraintes CHECK — états et bornes
  // =========================================================================

  describe('B. Contraintes CHECK', () => {
    it('B1 — PENDING_UPLOAD sans métadonnées → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        expect(photoId).toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('B2 — AVAILABLE sans content_type → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              byte_size, width_px, height_px, checksum_sha256, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad1',
              102400, 800, 600, ${fakeChecksum(1)}, 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B3 — AVAILABLE sans byte_size → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              content_type, width_px, height_px, checksum_sha256, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad2',
              'image/jpeg', 800, 600, ${fakeChecksum(2)}, 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B4 — AVAILABLE sans width_px → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              content_type, byte_size, height_px, checksum_sha256, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad3',
              'image/jpeg', 102400, 600, ${fakeChecksum(3)}, 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B5 — AVAILABLE sans height_px → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              content_type, byte_size, width_px, checksum_sha256, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad4',
              'image/jpeg', 102400, 800, ${fakeChecksum(4)}, 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B6 — AVAILABLE sans checksum_sha256 → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              content_type, byte_size, width_px, height_px, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad5',
              'image/jpeg', 102400, 800, 600, 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B7 — checksum mal formé (non 64 hex) → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key,
              content_type, byte_size, width_px, height_px, checksum_sha256, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/bad6',
              'image/jpeg', 102400, 800, 600, 'not-a-valid-checksum', 'AVAILABLE'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B8 — storage_key vide → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, '', 'PENDING_UPLOAD'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B9 — storage_key sans préfixe product-photos/ → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'wrong-prefix/key', 'PENDING_UPLOAD'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B10 — storage_key dupliqué → refusé (unique global)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await insertPendingPhoto(sql, ids.orgId, ids.productId, 'dup-key');
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key, file_state
            )
            VALUES (
              ${ids.orgId}, ${ids.productId}, 'product-photos/dup-key', 'PENDING_UPLOAD'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('B11 — rejection_reason vide (après trim) → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await expect(
          sql`
            UPDATE product_photos
            SET file_state = 'REJECTED', rejection_reason = '   '
            WHERE id = ${photoId}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // C. Machine d\u2019états — transitions
  // =========================================================================

  describe('C. Machine d\u2019états', () => {
    it('C1 — PENDING_UPLOAD → AVAILABLE → succès', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'AVAILABLE',
              content_type = 'image/jpeg', byte_size = 102400,
              width_px = 800, height_px = 600, checksum_sha256 = ${fakeChecksum(101)}
          WHERE id = ${photoId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('AVAILABLE');
      } finally {
        await sql.end();
      }
    });

    it('C2 — PENDING_UPLOAD → REJECTED → succès', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'REJECTED', rejection_reason = 'MIME non autorisé'
          WHERE id = ${photoId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('REJECTED');
      } finally {
        await sql.end();
      }
    });

    it('C3 — PENDING_UPLOAD → DELETED → succès', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await sql.end();
      }
    });

    it('C4 — AVAILABLE → DELETED → succès (produit non PUBLISHED)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(104),
        );
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await sql.end();
      }
    });

    it('C5 — REJECTED → DELETED → succès', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'REJECTED', rejection_reason = 'Trop petit'
          WHERE id = ${photoId}
        `;
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${photoId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await sql.end();
      }
    });

    it('C6 — AVAILABLE → PENDING_UPLOAD → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(106),
        );
        await expect(
          sql`UPDATE product_photos SET file_state = 'PENDING_UPLOAD' WHERE id = ${photoId}`,
        ).rejects.toThrow(/Transition/);
      } finally {
        await sql.end();
      }
    });

    it('C7 — REJECTED → AVAILABLE → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'REJECTED', rejection_reason = 'Bad MIME'
          WHERE id = ${photoId}
        `;
        await expect(
          sql`
            UPDATE product_photos
            SET file_state = 'AVAILABLE',
                content_type = 'image/jpeg', byte_size = 102400,
                width_px = 800, height_px = 600, checksum_sha256 = ${fakeChecksum(107)}
            WHERE id = ${photoId}
          `,
        ).rejects.toThrow(/Transition/);
      } finally {
        await sql.end();
      }
    });

    it('C8 — DELETED → anything → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoId}
        `;
        await expect(
          sql`UPDATE product_photos SET file_state = 'PENDING_UPLOAD' WHERE id = ${photoId}`,
        ).rejects.toThrow(/Transition/);
      } finally {
        await sql.end();
      }
    });

    it('C9 — AVAILABLE → REJECTED → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(109),
        );
        await expect(
          sql`
            UPDATE product_photos
            SET file_state = 'REJECTED', rejection_reason = 'Changed mind'
            WHERE id = ${photoId}
          `,
        ).rejects.toThrow(/Transition/);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // D. Immutabilité
  // =========================================================================

  describe('D. Immutabilité', () => {
    it('D1 — organization_id immuable après INSERT', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const other = await seedSecondOrg(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await expect(
          sql`UPDATE product_photos SET organization_id = ${other.orgId} WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuable/);
      } finally {
        await sql.end();
      }
    });

    it('D2 — product_id immuable après INSERT', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const other = await seedSecondOrg(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await expect(
          sql`UPDATE product_photos SET product_id = ${other.productId} WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuable/);
      } finally {
        await sql.end();
      }
    });

    it('D3 — storage_key immuable après INSERT', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await expect(
          sql`UPDATE product_photos SET storage_key = 'product-photos/changed' WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuable/);
      } finally {
        await sql.end();
      }
    });

    it('D4 — métadonnées immuables après AVAILABLE (content_type)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(114),
        );
        await expect(
          sql`UPDATE product_photos SET content_type = 'image/png' WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuables/);
      } finally {
        await sql.end();
      }
    });

    it('D5 — métadonnées immuables après AVAILABLE (checksum_sha256)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(115),
        );
        await expect(
          sql`UPDATE product_photos SET checksum_sha256 = ${fakeChecksum(999)} WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuables/);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // E. Multi-tenant
  // =========================================================================

  describe('E. Multi-tenant', () => {
    it('E1 — cross-tenant INSERT refusé (FK composite)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const other = await seedSecondOrg(sql);
        // Tente d'insérer une photo avec organization_id de l'org B mais
        // product_id de l'org A → la FK composite doit rejeter.
        await expect(
          sql`
            INSERT INTO product_photos (
              organization_id, product_id, storage_key, file_state
            )
            VALUES (
              ${other.orgId}, ${ids.productId}, 'product-photos/cross-tenant', 'PENDING_UPLOAD'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('E2 — cross-tenant UPDATE refusé (trigger immutability)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const other = await seedSecondOrg(sql);
        const photoId = await insertPendingPhoto(sql, ids.orgId, ids.productId);
        await expect(
          sql`UPDATE product_photos SET organization_id = ${other.orgId} WHERE id = ${photoId}`,
        ).rejects.toThrow(/immuable/);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // F. Index unique partiel — checksum
  // =========================================================================

  describe('F. Index unique partiel', () => {
    it('F1 — checksum actif dupliqué refusé (même produit)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const checksum = fakeChecksum(201);
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, checksum, 'key-a');
        await expect(
          insertAvailablePhoto(sql, ids.orgId, ids.productId, checksum, 'key-b'),
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('F2 — checksum dupliqué sur produits différents → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const other = await seedSecondOrg(sql);
        const checksum = fakeChecksum(202);
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, checksum, 'key-c');
        // Produit différent, même checksum → OK (l'index est par product_id).
        const photoId = await insertAvailablePhoto(
          sql,
          other.orgId,
          other.productId,
          checksum,
          'key-d',
        );
        expect(photoId).toBeDefined();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // G. Trigger de publication
  // =========================================================================

  describe('G. Trigger check_product_publication_photos', () => {
    it('G1 — publication avec 0 photos → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`,
        ).rejects.toThrow(/3 photos valides/);
      } finally {
        await sql.end();
      }
    });

    it('G2 — publication avec 1 photo → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(211), 'g2-1');
        await expect(
          sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`,
        ).rejects.toThrow(/3 photos valides/);
      } finally {
        await sql.end();
      }
    });

    it('G3 — publication avec 2 photos → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(231), 'g3-1');
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(232), 'g3-2');
        await expect(
          sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`,
        ).rejects.toThrow(/3 photos valides/);
      } finally {
        await sql.end();
      }
    });

    it('G4 — publication avec 3 photos → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(241), 'g4-1');
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(242), 'g4-2');
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(243), 'g4-3');
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        const product =
          await sql`SELECT publication_status FROM products WHERE id = ${ids.productId}`.then(
            (r) => r[0]!,
          );
        expect(product.publication_status).toBe('PUBLISHED');
      } finally {
        await sql.end();
      }
    });

    it('G5 — transaction ajoutant photos puis publiant → accepté (trigger différé)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await sql`BEGIN`;
        await sql`
          INSERT INTO product_photos (
            organization_id, product_id, storage_key,
            content_type, byte_size, width_px, height_px, checksum_sha256,
            sort_order, file_state
          )
          VALUES
            (${ids.orgId}, ${ids.productId}, 'product-photos/g5-1',
             'image/jpeg', 102400, 800, 600, ${fakeChecksum(251)}, 0, 'AVAILABLE'),
            (${ids.orgId}, ${ids.productId}, 'product-photos/g5-2',
             'image/jpeg', 102400, 800, 600, ${fakeChecksum(252)}, 1, 'AVAILABLE'),
            (${ids.orgId}, ${ids.productId}, 'product-photos/g5-3',
             'image/jpeg', 102400, 800, 600, ${fakeChecksum(253)}, 2, 'AVAILABLE')
        `;
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        await sql`COMMIT`;
        const product =
          await sql`SELECT publication_status FROM products WHERE id = ${ids.productId}`.then(
            (r) => r[0]!,
          );
        expect(product.publication_status).toBe('PUBLISHED');
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // H. Trigger guard_product_photo_deletion
  // =========================================================================

  describe('H. Trigger guard_product_photo_deletion', () => {
    it('H1 — suppression 3→2 sur produit PUBLISHED → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          photoIds.push(
            await insertAvailablePhoto(
              sql,
              ids.orgId,
              ids.productId,
              fakeChecksum(310 + i),
              `h1-${i}`,
            ),
          );
        }
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        // Soft delete d'une photo → refusé (3→2).
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

    it('H2 — suppression 4→3 sur produit PUBLISHED → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoIds: string[] = [];
        for (let i = 0; i < 4; i++) {
          photoIds.push(
            await insertAvailablePhoto(
              sql,
              ids.orgId,
              ids.productId,
              fakeChecksum(320 + i),
              `h2-${i}`,
            ),
          );
        }
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        // Soft delete d'une photo → accepté (4→3).
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoIds[0]!}
        `;
        const count = await sql`
          SELECT count_valid_product_photos(${ids.productId}) AS count
        `.then((r) => r[0]!.count);
        expect(Number(count)).toBe(3);
      } finally {
        await sql.end();
      }
    });

    it('H3 — modification sort_order sans réduction → accepté (court-circuit)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          photoIds.push(
            await insertAvailablePhoto(
              sql,
              ids.orgId,
              ids.productId,
              fakeChecksum(330 + i),
              `h3-${i}`,
            ),
          );
        }
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        // Modifier sort_order seulement → accepté (court-circuit : pas de réduction).
        await sql`UPDATE product_photos SET sort_order = 5, updated_at = now() WHERE id = ${photoIds[0]!}`;
        const photo =
          await sql`SELECT sort_order FROM product_photos WHERE id = ${photoIds[0]!}`.then(
            (r) => r[0]!,
          );
        expect(photo.sort_order).toBe(5);
      } finally {
        await sql.end();
      }
    });

    it('H4 — suppression PENDING sur produit PUBLISHED sous seuil → accepté (court-circuit)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // 3 photos AVAILABLE pour permettre la publication.
        for (let i = 0; i < 3; i++) {
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(340 + i),
            `h4-avail-${i}`,
          );
        }
        // 1 photo PENDING (ne compte pas pour le seuil).
        const pendingId = await insertPendingPhoto(sql, ids.orgId, ids.productId, 'h4-pending');
        // Publier le produit (3 photos valides → OK).
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        // Supprimer la photo PENDING → accepté (court-circuit : PENDING n'est pas valide).
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${pendingId}
        `;
        const photo = await sql`SELECT file_state FROM product_photos WHERE id = ${pendingId}`.then(
          (r) => r[0]!,
        );
        expect(photo.file_state).toBe('DELETED');
        // Le produit reste PUBLISHED avec 3 photos valides.
        const count = await sql`
          SELECT count_valid_product_photos(${ids.productId}) AS count
        `.then((r) => r[0]!.count);
        expect(Number(count)).toBe(3);
      } finally {
        await sql.end();
      }
    });

    it('H5 — suppression REJECTED sur produit PUBLISHED sous seuil → accepté (court-circuit)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // 3 photos AVAILABLE + 1 REJECTED.
        for (let i = 0; i < 3; i++) {
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(350 + i),
            `h5-${i}`,
          );
        }
        const rejectedId = await insertPendingPhoto(sql, ids.orgId, ids.productId, 'h5-rejected');
        await sql`
          UPDATE product_photos
          SET file_state = 'REJECTED', rejection_reason = 'Bad MIME'
          WHERE id = ${rejectedId}
        `;
        await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;
        // Supprimer la photo REJECTED → accepté (court-circuit).
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${rejectedId}
        `;
        const photo =
          await sql`SELECT file_state FROM product_photos WHERE id = ${rejectedId}`.then(
            (r) => r[0]!,
          );
        expect(photo.file_state).toBe('DELETED');
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // I. Concurrence
  // =========================================================================

  describe('I. Concurrence', () => {
    it('I1 — deux suppressions concurrentes 4→3, jamais 4→2', async () => {
      if (!testUrl) return;
      const sql1 = postgres(testUrl, { max: 1 });
      const sql2 = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql1);
        const photoIds: string[] = [];
        for (let i = 0; i < 4; i++) {
          photoIds.push(
            await insertAvailablePhoto(
              sql1,
              ids.orgId,
              ids.productId,
              fakeChecksum(410 + i),
              `i1-${i}`,
            ),
          );
        }
        await sql1`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${ids.productId}`;

        await sql1`BEGIN`;
        await sql2`BEGIN`;

        // sql1 supprime photo 0 (4→3, OK).
        const delete1 = sql1`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoIds[0]!}
        `;
        await delete1;

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

        // Vérifier : 3 photos valides restantes.
        const count = await sql1`
          SELECT count_valid_product_photos(${ids.productId}) AS count
        `.then((r) => r[0]!.count);
        expect(Number(count)).toBe(3);
      } finally {
        await sql1.end();
        await sql2.end();
      }
    });

    it('I2 — publication concurrente avec suppression', async () => {
      if (!testUrl) return;
      const sql1 = postgres(testUrl, { max: 1 });
      const sql2 = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql1);
        const photoIds: string[] = [];
        for (let i = 0; i < 4; i++) {
          photoIds.push(
            await insertAvailablePhoto(
              sql1,
              ids.orgId,
              ids.productId,
              fakeChecksum(420 + i),
              `i2-${i}`,
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
  });

  // =========================================================================
  // J. Absence d'outbox event
  // =========================================================================

  describe('J. Outbox', () => {
    it('J1 — aucun événement photo_object_cleanup émis lors du soft delete', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const photoId = await insertAvailablePhoto(
          sql,
          ids.orgId,
          ids.productId,
          fakeChecksum(501),
          'j1-1',
        );
        // Soft delete.
        await sql`
          UPDATE product_photos
          SET file_state = 'DELETED', deleted_at = now()
          WHERE id = ${photoId}
        `;
        // Vérifier qu'aucun événement photo_object_cleanup n'existe dans outbox_events.
        const events = await sql`
          SELECT count(*) AS count FROM outbox_events
          WHERE event_type = 'photo_object_cleanup'
        `.then((r) => r[0]!.count);
        expect(Number(events)).toBe(0);
      } finally {
        await sql.end();
      }
    });
  });
});
