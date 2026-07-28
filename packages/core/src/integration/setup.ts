import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '@uttily/database';

/**
 * Setup des tests d'intégration PostgreSQL.
 *
 * Crée une base de test dédiée (suffixée _test) à partir de DATABASE_URL,
 * applique les migrations, et expose un client Drizzle fraîchement réinitialisé
 * pour chaque test.
 *
 * Comportement selon l'environnement :
 * - En CI (CI=1) : DATABASE_URL est obligatoire et la base doit être joignable.
 *   Si ce n'est pas le cas, les tests d'intégration ÉCHOURENT (pas de skip silencieux).
 * - En local : si DATABASE_URL n'est pas définie, les tests d'intégration sont
 *   skippés (retour null — l'absence de base ne doit pas empêcher lint, typecheck,
 *   test unitaire ou build). En revanche, si DATABASE_URL est définie mais la base
 *   est injoignable, la fonction lève une erreur explicite (pas de faux vert).
 */

const DEFAULT_TEST_DB_NAME = 'uttily_test';

export interface IntegrationTestContext {
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

function isCi(): boolean {
  return process.env.CI === '1' || process.env.CI === 'true';
}

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
export function shouldSkipIntegrationTests(): boolean {
  const ci = isCi();
  if (ci) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(url: string): Promise<boolean> {
  try {
    const sql = postgres(url, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Setup des tests d'intégration PostgreSQL.
 *
 * @param suffix Suffixe optionnel pour le nom de la base de test.
 *   Permet à plusieurs fichiers de test de tourner en parallèle sans
 *   collision sur la même base (ex: "identity" → uttily_test_identity).
 */
export async function setupIntegrationTestDb(
  suffix?: string,
): Promise<IntegrationTestContext | null> {
  const url = process.env.DATABASE_URL;
  const ci = isCi();

  if (!url) {
    if (ci) {
      throw new Error(
        "CI: DATABASE_URL est requise pour les tests d'intégration PostgreSQL. " +
          'Aucun skip silencieux autorisé en CI.',
      );
    }
    return null;
  }

  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) {
      throw new Error(
        "CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI. Les tests d'intégration " +
          "PostgreSQL doivent s'exécuter.",
      );
    }
    return null;
  }

  const reachable = await checkConnectivity(url);
  if (!reachable) {
    if (ci) {
      throw new Error(
        "CI: la base PostgreSQL n'est pas joignable sur DATABASE_URL. " +
          "Les tests d'intégration ne peuvent pas être skippés en CI.",
      );
    }
    // DATABASE_URL défini mais base injoignable en local : échec explicite,
    // pas de faux vert (retour null silencieux).
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  const testDbName = suffix ? `${DEFAULT_TEST_DB_NAME}_${suffix}` : DEFAULT_TEST_DB_NAME;

  const adminSql = postgres(url, { max: 1 });

  try {
    // Recrée la base de test from scratch.
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${testDbName};`);
    await adminSql.unsafe(`CREATE DATABASE ${testDbName};`);
  } finally {
    await adminSql.end();
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${testDbName}`;
  const testUrl = testUrlObj.toString();

  // Applique les migrations.
  await runMigrations(testUrl);

  return {
    databaseUrl: testUrl,
    cleanup: async () => {
      const cleanupSql = postgres(url, { max: 1 });
      try {
        // Termine les connexions résiduelles sur la base de test
        // (le pool Drizzle peut avoir des connexions idle) avant le DROP.
        await cleanupSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid();`,
        );
        await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${testDbName};`);
      } finally {
        await cleanupSql.end();
      }
    },
  };
}
