import { describe, expect, it } from 'vitest';
import { ProductAnalyticsError } from './errors';
import { getProductAnalyticsSummary } from './summary';
import { safeBigIntToNumber } from './validation';

/**
 * Tests unitaires de getProductAnalyticsSummary (G7H-A).
 * Tests de validation de plage et overflow — aucune base de données requise.
 * Les tests d'intégration PostgreSQL sont dans product-analytics.integration.test.ts.
 */

const mockDb = {} as Parameters<typeof getProductAnalyticsSummary>[0];

describe('G7H-A — getProductAnalyticsSummary (validation)', () => {
  it('plage de 366 jours → passe la validation (borne max)', async () => {
    // Avec un mock vide, la fonction échouera sur l'accès DB, mais la
    // validation de plage doit passer.
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: '2025-01-01',
        toDayExclusive: '2026-01-02',
      }),
    ).rejects.toThrow();
  });

  it('plage de 367 jours → RANGE_TOO_LARGE', async () => {
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: '2025-01-01',
        toDayExclusive: '2026-01-03',
      }),
    ).rejects.toThrowError(ProductAnalyticsError);
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: '2025-01-01',
        toDayExclusive: '2026-01-03',
      }),
    ).rejects.toThrowError(/ne doit pas dépasser 366/);
  });

  it('plage nulle → INVALID_DAY_RANGE', async () => {
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: '2026-01-01',
        toDayExclusive: '2026-01-01',
      }),
    ).rejects.toThrowError(/positive/);
  });

  it('plage négative → INVALID_DAY_RANGE', async () => {
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: '2026-01-02',
        toDayExclusive: '2026-01-01',
      }),
    ).rejects.toThrowError(/positive/);
  });

  it('environnement invalide → INVALID_ENVIRONMENT', async () => {
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'LIVE' as never,
        fromDay: '2026-01-01',
        toDayExclusive: '2026-01-02',
      }),
    ).rejects.toThrowError(/Environnement invalide/);
  });

  it('date invalide → INVALID_DATE', async () => {
    await expect(
      getProductAnalyticsSummary(mockDb, {
        environment: 'TEST',
        fromDay: 'invalid',
        toDayExclusive: '2026-01-02',
      }),
    ).rejects.toThrowError(ProductAnalyticsError);
  });

  // =========================================================================
  // Overflow detection
  // =========================================================================
  describe('overflow detection', () => {
    it('MAX_SAFE_INTEGER → accepté', () => {
      expect(safeBigIntToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('MAX_SAFE_INTEGER + 1 → OVERFLOW', () => {
      expect(() => safeBigIntToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => safeBigIntToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(
        /Dépassement/,
      );
    });

    it('MIN_SAFE_INTEGER - 1 → OVERFLOW (négatif)', () => {
      expect(() => safeBigIntToNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => safeBigIntToNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrowError(
        /Dépassement/,
      );
    });

    it('MIN_SAFE_INTEGER → accepté (négatif)', () => {
      expect(safeBigIntToNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    });
  });
});
