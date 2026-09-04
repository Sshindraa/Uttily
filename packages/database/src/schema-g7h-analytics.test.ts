import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';
import { analyticsEventType, analyticsEnvironment, productAnalyticsDaily } from '../src/schema';

/**
 * Tests d'intégration PostgreSQL du schéma G7H-A — fondations analytics
 * first-party privacy-first (ADR-022, migration 0035).
 *
 * Vérifie :
 * - La migration 0035 (enums, tables, contraintes CHECK, index, triggers).
 * - Le rejeu idempotent et le rollback (DROP tout).
 * - L'alignement enum PostgreSQL / schéma Drizzle.
 * - L'absence de colonnes interdites (organization_id, user_id, etc.).
 * - Les invariants has_results selon event_type.
 * - La déduplication idempotente (UNIQUE event_type, environment, source_id).
 * - L'immutabilité : UPDATE toujours rejeté.
 * - La protection DELETE : événements récents rejetés, événements anciens autorisés.
 * - La borne exacte 90 jours (non supprimable).
 * - Les agrégats quotidiens : PK, contraintes >= 0, searches_with_results <= searches.
 * - Le journal de migrations (58 entrées, dont 0050, 0051, 0052, 0053, 0054, 0055 et 0056).
 */

const TEST_DB_NAME = 'uttily_test_g7h_analytics';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma G7H-A.');
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

