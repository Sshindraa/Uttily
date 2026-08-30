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
  it('applique les migrations et crée __drizzle_migrations (49 entrées)', async () => {
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
    expect(rows.length).toBe(49);

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
    expect(rows.length).toBe(49);
    await sql.end();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests du backfill 0025 : échec sur correspondance absente ou ambiguë
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'backfill 0025 — échec sur correspondance absente ou ambiguë',
  () => {
    const BACKFILL_TEST_DB_PREFIX = 'uttily_test_backfill';

    async function createTestDb(
      dbSuffix: string,
    ): Promise<{ testUrl: string; adminSql: ReturnType<typeof postgres> }> {
      if (!url) throw new Error('DATABASE_URL requise');
      const dbName = `${BACKFILL_TEST_DB_PREFIX}_${dbSuffix}`;
      const adminSql = postgres(url!, { max: 1 });
      try {
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName};`);
        await adminSql.unsafe(`CREATE DATABASE ${dbName};`);
      } finally {
        // Keep adminSql open for cleanup
      }
      const testUrlObj = new URL(url!);
      testUrlObj.pathname = `/${dbName}`;
      const testUrl = testUrlObj.toString();
      return { testUrl, adminSql };
    }

    async function cleanupTestDb(
      adminSql: ReturnType<typeof postgres>,
      dbSuffix: string,
    ): Promise<void> {
      const dbName = `${BACKFILL_TEST_DB_PREFIX}_${dbSuffix}`;
      try {
        await adminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
        );
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName};`);
      } finally {
        await adminSql.end();
      }
    }

    /**
     * Applique les migrations 0001 à 0024 (avant le backfill 0025), puis insère
     * des données de test, puis tente d'appliquer la migration 0025.
     */
    async function applyMigrationsUntilBefore0025(testUrl: string): Promise<void> {
      const sql = postgres(testUrl, { max: 1 });
      try {
        // Lire le journal des migrations pour obtenir les fichiers SQL dans l'ordre.
        const { readFileSync, readdirSync } = await import('node:fs');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const migrationsDir = join(__dirname, '..', 'drizzle');

        // Lister les fichiers de migration et appliquer 0001 à 0024 manuellement.
        const allFiles = readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        for (const file of allFiles) {
          const num = parseInt(file.slice(0, 4), 10);
          if (isNaN(num) || num >= 25) continue;
          const filePath = join(migrationsDir, file);
          const sqlContent = readFileSync(filePath, 'utf-8');
          await sql.unsafe(sqlContent);
        }
      } finally {
        await sql.end();
      }
    }

    async function applyMigration0025(testUrl: string): Promise<void> {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const migrationsDir = join(__dirname, '..', 'drizzle');
      const filePath = join(
        migrationsDir,
        '0025_reconcile_lease_token_and_payment_environment.sql',
      );
      const sqlContent = readFileSync(filePath, 'utf-8');
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql.unsafe(sqlContent);
      } finally {
        await sql.end();
      }
    }

    it("échoue si un paiement n'a pas de compte connecté correspondant (missing)", async () => {
      if (!url) return;
      const { testUrl, adminSql } = await createTestDb('missing');
      try {
        // Appliquer les migrations 0001 à 0024.
        await applyMigrationsUntilBefore0025(testUrl);

        // Insérer un paiement sans compte connecté correspondant.
        const sql = postgres(testUrl, { max: 1 });
        const orgId =
          await sql`INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code") VALUES ('Test', 'test-missing', 'FLEXIBLE') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const userId =
          await sql`INSERT INTO "users" ("email") VALUES ('test-missing@example.com') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const locationId =
          await sql`INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes") VALUES (${orgId}, 'Annecy', 'annecy-missing', 'Europe/Paris', 30, 30) RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const draftId =
          await sql`INSERT INTO "booking_drafts" ("organization_id", "location_id", "customer_user_id", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "subtotal_amount_minor", "total_amount_minor", "billable_unit_count", "cancellation_policy_snapshot", "expires_at", "status") VALUES (${orgId}, ${locationId}, ${userId}, '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', 'Europe/Paris', 30, 30, 10000, 10000, 3, ${sql.json({ code: 'FLEXIBLE' })}, '2026-02-01T00:00:00Z', 'PAYMENT_PROCESSING') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );

        // Insérer un paiement avec un connected_account_id qui n'existe pas dans organization_payment_accounts.
        await sql`INSERT INTO "payments" ("organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "currency", "tax_status", "commission_amount_minor", "financial_terms_version", "legal_terms_version", "terms_acceptance_snapshot", "connected_account_id", "charge_model", "settlement_merchant_mode") VALUES (${orgId}, ${draftId}, ${userId}, 'PENDING_PROVIDER', 10000, 'EUR', 'NOT_APPLICABLE', 500, 'v1', 'v1', ${sql.json({ termsVersion: 'v1', userId, acceptedAt: new Date().toISOString() })}, 'acct_nonexistent', 'DESTINATION', 'PLATFORM')`;
        await sql.end();

        // Tenter d'appliquer la migration 0025 — doit échouer (missing).
        await expect(applyMigration0025(testUrl)).rejects.toThrow(/Backfill incomplet/);
      } finally {
        await cleanupTestDb(adminSql, 'missing');
      }
    });

    it('échoue si un paiement a un compte connecté présent en TEST et LIVE (ambiguous)', async () => {
      if (!url) return;
      const { testUrl, adminSql } = await createTestDb('ambiguous');
      try {
        // Appliquer les migrations 0001 à 0024.
        await applyMigrationsUntilBefore0025(testUrl);

        // Insérer un paiement avec un compte connecté présent en TEST et LIVE.
        const sql = postgres(testUrl, { max: 1 });
        const orgId =
          await sql`INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code") VALUES ('Test', 'test-ambiguous', 'FLEXIBLE') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const userId =
          await sql`INSERT INTO "users" ("email") VALUES ('test-ambiguous@example.com') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const locationId =
          await sql`INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes") VALUES (${orgId}, 'Annecy', 'annecy-ambiguous', 'Europe/Paris', 30, 30) RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const draftId =
          await sql`INSERT INTO "booking_drafts" ("organization_id", "location_id", "customer_user_id", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "subtotal_amount_minor", "total_amount_minor", "billable_unit_count", "cancellation_policy_snapshot", "expires_at", "status") VALUES (${orgId}, ${locationId}, ${userId}, '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', 'Europe/Paris', 30, 30, 10000, 10000, 3, ${sql.json({ code: 'FLEXIBLE' })}, '2026-02-01T00:00:00Z', 'PAYMENT_PROCESSING') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );

        // Insérer le même compte en TEST et LIVE pour la même org.
        const accountId = 'acct_ambiguous_123';
        for (const env of ['TEST', 'LIVE'] as const) {
          await sql`INSERT INTO "organization_payment_accounts" ("organization_id", "provider", "environment", "provider_account_id", "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled", "transfers_capability_status", "settlement_merchant_mode", "controller_configuration_snapshot", "requirements_snapshot") VALUES (${orgId}, 'STRIPE', ${env}, ${accountId}, 'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true, 'ACTIVE', 'PLATFORM', ${sql.json({ preset: 'CUSTOM' })}, ${sql.json({})})`;
        }

        // Insérer un paiement avec ce compte ambigu.
        await sql`INSERT INTO "payments" ("organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "currency", "tax_status", "commission_amount_minor", "financial_terms_version", "legal_terms_version", "terms_acceptance_snapshot", "connected_account_id", "charge_model", "settlement_merchant_mode") VALUES (${orgId}, ${draftId}, ${userId}, 'PENDING_PROVIDER', 10000, 'EUR', 'NOT_APPLICABLE', 500, 'v1', 'v1', ${sql.json({ termsVersion: 'v1', userId, acceptedAt: new Date().toISOString() })}, ${accountId}, 'DESTINATION', 'PLATFORM')`;
        await sql.end();

        // Tenter d'appliquer la migration 0025 — doit échouer (ambiguous).
        await expect(applyMigration0025(testUrl)).rejects.toThrow(/Backfill ambigu/);
      } finally {
        await cleanupTestDb(adminSql, 'ambiguous');
      }
    });

    it('réussit un backfill non vide avec une correspondance unique (positive)', async () => {
      if (!url) return;
      const { testUrl, adminSql } = await createTestDb('positive');
      try {
        // Appliquer les migrations 0001 à 0024.
        await applyMigrationsUntilBefore0025(testUrl);

        // Insérer un paiement avec un compte connecté unique (TEST).
        const sql = postgres(testUrl, { max: 1 });
        const orgId =
          await sql`INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code") VALUES ('Test', 'test-positive', 'FLEXIBLE') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const userId =
          await sql`INSERT INTO "users" ("email") VALUES ('test-positive@example.com') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const locationId =
          await sql`INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes") VALUES (${orgId}, 'Annecy', 'annecy-positive', 'Europe/Paris', 30, 30) RETURNING "id"`.then(
            (r) => r[0]!.id,
          );
        const draftId =
          await sql`INSERT INTO "booking_drafts" ("organization_id", "location_id", "customer_user_id", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "subtotal_amount_minor", "total_amount_minor", "billable_unit_count", "cancellation_policy_snapshot", "expires_at", "status") VALUES (${orgId}, ${locationId}, ${userId}, '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', '2026-02-10T09:00:00Z', '2026-02-12T17:00:00Z', 'Europe/Paris', 30, 30, 10000, 10000, 3, ${sql.json({ code: 'FLEXIBLE' })}, '2026-02-01T00:00:00Z', 'PAYMENT_PROCESSING') RETURNING "id"`.then(
            (r) => r[0]!.id,
          );

        // Insérer un compte TEST unique pour cette org.
        const accountId = 'acct_positive_test';
        await sql`INSERT INTO "organization_payment_accounts" ("organization_id", "provider", "environment", "provider_account_id", "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled", "transfers_capability_status", "settlement_merchant_mode", "controller_configuration_snapshot", "requirements_snapshot") VALUES (${orgId}, 'STRIPE', 'TEST', ${accountId}, 'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true, 'ACTIVE', 'PLATFORM', ${sql.json({ preset: 'CUSTOM' })}, ${sql.json({})})`;

        // Insérer un paiement avec ce compte.
        await sql`INSERT INTO "payments" ("organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "currency", "tax_status", "commission_amount_minor", "financial_terms_version", "legal_terms_version", "terms_acceptance_snapshot", "connected_account_id", "charge_model", "settlement_merchant_mode") VALUES (${orgId}, ${draftId}, ${userId}, 'PENDING_PROVIDER', 10000, 'EUR', 'NOT_APPLICABLE', 500, 'v1', 'v1', ${sql.json({ termsVersion: 'v1', userId, acceptedAt: new Date().toISOString() })}, ${accountId}, 'DESTINATION', 'PLATFORM')`;
        await sql.end();

        // Appliquer la migration 0025 — doit réussir.
        await applyMigration0025(testUrl);

        // Vérifier que le paiement a été backfillé avec l'environnement TEST.
        const verifySql = postgres(testUrl, { max: 1 });
        const rows =
          await verifySql`SELECT "environment" FROM "payments" WHERE "connected_account_id" = ${accountId}`;
        expect(rows[0]!.environment).toBe('TEST');
        await verifySql.end();
      } finally {
        await cleanupTestDb(adminSql, 'positive');
      }
    });
  },
);
