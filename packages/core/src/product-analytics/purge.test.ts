import { describe, expect, it } from 'vitest';
import { ProductAnalyticsError } from './errors';
import { purgeExpiredProductAnalytics } from './purge';
import {
  calculateAggregateRetentionBoundary,
  calculateRawRetentionBoundary,
  normalizeRawLimit,
} from './validation';

/**
 * Tests unitaires de purgeExpiredProductAnalytics (G7H-A).
 * Tests de validation et calcul de bornes — aucune base de données requise.
 * Les tests d'intégration PostgreSQL sont dans product-analytics.integration.test.ts.
 */

const mockDb = {} as Parameters<typeof purgeExpiredProductAnalytics>[0];

describe('G7H-A — purgeExpiredProductAnalytics (validation)', () => {
  // =========================================================================
  // rawLimit normalization
  // =========================================================================
  describe('rawLimit normalization', () => {
    it('défaut 1000 via la fonction de validation', () => {
      expect(normalizeRawLimit(undefined)).toBe(1000);
    });

    it('cap 5000', () => {
      expect(normalizeRawLimit(5001)).toBe(5000);
    });

    it('null → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(null as unknown as undefined)).toThrowError(
        ProductAnalyticsError,
      );
    });

    it('0 → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(0)).toThrowError(ProductAnalyticsError);
    });
  });

  // =========================================================================
  // 90-day boundary calculation
  // =========================================================================
  describe('borne de rétention raw (90 jours)', () => {
    it('asOf - 90 jours exact', () => {
      const asOf = new Date('2026-08-15T12:00:00.000Z');
      const boundary = calculateRawRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2026-05-17T12:00:00.000Z');
    });

    it("préserve l'heure", () => {
      const asOf = new Date('2026-01-01T23:59:59.999Z');
      const boundary = calculateRawRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2025-10-03T23:59:59.999Z');
    });
  });

  // =========================================================================
  // 24-month boundary calculation
  // =========================================================================
  describe('borne de rétention agrégats (24 mois)', () => {
    it('15 janvier 2026 → 15 janvier 2024', () => {
      const asOf = new Date('2026-01-15T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('29 février 2024 (bissextile) → 28 février 2022', () => {
      const asOf = new Date('2024-02-29T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2022-02-28T00:00:00.000Z');
    });

    it('31 mars 2026 → 31 mars 2024 (mars a 31 jours)', () => {
      const asOf = new Date('2026-03-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-03-31T00:00:00.000Z');
    });

    it('31 août 2026 → 31 août 2024 (août a 31 jours)', () => {
      const asOf = new Date('2026-08-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-08-31T00:00:00.000Z');
    });

    it('borne est exclusive (day < boundary supprimé)', () => {
      const asOf = new Date('2026-01-15T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString().slice(0, 10)).toBe('2024-01-15');
    });
  });

  // =========================================================================
  // asOf validation
  // =========================================================================
  describe('validation asOf', () => {
    it('asOf invalide (Invalid Date) → INVALID_INPUT', async () => {
      await expect(
        purgeExpiredProductAnalytics(mockDb, { asOf: new Date('invalid') }),
      ).rejects.toThrowError(ProductAnalyticsError);
      await expect(
        purgeExpiredProductAnalytics(mockDb, { asOf: new Date('invalid') }),
      ).rejects.toThrowError(/asOf invalide/);
    });

    it('asOf non-Date → INVALID_INPUT', async () => {
      await expect(
        purgeExpiredProductAnalytics(mockDb, { asOf: '2026-01-01' as unknown as Date }),
      ).rejects.toThrowError(/asOf invalide/);
    });
  });
});
