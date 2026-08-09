/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Types d'entrée/sortie et types internes du moteur de tarification flexible.
 * Aucune dépendance base de données, aucune écriture.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Intent — discriminated union
// ─────────────────────────────────────────────────────────────────────────────

export type FlexiblePricingIntent =
  /**
   * `startAt` et `endAt` sont des chaînes de date+heure locale au format
   * ISO 8601 SANS offset de fuseau horaire (ex : "2026-08-08T22:08:00").
   * Elles représentent l'heure locale dans le fuseau IANA du lieu de location.
   * Le moteur convertit ces chaînes en UTC via `localDateTimeStringToUtc`
   * avec le `timeZone` du contexte de pricing.
   */
  | { kind: 'TIME_RANGE'; startAt: string; endAt: string }
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string };

/**
 * Intent flexible « résolu » : les chaînes locales TIME_RANGE ont été
 * converties en instants UTC `Date`. Utilisé en interne par le moteur
 * (PricingContext, candidate-generator, opening-hours, quote-engine) afin
 * que les calculs de durée et de fenêtres travaillent sur des instants UTC
 * absolus. L'intent d'entrée (`FlexiblePricingIntent`) reste en chaînes
 * locales ; la conversion a lieu dans `loadPricingContext`.
 */
export type ResolvedFlexiblePricingIntent =
  | { kind: 'TIME_RANGE'; startAt: Date; endAt: Date }
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string };

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteFlexiblePricingInput {
  organizationId: string;
  locationId: string;
  locale: string;
  intent: FlexiblePricingIntent;
  lines: Array<{ variantId: string; quantity: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectedWindow {
  weekdayMask: number;
  startTime: string; // HH:MM:SS
  endTime: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY_RANGE boundaries (G7P-B2-B)
// ─────────────────────────────────────────────────────────────────────────────

export interface DayRangeDayBoundary {
  localDate: string; // YYYY-MM-DD
  weekdayMask: number; // 1-127
  startTime: string; // HH:MM:SS
  endTime: string; // HH:MM:SS
}

export interface DayRangeBoundaries {
  kind: 'DAY_RANGE_BOUNDARIES';
  firstDay: DayRangeDayBoundary;
  lastDay: DayRangeDayBoundary;
}

// ─────────────────────────────────────────────────────────────────────────────
// PricingWindowSnapshot (G7P-B2-B Round 2 — Defect 2)
// Forme canonique de persistance de la fenêtre sélectionnée pour une ligne.
// Discriminated union : TIME_RANGE_WINDOW ou DAY_RANGE_BOUNDARIES.
// ─────────────────────────────────────────────────────────────────────────────

export type PricingWindowSnapshot =
  | {
      kind: 'TIME_RANGE_WINDOW';
      weekdayMask: number;
      startTime: string;
      endTime: string;
    }
  | {
      kind: 'DAY_RANGE_BOUNDARIES';
      firstDay: {
        localDate: string;
        weekdayMask: number;
        startTime: string;
        endTime: string;
      };
      lastDay: {
        localDate: string;
        weekdayMask: number;
        startTime: string;
        endTime: string;
      };
    };

export interface QuoteLineHourly {
  planType: 'HOURLY';
  variantId: string;
  quantity: number;
  pricingPlanId: string;
  planVersion: number;
  publicLabel: string;
  unitPriceAmountMinor: number;
  requestedDurationMinutes: number;
  billedDurationMinutes: number;
  coveredDurationMinutes: null;
  billedDays: null;
  selectedWindow: SelectedWindow | null;
  discountThresholdDays: null;
  discountPercent: null;
  amountBeforeDiscountMinor: null;
  amountAfterDiscountMinor: null;
  lineTotalAmountMinor: number;
  /** G7P-B2-B Round 2 : nombre d'unités facturables (increments pour HOURLY). */
  billableUnitCount: number;
  /** G7P-B2-B Round 2 : snapshot canonique de la fenêtre (null si pas de fenêtre). */
  windowSnapshot: PricingWindowSnapshot | null;
}

export interface QuoteLineFixedDuration {
  planType: 'FIXED_DURATION';
  variantId: string;
  quantity: number;
  pricingPlanId: string;
  planVersion: number;
  publicLabel: string;
  unitPriceAmountMinor: number;
  requestedDurationMinutes: number;
  billedDurationMinutes: null;
  coveredDurationMinutes: number;
  billedDays: null;
  selectedWindow: SelectedWindow | null;
  discountThresholdDays: null;
  discountPercent: null;
  amountBeforeDiscountMinor: null;
  amountAfterDiscountMinor: null;
  lineTotalAmountMinor: number;
  /** G7P-B2-B Round 2 : nombre d'unités facturables (toujours 1 pour FIXED_DURATION). */
  billableUnitCount: number;
  /** G7P-B2-B Round 2 : snapshot canonique de la fenêtre (null si pas de fenêtre). */
  windowSnapshot: PricingWindowSnapshot | null;
}

export interface QuoteLineDaily {
  planType: 'DAILY';
  variantId: string;
  quantity: number;
  pricingPlanId: string;
  planVersion: number;
  publicLabel: string;
  unitPriceAmountMinor: number;
  requestedDurationMinutes: number;
  billedDurationMinutes: null;
  coveredDurationMinutes: null;
  billedDays: number;
  selectedWindow: SelectedWindow | null;
  discountThresholdDays: number | null;
  discountPercent: number | null;
  amountBeforeDiscountMinor: number;
  amountAfterDiscountMinor: number;
  lineTotalAmountMinor: number;
  /** G7P-B2-B : bornes de fenêtre pour DAY_RANGE (null pour TIME_RANGE). */
  dayRangeBoundaries: DayRangeBoundaries | null;
  /** G7P-B2-B Round 2 : nombre d'unités facturables (billedDays pour DAILY). */
  billableUnitCount: number;
  /** G7P-B2-B Round 2 : snapshot canonique de la fenêtre (TIME_RANGE_WINDOW ou DAY_RANGE_BOUNDARIES). */
  windowSnapshot: PricingWindowSnapshot | null;
}

export type QuoteLine = QuoteLineHourly | QuoteLineFixedDuration | QuoteLineDaily;

export interface QuoteFlexiblePricingResult {
  algorithmVersion: 'flexible-pricing-v1';
  roundingRuleVersion: 'half-up-v1';
  organizationId: string;
  locationId: string;
  currency: string;
  timeZone: string;
  intent: ResolvedFlexiblePricingIntent;
  lines: QuoteLine[];
  subtotalAmountMinor: number;
  totalAmountMinor: number;
  /** G7P-B2-B Round 2 — Defect 1 : locale réellement résolue (persistée). */
  resolvedLocale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types for the engine
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedPlan {
  id: string;
  organizationId: string;
  productVariantId: string;
  locationId: string | null;
  planType: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
  currency: string;
  priceAmountMinor: number;
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
  billingIncrementMinutes: number | null;
  includedDurationMinutes: number | null;
  internalLabel: string | null;
  priority: number;
  version: number;
}

export interface ResolvedWindow {
  pricingPlanId: string;
  weekdayMask: number;
  startTime: string;
  endTime: string;
}

export interface ResolvedTier {
  pricingPlanId: string;
  thresholdDays: number;
  discountPercent: number;
}

export interface ResolvedTranslation {
  pricingPlanId: string;
  locale: string;
  publicLabel: string;
}

export interface OpeningHour {
  weekday: number; // 0=Monday..6=Sunday
  openTime: string;
  closeTime: string;
}

export interface PricingContext {
  organizationId: string;
  locationId: string;
  currency: string;
  timeZone: string;
  intent: ResolvedFlexiblePricingIntent;
  plans: ResolvedPlan[];
  windows: ResolvedWindow[];
  tiers: ResolvedTier[];
  translations: ResolvedTranslation[];
  openingHours: OpeningHour[];
  variants: Map<string, { productId: string; organizationId: string }>;
  lines: Array<{ variantId: string; quantity: number }>;
  locale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal candidate type (used between generator, calculator, selector)
// ─────────────────────────────────────────────────────────────────────────────

export interface Candidate {
  plan: ResolvedPlan;
  variantId: string;
  quantity: number;
  requestedDurationMinutes: number;
  billedDurationMinutes: number | null;
  coveredDurationMinutes: number | null;
  billedDays: number | null;
  selectedWindow: SelectedWindow | null;
  discountThresholdDays: number | null;
  discountPercent: number | null;
  amountBeforeDiscountMinor: number | null;
  amountAfterDiscountMinor: number | null;
  lineTotalAmountMinor: number;
  exactDurationMatch: boolean;
  sufficientDuration: number;
  unusedTime: number;
  /** G7P-B2-B : bornes de fenêtre pour DAY_RANGE (null pour TIME_RANGE). */
  dayRangeBoundaries: DayRangeBoundaries | null;
  /** G7P-B2-B Round 2 — Defect 4 : nombre d'unités facturables. */
  billableUnitCount: number;
}
