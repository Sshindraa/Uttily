/**
 * @uttily/core — Module Payment Initiation (Lot 5, ADR-010 §7).
 *
 * Use case d'initiation de paiement : convertit un brouillon HELD en
 * PAYMENT_PROCESSING, crée un payment + payment_attempt, appelle le provider
 * Stripe HORS transaction, puis projette la réponse du provider.
 *
 * Le client_secret n'est JAMAIS persisté, loggé ou inclus dans
 * idempotency_records — il n'apparaît que dans la valeur de retour.
 */

export * from './types';
export * from './errors';
export { computePaymentFingerprint } from './fingerprint';
export { initiatePayment } from './initiate-payment';
