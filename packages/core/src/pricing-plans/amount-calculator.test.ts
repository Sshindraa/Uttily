import { describe, it, expect } from 'vitest';
import { calculateAmount } from './amount-calculator';
import type { Candidate, ResolvedPlan, ResolvedTier } from './types';
import { FlexiblePricingError } from './errors';

function makePlan(overrides: Partial<ResolvedPlan> = {}): ResolvedPlan {
  return {
    id: 'plan-1',
    organizationId: 'org-1',
    productVariantId: 'variant-1',
    locationId: null,
    planType: 'HOURLY',
    currency: 'EUR',
    priceAmountMinor: 1000,
    minDurationMinutes: 30,
    maxDurationMinutes: 240,
    billingIncrementMinutes: 30,
    includedDurationMinutes: null,
    internalLabel: null,
    priority: 0,
    version: 1,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    plan: makePlan(),
    variantId: 'variant-1',
    quantity: 1,
    requestedDurationMinutes: 120,
    billedDurationMinutes: 120,
    coveredDurationMinutes: null,
    billedDays: null,
    selectedWindow: null,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 0,
    exactDurationMatch: true,
    sufficientDuration: 120,
    unusedTime: 0,
    dayRangeBoundaries: null,
    billableUnitCount: 4,
    ...overrides,
  };
}

