import { describe, it, expect } from 'vitest';
import { safeAdd, safeMultiply, halfUpRound } from './safe-arithmetic';
import { FlexiblePricingError } from './errors';

describe('safe-arithmetic', () => {
  describe('safeMultiply', () => {
    it('multiplication simple', () => {
      expect(safeMultiply(1000, 3)).toBe(3000);
      expect(safeMultiply(500, 7)).toBe(3500);
    });

    it('accepte MAX_SAFE_INTEGER × 1 (borne exacte)', () => {
      expect(safeMultiply(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejette MAX_SAFE_INTEGER × 2 (overflow)', () => {
      expect(() => safeMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(FlexiblePricingError);
      try {
        safeMultiply(Number.MAX_SAFE_INTEGER, 2);
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('AMOUNT_OVERFLOW');
      }
    });

    it('rejette les opérandes non safe-integer', () => {
      expect(() => safeMultiply(1.5, 2)).toThrow(FlexiblePricingError);
      expect(() => safeMultiply(2, 1.5)).toThrow(FlexiblePricingError);
    });
  });

  describe('safeAdd', () => {
    it('addition simple', () => {
      expect(safeAdd(1000, 2000)).toBe(3000);
    });

    it('accepte MAX_SAFE_INTEGER + 0', () => {
      expect(safeAdd(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("rejette l'overflow d'addition", () => {
      const big = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
      expect(() => safeAdd(big, big)).toThrow(FlexiblePricingError);
      try {
        safeAdd(big, big);
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('AMOUNT_OVERFLOW');
      }
    });
  });

  describe('halfUpRound', () => {
    it('montant 100, remise 10% → 90', () => {
      expect(halfUpRound(100, 10)).toBe(90);
    });

    it('montant 105, remise 10% → 94 (discount = halfUpRound(105,10) = (105*10*2+100)/200 = 2200/200 = 11, 105-11=94)', () => {
      expect(halfUpRound(105, 10)).toBe(94);
    });

    it('montant 103, remise 33% → 69 (discount = (103*33*2+100)/200 = (6798+100)/200 = 6898/200 = 34, 103-34=69)', () => {
      expect(halfUpRound(103, 33)).toBe(69);
    });

    it('remise 0% → montant inchangé', () => {
      expect(halfUpRound(1000, 0)).toBe(1000);
    });

    it('half-up : reste < 0.5 arrondit vers le bas, reste >= 0.5 vers le haut', () => {
      // 102 * 5 / 100 = 5.1 → half-up arrondit vers le bas (0.1 < 0.5) → discount = 5.
      // Formule : (102*5*2+100)/200 = 1120/200 = 5.6, floor = 5. Result = 102 - 5 = 97.
      expect(halfUpRound(102, 5)).toBe(97);
      // 101 * 5 / 100 = 5.05 → half-up arrondit vers le bas (0.05 < 0.5) → discount = 5.
      // Formule : (101*5*2+100)/200 = 1110/200 = 5.55, floor = 5. Result = 101 - 5 = 96.
      expect(halfUpRound(101, 5)).toBe(96);
      // 105 * 10 / 100 = 10.5 → half-up arrondit vers le haut (0.5 >= 0.5) → discount = 11.
      // Formule : (105*10*2+100)/200 = 2200/200 = 11.0, floor = 11. Result = 105 - 11 = 94.
      expect(halfUpRound(105, 10)).toBe(94);
    });

    it('grands montants', () => {
      expect(halfUpRound(1000000, 15)).toBe(850000);
    });

    it('rejette discountPercent invalide (< 0 ou >= 100)', () => {
      expect(() => halfUpRound(100, -1)).toThrow(FlexiblePricingError);
      expect(() => halfUpRound(100, 100)).toThrow(FlexiblePricingError);
    });

    it('overflow sur grands montants', () => {
      expect(() => halfUpRound(Number.MAX_SAFE_INTEGER, 99)).toThrow(FlexiblePricingError);
    });
  });
});
