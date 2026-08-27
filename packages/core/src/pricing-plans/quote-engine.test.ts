import { describe, it, expect } from 'vitest';
import { computeQuote } from './quote-engine';
import { FlexiblePricingError } from './errors';
import type {
  PricingContext,
  ResolvedPlan,
  ResolvedWindow,
  ResolvedTier,
  ResolvedTranslation,
  OpeningHour,
  ResolvedFlexiblePricingIntent,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = 'org-1';
const LOCATION_ID = 'loc-1';
const VARIANT_ID = 'variant-1';
const CURRENCY = 'EUR';
const TIME_ZONE = 'Europe/Paris';

function makePlan(overrides: Partial<ResolvedPlan> = {}): ResolvedPlan {
  return {
    id: 'plan-1',
    organizationId: ORG_ID,
    productVariantId: VARIANT_ID,
    locationId: null,
    planType: 'HOURLY',
    currency: CURRENCY,
    priceAmountMinor: 500,
    minDurationMinutes: 60,
    maxDurationMinutes: 480,
    billingIncrementMinutes: 30,
    includedDurationMinutes: null,
    internalLabel: null,
    priority: 0,
    version: 1,
    ...overrides,
  };
}

function makeContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    organizationId: ORG_ID,
    locationId: LOCATION_ID,
    currency: CURRENCY,
    timeZone: TIME_ZONE,
    intent: {
      kind: 'TIME_RANGE',
      startAt: new Date('2026-02-10T08:00:00.000Z'),
      endAt: new Date('2026-02-10T10:00:00.000Z'),
    },
    plans: [],
    windows: [],
    tiers: [],
    translations: [],
    openingHours: [],
    variants: new Map([[VARIANT_ID, { productId: 'prod-1', organizationId: ORG_ID }]]),
    lines: [{ variantId: VARIANT_ID, quantity: 1 }],
    locale: 'fr',
    ...overrides,
  };
}

/** 2h TIME_RANGE: 08:00–10:00 UTC = 09:00–11:00 Europe/Paris (Tuesday). */
const TWO_HOURS: ResolvedFlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: new Date('2026-02-10T08:00:00.000Z'),
  endAt: new Date('2026-02-10T10:00:00.000Z'),
};

/** 4h TIME_RANGE: 08:00–12:00 UTC = 09:00–13:00 Europe/Paris (Tuesday). */
const FOUR_HOURS: ResolvedFlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: new Date('2026-02-10T08:00:00.000Z'),
  endAt: new Date('2026-02-10T12:00:00.000Z'),
};

/** 5h TIME_RANGE: 08:00–13:00 UTC = 09:00–14:00 Europe/Paris (Tuesday). */
const FIVE_HOURS: ResolvedFlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: new Date('2026-02-10T08:00:00.000Z'),
  endAt: new Date('2026-02-10T13:00:00.000Z'),
};

/** 6h TIME_RANGE: 08:00–14:00 UTC = 09:00–15:00 Europe/Paris (Tuesday). */
const SIX_HOURS: ResolvedFlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: new Date('2026-02-10T08:00:00.000Z'),
  endAt: new Date('2026-02-10T14:00:00.000Z'),
};

/** 8h TIME_RANGE: 08:00–16:00 UTC = 09:00–17:00 Europe/Paris (Tuesday). */
const EIGHT_HOURS: ResolvedFlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: new Date('2026-02-10T08:00:00.000Z'),
  endAt: new Date('2026-02-10T16:00:00.000Z'),
};

/** Opening hours: Monday–Friday 09:00–18:00. */
const WEEKDAY_OPENING_HOURS: OpeningHour[] = [
  { weekday: 0, openTime: '09:00:00', closeTime: '18:00:00' },
  { weekday: 1, openTime: '09:00:00', closeTime: '18:00:00' },
  { weekday: 2, openTime: '09:00:00', closeTime: '18:00:00' },
  { weekday: 3, openTime: '09:00:00', closeTime: '18:00:00' },
  { weekday: 4, openTime: '09:00:00', closeTime: '18:00:00' },
];

function frTranslation(planId: string, label: string): ResolvedTranslation {
  return { pricingPlanId: planId, locale: 'fr', publicLabel: label };
}

