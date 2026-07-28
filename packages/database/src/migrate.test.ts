import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '../src/index';

/**
 * Test de migration via runMigrations sur une base vierge.
 *
 * Reprend la stratégie de setupIntegrationTestDb (packages/core/src/integration/setup.ts) :
 * - utilise DATABASE_URL (obligatoire en CI, skippé localement si absente) ;
 * - crée la base via le client postgres (pas de dropdb/createdb système) ;
 * - nom unique (suffixe "migrate") pour éviter les collisions entre workers.
 */

const TEST_DB_NAME = 'uttily_test_migrate';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de migration.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    if (ci) throw new Error("CI: la base PostgreSQL n'est pas joignable sur DATABASE_URL.");
    return;
  }

  // Crée la base de test via le client postgres.
  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  testUrl = url.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
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

describe.skipIf(!ci && !url)('runMigrations — base vierge', () => {
  it('applique exactement 17 migrations 0001-0017', async () => {
    if (!testUrl) {
      // testUrl est null si la base n'était pas joignable en local (skip silencieux).
      if (ci) throw new Error('CI: testUrl ne devrait pas être null après beforeAll.');
      return;
    }
    const sql = postgres(testUrl, { max: 1 });

    // Vérifie le nombre de migrations enregistrées par runMigrations.
    const rows = await sql`SELECT filename FROM __migrations ORDER BY filename`;
    expect(rows.length).toBe(17);
    expect(rows[0]!.filename).toBe('0001_enable_extensions.sql');
    expect(rows[16]!.filename).toBe('0017_create_inventory_blocks.sql');

    // Vérifie le seed de catégories.
    const cats = await sql`SELECT count(*)::int as n FROM categories`;
    expect(cats[0]!.n).toBe(9);

    // Vérifie que les triggers critiques sont en place.
    const triggers = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'categories'::regclass AND NOT tgisinternal
      ORDER BY tgname
    `;
    const triggerNames = triggers.map((r) => r.tgname as string);
    expect(triggerNames).toContain('before_check_category_depth');
    expect(triggerNames).toContain('before_check_parent_active');
    expect(triggerNames).toContain('before_deactivate_category');

    await sql.end();
  });
});