/** Génère un UUID v4 valide pour les tests. */
function fakeUuid(seed: number): string {
  const hex = seed.toString(16).padStart(8, '0');
  return `${hex}-4000-8000-0000-${'0'.repeat(12)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('G7H-A — Fondations analytics', () => {
  // =========================================================================
  // A. Migration et journal
  // =========================================================================

  describe('A. Migration 0035', () => {
    it('A1 — la migration 0035 est appliquée (table product_analytics_events existe)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const exists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_analytics_events'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(exists).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('A2 — rejeu idempotent : runMigrations deux fois sans erreur', async () => {
      if (!testUrl) return;
      await runMigrations(testUrl);
      const sql = postgres(testUrl, { max: 1 });
      try {
        const exists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_analytics_events'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(exists).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('A3 — rollback : DROP tout (triggers, fonctions, index, tables, types)', async () => {
      if (!testUrl || !url) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`DROP TABLE IF EXISTS product_analytics_daily`;
        await sql`DROP TRIGGER IF EXISTS guard_product_analytics_event_deletion_requires_aggregate ON product_analytics_events`;
        await sql`DROP TRIGGER IF EXISTS guard_product_analytics_event_deletion ON product_analytics_events`;
        await sql`DROP TRIGGER IF EXISTS guard_product_analytics_event_immutability ON product_analytics_events`;
        await sql`DROP FUNCTION IF EXISTS guard_product_analytics_event_deletion_requires_aggregate()`;
        await sql`DROP FUNCTION IF EXISTS guard_product_analytics_event_deletion()`;
        await sql`DROP FUNCTION IF EXISTS guard_product_analytics_event_immutability()`;
        await sql`DROP INDEX IF EXISTS product_analytics_events_env_occurred_type_idx`;
        await sql`DROP TABLE IF EXISTS product_analytics_events`;
        await sql`DROP TYPE IF EXISTS analytics_environment`;
        await sql`DROP TYPE IF EXISTS analytics_event_type`;

        const tableExists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = 'product_analytics_events'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(tableExists).toBe(false);

        const typeExists = await sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_type WHERE typname = 'analytics_event_type'
          ) AS exists
        `.then((r) => r[0]!.exists);
        expect(typeExists).toBe(false);
      } finally {
        await sql.end();
      }

      // Restaurer l'état : recréer la base de test from scratch et ré-appliquer
      // toutes les migrations.
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

    it('A4 — enums et schéma Drizzle alignés', () => {
      expect(analyticsEventType.enumValues).toEqual([
        'PUBLIC_SEARCH_PERFORMED',
        'BOOKING_ATTEMPTED',
        'BOOKING_CONFIRMED',
      ]);
      expect(analyticsEnvironment.enumValues).toEqual(['DEVELOPMENT', 'TEST', 'PRODUCTION']);
    });

    it('A4b — product_analytics_daily a une PK composite (day, environment) dans le schéma Drizzle', () => {
      // Vérifie que le schéma Drizzle déclare bien la PK composite.
      // La fonction extraConfig du pgTable retourne un tableau contenant
      // un PrimaryKeyBuilder avec les colonnes day et environment.
      const table = productAnalyticsDaily as unknown as Record<symbol, unknown>;
      const extraConfigBuilder = table[Symbol.for('drizzle:ExtraConfigBuilder')] as (
        self: Record<string, { name: string }>,
      ) => unknown[];
      expect(extraConfigBuilder).toBeDefined();
      if (extraConfigBuilder) {
        // Construit les colonnes extra-config simulées.
        const mockSelf = {
          day: { name: 'day' },
          environment: { name: 'environment' },
          searches: { name: 'searches' },
          searchesWithResults: { name: 'searches_with_results' },
          bookingAttempts: { name: 'booking_attempts' },
          bookingsConfirmed: { name: 'bookings_confirmed' },
          compactedSearches: { name: 'compacted_searches' },
          compactedSearchesWithResults: { name: 'compacted_searches_with_results' },
          compactedBookingAttempts: { name: 'compacted_booking_attempts' },
          compactedBookingsConfirmed: { name: 'compacted_bookings_confirmed' },
          updatedAt: { name: 'updated_at' },
        };
        const config = extraConfigBuilder(mockSelf);
        // Cherche le PrimaryKeyBuilder dans le tableau.
        const pkBuilder = config.find(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            'columns' in item &&
            'name' in item &&
            (item as { name: string }).name === 'product_analytics_daily_pkey',
        );
        expect(pkBuilder).toBeDefined();
      }
    });

    it('A5 — journal de migrations : __drizzle_migrations a 58 entrées, _journal.json a 58 entrées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(58);

        const __dirname = dirname(fileURLToPath(import.meta.url));
        const journalPath = join(__dirname, '..', 'drizzle', 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
        expect(journal.entries.length).toBe(59);
        expect(journal.entries[34]!.tag).toBe('0035_g7h_analytics_foundations');
        expect(journal.entries[34]!.idx).toBe(34);
      } finally {
        await sql.end();
      }
    });

    it('A6 — fichier de migration 0035 contient les éléments requis', () => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const migrationPath = join(__dirname, '..', 'drizzle', '0035_g7h_analytics_foundations.sql');
      const content = readFileSync(migrationPath, 'utf-8');

      expect(content).toContain('CREATE TYPE analytics_event_type AS ENUM');
      expect(content).toContain('CREATE TYPE analytics_environment AS ENUM');
      expect(content).toContain('CREATE TABLE product_analytics_events');
      expect(content).toContain('CREATE TABLE product_analytics_daily');
      expect(content).toContain('guard_product_analytics_event_immutability');
      expect(content).toContain('guard_product_analytics_event_deletion');
      expect(content).toContain('guard_product_analytics_event_deletion_requires_aggregate');
      expect(content).toContain('product_analytics_events_dedup_unique');
      expect(content).toContain('product_analytics_events_has_results_invariants');
      expect(content).toContain('product_analytics_events_env_occurred_type_idx');
      expect(content).toContain('product_analytics_daily_searches_with_results_le_searches');
      expect(content).toContain('product_analytics_daily_compacted_s_nn');
      expect(content).toContain('product_analytics_daily_compacted_s_le_s');
      expect(content).toContain('product_analytics_daily_compacted_swr_le_cs');
      expect(content).toContain('compacted_searches');
      expect(content).toContain('compacted_bookings_confirmed');
      expect(content).toContain("interval '90 days'");
      // Rollback section commenté.
      expect(content).toContain('-- DROP TABLE IF EXISTS product_analytics_daily');
      expect(content).toContain(
        '-- DROP TRIGGER IF EXISTS guard_product_analytics_event_deletion_requires_aggregate',
      );
      expect(content).toContain(
        '-- DROP FUNCTION IF EXISTS guard_product_analytics_event_deletion_requires_aggregate()',
      );
      expect(content).toContain('-- DROP TYPE IF EXISTS analytics_event_type');
      // Le fichier se termine par exactement un newline.
      expect(content.endsWith('\n')).toBe(true);
      expect(content.endsWith('\n\n')).toBe(false);
    });
  });

  // =========================================================================
  // B. Enums PostgreSQL
  // =========================================================================

  describe('B. Enums PostgreSQL', () => {
    it('B1 — analytics_event_type contient exactement les trois valeurs', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const labels = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'analytics_event_type')
          ORDER BY enumsortorder
        `;
        expect(labels.map((r) => r.enumlabel)).toEqual([
          'PUBLIC_SEARCH_PERFORMED',
          'BOOKING_ATTEMPTED',
          'BOOKING_CONFIRMED',
        ]);
      } finally {
        await sql.end();
      }
    });

    it('B2 — analytics_environment contient exactement les trois valeurs', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const labels = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'analytics_environment')
          ORDER BY enumsortorder
        `;
        expect(labels.map((r) => r.enumlabel)).toEqual(['DEVELOPMENT', 'TEST', 'PRODUCTION']);
      } finally {
        await sql.end();
      }
    });

    it('B3 — analytics_environment est distinct de payment_environment', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const paymentLabels = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'payment_environment')
          ORDER BY enumsortorder
        `;
        const analyticsLabels = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'analytics_environment')
          ORDER BY enumsortorder
        `;
        const paymentSet = new Set(paymentLabels.map((r) => r.enumlabel));
        const analyticsSet = new Set(analyticsLabels.map((r) => r.enumlabel));
        // Les deux enums n'ont pas exactement les mêmes valeurs.
        expect(analyticsSet).not.toEqual(paymentSet);
        // analytics_environment contient PRODUCTION qui n'est pas dans payment_environment.
        expect(analyticsSet.has('PRODUCTION')).toBe(true);
        expect(paymentSet.has('PRODUCTION')).toBe(false);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // C. Absence de colonnes interdites
  // =========================================================================

  describe('C. Colonnes interdites absentes', () => {
    it('C1 — product_analytics_events ne contient aucune colonne identifiante', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const cols = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'product_analytics_events'
        `;
        const colNames = new Set(cols.map((r) => r.column_name));
        const forbidden = [
          'organization_id',
          'user_id',
          'session_id',
          'ip',
          'ip_address',
          'email',
          'address',
          'geo_point',
          'latitude',
          'longitude',
          'user_agent',
          'referrer',
          'notes',
          'description',
          'payload',
          'data',
          'metadata',
          'booking_id',
          'payment_id',
          'sku',
          'serial_number',
          'search_text',
          'search_query',
          'cookie',
          'fingerprint',
        ];
        for (const f of forbidden) {
          expect(colNames.has(f)).toBe(false);
        }
        // Les colonnes autorisées.
        expect(colNames.has('id')).toBe(true);
        expect(colNames.has('event_type')).toBe(true);
        expect(colNames.has('environment')).toBe(true);
        expect(colNames.has('source_id')).toBe(true);
        expect(colNames.has('has_results')).toBe(true);
        expect(colNames.has('occurred_at')).toBe(true);
        expect(colNames.has('created_at')).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('C2 — product_analytics_daily ne contient aucun identifiant source', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const cols = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'product_analytics_daily'
        `;
        const colNames = new Set(cols.map((r) => r.column_name));
        const forbidden = [
          'source_id',
          'event_id',
          'organization_id',
          'user_id',
          'session_id',
          'ip',
          'email',
          'payload',
          'data',
          'metadata',
        ];
        for (const f of forbidden) {
          expect(colNames.has(f)).toBe(false);
        }
      } finally {
        await sql.end();
      }
    });

    it('C3 — aucune colonne JSON/JSONB dans product_analytics_events', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const jsonCols = await sql`
          SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'product_analytics_events'
            AND data_type IN ('json', 'jsonb')
        `;
        expect(jsonCols.length).toBe(0);
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // D. Contraintes CHECK — invariants has_results
  // =========================================================================

  describe('D. Invariants has_results', () => {
    it('D1 — PUBLIC_SEARCH_PERFORMED avec has_results NOT NULL → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${fakeUuid(1)}, true, now())
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('D2 — PUBLIC_SEARCH_PERFORMED avec has_results NULL → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${fakeUuid(2)}, NULL, now())
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('D3 — BOOKING_ATTEMPTED avec has_results NULL → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('BOOKING_ATTEMPTED', 'TEST', ${fakeUuid(3)}, NULL, now())
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('D4 — BOOKING_ATTEMPTED avec has_results NOT NULL → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('BOOKING_ATTEMPTED', 'TEST', ${fakeUuid(4)}, true, now())
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('D5 — BOOKING_CONFIRMED avec has_results NULL → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('BOOKING_CONFIRMED', 'TEST', ${fakeUuid(5)}, NULL, now())
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('D6 — BOOKING_CONFIRMED avec has_results NOT NULL → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('BOOKING_CONFIRMED', 'TEST', ${fakeUuid(6)}, false, now())
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // E. Déduplication idempotente
  // =========================================================================

  describe('E. Déduplication', () => {
    it('E1 — même (event_type, environment, source_id) → violation unique', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(10);
        await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now())
        `;
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, false, now())
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('E2 — source_id différent → accepté (pas de collision)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${fakeUuid(11)}, true, now())
          `,
        ).resolves.toBeDefined();
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${fakeUuid(12)}, false, now())
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('E3 — même source_id mais environment différent → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(13);
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now())
          `,
        ).resolves.toBeDefined();
        await expect(
          sql`
            INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
            VALUES ('PUBLIC_SEARCH_PERFORMED', 'DEVELOPMENT', ${sid}, true, now())
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // F. Immutabilité — UPDATE toujours rejeté
  // =========================================================================

  describe('F. Immutabilité', () => {
    it('F1 — UPDATE sur product_analytics_events → toujours rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(20);
        const [row] = await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now())
          RETURNING id
        `;
        await expect(
          sql`UPDATE product_analytics_events SET has_results = false WHERE id = ${row!.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // G. Protection DELETE — 90 jours
  // =========================================================================

  describe('G. Protection DELETE', () => {
    it("G1 — DELETE d'un événement récent (within 90 days) → rejeté", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(30);
        const [row] = await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now())
          RETURNING id
        `;
        await expect(
          sql`DELETE FROM product_analytics_events WHERE id = ${row!.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("G2 — DELETE d'un événement exactement à la borne 90 jours → rejeté", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(31);
        // occurred_at = now() - 90 days + 5 secondes (légèrement dans la fenêtre
        // de 90 jours pour éviter une course avec l'horloge PostgreSQL).
        const [row] = await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now() - interval '90 days' + interval '5 seconds')
          RETURNING id
        `;
        await expect(
          sql`DELETE FROM product_analytics_events WHERE id = ${row!.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("G3 — DELETE d'un événement strictement plus ancien que 90 jours avec agrégat → autorisé", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(32);
        // occurred_at = now() - 90 days - 1 milliseconde.
        const [row] = await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now() - interval '90 days' - interval '1 millisecond')
          RETURNING id, occurred_at
        `;
        // Insérer l'agrégat pour ce jour pour permettre la suppression.
        const eventDay = new Date(row!.occurred_at).toISOString().slice(0, 10);
        await sql`
          INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
          VALUES (${eventDay}, 'TEST', 1, 1, 0, 0)
          ON CONFLICT (day, environment) DO NOTHING
        `;
        await expect(
          sql`DELETE FROM product_analytics_events WHERE id = ${row!.id}`,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it("G4 — DELETE d'un événement expiré sans agrégat → rejeté", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const sid = fakeUuid(33);
        // occurred_at = now() - 91 days (strictement plus ancien que 90 jours).
        const [row] = await sql`
          INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
          VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${sid}, true, now() - interval '91 days')
          RETURNING id
        `;
        // Pas d'agrégat pour ce jour → le trigger doit rejeter.
        await expect(
          sql`DELETE FROM product_analytics_events WHERE id = ${row!.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // H. Table product_analytics_daily — contraintes
  // =========================================================================

  describe('H. Agrégats quotidiens', () => {
    it('H1 — PK (day, environment) — insertion dupliquée rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`
          INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
          VALUES ('2026-01-01', 'TEST', 10, 5, 3, 2)
        `;
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-01', 'TEST', 20, 10, 6, 4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('H2 — compteur négatif → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-02', 'TEST', -1, 0, 0, 0)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('H3 — searches_with_results > searches → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-03', 'TEST', 5, 6, 0, 0)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('H4 — bookings_confirmed > booking_attempts autorisé (même jour)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-04', 'TEST', 0, 0, 2, 5)
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('H5 — même day mais environment différent → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-05', 'TEST', 1, 1, 0, 0)
          `,
        ).resolves.toBeDefined();
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES ('2026-01-05', 'DEVELOPMENT', 2, 1, 0, 0)
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // I. Colonnes compactées (compacted counters)
  // =========================================================================

  describe('I. Colonnes compactées', () => {
    it('I1 — les 4 colonnes compacted existent avec type bigint et défaut 0', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const cols = await sql`
          SELECT column_name, data_type, column_default
          FROM information_schema.columns
          WHERE table_name = 'product_analytics_daily'
            AND column_name IN (
              'compacted_searches',
              'compacted_searches_with_results',
              'compacted_booking_attempts',
              'compacted_bookings_confirmed'
            )
          ORDER BY column_name
        `;
        expect(cols.length).toBe(4);
        for (const col of cols) {
          expect(col.data_type).toBe('bigint');
        }
        // Toutes ont un défaut (0).
        for (const col of cols) {
          expect(col.column_default).not.toBeNull();
        }
      } finally {
        await sql.end();
      }
    });

    it('I2 — insertion sans compacted → défaut 0', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`
          INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
          VALUES ('2026-01-10', 'TEST', 5, 3, 2, 1)
          ON CONFLICT (day, environment) DO NOTHING
        `;
        const [row] = await sql`
          SELECT compacted_searches, compacted_searches_with_results,
                 compacted_booking_attempts, compacted_bookings_confirmed
          FROM product_analytics_daily
          WHERE day = '2026-01-10' AND environment = 'TEST'
        `;
        expect(Number(row!.compacted_searches)).toBe(0);
        expect(Number(row!.compacted_searches_with_results)).toBe(0);
        expect(Number(row!.compacted_booking_attempts)).toBe(0);
        expect(Number(row!.compacted_bookings_confirmed)).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('I3 — compacted_searches négatif → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed, compacted_searches)
            VALUES ('2026-01-11', 'TEST', 5, 3, 0, 0, -1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('I4 — compacted_searches > searches → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed, compacted_searches)
            VALUES ('2026-01-12', 'TEST', 3, 0, 0, 0, 5)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('I5 — compacted_searches_with_results > compacted_searches → refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed, compacted_searches, compacted_searches_with_results)
            VALUES ('2026-01-13', 'TEST', 5, 5, 0, 0, 3, 4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('I6 — compacted <= total pour toutes les paires → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed, compacted_searches, compacted_searches_with_results, compacted_booking_attempts, compacted_bookings_confirmed)
            VALUES ('2026-01-14', 'TEST', 10, 8, 5, 3, 10, 8, 5, 3)
          `,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
      }
    });

    it('I7 — les contraintes CHECK compacted existent dans le schéma', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const constraints = await sql`
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'product_analytics_daily'::regclass
            AND conname LIKE 'product_analytics_daily_compacted%'
          ORDER BY conname
        `;
        const names = constraints.map((r) => r.conname);
        expect(names).toContain('product_analytics_daily_compacted_s_nn');
        expect(names).toContain('product_analytics_daily_compacted_swr_nn');
        expect(names).toContain('product_analytics_daily_compacted_ba_nn');
        expect(names).toContain('product_analytics_daily_compacted_bc_nn');
        expect(names).toContain('product_analytics_daily_compacted_s_le_s');
        expect(names).toContain('product_analytics_daily_compacted_swr_le_swr');
        expect(names).toContain('product_analytics_daily_compacted_ba_le_ba');
        expect(names).toContain('product_analytics_daily_compacted_bc_le_bc');
        expect(names).toContain('product_analytics_daily_compacted_swr_le_cs');
      } finally {
        await sql.end();
      }
    });
  });
});
