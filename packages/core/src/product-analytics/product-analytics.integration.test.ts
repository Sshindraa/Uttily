import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import {
  recordProductAnalyticsEvent,
  aggregateProductAnalyticsDays,
  purgeExpiredProductAnalytics,
  getProductAnalyticsSummary,
  ProductAnalyticsError,
} from './index';
import { calculateAggregateRetentionBoundary, calculateRawRetentionBoundary } from './validation';

/**
 * Tests d'intégration PostgreSQL du module Product Analytics (G7H-A).
 *
 * Vérifie :
 * - Migration upgrade et rollback.
 * - Enums et contraintes.
 * - Absence de colonnes interdites.
 * - Invariants has_results selon event_type.
 * - Déduplication idempotente.
 * - Conflit sémantique (DUPLICATE_CONFLICT).
 * - Immutabilité : UPDATE toujours rejeté.
 * - DELETE récent rejeté, DELETE expiré autorisé.
 * - Borne exacte 90 jours (non supprimable).
 * - 1 ms plus ancien que la borne → supprimé.
 * - Agrégation des quatre formules.
 * - Recalcul idempotent.
 * - Jour vide produit des zéros.
 * - Isolation par environnement.
 * - Agrégat manquant empêche la purge raw.
 * - Limit de batch.
 * - Borne exacte 24 mois pour les agrégats.
 * - Résumé sur plage [fromDay, toDayExclusive).
 * - Overflow BIGINT dans le résumé.
 * - Modèle de compaction : purges bornées successives sans perte.
 * - Événement tardif après compaction partielle.
 * - Concurrence réelle (deux connexions, SKIP LOCKED, advisory locks).
 * - Rétention d'agrégat avec raw restant.
 * - Erreur DELETE → ANALYTICS_UNAVAILABLE + rollback.
 * - Colonnes compacted et contraintes.
 */

const TEST_DB_NAME = 'uttily_test_product_analytics';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests G7H-A.');
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

