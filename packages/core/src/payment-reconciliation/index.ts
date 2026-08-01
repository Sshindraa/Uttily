/**
 * @uttily/core — Module Payment Reconciliation (Phase 7A, ADR-010 §12).
 *
 * Moteur de réconciliation des paiements non-terminaux. Réconcilie les
 * tentatives dont l'échéance de réconciliation est atteinte en interrogeant
 * le provider Stripe HORS transaction, puis en appliquant les transitions
 * métier appropriées dans des transactions PostgreSQL séparées.
 *
 * Contraintes critiques (ADR-010 §1, §12) :
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - Aucune libération basée uniquement sur le temps.
 * - Aucun nouveau PaymentIntent avec une nouvelle clé.
 * - Aucun faux webhook.
 * - Ne jamais utiliser Date.now() pour les décisions métier — utiliser
 *   l'horloge PostgreSQL (now()).
 */

export type { ReconciliationErrorCode } from './errors';
export { ReconciliationError } from './errors';
export type {
  ReconciliationDependencies,
  ReconciliationOptions,
  ClaimedAttempt,
  ReconciliationOutcome,
  ReconciliationBatchResult,
} from './types';
export {
  MAX_BATCH_LIMIT,
  DEFAULT_BATCH_LIMIT,
  LEASE_INTERVAL,
  RECONCILIATION_BACKOFF_INTERVAL,
  PROCESSING_DEADLINE_INTERVAL,
  IDEMPOTENCY_KEY_MAX_AGE_HOURS,
  MAX_IDEMPOTENCY_KEY_AGE_HOURS,
  validateBatchLimit,
} from './scheduling';
export { claimReconciliationBatch } from './claim-reconciliation-batch';
export { applyReconciliationResult } from './apply-reconciliation-result';
export { reconcilePaymentsBatch } from './reconcile-payments-batch';
