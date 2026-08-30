import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { assertLocalhost, runMigrations } from '../src/index';

/**
 * Tests PostgreSQL réels pour la migration 0038 (public_id immuable sur product_variants).
 */

const TEST_DB_NAME = 'uttily_test_product_variants_public_id';
const UPGRADE_DB_NAME = 'uttily_test_product_variants_public_id_upgrade';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  return !url || process.env.SKIP_INTEGRATION_TESTS === '1';
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
let upgradeUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests de migration.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  if (!(await checkConnectivity(url))) {
    throw new Error('DATABASE_URL est définie mais PostgreSQL est injoignable.');
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${UPGRADE_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  const upgradeUrlObj = new URL(url);
  upgradeUrlObj.pathname = `/${UPGRADE_DB_NAME}`;
  upgradeUrl = upgradeUrlObj.toString();
  await runMigrations(testUrl);
}, 600000);

afterAll(async () => {
  if (!url) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    for (const dbName of [TEST_DB_NAME, UPGRADE_DB_NAME]) {
      await cleanupSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      );
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${dbName};`);
    }
  } finally {
    await cleanupSql.end();
  }
});

async function runMigrationsFromFolder(dbUrl: string, folder: string): Promise<void> {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const migrationClient = postgres(dbUrl, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: folder });
  } finally {
    await migrationClient.end();
  }
}

async function createMigrationFolder(migrationCount: number): Promise<string> {
  const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } =
    await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { tmpdir } = await import('node:os');
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const tempDir = mkdtempSync(join(tmpdir(), 'pv-public-id-upgrade-'));
  const tempMetaDir = join(tempDir, 'meta');
  mkdirSync(tempMetaDir, { recursive: true });

  for (const file of readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const number = Number.parseInt(file.slice(0, 4), 10);
    if (number >= 1 && number <= migrationCount) {
      copyFileSync(join(sourceDir, file), join(tempDir, file));
    }
  }
  for (const file of readdirSync(join(sourceDir, 'meta'))
    .filter((entry) => entry.endsWith('.json') && entry !== '_journal.json')
    .sort()) {
    const number = Number.parseInt(file.slice(0, 4), 10);
    if (number >= 1 && number <= migrationCount) {
      copyFileSync(join(sourceDir, 'meta', file), join(tempMetaDir, file));
    }
  }
  const journal = JSON.parse(readFileSync(join(sourceDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  journal.entries = journal.entries.slice(0, migrationCount);
  writeFileSync(join(tempMetaDir, '_journal.json'), JSON.stringify(journal, null, 2));
  return tempDir;
}

async function appendMigration(folder: string, index: number): Promise<void> {
  const { copyFileSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const journal = JSON.parse(readFileSync(join(sourceDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries[index];
  if (!entry) throw new Error(`Migration index ${index} not found`);
  copyFileSync(join(sourceDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  const snapshot = `${entry.tag}.json`;
  if (readdirSync(join(sourceDir, 'meta')).includes(snapshot)) {
    copyFileSync(join(sourceDir, 'meta', snapshot), join(folder, 'meta', snapshot));
  }
  const tempJournal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  tempJournal.entries = journal.entries.slice(0, index + 1);
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(tempJournal, null, 2));
}

async function migrationCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  return rows[0]!.count;
}

describe.skipIf(shouldSkipIntegrationTests())(
  '0038_product_variants_public_id — migration et contraintes',
  () => {
    it('1. Applique la migration 0038 et vérifie le journal Drizzle', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        expect(await migrationCount(sql)).toBe(50);
        const rows = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
        expect(rows).toHaveLength(50);

        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const journalPath = join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          'drizzle',
          'meta',
          '_journal.json',
        );
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
          entries: Array<{ tag: string }>;
        };
        expect(journal.entries.some((e) => e.tag === '0038_product_variants_public_id')).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('2. Nouvelle variante reçoit automatiquement un public_id UUID distinct de son id interne', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const org = await sql`
        INSERT INTO organizations (legal_name, slug)
        VALUES ('Org PV Test', 'org-pv-test')
        RETURNING id
      `.then((r) => r[0]!);

        const cat = await sql`
        INSERT INTO categories (name, slug, is_active)
        VALUES ('Cat PV Test', 'cat-pv-test', true)
        RETURNING id
      `.then((r) => r[0]!);

        const prod = await sql`
        INSERT INTO products (organization_id, category_id, name, slug)
        VALUES (${org.id}, ${cat.id}, 'Prod PV Test', 'prod-pv-test')
        RETURNING id
      `.then((r) => r[0]!);

        const variant = await sql`
        INSERT INTO product_variants (product_id, name)
        VALUES (${prod.id}, 'Variante Test')
        RETURNING id, public_id, name
      `.then((r) => r[0]!);

        expect(variant.id).toBeDefined();
        expect(variant.public_id).toBeDefined();
        expect(variant.public_id).not.toBe(variant.id);
        expect(variant.public_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      } finally {
        await sql.end();
      }
    });

    it('3. Trigger d’immutabilité : refus de modifier ou nullifier public_id sur product_variants', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const org = await sql`
        INSERT INTO organizations (legal_name, slug)
        VALUES ('Org Immut', 'org-immut')
        RETURNING id
      `.then((r) => r[0]!);

        const cat = await sql`
        INSERT INTO categories (name, slug, is_active)
        VALUES ('Cat Immut', 'cat-immut', true)
        RETURNING id
      `.then((r) => r[0]!);

        const prod = await sql`
        INSERT INTO products (organization_id, category_id, name, slug)
        VALUES (${org.id}, ${cat.id}, 'Prod Immut', 'prod-immut')
        RETURNING id
      `.then((r) => r[0]!);

        const variant = await sql`
        INSERT INTO product_variants (product_id, name)
        VALUES (${prod.id}, 'Variante Immut')
        RETURNING id, public_id
      `.then((r) => r[0]!);

        // Mutation interdite
        await expect(
          sql`UPDATE product_variants SET public_id = gen_random_uuid() WHERE id = ${variant.id}`,
        ).rejects.toThrow(/public_id is immutable/);

        // Nullification interdite
        await expect(
          sql`UPDATE product_variants SET public_id = NULL WHERE id = ${variant.id}`,
        ).rejects.toThrow();

        // Mutation d'autres champs autorisée
        const updateRes =
          await sql`UPDATE product_variants SET name = 'Nouveau Nom' WHERE id = ${variant.id}`;
        expect(updateRes.count).toBe(1);

        // No-op public_id = public_id autorisé
        const noopRes =
          await sql`UPDATE product_variants SET public_id = ${variant.public_id} WHERE id = ${variant.id}`;
        expect(noopRes.count).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('4. Upgrade réel 0037 → 0038 avec backfill des variantes existantes et rerun idempotent', async () => {
      if (!upgradeUrl) return;
      const { rmSync } = await import('node:fs');
      const before = await createMigrationFolder(37);
      try {
        await runMigrationsFromFolder(upgradeUrl, before);
      } finally {
        rmSync(before, { recursive: true, force: true });
      }

      const sql = postgres(upgradeUrl, { max: 1 });
      try {
        expect(await migrationCount(sql)).toBe(37);

        // Insérer des données historiques avant la migration 0038
        const org = await sql`
        INSERT INTO organizations (legal_name, slug)
        VALUES ('Org Upgrade', 'org-upgrade')
        RETURNING id
      `.then((r) => r[0]!);

        const cat = await sql`
        INSERT INTO categories (name, slug, is_active)
        VALUES ('Cat Upgrade', 'cat-upgrade', true)
        RETURNING id
      `.then((r) => r[0]!);

        const prod = await sql`
        INSERT INTO products (organization_id, category_id, name, slug)
        VALUES (${org.id}, ${cat.id}, 'Prod Upgrade', 'prod-upgrade')
        RETURNING id
      `.then((r) => r[0]!);

        const v1 = await sql`
        INSERT INTO product_variants (product_id, name)
        VALUES (${prod.id}, 'V1 Legacy')
        RETURNING id, name
      `.then((r) => r[0]!);

        const v2 = await sql`
        INSERT INTO product_variants (product_id, name)
        VALUES (${prod.id}, 'V2 Legacy')
        RETURNING id, name
      `.then((r) => r[0]!);

        const beforeHashes = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;

        // Appliquer la migration 0038
        const migrationFolder = await createMigrationFolder(37);
        try {
          await appendMigration(migrationFolder, 37);
          await runMigrationsFromFolder(upgradeUrl, migrationFolder);
        } finally {
          rmSync(migrationFolder, { recursive: true, force: true });
        }

        expect(await migrationCount(sql)).toBe(38);

        const afterHashes = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
        expect(afterHashes).toHaveLength(38);
        const newHashes = afterHashes.filter(
          (row) => !beforeHashes.some((beforeRow) => beforeRow.hash === row.hash),
        );
        expect(newHashes).toHaveLength(1);

        // Vérifier le hash dans __drizzle_migrations
        const hashRecord = await sql`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${newHashes[0]!.hash}
      `;
        expect(hashRecord[0]!.count).toBe(1);

        // Vérifier le backfill des variantes existantes
        const rows = await sql`
        SELECT id, public_id, name FROM product_variants WHERE id IN (${v1.id}, ${v2.id})
      `;
        expect(rows).toHaveLength(2);
        expect(rows[0]!.public_id).toBeDefined();
        expect(rows[1]!.public_id).toBeDefined();
        expect(rows[0]!.public_id).not.toBe(rows[1]!.public_id);
        expect(rows[0]!.public_id).not.toBe(rows[0]!.id);
        expect(rows[1]!.public_id).not.toBe(rows[1]!.id);

        // Rerun idempotent
        const rerunFolder = await createMigrationFolder(37);
        try {
          await appendMigration(rerunFolder, 37);
          await runMigrationsFromFolder(upgradeUrl, rerunFolder);
        } finally {
          rmSync(rerunFolder, { recursive: true, force: true });
        }
        expect(await migrationCount(sql)).toBe(38);
      } finally {
        await sql.end();
      }
    }, 600000);
  },
);
