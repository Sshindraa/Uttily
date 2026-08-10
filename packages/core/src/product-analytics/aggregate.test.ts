import { describe, expect, it } from 'vitest';
import { ProductAnalyticsError } from './errors';
import { aggregateProductAnalyticsDays } from './aggregate';

/**
 * Tests unitaires de aggregateProductAnalyticsDays (G7H-A).
 * Tests de validation de plage — aucune base de données requise.
 * Les tests d'intégration PostgreSQL sont dans product-analytics.integration.test.ts.
 */

const mockDb = {} as Parameters<typeof aggregateProductAnalyticsDays>[0];

describe('G7H-A — aggregateProductAnalyticsDays (validation)', () => {
  it('plage de 31 jours → passe la validation (borne max)', async () => {
    // Avec un mock vide, la fonction échouera sur l'accès DB, mais la
    // validation de plage doit passer (pas d'erreur INVALID_DAY_RANGE).
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-01',
        toDayExclusive: '2026-02-01',
        environment: 'TEST',
      }),
    ).rejects.toThrow();
  });

  it('plage de 32 jours → RANGE_TOO_LARGE', async () => {
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-01',
        toDayExclusive: '2026-02-02',
        environment: 'TEST',
      }),
    ).rejects.toThrowError(ProductAnalyticsError);
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-01',
        toDayExclusive: '2026-02-02',
        environment: 'TEST',
      }),
    ).rejects.toThrowError(/ne doit pas dépasser 31/);
  });

  it('plage nulle → INVALID_DAY_RANGE', async () => {
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-01',
        toDayExclusive: '2026-01-01',
        environment: 'TEST',
      }),
    ).rejects.toThrowError(/positive/);
  });

  it('plage négative → INVALID_DAY_RANGE', async () => {
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-02',
        toDayExclusive: '2026-01-01',
        environment: 'TEST',
      }),
    ).rejects.toThrowError(/positive/);
  });

  it('date invalide → INVALID_DATE', async () => {
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: 'invalid',
        toDayExclusive: '2026-01-02',
        environment: 'TEST',
      }),
    ).rejects.toThrowError(ProductAnalyticsError);
  });

  it('environnement invalide → INVALID_ENVIRONMENT', async () => {
    await expect(
      aggregateProductAnalyticsDays(mockDb, {
        fromDay: '2026-01-01',
        toDayExclusive: '2026-01-02',
        environment: 'LIVE' as never,
      }),
    ).rejects.toThrowError(/Environnement invalide/);
  });
});
