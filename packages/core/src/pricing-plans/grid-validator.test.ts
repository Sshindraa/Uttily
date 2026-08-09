import { describe, it, expect } from 'vitest';
import { validateGrid } from './grid-validator';
import type { Candidate, ResolvedPlan } from './types';
import { FlexiblePricingError } from './errors';

function makePlan(overrides: Partial<ResolvedPlan> = {}): ResolvedPlan {
  return {
    id: 'plan-1',
    organizationId: 'org-1',
    productVariantId: 'variant-1',
    locationId: null,
    planType: 'FIXED_DURATION',
    currency: 'EUR',
    priceAmountMinor: 1000,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    billingIncrementMinutes: null,
    includedDurationMinutes: 240,
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
    billedDurationMinutes: null,
    coveredDurationMinutes: 240,
    billedDays: null,
    selectedWindow: null,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 2500,
    exactDurationMatch: false,
    sufficientDuration: 240,
    unusedTime: 120,
    dayRangeBoundaries: null,
    billableUnitCount: 1,
    ...overrides,
  };
}

describe('grid-validator', () => {
  it('valid grid → no error', () => {
    const candidates = [
      makeCandidate({
        plan: makePlan({ id: 'short', includedDurationMinutes: 120 }),
        coveredDurationMinutes: 120,
        lineTotalAmountMinor: 1500,
      }),
      makeCandidate({
        plan: makePlan({ id: 'long', includedDurationMinutes: 240 }),
        coveredDurationMinutes: 240,
        lineTotalAmountMinor: 2500,
      }),
    ];
    expect(() => validateGrid(candidates)).not.toThrow();
  });

  it('longer FIXED cheaper than shorter → PRICING_CONFIGURATION_INVALID', () => {
    const candidates = [
      makeCandidate({
        plan: makePlan({ id: 'short', includedDurationMinutes: 120 }),
        coveredDurationMinutes: 120,
        lineTotalAmountMinor: 3000,
      }),
      makeCandidate({
        plan: makePlan({ id: 'long', includedDurationMinutes: 240 }),
        coveredDurationMinutes: 240,
        lineTotalAmountMinor: 2000,
      }),
    ];
    expect(() => validateGrid(candidates)).toThrow(FlexiblePricingError);
    try {
      validateGrid(candidates);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('PRICING_CONFIGURATION_INVALID');
    }
  });

  it('DAILY total after discount decreases when adding a day → PRICING_CONFIGURATION_INVALID', () => {
    const candidates = [
      makeCandidate({
        plan: makePlan({ id: 'daily', planType: 'DAILY', includedDurationMinutes: null }),
        billedDays: 2,
        coveredDurationMinutes: null,
        amountBeforeDiscountMinor: 10000,
        amountAfterDiscountMinor: 9000,
        lineTotalAmountMinor: 9000,
      }),
      makeCandidate({
        plan: makePlan({ id: 'daily2', planType: 'DAILY', includedDurationMinutes: null }),
        billedDays: 3,
        coveredDurationMinutes: null,
        amountBeforeDiscountMinor: 15000,
        amountAfterDiscountMinor: 8000,
        lineTotalAmountMinor: 8000,
      }),
    ];
    expect(() => validateGrid(candidates)).toThrow(FlexiblePricingError);
    try {
      validateGrid(candidates);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('PRICING_CONFIGURATION_INVALID');
    }
  });

  it('single candidate → no error', () => {
    expect(() => validateGrid([makeCandidate()])).not.toThrow();
  });

  it('empty list → no error', () => {
    expect(() => validateGrid([])).not.toThrow();
  });
});
