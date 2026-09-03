import { describe, expect, it } from 'vitest';
import {
  calculateMarketplaceFeeDelta,
  calculateMarketplaceFeeSnapshot,
  calculateMarketplaceFeeSnapshotFromPricing,
  calculateSplitCancellationRefund,
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

  describe('calculateSplitCancellationRefund (ADR-030)', () => {
    it('calcule une annulation split à 100%', () => {
      const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 10000 });
      // 100,00 € base -> 107,00 € client, 13,00 € loueur fee, 7,00 € customer fee, 87,00 € net loueur, 20,00 € platform
      const refund = calculateSplitCancellationRefund({
        oldSnapshot: snapshot,
        refundPercentage: 100,
      });

      expect(refund.refundPercentage).toBe(100);
      expect(refund.customerRefundAmountMinor).toBe(10700);
      expect(refund.customerRetainedAmountMinor).toBe(0);
      expect(refund.merchantClawbackAmountMinor).toBe(8700);
      expect(refund.finalMerchantRevenueMinor).toBe(0);
      expect(refund.platformFeeRefundedMinor).toBe(2000);
      expect(refund.finalPlatformFeeMinor).toBe(0);

      // Invariant ADR-030 : remboursement client = reprise loueur + restitution plateforme
      expect(refund.customerRefundAmountMinor).toBe(
        refund.merchantClawbackAmountMinor + refund.platformFeeRefundedMinor,
      );
    });

    it('calcule une annulation split à 0%', () => {
      const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 10000 });
      const refund = calculateSplitCancellationRefund({
        oldSnapshot: snapshot,
        refundPercentage: 0,
      });

      expect(refund.refundPercentage).toBe(0);
      expect(refund.customerRefundAmountMinor).toBe(0);
      expect(refund.customerRetainedAmountMinor).toBe(10700);
      expect(refund.merchantClawbackAmountMinor).toBe(0);
      expect(refund.finalMerchantRevenueMinor).toBe(8700);
      expect(refund.platformFeeRefundedMinor).toBe(0);
      expect(refund.finalPlatformFeeMinor).toBe(2000);
    });

    it('calcule une annulation split partielle à 50%', () => {
      const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 10000 });
      const refund = calculateSplitCancellationRefund({
        oldSnapshot: snapshot,
        refundPercentage: 50,
      });

      expect(refund.refundPercentage).toBe(50);
      expect(refund.customerRefundAmountMinor).toBe(5350);
      expect(refund.customerRetainedAmountMinor).toBe(5350);
      expect(refund.merchantClawbackAmountMinor).toBe(4350);
      expect(refund.finalMerchantRevenueMinor).toBe(4350);
      expect(refund.platformFeeRefundedMinor).toBe(1000);
      expect(refund.finalPlatformFeeMinor).toBe(1000);

      // Invariant ADR-030
      expect(refund.customerRefundAmountMinor).toBe(
        refund.merchantClawbackAmountMinor + refund.platformFeeRefundedMinor,
      );
      expect(snapshot.customerTotalAmountMinor).toBe(
        refund.customerRefundAmountMinor + refund.customerRetainedAmountMinor,
      );
    });

    it('préserve les invariants au centime pour des bases asymétriques et impaires', () => {
      const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 3333 });
      const refund = calculateSplitCancellationRefund({
        oldSnapshot: snapshot,
        refundPercentage: 50,
      });

      expect(refund.customerRefundAmountMinor).toBe(1782);
      expect(refund.customerRetainedAmountMinor).toBe(1784);
      expect(refund.merchantClawbackAmountMinor).toBe(1450);
      expect(refund.finalMerchantRevenueMinor).toBe(1450);
      expect(refund.platformFeeRefundedMinor).toBe(332);
      expect(refund.finalPlatformFeeMinor).toBe(334);

      // Invariant strict ADR-030
      expect(refund.customerRefundAmountMinor).toBe(
        refund.merchantClawbackAmountMinor + refund.platformFeeRefundedMinor,
      );
      expect(snapshot.customerTotalAmountMinor).toBe(
        refund.customerRefundAmountMinor + refund.customerRetainedAmountMinor,
      );
    });

    it('rejette les pourcentages invalides', () => {
      const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: 5000 });
      expect(() =>
        calculateSplitCancellationRefund({ oldSnapshot: snapshot, refundPercentage: -1 }),
      ).toThrow(MarketplaceFeeError);
      expect(() =>
        calculateSplitCancellationRefund({ oldSnapshot: snapshot, refundPercentage: 101 }),
      ).toThrow(MarketplaceFeeError);
      expect(() =>
        calculateSplitCancellationRefund({ oldSnapshot: snapshot, refundPercentage: 50.5 }),
      ).toThrow(MarketplaceFeeError);
    });

    it('garantit les invariants économiques sur un échantillon de 1000 montants aléatoires', () => {
      for (let i = 1; i <= 1000; i++) {
        // Montants entre 100 (1 €) et 1 000 000 (10 000 €)
        const base = Math.floor(Math.random() * 999900) + 100;
        const snapshot = calculateMarketplaceFeeSnapshot({ marketplaceFeeBaseAmountMinor: base });
        for (const pct of [0, 50, 100]) {
          const res = calculateSplitCancellationRefund({
            oldSnapshot: snapshot,
            refundPercentage: pct,
          });
          expect(res.customerRefundAmountMinor).toBe(
            res.merchantClawbackAmountMinor + res.platformFeeRefundedMinor,
          );
          expect(snapshot.customerTotalAmountMinor).toBe(
            res.customerRefundAmountMinor + res.customerRetainedAmountMinor,
          );
          expect(snapshot.merchantNetAmountMinor).toBe(
            res.merchantClawbackAmountMinor + res.finalMerchantRevenueMinor,
          );
          expect(snapshot.platformApplicationFeeAmountMinor).toBe(
            res.platformFeeRefundedMinor + res.finalPlatformFeeMinor,
          );
        }
      }
    });
  });
});

