/**
 * @uttily/core — Module booking-amendments (G7M-B1, G7M-B2-A, G7M-C1, G7M-C2, G7M-C4-A).
 *
 * Projection canonique read-only de l'état effectif d'une réservation (G7M-B1)
 * et mutations transactionnelles d'amendement NEUTRAL/REFUND, ainsi que la
 * création locale durable d'un SUPPLEMENT avant Stripe (G7M-C1), initiation
 * du PaymentIntent hors transaction (G7M-C2) et cycle de vie complet du
 * supplément (G7M-C4-A : expiration atomique, retry métier N+1 et réconciliation).
 *
 * Exports publics :
 * - getEffectiveBooking, EffectiveBookingError, EffectiveBookingErrorCode,
 *   et les types nécessaires à la consommation de la projection.
 * - createNeutralBookingAmendment, createRefundBookingAmendment et
 *   createSupplementBookingAmendment, leurs erreurs/codes et types publics.
 * - initiateSupplementPayment et ses résultats fermés.
 * - expireSupplementAmendmentsBatch, retryFailedSupplementPayment et
 *   reconcileSupplementPaymentsBatch.
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
export { initiateSupplementPayment } from './initiate-supplement-payment';
export {
  expireSupplementAmendmentsBatch,
  BOOKING_AMENDMENT_EXPIRED_AGGREGATE_TYPE,
  BOOKING_AMENDMENT_EXPIRED_EVENT_TYPE,
  BOOKING_AMENDMENT_EXPIRED_EVENT_VERSION,
} from './expire-supplement-amendments';
export { retryFailedSupplementPayment } from './retry-supplement-payment';
export { reconcileSupplementPaymentsBatch } from './reconcile-supplement-payments-batch';
export {
  handleSupplementPaymentWebhook,
  projectSupplementPaymentStatus,
} from './apply-supplement-amendment';
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
export type {
  InitiateSupplementPaymentInput,
  InitiateSupplementPaymentOptions,
  InitiateSupplementPaymentResult,
  InitiateSupplementPaymentSuccess,
} from './initiate-supplement-payment-types';
export type {
  ExpireSupplementAmendmentsOptions,
  ExpiredSupplementAmendment,
  ExpireSupplementAmendmentsResult,
} from './expire-supplement-amendments';
export type {
  RetrySupplementPaymentInput,
  RetrySupplementPaymentResult,
} from './retry-supplement-payment';
export type {
  SupplementReconciliationAnomalyCode,
  SupplementReconciliationDependencies,
  SupplementReconciliationOptions,
  SupplementReconciliationBatchResult,
} from './reconcile-supplement-payments-batch';

// G7M-C5-A — Prévisualisation canonique read-only de modification de réservation.
export { previewBookingAmendment } from './preview-booking-amendment';
export {
  PreviewBookingAmendmentError,
  isPreviewBookingAmendmentErrorCode,
} from './types-amendment';
export type {
  PreviewBookingAmendmentCommand,
  PreviewLineDiffEntry,
  PreviewBookingAmendmentSuccess,
  PreviewBookingAmendmentResult,
  PreviewBookingAmendmentErrorCode,
} from './types-amendment';
export { getEffectivePricingIntent } from './get-effective-pricing-intent';
export type { GetEffectivePricingIntentResult } from './get-effective-pricing-intent';
