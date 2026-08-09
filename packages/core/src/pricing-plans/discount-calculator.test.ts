import { describe, it, expect } from 'vitest';
import { selectDiscountTier, applyDiscount } from './discount-calculator';
import type { ResolvedTier } from './types';
import { FlexiblePricingError } from './errors';

describe('discount-calculator', () => {
  describe('selectDiscountTier', () => {
    it('no tiers → null', () => {
      expect(selectDiscountTier('plan-1', [], 5)).toBeNull();
    });

    it('tiers 2@10%, 3@15%, 7@20% : 1 day → no discount', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-1', thresholdDays: 3, discountPercent: 15 },
        { pricingPlanId: 'plan-1', thresholdDays: 7, discountPercent: 20 },
      ];
      expect(selectDiscountTier('plan-1', tiers, 1)).toBeNull();
    });

    it('2 days → 10%', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-1', thresholdDays: 3, discountPercent: 15 },
        { pricingPlanId: 'plan-1', thresholdDays: 7, discountPercent: 20 },
      ];
      const tier = selectDiscountTier('plan-1', tiers, 2);
      expect(tier).not.toBeNull();
      expect(tier!.discountPercent).toBe(10);
    });

    it('3 days → 15%', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-1', thresholdDays: 3, discountPercent: 15 },
        { pricingPlanId: 'plan-1', thresholdDays: 7, discountPercent: 20 },
      ];
      const tier = selectDiscountTier('plan-1', tiers, 3);
      expect(tier).not.toBeNull();
      expect(tier!.discountPercent).toBe(15);
    });

    it('7 days → 20%', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-1', thresholdDays: 3, discountPercent: 15 },
        { pricingPlanId: 'plan-1', thresholdDays: 7, discountPercent: 20 },
      ];
      const tier = selectDiscountTier('plan-1', tiers, 7);
      expect(tier).not.toBeNull();
      expect(tier!.discountPercent).toBe(20);
    });

    it('5 days → 15% (highest threshold <= 5)', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-1', thresholdDays: 3, discountPercent: 15 },
        { pricingPlanId: 'plan-1', thresholdDays: 7, discountPercent: 20 },
      ];
      const tier = selectDiscountTier('plan-1', tiers, 5);
      expect(tier).not.toBeNull();
      expect(tier!.discountPercent).toBe(15);
    });

    it('only tiers from same plan (no fusion)', () => {
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-1', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-2', thresholdDays: 3, discountPercent: 50 },
      ];
      const tier = selectDiscountTier('plan-1', tiers, 5);
      expect(tier).not.toBeNull();
      expect(tier!.discountPercent).toBe(10);
    });
  });

  describe('applyDiscount', () => {
    it('amount 100, discount 10% → 90', () => {
      const { amountAfterDiscount, discountAmount } = applyDiscount(100, 10);
      expect(amountAfterDiscount).toBe(90);
      expect(discountAmount).toBe(10);
    });

    it('amount 105, discount 10% → 94', () => {
      const { amountAfterDiscount, discountAmount } = applyDiscount(105, 10);
      expect(amountAfterDiscount).toBe(94);
      expect(discountAmount).toBe(11);
    });

    it('amount 103, discount 33% → 69', () => {
      const { amountAfterDiscount, discountAmount } = applyDiscount(103, 33);
      expect(amountAfterDiscount).toBe(69);
      expect(discountAmount).toBe(34);
    });

    it('overflow', () => {
      expect(() => applyDiscount(Number.MAX_SAFE_INTEGER, 50)).toThrow(FlexiblePricingError);
    });
  });
});