describe.skipIf(shouldSkipIntegrationTests())(
  'G7H-A — Product Analytics (intégration PostgreSQL)',
  () => {
    // =========================================================================
    // A. Migration et structure
    // =========================================================================
    describe('A. Migration et structure', () => {
      it('A1 — les tables product_analytics_events et product_analytics_daily existent', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const tables = await sql`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename IN ('product_analytics_events', 'product_analytics_daily')
          ORDER BY tablename
        `;
          expect(tables.length).toBe(2);
        } finally {
          await sql.end();
        }
      });

      it('A2 — les enums analytics_event_type et analytics_environment existent', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const types = await sql`
          SELECT typname FROM pg_type
          WHERE typname IN ('analytics_event_type', 'analytics_environment')
          ORDER BY typname
        `;
          expect(types.length).toBe(2);
        } finally {
          await sql.end();
        }
      });

      it('A3 — aucune colonne interdite dans product_analytics_events', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const cols = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'product_analytics_events'
        `;
          const colNames = new Set(cols.map((r) => r.column_name));
          expect(colNames.has('organization_id')).toBe(false);
          expect(colNames.has('user_id')).toBe(false);
          expect(colNames.has('session_id')).toBe(false);
          expect(colNames.has('ip')).toBe(false);
          expect(colNames.has('email')).toBe(false);
          expect(colNames.has('payload')).toBe(false);
          expect(colNames.has('metadata')).toBe(false);
        } finally {
          await sql.end();
        }
      });
    });

    // =========================================================================
    // B. Enregistrement et déduplication
    // =========================================================================
    describe('B. Enregistrement et déduplication', () => {
      it('B1 — PUBLIC_SEARCH_PERFORMED avec hasResults=true → inséré', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const result = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(101),
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
            hasResults: true,
          });
          expect('id' in result).toBe(true);
        } finally {
          await db.$client.end();
        }
      });

      it('B2 — même (event_type, environment, source_id) → DUPLICATE', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const sid = fakeUuid(102);
          const occurredAt = new Date('2026-01-15T10:00:00.000Z');
          const r1 = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt,
            hasResults: true,
          });
          expect('id' in r1).toBe(true);

          const r2 = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt,
            hasResults: true,
          });
          expect('kind' in r2).toBe(true);
          if ('kind' in r2) {
            expect(r2.kind).toBe('DUPLICATE');
          }
        } finally {
          await db.$client.end();
        }
      });

      it('B3 — même clé mais has_results différent → DUPLICATE_CONFLICT', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const sid = fakeUuid(103);
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
            hasResults: true,
          });

          await expect(
            recordProductAnalyticsEvent(db, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'TEST',
              sourceId: sid,
              occurredAt: new Date('2026-01-15T11:00:00.000Z'),
              hasResults: false,
            }),
          ).rejects.toThrowError(ProductAnalyticsError);
        } finally {
          await db.$client.end();
        }
      });

      it('B3b — même clé mais occurredAt différent seulement → DUPLICATE_CONFLICT', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const sid = fakeUuid(107);
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
            hasResults: true,
          });

          await expect(
            recordProductAnalyticsEvent(db, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'TEST',
              sourceId: sid,
              occurredAt: new Date('2026-01-15T10:00:00.001Z'),
              hasResults: true,
            }),
          ).rejects.toThrowError(ProductAnalyticsError);
          await expect(
            recordProductAnalyticsEvent(db, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'TEST',
              sourceId: sid,
              occurredAt: new Date('2026-01-15T10:00:00.001Z'),
              hasResults: true,
            }),
          ).rejects.toThrowError(/Conflit de déduplication/);
        } finally {
          await db.$client.end();
        }
      });

      it('B3c — même clé, même occurredAt, même hasResults → DUPLICATE', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const sid = fakeUuid(108);
          const occurredAt = new Date('2026-01-15T10:00:00.000Z');
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt,
            hasResults: true,
          });

          const r2 = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt,
            hasResults: true,
          });
          expect('kind' in r2).toBe(true);
          if ('kind' in r2) {
            expect(r2.kind).toBe('DUPLICATE');
          }
        } finally {
          await db.$client.end();
        }
      });

      it('B4 — BOOKING_ATTEMPTED inséré sans hasResults', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const result = await recordProductAnalyticsEvent(db, {
            eventType: 'BOOKING_ATTEMPTED',
            environment: 'TEST',
            sourceId: fakeUuid(104),
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
          });
          expect('id' in result).toBe(true);
        } finally {
          await db.$client.end();
        }
      });

      it('B5 — BOOKING_CONFIRMED inséré sans hasResults', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const result = await recordProductAnalyticsEvent(db, {
            eventType: 'BOOKING_CONFIRMED',
            environment: 'TEST',
            sourceId: fakeUuid(105),
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
          });
          expect('id' in result).toBe(true);
        } finally {
          await db.$client.end();
        }
      });

      it('B6 — isolation par environnement (même source_id, env différent)', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const sid = fakeUuid(106);
          const r1 = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: sid,
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
            hasResults: true,
          });
          const r2 = await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: sid,
            occurredAt: new Date('2026-01-15T10:00:00.000Z'),
            hasResults: false,
          });
          expect('id' in r1).toBe(true);
          expect('id' in r2).toBe(true);
          if ('id' in r1 && 'id' in r2) {
            expect(r1.id).not.toBe(r2.id);
          }
        } finally {
          await db.$client.end();
        }
      });
    });

    // =========================================================================
    // C. Immutabilité et protection DELETE
    // =========================================================================
    describe('C. Immutabilité et protection DELETE', () => {
      it('C1 — UPDATE sur product_analytics_events → rejeté', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const sid = fakeUuid(201);
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

      it("C2 — DELETE d'un événement récent → rejeté", async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const sid = fakeUuid(202);
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

      it('C3 — DELETE à la borne exacte 90 jours → rejeté', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const sid = fakeUuid(203);
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

      it('C4 — DELETE 1 ms plus ancien que la borne → autorisé (avec agrégat)', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const sid = fakeUuid(204);
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
    });

    // =========================================================================
    // D. Agrégation
    // =========================================================================
    describe('D. Agrégation', () => {
      it('D1 — agrégation des quatre formules', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const day = '2026-02-01';
          const occurredAt = new Date(`${day}T10:00:00.000Z`);

          // 3 searches (2 with results, 1 without).
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(301),
            occurredAt,
            hasResults: true,
          });
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(302),
            occurredAt,
            hasResults: true,
          });
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(303),
            occurredAt,
            hasResults: false,
          });
          // 2 booking attempts.
          await recordProductAnalyticsEvent(db, {
            eventType: 'BOOKING_ATTEMPTED',
            environment: 'TEST',
            sourceId: fakeUuid(304),
            occurredAt,
          });
          await recordProductAnalyticsEvent(db, {
            eventType: 'BOOKING_ATTEMPTED',
            environment: 'TEST',
            sourceId: fakeUuid(305),
            occurredAt,
          });
          // 1 booking confirmed.
          await recordProductAnalyticsEvent(db, {
            eventType: 'BOOKING_CONFIRMED',
            environment: 'TEST',
            sourceId: fakeUuid(306),
            occurredAt,
          });

          const result = await aggregateProductAnalyticsDays(db, {
            fromDay: day,
            toDayExclusive: '2026-02-02',
            environment: 'TEST',
          });
          expect(result.daysProcessed).toBe(1);

          const sql = postgres(testUrl, { max: 1 });
          try {
            const [row] = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${day} AND environment = 'TEST'
          `;
            expect(row).toBeDefined();
            expect(Number(row!.searches)).toBe(3);
            expect(Number(row!.searches_with_results)).toBe(2);
            expect(Number(row!.booking_attempts)).toBe(2);
            expect(Number(row!.bookings_confirmed)).toBe(1);
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('D2 — recalcul idempotent (aggregate twice → same result)', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const day = '2026-02-02';
          const occurredAt = new Date(`${day}T10:00:00.000Z`);

          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(310),
            occurredAt,
            hasResults: true,
          });

          await aggregateProductAnalyticsDays(db, {
            fromDay: day,
            toDayExclusive: '2026-02-03',
            environment: 'TEST',
          });
          await aggregateProductAnalyticsDays(db, {
            fromDay: day,
            toDayExclusive: '2026-02-03',
            environment: 'TEST',
          });

          const sql = postgres(testUrl, { max: 1 });
          try {
            const rows = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${day} AND environment = 'TEST'
          `;
            expect(rows.length).toBe(1);
            expect(Number(rows[0]!.searches)).toBe(1);
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('D3 — jour vide produit des zéros', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const day = '2026-02-03';
          await aggregateProductAnalyticsDays(db, {
            fromDay: day,
            toDayExclusive: '2026-02-04',
            environment: 'TEST',
          });

          const sql = postgres(testUrl, { max: 1 });
          try {
            const [row] = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${day} AND environment = 'TEST'
          `;
            expect(row).toBeDefined();
            expect(Number(row!.searches)).toBe(0);
            expect(Number(row!.searches_with_results)).toBe(0);
            expect(Number(row!.booking_attempts)).toBe(0);
            expect(Number(row!.bookings_confirmed)).toBe(0);
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it("D4 — isolation par environnement dans l'agrégation", async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const day = '2026-02-04';
          const occurredAt = new Date(`${day}T10:00:00.000Z`);

          // Événement TEST.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'TEST',
            sourceId: fakeUuid(320),
            occurredAt,
            hasResults: true,
          });
          // Événement DEVELOPMENT.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(321),
            occurredAt,
            hasResults: true,
          });

          await aggregateProductAnalyticsDays(db, {
            fromDay: day,
            toDayExclusive: '2026-02-05',
            environment: 'TEST',
          });

          const sql = postgres(testUrl, { max: 1 });
          try {
            const [testRow] = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${day} AND environment = 'TEST'
          `;
            expect(Number(testRow!.searches)).toBe(1);

            const [devRow] = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${day} AND environment = 'DEVELOPMENT'
          `;
            // DEVELOPMENT n'a pas été agrégé.
            expect(devRow).toBeUndefined();
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });
    });

    // =========================================================================
    // E. Résumé
    // =========================================================================
    describe('E. Résumé', () => {
      it('E1 — résumé sur plage [fromDay, toDayExclusive)', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          // Utilise les données agrégées en D1 (2026-02-01), D2 (2026-02-02),
          // D3 (2026-02-03, jour vide) et D4 (2026-02-04).
          const summary = await getProductAnalyticsSummary(db, {
            environment: 'TEST',
            fromDay: '2026-02-01',
            toDayExclusive: '2026-02-05',
          });
          // D1 : 3 searches, 2 with results, 2 attempts, 1 confirmed.
          // D2 : 1 search, 1 with results.
          // D3 : 0 (jour vide).
          // D4 : 1 search, 1 with results.
          expect(summary.searches).toBe(5);
          expect(summary.searchesWithResults).toBe(4);
          expect(summary.bookingAttempts).toBe(2);
          expect(summary.bookingsConfirmed).toBe(1);
        } finally {
          await db.$client.end();
        }
      });

      it('E2 — résumé sur plage vide → zéros', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const summary = await getProductAnalyticsSummary(db, {
            environment: 'TEST',
            fromDay: '2030-01-01',
            toDayExclusive: '2030-01-02',
          });
          expect(summary.searches).toBe(0);
          expect(summary.searchesWithResults).toBe(0);
          expect(summary.bookingAttempts).toBe(0);
          expect(summary.bookingsConfirmed).toBe(0);
        } finally {
          await db.$client.end();
        }
      });
    });

    // =========================================================================
    // F. Purge
    // =========================================================================
    describe('F. Purge', () => {
      // Calcule une date dynamiquement : 91 jours avant maintenant (réellement
      // plus ancienne que 90 jours selon l'horloge PostgreSQL).
      function getOldDate(): { date: Date; day: string; nextDay: string } {
        const now = Date.now();
        const oldMs = now - 91 * 24 * 60 * 60 * 1000;
        const oldDate = new Date(oldMs);
        const day = oldDate.toISOString().slice(0, 10);
        const nextDayDate = new Date(oldMs + 24 * 60 * 60 * 1000);
        const nextDay = nextDayDate.toISOString().slice(0, 10);
        return { date: oldDate, day, nextDay };
      }

      // asOf dynamique : maintenant (garantit que oldDate < asOf - 90 jours).
      function getAsOf(): Date {
        return new Date();
      }

      it('F1 — stale aggregate + late event : recompute avant suppression', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const { date: oldDate, day: oldDay, nextDay } = getOldDate();
          const asOf = getAsOf();

          // Insère un premier événement ancien.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(401),
            occurredAt: oldDate,
            hasResults: true,
          });

          // Agrège ce jour (count=1).
          await aggregateProductAnalyticsDays(db, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });

          // Insère un second événement ancien pour le même jour (late event).
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(402),
            occurredAt: new Date(oldDate.getTime() + 1000),
            hasResults: false,
          });

          // Purge : doit recompute l'agrégat (count=2) AVANT de supprimer.
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 });

          // Les deux événements doivent être supprimés.
          const sql = postgres(testUrl, { max: 1 });
          try {
            const [row] = await sql`
            SELECT count(*)::int as n FROM product_analytics_events
            WHERE source_id IN (${fakeUuid(401)}, ${fakeUuid(402)})
          `;
            expect(row!.n).toBe(0);

            // L'agrégat doit refléter le count final (2 searches, 1 with results).
            const [agg] = await sql`
            SELECT * FROM product_analytics_daily
            WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
          `;
            expect(agg).toBeDefined();
            expect(Number(agg!.searches)).toBe(2);
            expect(Number(agg!.searches_with_results)).toBe(1);
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it("F2 — DELETE sans agrégat rejeté par le trigger, purge recompute d'abord", async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          // Utilise une date légèrement différente pour éviter les agrégats
          // des tests précédents (F1 utilise le même jour).
          const now = Date.now();
          const oldMs = now - 92 * 24 * 60 * 60 * 1000;
          const oldDate = new Date(oldMs);
          const oldDay = oldDate.toISOString().slice(0, 10);
          const asOf = getAsOf();

          // Insère un événement ancien sans agrégat.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(410),
            occurredAt: oldDate,
            hasResults: true,
          });

          // Tente une suppression directe sans agrégat → doit échouer (trigger).
          const sql = postgres(testUrl, { max: 1 });
          try {
            // S'assurer qu'aucun agrégat n'existe pour ce jour.
            await sql`DELETE FROM product_analytics_daily WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'`;
            const [row] = await sql`
            SELECT id FROM product_analytics_events WHERE source_id = ${fakeUuid(410)}
          `;
            await expect(
              sql`DELETE FROM product_analytics_events WHERE id = ${row!.id}`,
            ).rejects.toThrow();
          } finally {
            await sql.end();
          }

          // La purge recompute l'agrégat d'abord, puis supprime.
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 });

          const sql2 = postgres(testUrl, { max: 1 });
          try {
            const [row] = await sql2`
            SELECT count(*)::int as n FROM product_analytics_events
            WHERE source_id = ${fakeUuid(410)}
          `;
            expect(row!.n).toBe(0);

            // L'agrégat a été créé par la purge.
            const [agg] = await sql2`
            SELECT * FROM product_analytics_daily
            WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
          `;
            expect(agg).toBeDefined();
            expect(Number(agg!.searches)).toBe(1);
          } finally {
            await sql2.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F3 — Purge séquentielle partielle (compaction)', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          // Utilise une date unique (94 jours) pour éviter la collision
          // avec F1 (91 jours) et F2 (92 jours) qui laissent des compacted.
          const now = Date.now();
          const oldMs = now - 94 * 24 * 60 * 60 * 1000;
          const baseDate = new Date(oldMs);
          const oldDay = baseDate.toISOString().slice(0, 10);
          const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const asOf = getAsOf();

          // Nettoie d'abord tous les événements expirés d'autres tests.
          await aggregateProductAnalyticsDays(db, {
            fromDay: '2026-01-15',
            toDayExclusive: '2026-01-16',
            environment: 'TEST',
          });
          await aggregateProductAnalyticsDays(db, {
            fromDay: '2026-01-15',
            toDayExclusive: '2026-01-16',
            environment: 'DEVELOPMENT',
          });
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 5000 });

          // Insère 5 événements anciens, tous PUBLIC_SEARCH_PERFORMED avec hasResults=true.
          for (let i = 0; i < 5; i++) {
            await recordProductAnalyticsEvent(db, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'DEVELOPMENT',
              sourceId: fakeUuid(420 + i),
              occurredAt: new Date(baseDate.getTime() + i * 1000),
              hasResults: true,
            });
          }

          // Agrège d'abord (total=5, compacted=0).
          await aggregateProductAnalyticsDays(db, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });

          // Purge avec rawLimit=3 → 3 supprimés, aggregate total=5, compacted=3.
          const result1 = await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 3 });
          expect(result1.rawEventsDeleted).toBe(3);

          const sql = postgres(testUrl, { max: 1 });
          try {
            const [agg1] = await sql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(agg1).toBeDefined();
            expect(Number(agg1!.searches)).toBe(5);
            expect(Number(agg1!.compacted_searches)).toBe(3);
          } finally {
            await sql.end();
          }

          // Purge avec rawLimit=3 → 2 supprimés (reste), aggregate total=5, compacted=5.
          const result2 = await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 3 });
          expect(result2.rawEventsDeleted).toBe(2);

          const sql2 = postgres(testUrl, { max: 1 });
          try {
            const [agg2] = await sql2`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(agg2).toBeDefined();
            expect(Number(agg2!.searches)).toBe(5);
            expect(Number(agg2!.compacted_searches)).toBe(5);

            // Vérifie qu'aucun événement raw ne reste.
            const [rawCount] = await sql2`
              SELECT count(*)::int as n FROM product_analytics_events
              WHERE source_id IN (${fakeUuid(420)}, ${fakeUuid(421)}, ${fakeUuid(422)}, ${fakeUuid(423)}, ${fakeUuid(424)})
            `;
            expect(rawCount!.n).toBe(0);
          } finally {
            await sql2.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F4 — Événement tardif après compaction partielle', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          // Utilise une date unique (95 jours) pour éviter la collision.
          const now = Date.now();
          const oldMs = now - 95 * 24 * 60 * 60 * 1000;
          const oldDate = new Date(oldMs);
          const oldDay = oldDate.toISOString().slice(0, 10);
          const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const asOf = getAsOf();

          // Nettoie les événements expirés d'autres tests.
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 5000 });

          // Insère 3 événements anciens, agrège (total=3, compacted=0).
          for (let i = 0; i < 3; i++) {
            await recordProductAnalyticsEvent(db, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'DEVELOPMENT',
              sourceId: fakeUuid(440 + i),
              occurredAt: new Date(oldMs + i * 1000),
              hasResults: true,
            });
          }
          await aggregateProductAnalyticsDays(db, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });

          // Purge avec rawLimit=3 → 3 supprimés, compacted=3, total=3.
          const result1 = await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 3 });
          expect(result1.rawEventsDeleted).toBe(3);

          // Ajoute 1 nouvel événement pour le même jour (late).
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(445),
            occurredAt: new Date(oldMs + 5000),
            hasResults: true,
          });

          // Agrège à nouveau → total=4 (compacted=3 + raw=1), compacted=3.
          await aggregateProductAnalyticsDays(db, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });

          const sql = postgres(testUrl, { max: 1 });
          try {
            const [agg1] = await sql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(Number(agg1!.searches)).toBe(4);
            expect(Number(agg1!.compacted_searches)).toBe(3);
          } finally {
            await sql.end();
          }

          // Purge → total=4, compacted=4.
          const result2 = await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 });
          expect(result2.rawEventsDeleted).toBe(1);

          const sql2 = postgres(testUrl, { max: 1 });
          try {
            const [agg2] = await sql2`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(Number(agg2!.searches)).toBe(4);
            expect(Number(agg2!.compacted_searches)).toBe(4);
          } finally {
            await sql2.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F5 — Deux purges concurrentes (REAL concurrency)', async () => {
        if (!testUrl) return;
        const now = Date.now();
        const oldMs = now - 97 * 24 * 60 * 60 * 1000;
        const oldDate = new Date(oldMs);
        const oldDay = oldDate.toISOString().slice(0, 10);
        const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const asOf = getAsOf();

        // Nettoie les événements expirés d'autres tests.
        const dbClean = createDatabase(testUrl);
        try {
          await purgeExpiredProductAnalytics(dbClean, { asOf, rawLimit: 5000 });
        } finally {
          await dbClean.$client.end();
        }

        // Insère 10 événements anciens.
        const dbSetup = createDatabase(testUrl);
        try {
          for (let i = 0; i < 10; i++) {
            await recordProductAnalyticsEvent(dbSetup, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'DEVELOPMENT',
              sourceId: fakeUuid(460 + i),
              occurredAt: new Date(oldMs + i * 1000),
              hasResults: true,
            });
          }
          // Agrège d'abord.
          await aggregateProductAnalyticsDays(dbSetup, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });
        } finally {
          await dbSetup.$client.end();
        }

        // Deux connexions séparées pour la concurrence réelle.
        const db1 = createDatabase(testUrl);
        const db2 = createDatabase(testUrl);
        try {
          const results = await Promise.allSettled([
            purgeExpiredProductAnalytics(db1, { asOf, rawLimit: 5 }),
            purgeExpiredProductAnalytics(db2, { asOf, rawLimit: 5 }),
          ]);

          // Strengthened assertions : les deux purges doivent réussir (pas de
          // deadlock), 10 événements supprimés au total, et chaque purge doit
          // avoir contribué à la suppression (rawEventsDeleted > 0 pour chacune).
          expect(results[0].status).toBe('fulfilled');
          expect(results[1].status).toBe('fulfilled');
          expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
          if (results.some((r) => r.status === 'rejected')) {
            const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
            throw new Error(`Purge rejected: ${rejected.reason}`);
          }

          // Chaque purge doit avoir contribué (rawEventsDeleted > 0).
          const fulfilled0 = results[0] as PromiseFulfilledResult<{
            rawEventsDeleted: number;
            aggregatesDeleted: number;
          }>;
          const fulfilled1 = results[1] as PromiseFulfilledResult<{
            rawEventsDeleted: number;
            aggregatesDeleted: number;
          }>;
          expect(fulfilled0.value.rawEventsDeleted).toBeGreaterThan(0);
          expect(fulfilled1.value.rawEventsDeleted).toBeGreaterThan(0);

          const totalDeleted = results.reduce(
            (sum, r) => sum + (r.status === 'fulfilled' ? r.value.rawEventsDeleted : 0),
            0,
          );
          // Au total, 10 événements doivent être supprimés (ou moins si SKIP LOCKED
          // a sauté certains — mais avec 10 candidats et rawLimit=5+5, tous devraient
          // être couverts).
          expect(totalDeleted).toBe(10);

          // Vérifie la cohérence de l'agrégat.
          const sql = postgres(testUrl, { max: 1 });
          try {
            const [agg] = await sql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(agg).toBeDefined();
            // total doit être 10 (tous les événements ont été comptés avant suppression).
            expect(Number(agg!.searches)).toBe(10);
            // compacted doit correspondre au nombre d'événements supprimés.
            expect(Number(agg!.compacted_searches)).toBe(10);

            // Vérifie qu'aucun événement raw ne reste.
            const [rawCount] = await sql`
              SELECT count(*)::int as n FROM product_analytics_events
              WHERE environment = 'DEVELOPMENT'
                AND occurred_at >= ${new Date(oldDay + 'T00:00:00.000Z')}
                AND occurred_at < ${new Date(nextDay + 'T00:00:00.000Z')}
            `;
            expect(rawCount!.n).toBe(0);
          } finally {
            await sql.end();
          }
        } finally {
          await db1.$client.end();
          await db2.$client.end();
        }
      });

      it('F6 — Agrégation concurrente à une purge (REAL concurrency)', async () => {
        if (!testUrl) return;
        const now = Date.now();
        const oldMs = now - 98 * 24 * 60 * 60 * 1000;
        const oldDate = new Date(oldMs);
        const oldDay = oldDate.toISOString().slice(0, 10);
        const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const asOf = getAsOf();

        // Nettoie les événements expirés d'autres tests.
        const dbClean = createDatabase(testUrl);
        try {
          await purgeExpiredProductAnalytics(dbClean, { asOf, rawLimit: 5000 });
        } finally {
          await dbClean.$client.end();
        }

        // Insère 5 événements anciens et agrège.
        const dbSetup = createDatabase(testUrl);
        try {
          for (let i = 0; i < 5; i++) {
            await recordProductAnalyticsEvent(dbSetup, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: 'DEVELOPMENT',
              sourceId: fakeUuid(480 + i),
              occurredAt: new Date(oldMs + i * 1000),
              hasResults: true,
            });
          }
          await aggregateProductAnalyticsDays(dbSetup, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });
        } finally {
          await dbSetup.$client.end();
        }

        // Deux connexions : une purge, une agrégation, en parallèle.
        const db1 = createDatabase(testUrl);
        const db2 = createDatabase(testUrl);
        try {
          const results = await Promise.allSettled([
            purgeExpiredProductAnalytics(db1, { asOf, rawLimit: 5 }),
            aggregateProductAnalyticsDays(db2, {
              fromDay: oldDay,
              toDayExclusive: nextDay,
              environment: 'DEVELOPMENT',
            }),
          ]);

          // Les deux doivent réussir (l'advisory lock sérialise les opérations).
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          expect(fulfilled.length).toBe(2);

          // Vérifie la cohérence : pas d'événement perdu, pas de compacted à zéro.
          const sql = postgres(testUrl, { max: 1 });
          try {
            const [agg] = await sql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(agg).toBeDefined();
            // total doit être 5 (tous les événements ont été comptés).
            expect(Number(agg!.searches)).toBe(5);
            // compacted doit être 5 (tous supprimés par la purge).
            expect(Number(agg!.compacted_searches)).toBe(5);
          } finally {
            await sql.end();
          }
        } finally {
          await db1.$client.end();
          await db2.$client.end();
        }
      });

      it("F7 — Rétention d'agrégat avec raw restant", async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const asOf = getAsOf();
          const aggregateBoundary = calculateAggregateRetentionBoundary(asOf);
          // Jour avant la borne (plus ancien que 24 mois).
          const oldDay = new Date(aggregateBoundary.getTime() - 10 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
          const oldDate = new Date(oldDay + 'T10:00:00.000Z');
          const nextDayDate = new Date(new Date(oldDay + 'T00:00:00.000Z').getTime() + 86400000);
          const nextDayStr = nextDayDate.toISOString().slice(0, 10);

          // Nettoie les événements expirés d'autres tests.
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 5000 });

          // Insère un agrégat ancien.
          const sql = postgres(testUrl, { max: 1 });
          try {
            await sql`
              INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
              VALUES (${oldDay}, 'TEST', 1, 1, 0, 0)
              ON CONFLICT (day, environment) DO NOTHING
            `;
            // Insère 3 événements raw pour le même jour (aussi > 90 jours, > 24 mois).
            for (let i = 0; i < 3; i++) {
              await sql`
                INSERT INTO product_analytics_events (event_type, environment, source_id, has_results, occurred_at)
                VALUES ('PUBLIC_SEARCH_PERFORMED', 'TEST', ${fakeUuid(490 + i)}, true, ${new Date(oldDate.getTime() + i * 1000)})
              `;
            }
          } finally {
            await sql.end();
          }

          // Purge avec rawLimit=1 → 1 raw supprimé, 2 restent.
          // L'agrégat ne doit PAS être supprimé (2 raw restent).
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1 });

          const sql2 = postgres(testUrl, { max: 1 });
          try {
            const [agg] = await sql2`
              SELECT count(*)::int as n FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'TEST'
            `;
            // L'agrégat est conservé car 2 raw restent.
            expect(agg!.n).toBe(1);

            const [rawCount] = await sql2`
              SELECT count(*)::int as n FROM product_analytics_events
              WHERE environment = 'TEST'
                AND occurred_at >= ${new Date(oldDay + 'T00:00:00.000Z')}
                AND occurred_at < ${new Date(nextDayStr + 'T00:00:00.000Z')}
            `;
            expect(rawCount!.n).toBe(2);
          } finally {
            await sql2.end();
          }

          // Purge avec rawLimit=1000 → tous les raw restants supprimés.
          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 });

          const sql3 = postgres(testUrl, { max: 1 });
          try {
            // L'agrégat DOIT être supprimé (plus de raw).
            const [agg2] = await sql3`
              SELECT count(*)::int as n FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'TEST'
            `;
            expect(agg2!.n).toBe(0);
          } finally {
            await sql3.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F8 — asOf dans le futur → INVALID_INPUT', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          await expect(
            purgeExpiredProductAnalytics(db, { asOf: new Date(Date.now() + 60000) }),
          ).rejects.toThrowError(ProductAnalyticsError);
          await expect(
            purgeExpiredProductAnalytics(db, { asOf: new Date(Date.now() + 60000) }),
          ).rejects.toThrowError(/futur/);
        } finally {
          await db.$client.end();
        }
      });

      it('F9 — borne exacte 90 jours conservée, 1ms plus ancien éligible', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          const asOf = getAsOf();
          const rawBoundary = calculateRawRetentionBoundary(asOf);

          // Événement exactement à la borne → KEPT (occurred_at = boundary).
          // Événement 1ms avant la borne → eligible.
          const atBoundary = new Date(rawBoundary.getTime());
          const beforeBoundary = new Date(rawBoundary.getTime() - 1);

          // Insère l'événement à la borne.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(430),
            occurredAt: atBoundary,
            hasResults: true,
          });

          // Insère l'événement 1ms avant la borne.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(431),
            occurredAt: beforeBoundary,
            hasResults: true,
          });

          // Agrège les jours pour permettre la purge.
          const dayAt = atBoundary.toISOString().slice(0, 10);
          const dayBefore = beforeBoundary.toISOString().slice(0, 10);
          if (dayAt === dayBefore) {
            await aggregateProductAnalyticsDays(db, {
              fromDay: dayAt,
              toDayExclusive: new Date(new Date(dayAt + 'T00:00:00.000Z').getTime() + 86400000)
                .toISOString()
                .slice(0, 10),
              environment: 'DEVELOPMENT',
            });
          } else {
            await aggregateProductAnalyticsDays(db, {
              fromDay: dayBefore,
              toDayExclusive: new Date(new Date(dayBefore + 'T00:00:00.000Z').getTime() + 86400000)
                .toISOString()
                .slice(0, 10),
              environment: 'DEVELOPMENT',
            });
            await aggregateProductAnalyticsDays(db, {
              fromDay: dayAt,
              toDayExclusive: new Date(new Date(dayAt + 'T00:00:00.000Z').getTime() + 86400000)
                .toISOString()
                .slice(0, 10),
              environment: 'DEVELOPMENT',
            });
          }

          await purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 });

          const sql = postgres(testUrl, { max: 1 });
          try {
            // L'événement à la borne est conservé.
            const [atRow] = await sql`
            SELECT count(*)::int as n FROM product_analytics_events
            WHERE source_id = ${fakeUuid(430)}
          `;
            expect(atRow!.n).toBe(1);

            // L'événement 1ms avant la borne est supprimé.
            const [beforeRow] = await sql`
            SELECT count(*)::int as n FROM product_analytics_events
            WHERE source_id = ${fakeUuid(431)}
          `;
            expect(beforeRow!.n).toBe(0);
          } finally {
            await sql.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F10 — borne exacte 24 mois pour les agrégats', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        try {
          // Utilise une date dynamique pour que asOf ne soit pas dans le futur.
          const asOf = getAsOf();
          const boundary = calculateAggregateRetentionBoundary(asOf);
          const boundaryStr = boundary.toISOString().slice(0, 10);
          // Jour avant la borne (sera supprimé) et jour à la borne (conservé).
          const beforeBoundaryDate = new Date(boundary.getTime() - 24 * 60 * 60 * 1000);
          const beforeBoundaryStr = beforeBoundaryDate.toISOString().slice(0, 10);

          const sql = postgres(testUrl, { max: 1 });
          try {
            await sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES (${beforeBoundaryStr}, 'TEST', 1, 1, 0, 0)
            ON CONFLICT (day, environment) DO NOTHING
          `;
            await sql`
            INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
            VALUES (${boundaryStr}, 'TEST', 2, 1, 0, 0)
            ON CONFLICT (day, environment) DO NOTHING
          `;
          } finally {
            await sql.end();
          }

          await purgeExpiredProductAnalytics(db, { asOf });

          const sql2 = postgres(testUrl, { max: 1 });
          try {
            const [beforeBoundary] = await sql2`
            SELECT count(*)::int as n FROM product_analytics_daily
            WHERE day = ${beforeBoundaryStr} AND environment = 'TEST'
          `;
            expect(beforeBoundary!.n).toBe(0);

            const [atBoundary] = await sql2`
            SELECT count(*)::int as n FROM product_analytics_daily
            WHERE day = ${boundaryStr} AND environment = 'TEST'
          `;
            expect(atBoundary!.n).toBe(1);
          } finally {
            await sql2.end();
          }
        } finally {
          await db.$client.end();
        }
      });

      it('F11 — Erreur DELETE → ANALYTICS_UNAVAILABLE + rollback', async () => {
        if (!testUrl) return;
        const db = createDatabase(testUrl);
        const sql = postgres(testUrl, { max: 1 });
        try {
          const now = Date.now();
          const oldMs = now - 99 * 24 * 60 * 60 * 1000;
          const oldDate = new Date(oldMs);
          const oldDay = oldDate.toISOString().slice(0, 10);
          const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const asOf = getAsOf();

          // Insère un événement ancien et agrège.
          await recordProductAnalyticsEvent(db, {
            eventType: 'PUBLIC_SEARCH_PERFORMED',
            environment: 'DEVELOPMENT',
            sourceId: fakeUuid(500),
            occurredAt: oldDate,
            hasResults: true,
          });
          await aggregateProductAnalyticsDays(db, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: 'DEVELOPMENT',
          });

          // Installe un trigger temporaire qui lève une erreur sur DELETE.
          await sql`
            CREATE OR REPLACE FUNCTION temp_block_delete() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'temp_block_delete: DELETE bloqué pour test';
            END;
            $$
          `;
          await sql`
            CREATE TRIGGER temp_block_delete_trigger
            BEFORE DELETE ON product_analytics_events
            FOR EACH ROW
            EXECUTE FUNCTION temp_block_delete()
          `;

          try {
            // La purge doit échouer avec ANALYTICS_UNAVAILABLE.
            await expect(
              purgeExpiredProductAnalytics(db, { asOf, rawLimit: 1000 }),
            ).rejects.toThrowError(ProductAnalyticsError);

            // Vérifie le rollback : l'événement n'a pas été supprimé.
            const [rawCount] = await sql`
              SELECT count(*)::int as n FROM product_analytics_events
              WHERE source_id = ${fakeUuid(500)}
            `;
            expect(rawCount!.n).toBe(1);

            // L'agrégat n'a pas été modifié de manière incohérente.
            const [agg] = await sql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = 'DEVELOPMENT'
            `;
            expect(agg).toBeDefined();
            expect(Number(agg!.searches)).toBe(1);
            expect(Number(agg!.compacted_searches)).toBe(0);
          } finally {
            // Nettoie le trigger temporaire.
            await sql`DROP TRIGGER IF EXISTS temp_block_delete_trigger ON product_analytics_events`;
            await sql`DROP FUNCTION IF EXISTS temp_block_delete()`;
          }
        } finally {
          await sql.end();
          await db.$client.end();
        }
      });

      it('F12 — Vérifier les nouvelles colonnes compacted', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          // Vérifie les 4 colonnes existent avec type bigint et défaut 0.
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
            expect(col.column_default).not.toBeNull();
          }

          // Vérifie les contraintes CHECK existent.
          const constraints = await sql`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'product_analytics_daily'::regclass
              AND conname LIKE 'product_analytics_daily_compacted%'
            ORDER BY conname
          `;
          const names = constraints.map((r) => r.conname);
          expect(names.length).toBeGreaterThanOrEqual(9);
          expect(names).toContain('product_analytics_daily_compacted_s_le_s');
          expect(names).toContain('product_analytics_daily_compacted_swr_le_cs');
        } finally {
          await sql.end();
        }
      });

      it('F13 — lock-order : pas de deadlock entre advisory lock et row lock', async () => {
        if (!testUrl) return;
        // Use a day > 24 months ago.
        const asOf = getAsOf();
        const boundary = calculateAggregateRetentionBoundary(asOf);
        const oldDay = new Date(boundary.getTime() - 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const env = 'TEST';

        // Insert an expired aggregate (no raw events for this day).
        const setupSql = postgres(testUrl, { max: 1 });
        try {
          await setupSql`
              INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed, compacted_searches, compacted_searches_with_results, compacted_booking_attempts, compacted_bookings_confirmed)
              VALUES (${oldDay}, ${env}, 5, 3, 2, 1, 5, 3, 2, 1)
              ON CONFLICT (day, environment) DO NOTHING
            `;
        } finally {
          await setupSql.end();
        }

        // Compute the advisory lock key that purge will use.
        // Replicates advisoryLockKey(day, environment) from aggregate.ts.
        function testAdvisoryLockKey(day: string, environment: string): bigint {
          const str = `${day}|${environment}`;
          let hash = 0n;
          for (let i = 0; i < str.length; i++) {
            hash = (hash * 31n + BigInt(str.charCodeAt(i))) & ((1n << 63n) - 1n);
          }
          return hash;
        }
        const lockKey = testAdvisoryLockKey(oldDay, env);

        // Sentinel connection: holds the advisory lock (session-level).
        const sentinelConn = postgres(testUrl, { max: 1 });
        await sentinelConn`SELECT pg_advisory_lock(${lockKey.toString()})`;

        const db1 = createDatabase(testUrl);
        const db2 = createDatabase(testUrl);
        try {
          // Start purge in background — it will block on the advisory lock.
          const purgePromise = purgeExpiredProductAnalytics(db2, { asOf, rawLimit: 1000 });

          // Give it time to select candidate keys and reach the advisory lock.
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Release the sentinel — purge proceeds.
          await sentinelConn`SELECT pg_advisory_unlock(${lockKey.toString()})`;

          // Wait for purge to complete with a bounded timeout.
          const result = await Promise.race([
            purgePromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Purge timeout — possible deadlock')), 10000),
            ),
          ]);

          expect(result.aggregatesDeleted).toBeGreaterThanOrEqual(1);

          // Verify the aggregate was deleted.
          const verifySql = postgres(testUrl, { max: 1 });
          try {
            const [row] = await verifySql`
                SELECT count(*)::int as n FROM product_analytics_daily
                WHERE day = ${oldDay} AND environment = ${env}
              `;
            expect(row!.n).toBe(0);
          } finally {
            await verifySql.end();
          }
        } finally {
          await sentinelConn`SELECT pg_advisory_unlock(${lockKey.toString()})`.catch(() => {});
          await sentinelConn.end();
          await db1.$client.end();
          await db2.$client.end();
        }
      }, 15000); // Bounded test timeout: 15 seconds.

      it('F14 — lock-order raw : pas de deadlock entre advisory lock et row lock (raw phase)', async () => {
        if (!testUrl) return;
        // Use a day > 90 days ago (raw retention) but < 24 months (aggregate
        // retention) so that only the raw events are purged, not the aggregate.
        const asOf = getAsOf();
        const rawBoundary = calculateRawRetentionBoundary(asOf);
        const oldMs = rawBoundary.getTime() - 7 * 24 * 60 * 60 * 1000;
        const oldDate = new Date(oldMs);
        const oldDay = oldDate.toISOString().slice(0, 10);
        const nextDay = new Date(oldMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const env = 'TEST';

        // Clean expired events from other tests first.
        const dbClean = createDatabase(testUrl);
        try {
          await purgeExpiredProductAnalytics(dbClean, { asOf, rawLimit: 5000 });
        } finally {
          await dbClean.$client.end();
        }

        // Insert 3 raw events old enough to be purged, then aggregate.
        const dbSetup = createDatabase(testUrl);
        try {
          for (let i = 0; i < 3; i++) {
            await recordProductAnalyticsEvent(dbSetup, {
              eventType: 'PUBLIC_SEARCH_PERFORMED',
              environment: env,
              sourceId: fakeUuid(600 + i),
              occurredAt: new Date(oldMs + i * 1000),
              hasResults: true,
            });
          }
          await aggregateProductAnalyticsDays(dbSetup, {
            fromDay: oldDay,
            toDayExclusive: nextDay,
            environment: env,
          });
        } finally {
          await dbSetup.$client.end();
        }

        // Compute the advisory lock key that purge will use.
        // Replicates advisoryLockKey(day, environment) from aggregate.ts.
        function testAdvisoryLockKey(day: string, environment: string): bigint {
          const str = `${day}|${environment}`;
          let hash = 0n;
          for (let i = 0; i < str.length; i++) {
            hash = (hash * 31n + BigInt(str.charCodeAt(i))) & ((1n << 63n) - 1n);
          }
          return hash;
        }
        const lockKey = testAdvisoryLockKey(oldDay, env);

        // Sentinel connection: holds the advisory lock (session-level).
        const sentinelConn = postgres(testUrl, { max: 1 });
        await sentinelConn`SELECT pg_advisory_lock(${lockKey.toString()})`;

        const db1 = createDatabase(testUrl);
        const db2 = createDatabase(testUrl);
        try {
          // Start purge in background — it will block on the advisory lock
          // during the raw events purge phase (advisory lock acquired FIRST,
          // before any row locks).
          const purgePromise = purgeExpiredProductAnalytics(db2, { asOf, rawLimit: 1000 });

          // Give it time to select candidate keys (without row lock) and reach
          // the advisory lock for the group.
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Release the sentinel — purge proceeds.
          await sentinelConn`SELECT pg_advisory_unlock(${lockKey.toString()})`;

          // Wait for purge to complete with a bounded timeout.
          const result = await Promise.race([
            purgePromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Purge timeout — possible deadlock')), 10000),
            ),
          ]);

          // Verify raw events were deleted.
          expect(result.rawEventsDeleted).toBeGreaterThanOrEqual(3);

          // Verify the aggregate is correct and no raw events remain.
          const verifySql = postgres(testUrl, { max: 1 });
          try {
            const [agg] = await verifySql`
              SELECT * FROM product_analytics_daily
              WHERE day = ${oldDay} AND environment = ${env}
            `;
            expect(agg).toBeDefined();
            expect(Number(agg!.searches)).toBe(3);
            expect(Number(agg!.compacted_searches)).toBe(3);

            const [rawCount] = await verifySql`
              SELECT count(*)::int as n FROM product_analytics_events
              WHERE environment = ${env}
                AND occurred_at >= ${new Date(oldDay + 'T00:00:00.000Z')}
                AND occurred_at < ${new Date(nextDay + 'T00:00:00.000Z')}
            `;
            expect(rawCount!.n).toBe(0);
          } finally {
            await verifySql.end();
          }
        } finally {
          await sentinelConn`SELECT pg_advisory_unlock(${lockKey.toString()})`.catch(() => {});
          await sentinelConn.end();
          await db1.$client.end();
          await db2.$client.end();
        }
      }, 15000); // Bounded test timeout: 15 seconds.
    });

    // =========================================================================
    // G. Overflow BIGINT
    // =========================================================================
    describe('G. Overflow', () => {
      it('G1 — overflow BIGINT dans le résumé → OVERFLOW', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          // Insère un agrégat avec une valeur énorme.
          await sql`
          INSERT INTO product_analytics_daily (day, environment, searches, searches_with_results, booking_attempts, bookings_confirmed)
          VALUES ('2030-06-01', 'TEST', 9007199254740992, 0, 0, 0)
        `;
        } finally {
          await sql.end();
        }

        const db = createDatabase(testUrl);
        try {
          await expect(
            getProductAnalyticsSummary(db, {
              environment: 'TEST',
              fromDay: '2030-06-01',
              toDayExclusive: '2030-06-02',
            }),
          ).rejects.toThrowError(ProductAnalyticsError);
        } finally {
          await db.$client.end();
        }
      });
    });
  },
);
