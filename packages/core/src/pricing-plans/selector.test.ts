import { describe, it, expect } from 'vitest';
import { selectBestCandidate, compareCandidates } from './selector';
import type { Candidate, ResolvedPlan } from './types';
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
    lineTotalAmountMinor: 2000,
    exactDurationMatch: true,
    sufficientDuration: 120,
    unusedTime: 0,
    dayRangeBoundaries: null,
    billableUnitCount: 4,
    ...overrides,
  };
}

describe('selector', () => {
  it('single candidate → selected', () => {
    const c = makeCandidate();
    expect(selectBestCandidate([c])).toBe(c);
  });

  it('empty list → NO_ELIGIBLE_PLAN', () => {
    expect(() => selectBestCandidate([])).toThrow(FlexiblePricingError);
    try {
      selectBestCandidate([]);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  it('cheaper candidate wins regardless of priority', () => {
    const cheap = makeCandidate({
      plan: makePlan({ id: 'cheap', priority: 10 }),
      lineTotalAmountMinor: 1000,
    });
    const expensive = makeCandidate({
      plan: makePlan({ id: 'expensive', priority: 0 }),
      lineTotalAmountMinor: 2000,
    });
    expect(selectBestCandidate([expensive, cheap])).toBe(cheap);
  });

  it('priority cannot make a more expensive plan win', () => {
    const expensive = makeCandidate({
      plan: makePlan({ id: 'expensive', priority: 0 }),
      lineTotalAmountMinor: 2000,
    });
    const cheap = makeCandidate({
      plan: makePlan({ id: 'cheap', priority: 100 }),
      lineTotalAmountMinor: 1000,
    });
    expect(selectBestCandidate([expensive, cheap])).toBe(cheap);
  });

  it('same amount → tie-break by exact match (true first)', () => {
    const exact = makeCandidate({
      plan: makePlan({ id: 'exact' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: true,
    });
    const notExact = makeCandidate({
      plan: makePlan({ id: 'notexact' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
    });
    expect(selectBestCandidate([notExact, exact])).toBe(exact);
  });

  it('same amount, same exact → tie-break by smallest duration', () => {
    const small = makeCandidate({
      plan: makePlan({ id: 'small' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: true,
      sufficientDuration: 120,
    });
    const big = makeCandidate({
      plan: makePlan({ id: 'big' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: true,
      sufficientDuration: 240,
    });
    expect(selectBestCandidate([big, small])).toBe(small);
  });

  it('same amount, same exact, same duration → tie-break by least unused time', () => {
    const lessUnused = makeCandidate({
      plan: makePlan({ id: 'less' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 30,
    });
    const moreUnused = makeCandidate({
      plan: makePlan({ id: 'more' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    expect(selectBestCandidate([moreUnused, lessUnused])).toBe(lessUnused);
  });

  it('same amount, same exact, same duration, same unused → tie-break by priority', () => {
    const lowPriority = makeCandidate({
      plan: makePlan({ id: 'low', priority: 0 }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    const highPriority = makeCandidate({
      plan: makePlan({ id: 'high', priority: 5 }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    expect(selectBestCandidate([highPriority, lowPriority])).toBe(lowPriority);
  });

  it('all equal except version → tie-break by version ascending', () => {
    const v1 = makeCandidate({
      plan: makePlan({ id: 'v1', version: 1 }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    const v2 = makeCandidate({
      plan: makePlan({ id: 'v2', version: 2 }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    expect(selectBestCandidate([v2, v1])).toBe(v1);
  });

  it('all equal except id → tie-break by pricingPlanId lexical', () => {
    const a = makeCandidate({
      plan: makePlan({ id: 'aaaa' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    const b = makeCandidate({
      plan: makePlan({ id: 'zzzz' }),
      lineTotalAmountMinor: 2000,
      exactDurationMatch: false,
      sufficientDuration: 240,
      unusedTime: 60,
    });
    expect(selectBestCandidate([b, a])).toBe(a);
  });

  it('compareCandidates is deterministic', () => {
    const a = makeCandidate({ plan: makePlan({ id: 'a' }), lineTotalAmountMinor: 1000 });
    const b = makeCandidate({ plan: makePlan({ id: 'b' }), lineTotalAmountMinor: 2000 });
    expect(compareCandidates(a, b)).toBeLessThan(0);
    expect(compareCandidates(b, a)).toBeGreaterThan(0);
  });
});
