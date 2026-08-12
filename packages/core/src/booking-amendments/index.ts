/**
 * @uttily/core — Module booking-amendments (G7M-B1, G7M-B2-A).
 *
 * Projection canonique read-only de l'état effectif d'une réservation (G7M-B1)
 * et mutation transactionnelle idempotente d'amendement NEUTRAL (G7M-B2-A).
 *
 * Exports publics :
 * - getEffectiveBooking, EffectiveBookingError, EffectiveBookingErrorCode,
 *   et les types nécessaires à la consommation de la projection.
 * - createNeutralBookingAmendment, NeutralAmendmentError,
 *   NeutralAmendmentErrorCode, et les types de commande/résultat.
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

export { createNeutralBookingAmendment } from './create-neutral-booking-amendment';
export { NeutralAmendmentError } from './types-amendment';
export type { NeutralAmendmentErrorCode } from './types-amendment';
export type {
  NeutralAmendmentCommand,
  NeutralAmendmentDesiredLine,
  NeutralAmendmentIntent,
  NeutralAmendmentResult,
} from './types-amendment';
