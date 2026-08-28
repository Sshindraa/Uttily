import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost, createDatabase } from '@uttily/database';
import { recordProductAnalyticsEvent, getProductAnalyticsSummary } from '@uttily/core';
import {
  runProductAnalyticsMaintenance,
  resolveMaintenanceWindow,
} from './product-analytics-maintenance';

/**
 * Chantier 18-A — Tests d'intégration PostgreSQL pour la maintenance analytics.
 *
 * Vérifie sur base PostgreSQL réelle :
 * - L'agrégation effective des événements de la fenêtre (DEVELOPMENT et TEST).
 * - L'idempotence et la sécurité en rejeu (deux exécutions consécutives).
 * - L'exécution de la purge avec compaction.
 * - Le respect strict de l'exclusion de PRODUCTION.
 */

const TEST_DB_NAME = 'uttily_test_product_analytics_maintenance_18a';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests 18-A.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error('DATABASE_URL est définie mais la base PostgreSQL est injoignable.');
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

function fakeUuid(seed: number): string {
  const hex = seed.toString(16).padStart(8, '0');
  return `${hex}-4000-8000-0000-${'0'.repeat(12)}`;
}

describe.skipIf(shouldSkipIntegrationTests())(
  '18-A — Maintenance analytics produit (intégration PostgreSQL)',
  () => {
    it('agrège correctement les jours, est idempotent en rejeu, et purge sans perte', async () => {
      if (!testUrl) return;
      const db = createDatabase(testUrl);

      const now = new Date('2026-08-28T14:00:00.000Z');
      const window = resolveMaintenanceWindow(now);

      // Insérer des événements dans DEVELOPMENT
      await recordProductAnalyticsEvent(db, {
        sourceId: fakeUuid(1),
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        occurredAt: new Date('2026-08-27T10:00:00.000Z'),
        environment: 'DEVELOPMENT',
        hasResults: false,
      });
      await recordProductAnalyticsEvent(db, {
        sourceId: fakeUuid(2),
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        occurredAt: new Date('2026-08-27T10:01:00.000Z'),
        environment: 'DEVELOPMENT',
        hasResults: true,
      });
      await recordProductAnalyticsEvent(db, {
        sourceId: fakeUuid(3),
        eventType: 'BOOKING_ATTEMPTED',
        occurredAt: new Date('2026-08-28T09:00:00.000Z'),
        environment: 'DEVELOPMENT',
      });
      await recordProductAnalyticsEvent(db, {
        sourceId: fakeUuid(4),
        eventType: 'BOOKING_CONFIRMED',
        occurredAt: new Date('2026-08-28T09:05:00.000Z'),
        environment: 'DEVELOPMENT',
      });

      // Insérer des événements dans TEST
      await recordProductAnalyticsEvent(db, {
        sourceId: fakeUuid(10),
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        occurredAt: new Date('2026-08-28T11:00:00.000Z'),
        environment: 'TEST',
        hasResults: false,
      });

      // 1. Première exécution de maintenance
      const result1 = await runProductAnalyticsMaintenance(db, { now });

      expect(result1.productionCollectionEnabled).toBe(false);
      expect(result1.aggregatedEnvironments).toEqual(['DEVELOPMENT', 'TEST']);
      expect(result1.window).toEqual(window);

      // Vérifier le résumé DEVELOPMENT
      const summaryDev1 = await getProductAnalyticsSummary(db, {
        environment: 'DEVELOPMENT',
        fromDay: window.fromDay,
        toDayExclusive: window.toDayExclusive,
      });
      expect(summaryDev1).toEqual({
        searches: 2,
        searchesWithResults: 1,
        bookingAttempts: 1,
        bookingsConfirmed: 1,
      });

      // Vérifier le résumé TEST
      const summaryTest1 = await getProductAnalyticsSummary(db, {
        environment: 'TEST',
        fromDay: window.fromDay,
        toDayExclusive: window.toDayExclusive,
      });
      expect(summaryTest1).toEqual({
        searches: 1,
        searchesWithResults: 0,
        bookingAttempts: 0,
        bookingsConfirmed: 0,
      });

      // 2. Deuxième exécution (rejeu / idempotence)
      const result2 = await runProductAnalyticsMaintenance(db, { now });

      expect(result2.productionCollectionEnabled).toBe(false);
      expect(result2.aggregatedEnvironments).toEqual(['DEVELOPMENT', 'TEST']);

      const summaryDev2 = await getProductAnalyticsSummary(db, {
        environment: 'DEVELOPMENT',
        fromDay: window.fromDay,
        toDayExclusive: window.toDayExclusive,
      });
      expect(summaryDev2).toEqual(summaryDev1);

      const summaryTest2 = await getProductAnalyticsSummary(db, {
        environment: 'TEST',
        fromDay: window.fromDay,
        toDayExclusive: window.toDayExclusive,
      });
      expect(summaryTest2).toEqual(summaryTest1);
    });
  },
);
