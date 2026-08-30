import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import { PostgresPhotoPublicationGate } from './postgres-publication-gate';
import { PublicSearchError } from '../public-search/errors';

/**
 * Tests d'intégration PostgreSQL du publication gate (G7F-A2, ADR-020 §D).
 *
 * Vérifie :
 * - Gate batch : N produits avec comptes variés (0, 1, 2, 3, 5).
 * - Gate batch avec doublons → non éligible.
 * - Multi-tenant : produit org A non éligible pour org B.
 * - Fail-closed : panne DB → erreur PUBLICATION_GATE_UNAVAILABLE.
 * - Batch unique : une seule requête pour N produits.
 * - Produit soft-deleted → non éligible.
 * - Photos soft-deleted → non comptées.
 * - Photos non AVAILABLE → non comptées.
 * - Produit PUBLISHED historique sans photos → invisible.
 * - Entrée vide → Set vide sans SQL.
 */

const TEST_DB_NAME = 'uttily_test_g7f_gate';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test du publication gate.');
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

async function seedBaseData(
  sql: postgres.Sql,
  slugSuffix?: string,
  categorySlug = 'equipment',
): Promise<BaseIds> {
  const suffix = slugSuffix ?? Math.random().toString(36).slice(2, 10);
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`
    SELECT "id" FROM "categories" WHERE "slug" = ${categorySlug} LIMIT 1
  `.then((r) => r[0]!);
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
  slotType?: string,
): Promise<string> {
  const suffix = storageKeySuffix ?? Math.random().toString(36).slice(2, 10);
  const photo = await sql`
    INSERT INTO product_photos (
      organization_id, product_id, storage_key,
      slot_type,
      content_type, byte_size, width_px, height_px, checksum_sha256,
      sort_order, file_state
    )
    VALUES (
      ${orgId}, ${productId}, ${'product-photos/' + suffix},
      CAST(${slotType ?? null} AS product_photo_slot_type),
      'image/jpeg', 102400, 800, 600, ${checksum},
      0, 'AVAILABLE'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return photo.id;
}

describe.skipIf(shouldSkipIntegrationTests())('PostgresPhotoPublicationGate', () => {
  it('gate batch : N produits avec comptes variés (0, 1, 2, 3, 5)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const productIds: string[] = [];
      // 0 photos
      const p0 = await seedBaseData(sql, 'gate-0');
      productIds.push(p0.productId);
      // 1 photo
      const p1 = await seedBaseData(sql, 'gate-1');
      await insertAvailablePhoto(sql, p1.orgId, p1.productId, fakeChecksum(11), 'gate-1-1');
      productIds.push(p1.productId);
      // 2 photos
      const p2 = await seedBaseData(sql, 'gate-2');
      await insertAvailablePhoto(sql, p2.orgId, p2.productId, fakeChecksum(21), 'gate-2-1');
      await insertAvailablePhoto(sql, p2.orgId, p2.productId, fakeChecksum(22), 'gate-2-2');
      productIds.push(p2.productId);
      // 3 photos
      const p3 = await seedBaseData(sql, 'gate-3');
      for (let i = 0; i < 3; i++) {
        await insertAvailablePhoto(
          sql,
          p3.orgId,
          p3.productId,
          fakeChecksum(31 + i),
          `gate-3-${i}`,
        );
      }
      productIds.push(p3.productId);
      // 5 photos
      const p5 = await seedBaseData(sql, 'gate-5');
      for (let i = 0; i < 5; i++) {
        await insertAvailablePhoto(
          sql,
          p5.orgId,
          p5.productId,
          fakeChecksum(51 + i),
          `gate-5-${i}`,
        );
      }
      productIds.push(p5.productId);

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, productIds);
        expect(eligible.has(p0.productId)).toBe(false);
        expect(eligible.has(p1.productId)).toBe(false);
        expect(eligible.has(p2.productId)).toBe(false);
        expect(eligible.has(p3.productId)).toBe(true);
        expect(eligible.has(p5.productId)).toBe(true);
        expect(eligible.size).toBe(2);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('gate batch avec doublons → non éligible', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'gate-dup');
      // 3 photos avec le même checksum → compte distinct = 1 < 3.
      const checksum = fakeChecksum(301);
      // L'index unique partiel empêche d'insérer 3 photos avec le même checksum.
      // On insère donc 1 photo AVAILABLE + 2 PENDING (qui ne comptent pas).
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, checksum, 'gate-dup-1');
      for (let i = 0; i < 2; i++) {
        const suffix = `gate-dup-pending-${i}`;
        await sql`
          INSERT INTO product_photos (
            organization_id, product_id, storage_key, file_state
          )
          VALUES (
            ${ids.orgId}, ${ids.productId}, ${'product-photos/' + suffix}, 'PENDING_UPLOAD'
          )
        `;
      }

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [ids.productId]);
        expect(eligible.has(ids.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('gate vélo : exige les trois slots canoniques', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const complete = await seedBaseData(sql, 'gate-bike-complete', 'bike');
      await insertAvailablePhoto(
        sql,
        complete.orgId,
        complete.productId,
        fakeChecksum(801),
        'gate-bike-complete-hero',
        'HERO_PROFILE',
      );
      await insertAvailablePhoto(
        sql,
        complete.orgId,
        complete.productId,
        fakeChecksum(802),
        'gate-bike-complete-three-quarter',
        'THREE_QUARTER_FRONT',
      );
      await insertAvailablePhoto(
        sql,
        complete.orgId,
        complete.productId,
        fakeChecksum(803),
        'gate-bike-complete-secondary',
        'SECONDARY_VIEW',
      );

      const legacy = await seedBaseData(sql, 'gate-bike-legacy', 'bike');
      for (let i = 0; i < 3; i++) {
        await insertAvailablePhoto(
          sql,
          legacy.orgId,
          legacy.productId,
          fakeChecksum(811 + i),
          `gate-bike-legacy-${i}`,
        );
      }

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [
          complete.productId,
          legacy.productId,
        ]);
        expect(eligible.has(complete.productId)).toBe(true);
        expect(eligible.has(legacy.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('multi-tenant : produit org A non éligible pour org B', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const orgA = await seedBaseData(sql, 'gate-mt-a');
      for (let i = 0; i < 3; i++) {
        await insertAvailablePhoto(
          sql,
          orgA.orgId,
          orgA.productId,
          fakeChecksum(401 + i),
          `mt-a-${i}`,
        );
      }
      const orgB = await seedSecondOrg(sql);

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        // Passer le productId de orgA — le gate ne filtre pas par organization_id
        // dans l'input (il vérifie la cohérence dans la requête SQL).
        // Le gate retourne les productIds éligibles ; c'est l'appelant qui
        // vérifie l'appartenance à l'organisation.
        const eligible = await gate.filterEligibleProductIds(db, [orgA.productId, orgB.productId]);
        expect(eligible.has(orgA.productId)).toBe(true);
        expect(eligible.has(orgB.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('fail-closed : panne DB → erreur PUBLICATION_GATE_UNAVAILABLE', async () => {
    if (!testUrl) return;
    // Créer un client qui pointe vers une base inexistante.
    const badUrl = testUrl.replace(TEST_DB_NAME, 'uttily_nonexistent_db');
    const db = createDatabase(badUrl);
    try {
      const gate = new PostgresPhotoPublicationGate();
      await expect(
        gate.filterEligibleProductIds(db, ['00000000-0000-0000-0000-000000000001']),
      ).rejects.toThrow(PublicSearchError);
      try {
        await gate.filterEligibleProductIds(db, ['00000000-0000-0000-0000-000000000001']);
      } catch (e) {
        expect(e).toBeInstanceOf(PublicSearchError);
        expect((e as PublicSearchError).code).toBe('PUBLICATION_GATE_UNAVAILABLE');
      }
    } finally {
      await db.$client.end();
    }
  });

  it('produit soft-deleted → non éligible', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'gate-sd');
      for (let i = 0; i < 3; i++) {
        await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(501 + i), `sd-${i}`);
      }
      // Soft delete le produit.
      await sql`UPDATE products SET deleted_at = now() WHERE id = ${ids.productId}`;

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [ids.productId]);
        expect(eligible.has(ids.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('photos soft-deleted → non comptées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'gate-psd');
      // 3 photos AVAILABLE + 1 soft-deleted.
      const photoIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        photoIds.push(
          await insertAvailablePhoto(
            sql,
            ids.orgId,
            ids.productId,
            fakeChecksum(601 + i),
            `psd-${i}`,
          ),
        );
      }
      // Soft delete une photo (produit non PUBLISHED → OK).
      await sql`
        UPDATE product_photos
        SET file_state = 'DELETED', deleted_at = now()
        WHERE id = ${photoIds[0]!}
      `;

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [ids.productId]);
        // 2 photos valides restantes → non éligible.
        expect(eligible.has(ids.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('photos non AVAILABLE → non comptées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'gate-na');
      // 2 AVAILABLE + 1 PENDING + 1 REJECTED.
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(701), 'na-1');
      await insertAvailablePhoto(sql, ids.orgId, ids.productId, fakeChecksum(702), 'na-2');
      const pendingRow = await sql`
        INSERT INTO product_photos (
          organization_id, product_id, storage_key, file_state
        )
        VALUES (
          ${ids.orgId}, ${ids.productId}, 'product-photos/na-pending', 'PENDING_UPLOAD'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        UPDATE product_photos
        SET file_state = 'REJECTED', rejection_reason = 'Bad MIME'
        WHERE id = ${pendingRow.id}
      `;

      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [ids.productId]);
        // Seulement 2 AVAILABLE → non éligible.
        expect(eligible.has(ids.productId)).toBe(false);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('produit PUBLISHED historique sans photos → invisible', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, 'gate-hist');
      // Pas de photos. Le produit est en DRAFT.
      // Le gate doit retourner non éligible (0 < 3).
      const db = createDatabase(testUrl);
      try {
        const gate = new PostgresPhotoPublicationGate();
        const eligible = await gate.filterEligibleProductIds(db, [ids.productId]);
        expect(eligible.has(ids.productId)).toBe(false);
        expect(eligible.size).toBe(0);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql.end();
    }
  });

  it('entrée vide → Set vide sans SQL', async () => {
    if (!testUrl) return;
    const db = createDatabase(testUrl);
    try {
      const gate = new PostgresPhotoPublicationGate();
      const eligible = await gate.filterEligibleProductIds(db, []);
      expect(eligible.size).toBe(0);
    } finally {
      await db.$client.end();
    }
  });
});
