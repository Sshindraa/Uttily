/**
 * @uttily/core — Module commun de revendication d'événements outbox (G5D, ADR-013 §7).
 *
 * Module partagé entre le worker de compensation (ADR-010 §13) et le worker de
 * documents transactionnels (ADR-013 §7). Fournit :
 * - HandlerSelection : validation des filtres d'événement.
 * - Constantes de planification partagées (lease, backoff, max attempts).
 * - claimOutboxBatch : revendication générique avec FOR UPDATE SKIP LOCKED.
 * - poseLease : pose de lease uniforme pour les handlers spécialisés.
 *
 * Les deux stratégies d'incrémentation d'attempt_count sont supportées via
 * IncrementStrategy :
 * - 'always' (ADR-013 §7) : incrémente à chaque claim.
 * - 'reclaim_only' (ADR-010 §13) : n'incrémente que lors d'un reclaim.
 */

export type { KnownHandlerSelection } from './handler-selection';
export {
  validateHandlerSelection,
  BOOKING_CONFIRMED_SELECTION,
  PAYMENT_COMPENSATION_SELECTION,
  REFUND_REQUEST_SELECTION,
} from './handler-selection';
export {
  MAX_BATCH_LIMIT,
  DEFAULT_BATCH_LIMIT,
  LEASE_INTERVAL,
  MAX_ATTEMPTS,
  BASE_BACKOFF_INTERVAL,
  validateBatchLimit,
  getBackoffIntervalSeconds,
} from './scheduling';
export type { IncrementStrategy, ClaimedOutboxEvent, ClaimEligibility } from './claim-outbox-batch';
export { claimOutboxBatch, poseLease, validateClaimEligibility } from './claim-outbox-batch';
