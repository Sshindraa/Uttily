import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@uttily/core';
import {
  ANALYTICS_AGGREGATION_LOOKBACK_DAYS,
  ANALYTICS_MAINTENANCE_ENVIRONMENTS,
  resolveMaintenanceWindow,
  runProductAnalyticsMaintenance,
} from './product-analytics-maintenance';

/**
 * Chantier 18-A — Orchestration de maintenance analytics.
 *
 * Volet rapide (hors PostgreSQL) : fenêtre de rattrapage, exclusion stricte de
 * PRODUCTION, et ordonnancement agrégation → purge. Les invariants
 * d'agrégation et de purge sur PostgreSQL réel sont dans
 * `product-analytics-maintenance.integration.test.ts`.
 */

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    aggregateProductAnalyticsDays: vi.fn(async () => ({ daysProcessed: 3 })),
    purgeExpiredProductAnalytics: vi.fn(async () => ({
      rawEventsDeleted: 7,
      aggregatesDeleted: 2,
    })),
    resolveAnalyticsEnvironmentFromProcessEnv: vi.fn(() => 'DEVELOPMENT'),
  };
});

describe('18-A — Fenêtre de maintenance', () => {
  it('couvre le jour courant et rattrape un cron manqué', () => {
    const now = new Date('2026-08-28T17:45:00.000Z');
    const window = resolveMaintenanceWindow(now);

    expect(window.toDayExclusive).toBe('2026-08-29');
    expect(window.fromDay).toBe('2026-08-26');

    const from = new Date(`${window.fromDay}T00:00:00.000Z`);
    const to = new Date(`${window.toDayExclusive}T00:00:00.000Z`);
    const days = (to.getTime() - from.getTime()) / 86_400_000;

    expect(days).toBe(ANALYTICS_AGGREGATION_LOOKBACK_DAYS + 1);
  });

  it('reste strictement sous la borne Core de 31 jours', () => {
    const window = resolveMaintenanceWindow(new Date('2026-08-28T00:00:00.000Z'));
    const from = new Date(`${window.fromDay}T00:00:00.000Z`);
    const to = new Date(`${window.toDayExclusive}T00:00:00.000Z`);

    expect((to.getTime() - from.getTime()) / 86_400_000).toBeLessThanOrEqual(31);
  });

  it('est calculée en UTC, indépendamment du fuseau du serveur', () => {
    const window = resolveMaintenanceWindow(new Date('2026-01-01T00:30:00.000Z'));
    expect(window.toDayExclusive).toBe('2026-01-02');
  });
});

describe('18-A — Environnements maintenus', () => {
  it('n’inclut jamais PRODUCTION', () => {
    expect(ANALYTICS_MAINTENANCE_ENVIRONMENTS).toEqual(['DEVELOPMENT', 'TEST']);
    expect(ANALYTICS_MAINTENANCE_ENVIRONMENTS).not.toContain('PRODUCTION');
  });
});

describe('18-A — Exécution de la maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(core.resolveAnalyticsEnvironmentFromProcessEnv).mockReturnValue('DEVELOPMENT');
    vi.mocked(core.aggregateProductAnalyticsDays).mockResolvedValue({ daysProcessed: 3 });
    vi.mocked(core.purgeExpiredProductAnalytics).mockResolvedValue({
      rawEventsDeleted: 7,
      aggregatesDeleted: 2,
    });
  });

  it('agrège chaque environnement maintenu, puis purge une seule fois', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    await runProductAnalyticsMaintenance({} as never, { now });

    expect(core.aggregateProductAnalyticsDays).toHaveBeenCalledTimes(
      ANALYTICS_MAINTENANCE_ENVIRONMENTS.length,
    );

    const window = resolveMaintenanceWindow(now);
    for (const environment of ANALYTICS_MAINTENANCE_ENVIRONMENTS) {
      expect(core.aggregateProductAnalyticsDays).toHaveBeenCalledWith(
        {},
        {
          fromDay: window.fromDay,
          toDayExclusive: window.toDayExclusive,
          environment,
        },
      );
    }

    expect(core.purgeExpiredProductAnalytics).toHaveBeenCalledTimes(1);
    expect(core.purgeExpiredProductAnalytics).toHaveBeenCalledWith({}, { asOf: now });
  });

  it('n’agrège jamais PRODUCTION, même si l’environnement résolu l’exige', async () => {
    // PRODUCTION est inatteignable : exclu du type et de la liste fermée.
    process.env.PRODUCT_ANALYTICS_ENVIRONMENT = 'PRODUCTION';
    try {
      const result = await runProductAnalyticsMaintenance({} as never, { now: new Date() });

      expect(result.aggregatedEnvironments).not.toContain('PRODUCTION');
      expect(result.aggregatedEnvironments).toEqual(['DEVELOPMENT', 'TEST']);
      expect(result.productionCollectionEnabled).toBe(false);

      const aggregatedArgs = vi
        .mocked(core.aggregateProductAnalyticsDays)
        .mock.calls.map((call) => call[1].environment);
      expect(aggregatedArgs).not.toContain('PRODUCTION');
    } finally {
      delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
    }
  });

  it('rapporte l’environnement de collecte résolu et des compteurs de purge', async () => {
    vi.mocked(core.resolveAnalyticsEnvironmentFromProcessEnv).mockReturnValue('DISABLED');

    const result = await runProductAnalyticsMaintenance({} as never, { now: new Date() });

    expect(result.collectionEnvironment).toBe('DISABLED');
    expect(result.productionCollectionEnabled).toBe(false);
    expect(result.purge).toEqual({ rawEventsDeleted: 7, aggregatesDeleted: 2 });
    expect(result.aggregationDaysProcessed).toBe(6);
  });
});
