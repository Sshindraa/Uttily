import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Test de migration via runMigrations sur une base vierge.
 *
 * Reprend la stratégie de setupIntegrationTestDb (packages/core/src/integration/setup.ts) :
 * - utilise DATABASE_URL (obligatoire en CI, skippé localement si absente) ;
 * - crée la base via le client postgres (pas de dropdb/createdb système) ;
 * - nom unique (suffixe "migrate") pour éviter les collisions entre workers.
 *
 * Vérifie que le migrateur officiel Drizzle (`drizzle-orm/postgres-js/migrator`)
 * est utilisé en lieu et place du runner maison (table `__migrations` retirée).
 * Le suivi Drizzle Kit s'appuie sur la table `__drizzle_migrations`.
 */

const TEST_DB_NAME = 'uttily_test_migrate';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
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
    // Skip accepté uniquement quand DATABASE_URL est absente en local.
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de migration.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    // DATABASE_URL défini mais base injoignable : échec explicite, pas de faux vert.
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  // Crée la base de test via le client postgres.
  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
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

describe.skipIf(shouldSkipIntegrationTests())('runMigrations — base vierge via Drizzle Kit', () => {
  it('applique les migrations et crée __drizzle_migrations (20 entrées)', async () => {
    if (!testUrl) {
      // Garde de sécurité : ne devrait plus être atteint car describe.skipIf
      // (shouldSkipIntegrationTests) skipe toute la suite quand la base est absente
      // ou SKIP_INTEGRATION_TESTS=1, et le setup throw si la base est injoignable.
      // Conservé par défense en profondeur.
      return;
    }
    const sql = postgres(testUrl, { max: 1 });

    // Vérifie la table de suivi Drizzle (et non l'ancienne __migrations).
    // Drizzle Kit crée __drizzle_migrations dans le schéma "drizzle".
    const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    expect(rows.length).toBe(20);

    // Vérifie le seed de catégories.
    const cats = await sql`SELECT count(*)::int as n FROM categories`;
    expect(cats[0]!.n).toBe(9);

    // Vérifie les extensions.
    const exts =
      await sql`SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'btree_gist') ORDER BY extname`;
    const extNames = exts.map((r) => r.extname as string);
    expect(extNames).toContain('postgis');
    expect(extNames).toContain('btree_gist');

    // Vérifie les triggers critiques sur categories.
    const triggers = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'categories'::regclass AND NOT tgisinternal
      ORDER BY tgname
    `;
    const triggerNames = triggers.map((r) => r.tgname as string);
    expect(triggerNames).toContain('before_check_category_depth');
    expect(triggerNames).toContain('before_check_parent_active');
    expect(triggerNames).toContain('before_deactivate_category');

    // Vérifie la contrainte d'exclusion du Lot 3.
    const constraints = await sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'inventory_blocks'::regclass AND conname = 'no_overlapping_blocks'
    `;
    expect(constraints.length).toBe(1);

    // Vérifie les tables Lot 4.
    const lot4Tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('booking_drafts', 'booking_draft_lines', 'allocations', 'idempotency_records')
      ORDER BY tablename
    `;
    expect(lot4Tables.length).toBe(4);

    // Vérifie la colonne prix sur product_variants.
    const priceCol = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'product_variants' AND column_name = 'daily_price_amount_minor'
    `;
    expect(priceCol.length).toBe(1);

    // Vérifie la politique d'annulation sur organizations.
    const policyCol = await sql`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'default_cancellation_policy_code'
    `;
    expect(policyCol.length).toBe(1);
    expect(policyCol[0]!.column_default).toContain('FLEXIBLE');

    // Vérifie les marges sur locations.
    const bufferCols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'locations' AND column_name IN ('prep_buffer_minutes', 'cleanup_buffer_minutes')
      ORDER BY column_name
    `;
    expect(bufferCols.length).toBe(2);

    // Vérifie qu'aucune table __migrations maison n'a été créée par le code.
    const legacyTables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = '__migrations'
    `;
    expect(legacyTables.length).toBe(0);

    await sql.end();
  });

  it('ne réapplique pas les migrations au rejeu (idempotence)', async () => {
    if (!testUrl) {
      // Garde de sécurité : voir commentaire du test précédent.
      return;
    }
    // Second appel : ne doit pas dupliquer les entrées.
    await runMigrations(testUrl);
    const sql = postgres(testUrl, { max: 1 });
    const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    expect(rows.length).toBe(20);
    await sql.end();
  });
});