function enTranslation(planId: string, label: string): ResolvedTranslation {
  return { pricingPlanId: planId, locale: 'en', publicLabel: label };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('computeQuote — moteur pur', () => {
  // 1. 2h TIME_RANGE: HOURLY plan (30min increments, min=60, max=480, price=500)
  //    → 120min / 30 = 4 increments, billed 120min, total = 500*4*1 = 2000
  it('1. 2h TIME_RANGE HOURLY → 4 increments, total 2000', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: 500,
      minDurationMinutes: 60,
      maxDurationMinutes: 480,
      billingIncrementMinutes: 30,
    });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.planType).toBe('HOURLY');
    expect(line.billedDurationMinutes).toBe(120);
    expect(line.lineTotalAmountMinor).toBe(2000);
    expect(result.subtotalAmountMinor).toBe(2000);
    expect(result.totalAmountMinor).toBe(2000);
    expect(result.algorithmVersion).toBe('flexible-pricing-v1');
    expect(result.roundingRuleVersion).toBe('half-up-v1');
  });

  // 2. 4h TIME_RANGE: HOURLY + FIXED_DURATION 4h → FIXED selected if cheaper
  it('2. 4h TIME_RANGE: HOURLY (240min → 8 inc × 500 = 4000) vs FIXED 4h (3000) → FIXED', () => {
    const hourly = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: 500,
      minDurationMinutes: 60,
      maxDurationMinutes: 480,
      billingIncrementMinutes: 30,
    });
    const fixed = makePlan({
      id: 'plan-fixed-4h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 3000,
      includedDurationMinutes: 240,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const ctx = makeContext({
      intent: FOUR_HOURS,
      plans: [hourly, fixed],
      translations: [
        frTranslation('plan-hourly', 'Heure'),
        frTranslation('plan-fixed-4h', 'Forfait 4h'),
      ],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.planType).toBe('FIXED_DURATION');
    expect(line.pricingPlanId).toBe('plan-fixed-4h');
    expect(line.coveredDurationMinutes).toBe(240);
    expect(line.lineTotalAmountMinor).toBe(3000);
    expect(result.totalAmountMinor).toBe(3000);
  });

  // 3. 5h TIME_RANGE: FIXED 4h (ineligible) + FIXED 6h (eligible, 4000) → FIXED 6h
  it('3. 5h TIME_RANGE: FIXED 4h (ineligible) + FIXED 6h (eligible) → FIXED 6h', () => {
    const fixed4h = makePlan({
      id: 'plan-fixed-4h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 3000,
      includedDurationMinutes: 240,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const fixed6h = makePlan({
      id: 'plan-fixed-6h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 4000,
      includedDurationMinutes: 360,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const ctx = makeContext({
      intent: FIVE_HOURS,
      plans: [fixed4h, fixed6h],
      translations: [
        frTranslation('plan-fixed-4h', 'Forfait 4h'),
        frTranslation('plan-fixed-6h', 'Forfait 6h'),
      ],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.planType).toBe('FIXED_DURATION');
    expect(line.pricingPlanId).toBe('plan-fixed-6h');
    expect(line.coveredDurationMinutes).toBe(360);
    expect(line.lineTotalAmountMinor).toBe(4000);
  });

  // 4. 5h TIME_RANGE: only FIXED 4h → NO_ELIGIBLE_PLAN
  it('4. 5h TIME_RANGE: only FIXED 4h → NO_ELIGIBLE_PLAN', () => {
    const fixed4h = makePlan({
      id: 'plan-fixed-4h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 3000,
      includedDurationMinutes: 240,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const ctx = makeContext({
      intent: FIVE_HOURS,
      plans: [fixed4h],
      translations: [frTranslation('plan-fixed-4h', 'Forfait 4h')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  // 5. 8h TIME_RANGE: DAILY with window 9-17 → eligible, 1 day
  it('5. 8h TIME_RANGE: DAILY with window 09:00–17:00 → eligible, 1 day', () => {
    const daily = makePlan({
      id: 'plan-daily',
      planType: 'DAILY',
      priceAmountMinor: 8000,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
      includedDurationMinutes: null,
    });
    // 2026-02-10 is a Tuesday (weekday=1). weekdayMask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16 → all = 31.
    const window: ResolvedWindow = {
      pricingPlanId: 'plan-daily',
      weekdayMask: 0b11111, // Mon–Fri
      startTime: '09:00:00',
      endTime: '17:00:00',
    };
    const ctx = makeContext({
      intent: EIGHT_HOURS,
      plans: [daily],
      windows: [window],
      translations: [frTranslation('plan-daily', 'Journée')],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.planType).toBe('DAILY');
    expect(line.billedDays).toBe(1);
    expect(line.selectedWindow).not.toBeNull();
    expect(line.selectedWindow!.startTime).toBe('09:00:00');
    expect(line.selectedWindow!.endTime).toBe('17:00:00');
    expect(line.lineTotalAmountMinor).toBe(8000);
    expect(result.totalAmountMinor).toBe(8000);
  });

  // 6. HOURLY beyond max → rejected (NO_ELIGIBLE_PLAN)
  it('6. HOURLY beyond max → NO_ELIGIBLE_PLAN', () => {
    const hourly = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: 500,
      minDurationMinutes: 60,
      maxDurationMinutes: 120,
      billingIncrementMinutes: 30,
    });
    const ctx = makeContext({
      intent: FOUR_HOURS, // 240min > max 120
      plans: [hourly],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  // 7. DAY_RANGE 3 days with DAILY plan and discount tiers (2@10%, 3@15%) → 15% applied
  it('7. DAY_RANGE 3 days with DAILY + tiers 2@10%, 3@15% → 15% discount', () => {
    const daily = makePlan({
      id: 'plan-daily',
      planType: 'DAILY',
      priceAmountMinor: 5000,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
      includedDurationMinutes: null,
    });
    const windows: ResolvedWindow[] = [
      {
        pricingPlanId: 'plan-daily',
        weekdayMask: 127, // all days
        startTime: '08:00:00',
        endTime: '18:00:00',
      },
    ];
    const tiers: ResolvedTier[] = [
      { pricingPlanId: 'plan-daily', thresholdDays: 2, discountPercent: 10 },
      { pricingPlanId: 'plan-daily', thresholdDays: 3, discountPercent: 15 },
    ];
    const ctx = makeContext({
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-02-10',
        endDateExclusive: '2026-02-13',
      },
      plans: [daily],
      windows,
      tiers,
      translations: [frTranslation('plan-daily', 'Journée')],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.planType).toBe('DAILY');
    expect(line.billedDays).toBe(3);
    expect(line.discountPercent).toBe(15);
    expect(line.discountThresholdDays).toBe(3);
    expect(line.amountBeforeDiscountMinor).toBe(15000);
    // halfUpRound(15000, 15) = 15000 - 2250 = 12750
    expect(line.amountAfterDiscountMinor).toBe(12750);
    expect(line.lineTotalAmountMinor).toBe(12750);
    expect(result.totalAmountMinor).toBe(12750);
    // G7P-B2-B : dayRangeBoundaries populated
    const dailyLine = line as Extract<typeof line, { planType: 'DAILY' }>;
    expect(dailyLine.dayRangeBoundaries).not.toBeNull();
    expect(dailyLine.dayRangeBoundaries!.kind).toBe('DAY_RANGE_BOUNDARIES');
    expect(dailyLine.dayRangeBoundaries!.firstDay.localDate).toBe('2026-02-10');
    expect(dailyLine.dayRangeBoundaries!.lastDay.localDate).toBe('2026-02-12');
    expect(dailyLine.dayRangeBoundaries!.firstDay.startTime).toBe('08:00:00');
    expect(dailyLine.dayRangeBoundaries!.firstDay.endTime).toBe('18:00:00');
    expect(dailyLine.dayRangeBoundaries!.lastDay.startTime).toBe('08:00:00');
    expect(dailyLine.dayRangeBoundaries!.lastDay.endTime).toBe('18:00:00');
  });

  // 8. Default/local: local v2 replaces default v1 (same variant, local plan in context)
  it('8. local plan v2 replaces default plan v1 → v2 selected', () => {
    const defaultPlan = makePlan({
      id: 'plan-default-v1',
      planType: 'HOURLY',
      priceAmountMinor: 500,
      version: 1,
      locationId: null,
    });
    const localPlan = makePlan({
      id: 'plan-local-v2',
      planType: 'HOURLY',
      priceAmountMinor: 400,
      version: 2,
      locationId: LOCATION_ID,
    });
    // Both plans are in context — resolve_effective_pricing_plans already filtered.
    // The engine just picks the cheapest (400 < 500).
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [defaultPlan, localPlan],
      translations: [
        frTranslation('plan-default-v1', 'Heure standard'),
        frTranslation('plan-local-v2', 'Heure locale'),
      ],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.pricingPlanId).toBe('plan-local-v2');
    expect(line.planVersion).toBe(2);
    expect(line.lineTotalAmountMinor).toBe(1600); // 400 * 4 * 1
  });

  // 9. Two orgs: only same-org plans in context → cross-org variant rejected
  it('9. variant from different org → PRODUCT_NOT_ELIGIBLE', () => {
    const plan = makePlan({
      id: 'plan-1',
      organizationId: ORG_ID,
    });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      variants: new Map([[VARIANT_ID, { productId: 'prod-1', organizationId: 'org-other' }]]),
      translations: [frTranslation('plan-1', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('PRODUCT_NOT_ELIGIBLE');
    }
  });

  // 10. FR/EN labels resolved correctly
  it('10. FR locale → FR label; EN locale → EN label', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
    });
    const translations = [
      frTranslation('plan-hourly', 'Tarif horaire'),
      enTranslation('plan-hourly', 'Hourly rate'),
    ];

    // FR
    const ctxFr = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations,
      locale: 'fr',
    });
    const resultFr = computeQuote(ctxFr);
    expect(resultFr.lines[0]!.publicLabel).toBe('Tarif horaire');

    // EN
    const ctxEn = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations,
      locale: 'en',
    });
    const resultEn = computeQuote(ctxEn);
    expect(resultEn.lines[0]!.publicLabel).toBe('Hourly rate');
  });

  // 11. Opening hours violation → OUTSIDE_OPENING_HOURS
  it('11. TIME_RANGE outside opening hours → OUTSIDE_OPENING_HOURS', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
    });
    // 06:00–08:00 UTC = 07:00–09:00 Paris → before opening (09:00)
    const earlyIntent: ResolvedFlexiblePricingIntent = {
      kind: 'TIME_RANGE',
      startAt: new Date('2026-02-10T06:00:00.000Z'),
      endAt: new Date('2026-02-10T08:00:00.000Z'),
    };
    const ctx = makeContext({
      intent: earlyIntent,
      plans: [plan],
      openingHours: WEEKDAY_OPENING_HOURS,
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('OUTSIDE_OPENING_HOURS');
    }
  });

  // 12. Grid incoherent → PRICING_CONFIGURATION_INVALID
  it('12. FIXED_DURATION grid incoherent (longer plan cheaper) → PRICING_CONFIGURATION_INVALID', () => {
    const fixed4h = makePlan({
      id: 'plan-fixed-4h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 5000,
      includedDurationMinutes: 240,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const fixed6h = makePlan({
      id: 'plan-fixed-6h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 3000, // 6h cheaper than 4h → incoherent
      includedDurationMinutes: 360,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const ctx = makeContext({
      intent: FOUR_HOURS, // 240min: both 4h and 6h are eligible
      plans: [fixed4h, fixed6h],
      translations: [
        frTranslation('plan-fixed-4h', 'Forfait 4h'),
        frTranslation('plan-fixed-6h', 'Forfait 6h'),
      ],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('PRICING_CONFIGURATION_INVALID');
    }
  });

  // 13. No plan → NO_ELIGIBLE_PLAN
  it('13. no plans → NO_ELIGIBLE_PLAN', () => {
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [],
      // Provide a translation so locale resolution passes; no plan means no candidate.
      translations: [{ pricingPlanId: 'nonexistent', locale: 'fr', publicLabel: 'N/A' }],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  // 14. Overflow → AMOUNT_OVERFLOW
  it('14. HOURLY overflow → AMOUNT_OVERFLOW', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: Number.MAX_SAFE_INTEGER,
      billingIncrementMinutes: 1,
      minDurationMinutes: 1,
      maxDurationMinutes: 480,
    });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('AMOUNT_OVERFLOW');
    }
  });

  // 15. Line ordering by variantId
  it('15. multiple lines → sorted by variantId ascending', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const variantZ = 'variant-zzz';
    const variantA = 'variant-aaa';
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [
        { ...plan, id: 'plan-z', productVariantId: variantZ },
        { ...plan, id: 'plan-a', productVariantId: variantA },
      ],
      variants: new Map([
        [variantZ, { productId: 'prod-z', organizationId: ORG_ID }],
        [variantA, { productId: 'prod-a', organizationId: ORG_ID }],
      ]),
      lines: [
        { variantId: variantZ, quantity: 1 },
        { variantId: variantA, quantity: 1 },
      ],
      translations: [frTranslation('plan-z', 'Heure Z'), frTranslation('plan-a', 'Heure A')],
    });
    const result = computeQuote(ctx);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.variantId).toBe(variantA);
    expect(result.lines[1]!.variantId).toBe(variantZ);
  });

  // 16. Reproducibility: same context → same result
  it('16. same context → byte-for-byte equivalent result', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: 500,
    });
    const baseCtx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    const result1 = computeQuote(baseCtx);
    const result2 = computeQuote(baseCtx);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  // Additional: VARIANT_NOT_FOUND
  it('variant not in context → VARIANT_NOT_FOUND', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      variants: new Map(), // empty → variant not found
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('VARIANT_NOT_FOUND');
    }
  });

  // Additional: UNSUPPORTED_LOCALE
  it('unsupported locale (de) → UNSUPPORTED_LOCALE', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
      locale: 'de',
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('UNSUPPORTED_LOCALE');
    }
  });

  // Additional: locale base fallback (fr-FR → fr)
  it('locale fr-FR resolves to fr base', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Tarif horaire')],
      locale: 'fr-FR',
    });
    const result = computeQuote(ctx);
    expect(result.lines[0]!.publicLabel).toBe('Tarif horaire');
  });

  // Additional: currency mismatch → plan filtered out → NO_ELIGIBLE_PLAN
  it('plan with wrong currency → filtered out → NO_ELIGIBLE_PLAN', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      currency: 'USD',
    });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      currency: 'EUR',
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  // Additional: TIME_RANGE with endAt <= startAt → VALIDATION
  it('TIME_RANGE with endAt <= startAt → VALIDATION', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const ctx = makeContext({
      intent: {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-02-10T10:00:00.000Z'),
        endAt: new Date('2026-02-10T08:00:00.000Z'),
      },
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('VALIDATION');
    }
  });

  // Additional: DAY_RANGE with HOURLY plan → NO_ELIGIBLE_PLAN (only DAILY eligible)
  it('DAY_RANGE with only HOURLY plan → NO_ELIGIBLE_PLAN', () => {
    const plan = makePlan({ id: 'plan-hourly', planType: 'HOURLY' });
    const ctx = makeContext({
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-02-10',
        endDateExclusive: '2026-02-12',
      },
      plans: [plan],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    expect(() => computeQuote(ctx)).toThrow(FlexiblePricingError);
    try {
      computeQuote(ctx);
    } catch (err) {
      expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
    }
  });

  // Additional: 6h TIME_RANGE with FIXED 6h → exact match
  it('6h TIME_RANGE: FIXED 6h → exact duration match', () => {
    const fixed6h = makePlan({
      id: 'plan-fixed-6h',
      planType: 'FIXED_DURATION',
      priceAmountMinor: 4000,
      includedDurationMinutes: 360,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
    });
    const ctx = makeContext({
      intent: SIX_HOURS,
      plans: [fixed6h],
      translations: [frTranslation('plan-fixed-6h', 'Forfait 6h')],
    });
    const result = computeQuote(ctx);
    expect(result.lines[0]!.planType).toBe('FIXED_DURATION');
    expect(result.lines[0]!.coveredDurationMinutes).toBe(360);
    expect(result.lines[0]!.lineTotalAmountMinor).toBe(4000);
  });

  // Additional: quantity > 1
  it('HOURLY with quantity 2 → total doubled', () => {
    const plan = makePlan({
      id: 'plan-hourly',
      planType: 'HOURLY',
      priceAmountMinor: 500,
    });
    const ctx = makeContext({
      intent: TWO_HOURS,
      plans: [plan],
      lines: [{ variantId: VARIANT_ID, quantity: 2 }],
      translations: [frTranslation('plan-hourly', 'Heure')],
    });
    const result = computeQuote(ctx);
    expect(result.lines[0]!.lineTotalAmountMinor).toBe(4000); // 500 * 4 * 2
    expect(result.totalAmountMinor).toBe(4000);
  });

  describe('DAY_RANGE et exceptions de calendrier (Chantier 15.2.1)', () => {
    const dailyPlan = makePlan({
      id: 'plan-daily-ex',
      planType: 'DAILY',
      priceAmountMinor: 5000,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
      includedDurationMinutes: null,
    });
    const dailyWindow: ResolvedWindow = {
      pricingPlanId: 'plan-daily-ex',
      weekdayMask: 127,
      startTime: '09:00:00',
      endTime: '18:00:00',
    };

    it('rejette avec OUTSIDE_OPENING_HOURS si l’heure de retrait est incompatible avec l’OPEN_INTERVAL du premier jour', () => {
      const ctx = makeContext({
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-08-24', // Lundi
          endDateExclusive: '2026-08-28', // Vendredi (fin exclusive)
        },
        plans: [dailyPlan],
        windows: [dailyWindow],
        openingHours: WEEKDAY_OPENING_HOURS,
        scheduleExceptions: [
          {
            id: 'ex-start-incompat',
            organizationId: ORG_ID,
            locationId: LOCATION_ID,
            localDate: '2026-08-24',
            kind: 'OPEN_INTERVAL',
            openTime: '12:00:00',
            closeTime: '15:00:00',
            reason: 'Ouverture partielle',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        translations: [frTranslation('plan-daily-ex', 'Journée')],
      });

      expect(() => computeQuote(ctx)).toThrow(
        expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
      );
    });

    it('rejette avec OUTSIDE_OPENING_HOURS si l’heure de retour est incompatible avec l’OPEN_INTERVAL du dernier jour', () => {
      const ctx = makeContext({
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-08-24', // Lundi
          endDateExclusive: '2026-08-28', // Vendredi (dernier jour inclus: 27/08 Jeudi)
        },
        plans: [dailyPlan],
        windows: [dailyWindow],
        openingHours: WEEKDAY_OPENING_HOURS,
        scheduleExceptions: [
          {
            id: 'ex-end-incompat',
            organizationId: ORG_ID,
            locationId: LOCATION_ID,
            localDate: '2026-08-27', // Jeudi
            kind: 'OPEN_INTERVAL',
            openTime: '09:00:00',
            closeTime: '16:00:00', // Fenêtre finit à 18:00 -> hors créneau
            reason: 'Fermeture tôt',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        translations: [frTranslation('plan-daily-ex', 'Journée')],
      });

      expect(() => computeQuote(ctx)).toThrow(
        expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
      );
    });

    it('accepte si l’OPEN_INTERVAL du premier jour et du dernier jour couvrent les heures de retrait et retour', () => {
      const ctx = makeContext({
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-08-24',
          endDateExclusive: '2026-08-28',
        },
        plans: [dailyPlan],
        windows: [dailyWindow],
        openingHours: WEEKDAY_OPENING_HOURS,
        scheduleExceptions: [
          {
            id: 'ex-start-compat',
            organizationId: ORG_ID,
            locationId: LOCATION_ID,
            localDate: '2026-08-24',
            kind: 'OPEN_INTERVAL',
            openTime: '08:00:00',
            closeTime: '19:00:00',
            reason: 'Nocturne',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        translations: [frTranslation('plan-daily-ex', 'Journée')],
      });

      const result = computeQuote(ctx);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.planType).toBe('DAILY');
      expect(result.totalAmountMinor).toBe(20000); // 4 jours * 5000
    });

    it('accepte une location DAY_RANGE même si un jour intermédiaire (ex: Mardi) est fermé par exception', () => {
      const ctx = makeContext({
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-08-24', // Lundi
          endDateExclusive: '2026-08-28', // Vendredi (fin exclusive)
        },
        plans: [dailyPlan],
        windows: [dailyWindow],
        openingHours: WEEKDAY_OPENING_HOURS,
        scheduleExceptions: [
          {
            id: 'ex-mid-closed',
            organizationId: ORG_ID,
            locationId: LOCATION_ID,
            localDate: '2026-08-25', // Mardi fermé
            kind: 'CLOSED',
            openTime: null,
            closeTime: null,
            reason: 'Fermeture exceptionnelle',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        translations: [frTranslation('plan-daily-ex', 'Journée')],
      });

      const result = computeQuote(ctx);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.planType).toBe('DAILY');
      expect(result.totalAmountMinor).toBe(20000);
    });
  });
});
