import { describe, it, expect } from 'vitest';
import { calculatePrice } from './calculate-price';
import { PricingError } from './errors';
import type { PricingLineInput, VariantPricingSnapshot } from './types';

const EUR = 'EUR';

const testSnapshot: VariantPricingSnapshot = {
  productName: 'Test Product',
  variantName: 'Test Variant',
  skuSuffix: null,
  attributes: {},
};

function line(
  variantId: string,
  unitPriceAmountMinor: number,
  quantity: number,
  currency = EUR,
): PricingLineInput {
  return {
    variantId,
    unitPriceAmountMinor,
    quantity,
    currency,
    variantSnapshot: {
      productName: 'Test Product',
      variantName: 'Test Variant',
      skuSuffix: null,
      attributes: {},
    },
  };
}

describe('calculatePrice', () => {
  it('une ligne valide → total = unitPrice × dayCount × quantity', () => {
    const result = calculatePrice([line('v1', 1000, 2)], 3);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.lineTotalAmountMinor).toBe(1000 * 3 * 2);
    expect(result.subtotalAmountMinor).toBe(6000);
    expect(result.totalAmountMinor).toBe(6000);
    expect(result.currency).toBe('EUR');
  });

  it('plusieurs lignes valides → total = somme des lignes', () => {
    const result = calculatePrice([line('v1', 1000, 1), line('v2', 500, 2)], 3);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.lineTotalAmountMinor).toBe(3000);
    expect(result.lines[1]?.lineTotalAmountMinor).toBe(3000);
    expect(result.subtotalAmountMinor).toBe(6000);
    expect(result.totalAmountMinor).toBe(6000);
  });

  it('quantité invalide (0, -1, 1.5) → PricingError', () => {
    expect(() => calculatePrice([line('v1', 1000, 0)], 3)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1000, -1)], 3)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1000, 1.5)], 3)).toThrow(PricingError);
  });

  it('prix invalide (0, -1, 1.5) → PricingError', () => {
    expect(() => calculatePrice([line('v1', 0, 1)], 3)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', -1, 1)], 3)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1.5, 1)], 3)).toThrow(PricingError);
  });

  it('devise non EUR (USD) → PricingError', () => {
    expect(() => calculatePrice([line('v1', 1000, 1, 'USD')], 3)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1000, 1, 'USD')], 3)).toThrow(/devise non supportée/);
  });

  it('overflow de multiplication (unitPrice = MAX_SAFE_INTEGER, dayCount = 2) → PricingError', () => {
    expect(() => calculatePrice([line('v1', Number.MAX_SAFE_INTEGER, 1)], 2)).toThrow(PricingError);
    try {
      calculatePrice([line('v1', Number.MAX_SAFE_INTEGER, 1)], 2);
    } catch (err) {
      expect((err as PricingError).code).toBe('VALIDATION');
    }
  });

  it('overflow de somme (plusieurs lignes dont la somme dépasse MAX_SAFE_INTEGER) → PricingError', () => {
    const big = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    // 2 lignes × big dépassera MAX_SAFE_INTEGER à l’addition (chaque lineTotal = big est safe)
    expect(() => calculatePrice([line('v1', big, 1), line('v2', big, 1)], 1)).toThrow(PricingError);
    try {
      calculatePrice([line('v1', big, 1), line('v2', big, 1)], 1);
    } catch (err) {
      expect((err as PricingError).code).toBe('VALIDATION');
    }
  });

  it('snapshot fiscal Lot 4 : taxStatus UNDETERMINED, tax null, commission null, billableUnit DAY, mandatoryFees 0', () => {
    const result = calculatePrice([line('v1', 1000, 2)], 3);
    expect(result.taxStatus).toBe('UNDETERMINED');
    expect(result.taxAmountMinor).toBeNull();
    expect(result.taxRateBps).toBeNull();
    expect(result.commissionAmountMinor).toBeNull();
    expect(result.billableUnit).toBe('DAY');
    expect(result.billableUnitCount).toBe(3);
    expect(result.mandatoryFeesAmountMinor).toBe(0);
    expect(result.totalAmountMinor).toBe(result.subtotalAmountMinor);
  });

  it('billableDayCount invalide (0, -1, 1.5) → PricingError', () => {
    expect(() => calculatePrice([line('v1', 1000, 1)], 0)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1000, 1)], -1)).toThrow(PricingError);
    expect(() => calculatePrice([line('v1', 1000, 1)], 1.5)).toThrow(PricingError);
  });

  it('lines vide → PricingError', () => {
    expect(() => calculatePrice([], 3)).toThrow(PricingError);
    expect(() => calculatePrice([], 3)).toThrow(/Au moins une ligne/);
  });

  it('tous les montants du résultat sont des safe integers', () => {
    const result = calculatePrice([line('v1', 1000, 2), line('v2', 500, 3)], 5);
    expect(Number.isSafeInteger(result.subtotalAmountMinor)).toBe(true);
    expect(Number.isSafeInteger(result.mandatoryFeesAmountMinor)).toBe(true);
    expect(Number.isSafeInteger(result.totalAmountMinor)).toBe(true);
    expect(Number.isSafeInteger(result.billableUnitCount)).toBe(true);
    for (const l of result.lines) {
      expect(Number.isSafeInteger(l.unitPriceAmountMinor)).toBe(true);
      expect(Number.isSafeInteger(l.quantity)).toBe(true);
      expect(Number.isSafeInteger(l.billableUnitCount)).toBe(true);
      expect(Number.isSafeInteger(l.lineTotalAmountMinor)).toBe(true);
    }
  });

  it('billableUnitCount propagé sur chaque ligne', () => {
    const result = calculatePrice([line('v1', 1000, 2), line('v2', 500, 3)], 7);
    expect(result.lines[0]?.billableUnitCount).toBe(7);
    expect(result.lines[1]?.billableUnitCount).toBe(7);
  });

  it("recopie exactement le variantSnapshot fourni dans l'input", () => {
    const snapshot: VariantPricingSnapshot = {
      productName: 'Kayak',
      variantName: 'Standard',
      skuSuffix: 'STD',
      attributes: { color: 'red', size: 'M' },
    };
    const result = calculatePrice(
      [
        {
          variantId: 'v1',
          unitPriceAmountMinor: 5000,
          quantity: 2,
          currency: 'EUR',
          variantSnapshot: snapshot,
        },
      ],
      3,
    );
    expect(result.lines[0]?.variantSnapshot).toEqual(snapshot);
    expect(result.lines[0]?.variantSnapshot).not.toBe(snapshot); // recopie, pas référence
  });

  it('accepte Number.MAX_SAFE_INTEGER × 1 × 1 (borne exacte) et rejette le premier dépassement', () => {
    // MAX_SAFE_INTEGER × 1 × 1 = MAX_SAFE_INTEGER → accepté
    const result = calculatePrice(
      [
        {
          variantId: 'v1',
          unitPriceAmountMinor: Number.MAX_SAFE_INTEGER,
          quantity: 1,
          currency: 'EUR',
          variantSnapshot: testSnapshot,
        },
      ],
      1,
    );
    expect(result.lines[0]?.lineTotalAmountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.subtotalAmountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.totalAmountMinor).toBe(Number.MAX_SAFE_INTEGER);

    // MAX_SAFE_INTEGER × 2 × 1 → overflow → rejeté
    expect(() =>
      calculatePrice(
        [
          {
            variantId: 'v1',
            unitPriceAmountMinor: Number.MAX_SAFE_INTEGER,
            quantity: 2,
            currency: 'EUR',
            variantSnapshot: testSnapshot,
          },
        ],
        1,
      ),
    ).toThrow(PricingError);
  });
});
