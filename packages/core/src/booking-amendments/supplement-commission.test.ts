import { describe, expect, it } from 'vitest';
import {
  calculateSupplementCommission,
  SupplementCommissionCalculationError,
} from './supplement-commission';

describe('calculateSupplementCommission', () => {
  it('retourne zéro quand la commission originale est zéro', () => {
    expect(calculateSupplementCommission(12_345, 100_000, 0)).toBe(0);
  });

  it('calcule la commission proportionnelle exacte avec BigInt', () => {
    expect(calculateSupplementCommission(5_000, 10_000, 500)).toBe(250);
  });

  it('applique l’arrondi half-up aux valeurs positives', () => {
    expect(calculateSupplementCommission(3, 10, 5)).toBe(2);
    expect(calculateSupplementCommission(3, 10, 4)).toBe(1);
  });

  it('borne le résultat entre zéro et le supplément', () => {
    expect(calculateSupplementCommission(100, 10, 20)).toBe(100);
  });

  it('calcule sans overflow Number sur des entiers sûrs', () => {
    const result = calculateSupplementCommission(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('fail-closed quand le total original est nul et la commission non nulle', () => {
    expect(() => calculateSupplementCommission(100, 0, 1)).toThrow(
      SupplementCommissionCalculationError,
    );
    expect(calculateSupplementCommission(100, 0, 0)).toBe(0);
  });

  it('refuse les montants non représentables comme entiers sûrs', () => {
    expect(() => calculateSupplementCommission(Number.MAX_SAFE_INTEGER + 1, 10, 1)).toThrow(
      SupplementCommissionCalculationError,
    );
  });
});
