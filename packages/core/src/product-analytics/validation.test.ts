import { describe, expect, it } from 'vitest';
import { ProductAnalyticsError } from './errors';
import {
  calculateAggregateRetentionBoundary,
  calculateRawRetentionBoundary,
  decodeBigInt,
  decodeNonNegativeBigInt,
  normalizeRawLimit,
  safeBigIntToNumber,
  validateAsOfRepresentable,
  validateDateString,
  validateDayRange,
  validateEnvironment,
  validateEventType,
  validateOccurredAt,
  validateUuid,
} from './validation';

/**
 * Tests unitaires des fonctions de validation pures (G7H-A).
 * Aucune base de données requise.
 */

describe('G7H-A — validation', () => {
  // =========================================================================
  // validateUuid
  // =========================================================================
  describe('validateUuid', () => {
    it('UUID valide (lowercase) → accepté', () => {
      expect(() => validateUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'sourceId')).not.toThrow();
    });

    it('UUID valide (uppercase) → accepté', () => {
      expect(() => validateUuid('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 'sourceId')).not.toThrow();
    });

    it('UUID invalide (trop court) → INVALID_UUID', () => {
      expect(() => validateUuid('a0eebc99-9c0b-4ef8-bb6d', 'sourceId')).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => validateUuid('a0eebc99-9c0b-4ef8-bb6d', 'sourceId')).toThrowError(
        /sourceId invalide/,
      );
    });

    it('UUID invalide (caractères non hex) → INVALID_UUID', () => {
      expect(() => validateUuid('g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'sourceId')).toThrowError(
        ProductAnalyticsError,
      );
    });

    it('UUID vide → INVALID_UUID', () => {
      expect(() => validateUuid('', 'sourceId')).toThrowError(ProductAnalyticsError);
    });

    it('UUID non-string → INVALID_UUID', () => {
      expect(() => validateUuid(null as unknown as string, 'sourceId')).toThrowError(
        ProductAnalyticsError,
      );
    });
  });

  // =========================================================================
  // validateDateString
  // =========================================================================
  describe('validateDateString', () => {
    it('date valide → retourne les composants', () => {
      const result = validateDateString('2026-01-15', 'fromDay');
      expect(result).toEqual({ year: 2026, month: 1, day: 15 });
    });

    it('29 février année bissextile → accepté', () => {
      const result = validateDateString('2024-02-29', 'fromDay');
      expect(result).toEqual({ year: 2024, month: 2, day: 29 });
    });

    it('29 février année non-bissextile → INVALID_DATE', () => {
      expect(() => validateDateString('2023-02-29', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('31 avril → INVALID_DATE (avril a 30 jours)', () => {
      expect(() => validateDateString('2026-04-31', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('format non-YYYY-MM-DD → INVALID_DATE', () => {
      expect(() => validateDateString('2026/01/15', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('mois 00 → INVALID_DATE', () => {
      expect(() => validateDateString('2026-00-15', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('mois 13 → INVALID_DATE', () => {
      expect(() => validateDateString('2026-13-15', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('jour 00 → INVALID_DATE', () => {
      expect(() => validateDateString('2026-01-00', 'fromDay')).toThrowError(ProductAnalyticsError);
    });

    it('chaîne vide → INVALID_DATE', () => {
      expect(() => validateDateString('', 'fromDay')).toThrowError(ProductAnalyticsError);
    });
  });

  // =========================================================================
  // validateDayRange
  // =========================================================================
  describe('validateDayRange', () => {
    it('plage positive de 1 jour → accepté', () => {
      const result = validateDayRange('2026-01-01', '2026-01-02', 31);
      expect(result.dayCount).toBe(1);
    });

    it('plage positive de 31 jours → accepté (borne max)', () => {
      const result = validateDayRange('2026-01-01', '2026-02-01', 31);
      expect(result.dayCount).toBe(31);
    });

    it('plage de 32 jours → RANGE_TOO_LARGE', () => {
      expect(() => validateDayRange('2026-01-01', '2026-02-02', 31)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => validateDayRange('2026-01-01', '2026-02-02', 31)).toThrowError(
        /ne doit pas dépasser 31/,
      );
    });

    it('plage nulle (fromDay == toDayExclusive) → INVALID_DAY_RANGE', () => {
      expect(() => validateDayRange('2026-01-01', '2026-01-01', 31)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => validateDayRange('2026-01-01', '2026-01-01', 31)).toThrowError(/positive/);
    });

    it('plage négative (fromDay > toDayExclusive) → INVALID_DAY_RANGE', () => {
      expect(() => validateDayRange('2026-01-02', '2026-01-01', 31)).toThrowError(
        ProductAnalyticsError,
      );
    });

    it('date invalide → INVALID_DATE', () => {
      expect(() => validateDayRange('invalid', '2026-01-02', 31)).toThrowError(
        ProductAnalyticsError,
      );
    });
  });

  // =========================================================================
  // validateOccurredAt
  // =========================================================================
  describe('validateOccurredAt', () => {
    it('Date valide → accepté', () => {
      expect(() => validateOccurredAt(new Date('2026-01-15T10:00:00Z'))).not.toThrow();
    });

    it('Invalid Date → INVALID_INPUT', () => {
      expect(() => validateOccurredAt(new Date('invalid'))).toThrowError(ProductAnalyticsError);
    });

    it('NaN (non-Date) → INVALID_INPUT', () => {
      expect(() => validateOccurredAt(NaN as unknown as Date)).toThrowError(ProductAnalyticsError);
    });

    it('non-Date → INVALID_INPUT', () => {
      expect(() => validateOccurredAt('2026-01-15' as unknown as Date)).toThrowError(
        ProductAnalyticsError,
      );
    });
  });

  // =========================================================================
  // normalizeRawLimit
  // =========================================================================
  describe('normalizeRawLimit', () => {
    it('undefined → défaut 1000', () => {
      expect(normalizeRawLimit(undefined)).toBe(1000);
    });

    it('1 → 1', () => {
      expect(normalizeRawLimit(1)).toBe(1);
    });

    it('5000 → 5000 (borne max)', () => {
      expect(normalizeRawLimit(5000)).toBe(5000);
    });

    it('5001 → 5000 (cap)', () => {
      expect(normalizeRawLimit(5001)).toBe(5000);
    });

    it('null → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(null as unknown as undefined)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => normalizeRawLimit(null as unknown as undefined)).toThrowError(
        /rawLimit invalide/,
      );
    });

    it('0 → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(0)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(0)).toThrowError(/rawLimit invalide/);
    });

    it('négatif → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(-100)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(-100)).toThrowError(/rawLimit invalide/);
    });

    it('NaN → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(NaN)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(NaN)).toThrowError(/rawLimit invalide/);
    });

    it('Infinity → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(Infinity)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(Infinity)).toThrowError(/rawLimit invalide/);
    });

    it('-Infinity → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(-Infinity)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(-Infinity)).toThrowError(/rawLimit invalide/);
    });

    it('string → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit('1000' as unknown as undefined)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => normalizeRawLimit('1000' as unknown as undefined)).toThrowError(
        /rawLimit invalide/,
      );
    });

    it('boolean → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(true as unknown as undefined)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => normalizeRawLimit(true as unknown as undefined)).toThrowError(
        /rawLimit invalide/,
      );
    });

    it('décimal → INVALID_INPUT', () => {
      expect(() => normalizeRawLimit(500.9)).toThrowError(ProductAnalyticsError);
      expect(() => normalizeRawLimit(500.9)).toThrowError(/rawLimit invalide/);
    });

    it('MAX_SAFE_INTEGER + 1 → INVALID_INPUT (non-safe integer)', () => {
      expect(() => normalizeRawLimit(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => normalizeRawLimit(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
        /rawLimit invalide/,
      );
    });
  });

  // =========================================================================
  // calculateRawRetentionBoundary
  // =========================================================================
  describe('calculateRawRetentionBoundary', () => {
    it('asOf - 90 jours exact', () => {
      const asOf = new Date('2026-08-15T12:00:00.000Z');
      const boundary = calculateRawRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2026-05-17T12:00:00.000Z');
    });

    it("préserve l'heure exacte", () => {
      const asOf = new Date('2026-01-01T23:59:59.999Z');
      const boundary = calculateRawRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2025-10-03T23:59:59.999Z');
    });
  });

  // =========================================================================
  // calculateAggregateRetentionBoundary
  // =========================================================================
  describe('calculateAggregateRetentionBoundary', () => {
    it('15 janvier 2026 → 15 janvier 2024', () => {
      const asOf = new Date('2026-01-15T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it("31 mars 2026 → 31 mars 2024 (mars a 31 jours, pas d'ajustement)", () => {
      const asOf = new Date('2026-03-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-03-31T00:00:00.000Z');
    });

    it('31 mars 2024 → 29 février 2022 (fin de mois, année bissextile cible)', () => {
      // asOf = 2024-03-31, moins 24 mois = 2022-03-31 (mars a 31 jours, OK).
      const asOf = new Date('2024-03-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2022-03-31T00:00:00.000Z');
    });

    it('29 février 2024 → 28 février 2022 (année bissextile source)', () => {
      const asOf = new Date('2024-02-29T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      // 2024-02 - 24 mois = 2022-02. Février 2022 a 28 jours.
      expect(boundary.toISOString()).toBe('2022-02-28T00:00:00.000Z');
    });

    it('31 janvier 2026 → 31 janvier 2024', () => {
      const asOf = new Date('2026-01-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-01-31T00:00:00.000Z');
    });

    it('31 août 2026 → 31 août 2024 (août a 31 jours)', () => {
      const asOf = new Date('2026-08-31T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-08-31T00:00:00.000Z');
    });

    it('30 janvier 2026 → 30 janvier 2024', () => {
      const asOf = new Date('2026-01-30T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      expect(boundary.toISOString()).toBe('2024-01-30T00:00:00.000Z');
    });

    it('borne exclusive : day < boundary est supprimé', () => {
      // La borne est utilisée avec lt() dans purge, donc day == boundary est conservé.
      const asOf = new Date('2026-01-15T00:00:00.000Z');
      const boundary = calculateAggregateRetentionBoundary(asOf);
      const boundaryStr = boundary.toISOString().slice(0, 10);
      expect(boundaryStr).toBe('2024-01-15');
    });
  });

  // =========================================================================
  // safeBigIntToNumber
  // =========================================================================
  describe('safeBigIntToNumber', () => {
    it('0n → 0', () => {
      expect(safeBigIntToNumber(0n)).toBe(0);
    });

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

    it('MIN_SAFE_INTEGER → accepté', () => {
      expect(safeBigIntToNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    });

    it('MIN_SAFE_INTEGER - 1 → OVERFLOW', () => {
      expect(() => safeBigIntToNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrowError(
        ProductAnalyticsError,
      );
    });
  });

  // =========================================================================
  // validateEnvironment
  // =========================================================================
  describe('validateEnvironment', () => {
    it('DEVELOPMENT → accepté', () => {
      expect(validateEnvironment('DEVELOPMENT')).toBe('DEVELOPMENT');
    });

    it('TEST → accepté', () => {
      expect(validateEnvironment('TEST')).toBe('TEST');
    });

    it('PRODUCTION → accepté', () => {
      expect(validateEnvironment('PRODUCTION')).toBe('PRODUCTION');
    });

    it('LIVE (payment_environment) → INVALID_ENVIRONMENT', () => {
      expect(() => validateEnvironment('LIVE')).toThrowError(ProductAnalyticsError);
    });

    it('valeur inconnue → INVALID_ENVIRONMENT', () => {
      expect(() => validateEnvironment('STAGING')).toThrowError(ProductAnalyticsError);
    });
  });

  // =========================================================================
  // validateEventType
  // =========================================================================
  describe('validateEventType', () => {
    it('PUBLIC_SEARCH_PERFORMED → accepté', () => {
      expect(validateEventType('PUBLIC_SEARCH_PERFORMED')).toBe('PUBLIC_SEARCH_PERFORMED');
    });

    it('BOOKING_ATTEMPTED → accepté', () => {
      expect(validateEventType('BOOKING_ATTEMPTED')).toBe('BOOKING_ATTEMPTED');
    });

    it('BOOKING_CONFIRMED → accepté', () => {
      expect(validateEventType('BOOKING_CONFIRMED')).toBe('BOOKING_CONFIRMED');
    });

    it('valeur inconnue → INVALID_EVENT_TYPE', () => {
      expect(() => validateEventType('UNKNOWN')).toThrowError(ProductAnalyticsError);
    });
  });

  // =========================================================================
  // validateAsOfRepresentable
  // =========================================================================
  describe('validateAsOfRepresentable', () => {
    it('date normale → passe', () => {
      expect(() => validateAsOfRepresentable(new Date('2026-01-15T12:00:00.000Z'))).not.toThrow();
    });

    it('date extrême (année 100000) → INVALID_INPUT', () => {
      expect(() => validateAsOfRepresentable(new Date('100000-01-01T00:00:00.000Z'))).toThrowError(
        ProductAnalyticsError,
      );
      expect(() => validateAsOfRepresentable(new Date('100000-01-01T00:00:00.000Z'))).toThrowError(
        /non représentable/,
      );
    });
  });

  // =========================================================================
  // decodeBigInt
  // =========================================================================
  describe('decodeBigInt', () => {
    it('bigint → accepté', () => {
      expect(decodeBigInt(123n, 'test')).toBe(123n);
    });

    it('chaîne décimale "123" → accepté comme 123n', () => {
      expect(decodeBigInt('123', 'test')).toBe(123n);
    });

    it('chaîne "0" → accepté comme 0n', () => {
      expect(decodeBigInt('0', 'test')).toBe(0n);
    });

    it('number → rejeté (ANALYTICS_UNAVAILABLE)', () => {
      expect(() => decodeBigInt(123, 'test')).toThrowError(ProductAnalyticsError);
      expect(() => decodeBigInt(123, 'test')).toThrowError(/ANALYTICS_UNAVAILABLE|bigint invalide/);
    });

    it('NaN → rejeté', () => {
      expect(() => decodeBigInt(NaN, 'test')).toThrowError(ProductAnalyticsError);
    });

    it('chaîne vide → rejeté', () => {
      expect(() => decodeBigInt('', 'test')).toThrowError(ProductAnalyticsError);
    });

    it('chaîne négative "-1" → rejeté', () => {
      expect(() => decodeBigInt('-1', 'test')).toThrowError(ProductAnalyticsError);
    });

    it('chaîne décimale "1.5" → rejeté', () => {
      expect(() => decodeBigInt('1.5', 'test')).toThrowError(ProductAnalyticsError);
    });

    it('null → rejeté', () => {
      expect(() => decodeBigInt(null, 'test')).toThrowError(ProductAnalyticsError);
    });

    it('undefined → rejeté', () => {
      expect(() => decodeBigInt(undefined, 'test')).toThrowError(ProductAnalyticsError);
    });

    it('boolean → rejeté', () => {
      expect(() => decodeBigInt(true, 'test')).toThrowError(ProductAnalyticsError);
    });
  });

  // =========================================================================
  // decodeNonNegativeBigInt
  // =========================================================================
  describe('decodeNonNegativeBigInt', () => {
    it('bigint valide → accepté', () => {
      expect(decodeNonNegativeBigInt(42n, 'test')).toBe(42n);
    });

    it('bigint négatif → rejeté', () => {
      expect(() => decodeNonNegativeBigInt(-1n, 'test')).toThrowError(ProductAnalyticsError);
      expect(() => decodeNonNegativeBigInt(-1n, 'test')).toThrowError(/négative/);
    });

    it('0n → accepté', () => {
      expect(decodeNonNegativeBigInt(0n, 'test')).toBe(0n);
    });
  });
});
