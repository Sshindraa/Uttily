/**
 * @uttily/core — Erreurs du module Compensation Execution (Phase 8, ADR-010 §13).
 *
 * Codes d'erreur fermés pour le moteur d'exécution des compensations.
 */

/** Codes d'erreur fermés du module compensation-execution. */
export type CompensationErrorCode =
  | 'REFUND_NOT_FOUND'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_INTENT_MISSING'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'ORGANIZATION_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'REFUND_ALREADY_SUBMITTED'
  | 'REFUND_FLAGS_INVALID'
  | 'PROVIDER_REFUND_FAILED'
  | 'LEASE_LOST';

/**
 * Erreur métier typée pour l'exécution des compensations.
 */
export class CompensationError extends Error {
  readonly code: CompensationErrorCode;

  constructor(code: CompensationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CompensationError';
    this.code = code;
  }
}
