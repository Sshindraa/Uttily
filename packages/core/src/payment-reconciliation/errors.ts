/**
 * @uttily/core — Erreurs du module Payment Reconciliation (Phase 7A, ADR-010 §12).
 *
 * Codes d'erreur fermés pour le moteur de réconciliation des paiements.
 */

/** Codes d'erreur fermés du module payment-reconciliation. */
export type ReconciliationErrorCode =
  | 'BATCH_LIMIT_INVALID'
  | 'LEASE_LOST'
  | 'PROVIDER_CALL_FAILED'
  | 'PROVIDER_STATE_UNKNOWN'
  | 'PROVIDER_RESULT_INCOMPATIBLE'
  | 'PROVIDER_AUTHORITY_MISMATCH'
  | 'PROVIDER_ENVIRONMENT_MISMATCH'
  | 'KEY_EXPIRED'
  | 'CANCEL_FAILED'
  | 'INVARIANT_BROKEN'
  | 'SNAPSHOT_MISMATCH';

/**
 * Erreur métier typée pour la réconciliation des paiements.
 */
export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode, message: string) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}
