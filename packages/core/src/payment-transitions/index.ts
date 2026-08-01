/**
 * @uttily/core — Module Payment Transitions (Phase 7A, ADR-010 §10, §12).
 *
 * Transitions métier source-agnostiques partagées entre les handlers webhook
 * et le moteur de réconciliation. Ces fonctions NE touchent PAS
 * payment_webhook_events — le verrouillage et le marquage du webhook restent
 * la responsabilité de l'appelant.
 */

export type { LockedBusinessRows, LockedPaymentRows } from './types';
export { lockFullBusinessRows, lockPaymentAttemptRows } from './lock-rows';
export {
  applyBookingConfirmation,
  type ApplyBookingConfirmationResult,
} from './apply-booking-confirmation';
export { applyCancellation } from './apply-cancellation';
export { applyProcessingProjection } from './apply-processing-projection';
export { applyLateCompensation } from './apply-late-compensation';
