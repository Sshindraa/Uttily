/**
 * @uttily/core — Module Compensation Execution (Phase 8, ADR-010 §13).
 *
 * Worker d'exécution des compensations. Consomme les événements
 * `PAYMENT_COMPENSATION_REQUESTED` de l'outbox, appelle Stripe `createRefund`
 * hors transaction, et persiste le résultat (`SUBMITTED` + `provider_refund_id`).
 *
 * Contraintes critiques (ADR-010 §1, §13) :
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - Ne jamais déclarer le refund `SUCCEEDED` — c'est le webhook qui le fait.
 * - Jamais de retry sans `reverse_transfer = true` et `refund_application_fee = true`.
 * - Ne jamais utiliser Date.now() pour les décisions métier — utiliser
 *   l'horloge PostgreSQL (now()).
 */

export type { CompensationErrorCode } from './errors';
export { CompensationError } from './errors';
export type {
  CompensationDependencies,
  CompensationOptions,
  ClaimedCompensation,
  CompensationBatchResult,
} from './types';
export { MAX_ATTEMPTS, BASE_BACKOFF_INTERVAL, getBackoffIntervalSeconds } from './scheduling';
export { claimCompensationBatch } from './claim-compensation-batch';
export { executeCompensation } from './execute-compensation';
export { executeCompensationBatch } from './execute-compensation-batch';
