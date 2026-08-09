/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Moteur de tarification flexible déterministe (read-only quote).
 * Architecture : moteur pur (computeQuote) séparé du chargement DB (loadPricingContext).
 *
 * - Aucune dépendance base de données dans le moteur pur.
 * - Same input + same plans = byte-for-byte equivalent result.
 * - Montants en unités mineures (entiers), arrondi half-up.
 * - PostgreSQL et le moteur déterministe restent l'autorité financière.
 */

export { quoteFlexiblePricing } from './quote-flexible-pricing';
export { computeQuote } from './quote-engine';
export { loadPricingContext } from './load-pricing-context';

export { FlexiblePricingError } from './errors';
export type { FlexiblePricingErrorCode } from './errors';

export type {
  QuoteFlexiblePricingInput,
  QuoteFlexiblePricingResult,
  QuoteLine,
  QuoteLineHourly,
  QuoteLineFixedDuration,
  QuoteLineDaily,
  FlexiblePricingIntent,
  ResolvedFlexiblePricingIntent,
  SelectedWindow,
  DayRangeBoundaries,
  DayRangeDayBoundary,
  PricingWindowSnapshot,
  PricingContext,
  ResolvedPlan,
  ResolvedWindow,
  ResolvedTier,
  ResolvedTranslation,
  OpeningHour,
  Candidate,
} from './types';