describe('amount-calculator', () => {
  describe('HOURLY', () => {
    it('2h request, 30min increments → 4 increments, billed 120min', () => {
      const candidate = makeCandidate({
        plan: makePlan({ priceAmountMinor: 500, billingIncrementMinutes: 30 }),
        requestedDurationMinutes: 120,
        billedDurationMinutes: 120,
      });
      const result = calculateAmount(candidate, []);
      // 4 increments × 500 × 1 = 2000
      expect(result.lineTotalAmountMinor).toBe(2000);
    });

    it('90min request, 60min increments → 2 increments, billed 120min', () => {
      const candidate = makeCandidate({
        plan: makePlan({ priceAmountMinor: 800, billingIncrementMinutes: 60 }),
        requestedDurationMinutes: 90,
        billedDurationMinutes: 120,
      });
      const result = calculateAmount(candidate, []);
      // 2 increments × 800 × 1 = 1600
      expect(result.lineTotalAmountMinor).toBe(1600);
    });

    it('quantity > 1 : amounts multiply correctly', () => {
      const candidate = makeCandidate({
        plan: makePlan({ priceAmountMinor: 500, billingIncrementMinutes: 30 }),
        quantity: 3,
        requestedDurationMinutes: 120,
        billedDurationMinutes: 120,
      });
      const result = calculateAmount(candidate, []);
      // 4 increments × 500 × 3 = 6000
      expect(result.lineTotalAmountMinor).toBe(6000);
    });

    it('overflow detection', () => {
      const candidate = makeCandidate({
        plan: makePlan({ priceAmountMinor: Number.MAX_SAFE_INTEGER, billingIncrementMinutes: 30 }),
        quantity: 2,
        billedDurationMinutes: 60,
      });
      expect(() => calculateAmount(candidate, [])).toThrow(FlexiblePricingError);
      try {
        calculateAmount(candidate, []);
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('AMOUNT_OVERFLOW');
      }
    });
  });

  describe('FIXED_DURATION', () => {
    it('4h plan covering 5h request → eligible, unused 60min', () => {
      const plan = makePlan({
        planType: 'FIXED_DURATION',
        priceAmountMinor: 4500,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        billingIncrementMinutes: null,
        includedDurationMinutes: 360, // 6h
      });
      const candidate = makeCandidate({
        plan,
        requestedDurationMinutes: 300, // 5h
        billedDurationMinutes: null,
        coveredDurationMinutes: 360,
        unusedTime: 60,
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(4500);
    });

    it('4h plan for 3h request → eligible (covers), unused 60min', () => {
      const plan = makePlan({
        planType: 'FIXED_DURATION',
        priceAmountMinor: 2500,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        billingIncrementMinutes: null,
        includedDurationMinutes: 240, // 4h
      });
      const candidate = makeCandidate({
        plan,
        requestedDurationMinutes: 180, // 3h
        billedDurationMinutes: null,
        coveredDurationMinutes: 240,
        unusedTime: 60,
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(2500);
    });

    it('6h plan for 5h request → eligible, unused 60min', () => {
      const plan = makePlan({
        planType: 'FIXED_DURATION',
        priceAmountMinor: 6000,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        billingIncrementMinutes: null,
        includedDurationMinutes: 360, // 6h
      });
      const candidate = makeCandidate({
        plan,
        requestedDurationMinutes: 300, // 5h
        billedDurationMinutes: null,
        coveredDurationMinutes: 360,
        unusedTime: 60,
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(6000);
    });

    it('quantity > 1', () => {
      const plan = makePlan({
        planType: 'FIXED_DURATION',
        priceAmountMinor: 4500,
        includedDurationMinutes: 360,
      });
      const candidate = makeCandidate({
        plan,
        quantity: 2,
        billedDurationMinutes: null,
        coveredDurationMinutes: 360,
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(9000);
    });
  });

  describe('DAILY TIME_RANGE', () => {
    it('window 9-17, request 9-17 → 1 day', () => {
      const plan = makePlan({
        planType: 'DAILY',
        priceAmountMinor: 8000,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        billingIncrementMinutes: null,
        includedDurationMinutes: null,
      });
      const candidate = makeCandidate({
        plan,
        requestedDurationMinutes: 480,
        billedDurationMinutes: null,
        coveredDurationMinutes: null,
        billedDays: 1,
        selectedWindow: { weekdayMask: 127, startTime: '09:00:00', endTime: '17:00:00' },
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(8000);
      expect(result.amountBeforeDiscountMinor).toBe(8000);
      expect(result.amountAfterDiscountMinor).toBe(8000);
    });
  });

  describe('DAILY DAY_RANGE', () => {
    it('3 days → 3 days billed', () => {
      const plan = makePlan({
        planType: 'DAILY',
        priceAmountMinor: 5000,
      });
      const candidate = makeCandidate({
        plan,
        requestedDurationMinutes: 0,
        billedDurationMinutes: null,
        coveredDurationMinutes: null,
        billedDays: 3,
        selectedWindow: null,
      });
      const result = calculateAmount(candidate, []);
      expect(result.lineTotalAmountMinor).toBe(15000);
      expect(result.amountBeforeDiscountMinor).toBe(15000);
    });

    it('with discount tier 3@15%', () => {
      const plan = makePlan({
        id: 'plan-daily',
        planType: 'DAILY',
        priceAmountMinor: 5000,
      });
      const candidate = makeCandidate({
        plan,
        billedDays: 3,
      });
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-daily', thresholdDays: 2, discountPercent: 10 },
        { pricingPlanId: 'plan-daily', thresholdDays: 3, discountPercent: 15 },
      ];
      const result = calculateAmount(candidate, tiers);
      // 5000 × 3 = 15000, 15% off → halfUpRound(15000, 15).
      // 15000 * 15 / 100 = 2250.0 (exact) → half-up discount = 2250.
      // Formule : (15000*15*2+100)/200 = 450100/200 = 2250.5 → floor = 2250.
      // 15000 - 2250 = 12750.
      expect(result.lineTotalAmountMinor).toBe(12750);
      expect(result.discountPercent).toBe(15);
      expect(result.discountThresholdDays).toBe(3);
    });

    it('quantity > 1 : discount applied to total', () => {
      const plan = makePlan({
        id: 'plan-daily',
        planType: 'DAILY',
        priceAmountMinor: 5000,
      });
      const candidate = makeCandidate({
        plan,
        quantity: 2,
        billedDays: 3,
      });
      const tiers: ResolvedTier[] = [
        { pricingPlanId: 'plan-daily', thresholdDays: 3, discountPercent: 10 },
      ];
      const result = calculateAmount(candidate, tiers);
      // 5000 × 3 × 2 = 30000, 10% off → halfUpRound(30000, 10) = 30000 - 3000 = 27000
      expect(result.lineTotalAmountMinor).toBe(27000);
    });
  });
});
