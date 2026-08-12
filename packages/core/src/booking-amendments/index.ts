/**
 * @uttily/core — Module booking-amendments (G7M-B1).
 *
 * Projection canonique read-only de l'état effectif d'une réservation.
 *
 * Exports publics : getEffectiveBooking, EffectiveBookingError,
 * EffectiveBookingErrorCode, et les types nécessaires à la consommation de la
 * projection (EffectiveBooking, EffectiveLine, EffectiveAllocation,
 * EffectiveFinancials, AmendmentSummary, GetEffectiveBookingResult).
 *
 * Les helpers internes (parseFinancialSnapshot, normalizeAggregateAmount,
 * assertFinancialInvariant, isEffectiveBookingErrorCode, FinancialSnapshot,
 * loaders) ne sont pas exposés depuis ce barrel.
 */

export { getEffectiveBooking } from './get-effective-booking';
export { EffectiveBookingError } from './errors';
export type { EffectiveBookingErrorCode } from './errors';
export type {
  EffectiveBooking,
  EffectiveLine,
  EffectiveAllocation,
  EffectiveFinancials,
  AmendmentSummary,
  GetEffectiveBookingResult,
} from './types';
