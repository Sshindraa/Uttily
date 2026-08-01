/**
 * @uttily/core — Module Webhook Handler (Lot 5, ADR-010 §9, §10, §11, §13, §14).
 *
 * Use case de traitement des webhooks Stripe signés, idempotents et
 * transactionnels. Le webhook signé est l'autorité de l'état externe du
 * paiement ; PostgreSQL reste l'autorité de l'état métier et de la confirmation
 * de réservation.
 *
 * Contraintes critiques (ADR-010 §1, §9, §14) :
 * - La vérification de signature se fait HORS transaction, avant toute écriture.
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - Le corps brut et les données de carte ne sont JAMAIS persistés.
 * - Le `client_secret` n'est JAMAIS persisté, loggé ou inclus dans une réponse.
 */

export * from './types';
export {
  WebhookHandlerError,
  normalizeWebhookError,
  toActionErrorCode as toWebhookActionErrorCode,
  type WebhookHandlerErrorCode,
} from './errors';
export { handleWebhook } from './handle-webhook';
export { extractPaymentIntentEventData } from './extract-event';
export { projectAttemptStatus, isStaleEvent } from './project-status';
export { resolveAttempt } from './resolve-attempt';
export {
  dedupeEvent,
  ingestEvent,
  lockWebhookEvent,
  computePayloadSha256,
  resolveOrgFromConnectedAccount,
  markWebhookFailed,
  NIL_ORG_ID,
} from './dedupe-event';
export { validateWebhookAuthority } from './validate-authority';
export { confirmBooking, isDraftTerminalForConversion } from './confirm-booking';
export { handlePaymentFailed, handleCanceled, handleProcessing } from './handle-non-success';
export { compensateLatePayment } from './compensate-late';
export { withInvariantHandling, isHandlerError } from './with-invariant-handling';

// Phase 7A — Transitions métier source-agnostiques (réutilisées par la réconciliation).
export * from '../payment-transitions';
