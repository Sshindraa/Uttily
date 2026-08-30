import { describe, expect, it } from 'vitest';
import {
  calculateMarketplaceFeeDelta,
  calculateMarketplaceFeeSnapshot,
  calculateMarketplaceFeeSnapshotFromPricing,
  MarketplaceFeeError,
  parseMarketplaceFeeSnapshot,
  resolveMarketplaceFeeRule,
  roundHalfUpPerComponent,
} from './index';

describe('marketplace fee engine split-13-7-v1', () => {
  it('calcule le snapshot de référence 70 €', () => {
    expect(calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 7000 })).toEqual({
      ruleVersion: 'split-13-7-v1',
      roundingRule: 'HALF_UP_PER_COMPONENT',
      marketplaceFeeBaseAmountMinor: 7000,
      merchantRateBps: 1300,
      merchantFeeAmountMinor: 910,
      customerRateBps: 700,
      customerServiceFeeAmountMinor: 490,
      customerTotalAmountMinor: 7490,
      merchantNetAmountMinor: 6090,
      platformApplicationFeeAmountMinor: 1400,
    });
  });

  it('inclut les frais obligatoires marchands dans la base, jamais le service fee', () => {
    expect(
      calculateMarketplaceFeeSnapshotFromPricing({
        subtotalAmountMinor: 6000,
        mandatoryFeesAmountMinor: 1000,
      }).marketplaceFeeBaseAmountMinor,
    ).toBe(7000);
  });

  it('applique HALF_UP séparément pour 103 et 104', () => {
    const old = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 103 });
    const next = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 104 });
    expect(old.merchantFeeAmountMinor).toBe(13);
    expect(old.customerServiceFeeAmountMinor).toBe(7);
    expect(old.platformApplicationFeeAmountMinor).toBe(20);
    expect(next.merchantFeeAmountMinor).toBe(14);
    expect(next.customerServiceFeeAmountMinor).toBe(7);
    expect(next.platformApplicationFeeAmountMinor).toBe(21);
  });

  it('calcule le delta par état final', () => {
    expect(
      calculateMarketplaceFeeDelta({
        oldBaseAmountMinor: 103,
        nextBaseAmountMinor: 104,
        ruleVersion: 'split-13-7-v1',
      }),
    ).toMatchObject({
      merchantFeeDeltaAmountMinor: 1,
      customerServiceFeeDeltaAmountMinor: 0,
      customerTotalDeltaAmountMinor: 1,
      platformApplicationFeeDeltaAmountMinor: 1,
    });
  });

  it('conserve les deltas négatifs pour permettre un refus explicite des remboursements', () => {
    expect(
      calculateMarketplaceFeeDelta({
        oldBaseAmountMinor: 104,
        nextBaseAmountMinor: 103,
        ruleVersion: 'split-13-7-v1',
      }),
    ).toMatchObject({
      marketplaceFeeBaseDeltaAmountMinor: -1,
      merchantFeeDeltaAmountMinor: -1,
      customerServiceFeeDeltaAmountMinor: 0,
      customerTotalDeltaAmountMinor: -1,
      platformApplicationFeeDeltaAmountMinor: -1,
    });
  });

  it('couvre zéro, unité, bornes et overflow avant retour', () => {
    expect(roundHalfUpPerComponent(0, 1300)).toBe(0);
    expect(roundHalfUpPerComponent(1, 1300)).toBe(0);
    expect(() =>
      calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: Number.MAX_SAFE_INTEGER }),
    ).toThrow(MarketplaceFeeError);
    expect(() => calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: -1 })).toThrow(
      MarketplaceFeeError,
    );
  });

  it('refuse une règle inconnue et un snapshot falsifié', () => {
    expect(() => resolveMarketplaceFeeRule('split-12-8-v2')).toThrowError(
      /Version de règle marketplace inconnue/,
    );
    const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 7000 });
    expect(() =>
      parseMarketplaceFeeSnapshot({ ...snapshot, customerServiceFeeAmountMinor: 491 }),
    ).toThrow(MarketplaceFeeError);
  });
});
