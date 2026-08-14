/**
 * @uttily/core — Module booking-amendments (G7M-B1, G7M-B2-A, G7M-C1).
 *
 * Projection canonique read-only de l'état effectif d'une réservation (G7M-B1)
 * et mutations transactionnelles d'amendement NEUTRAL/REFUND, ainsi que la
 * création locale durable d'un SUPPLEMENT avant Stripe (G7M-C1).
 *
 * Exports publics :
 * - getEffectiveBooking, EffectiveBookingError, EffectiveBookingErrorCode,
 *   et les types nécessaires à la consommation de la projection.
 * - createNeutralBookingAmendment, createRefundBookingAmendment et
 *   createSupplementBookingAmendment, leurs erreurs/codes et types publics.
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
export { createRefundBookingAmendment } from './create-refund-booking-amendment';
export { createSupplementBookingAmendment } from './create-supplement-booking-amendment';
export {
  NeutralAmendmentError,
  RefundAmendmentError,
  SupplementAmendmentError,
} from './types-amendment';
export type {
  NeutralAmendmentErrorCode,
  RefundAmendmentErrorCode,
  SupplementAmendmentErrorCode,
} from './types-amendment';
export type {
  NeutralAmendmentCommand,
  NeutralAmendmentDesiredLine,
  NeutralAmendmentIntent,
  NeutralAmendmentResult,
  RefundAmendmentCommand,
  RefundAmendmentResult,
  SupplementAmendmentCommand,
  SupplementAmendmentResult,
} from './types-amendment';
