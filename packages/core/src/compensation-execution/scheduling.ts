/**
 * @uttily/core — Constantes et validation de planification (Phase 8, ADR-010 §13).
 *
 * Re-exporte les constantes partagées du module commun outbox-claim (G5D,
 * ADR-013 §7) pour préserver la compatibilité ascendante du module
 * compensation-execution. Les valeurs sont identiques — la source de vérité
 * est désormais le module commun.
 */

export {
  MAX_BATCH_LIMIT,
  DEFAULT_BATCH_LIMIT,
  LEASE_INTERVAL,
  MAX_ATTEMPTS,
  BASE_BACKOFF_INTERVAL,
  validateBatchLimit,
  getBackoffIntervalSeconds,
} from '../outbox-claim/scheduling';
