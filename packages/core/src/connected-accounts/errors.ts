/**
 * @uttily/core — Erreurs du module connected-accounts (Lot 5, ADR-010 §3.3).
 *
 * Codes d'erreur fermés mappés vers l'union `ActionErrorCode` utilisée par les
 * Server Actions et persistée dans idempotency_records.
 */

import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';
import type { ConnectedAccountErrorCode } from './types';

/**
 * Mappe un code interne `ConnectedAccountErrorCode` vers l'union fermée
 * `ActionErrorCode` utilisée par les Server Actions.
 */
export function toActionErrorCode(code: ConnectedAccountErrorCode): ActionErrorCode {
  switch (code) {
    case 'VALIDATION':
      return 'VALIDATION';
    case 'ACCOUNT_ALREADY_EXISTS':
      return 'CONFLICT_IDEMPOTENCY';
    case 'ACCOUNT_NOT_FOUND':
      return 'NOT_FOUND';
    case 'ONBOARDING_NOT_STARTED':
      return 'PAYMENT_ACCOUNT_NOT_READY';
    case 'PROVIDER_CALL_FAILED':
      return 'UNKNOWN';
    case 'ENVIRONMENT_MISMATCH':
      return 'PAYMENT_ENVIRONMENT_MISMATCH';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

/**
 * Erreur métier typée pour le module connected-accounts.
 *
 * Porte un `statusCode` stable afin d'être persistée et rejouée lors d'un
 * replay idempotent. Le message ne doit jamais contenir de données sensibles
 * (client_secret, informations bancaires, etc.).
 */
export class ConnectedAccountError extends Error {
  readonly code: ConnectedAccountErrorCode;
  readonly statusCode: number;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(
    code: ConnectedAccountErrorCode,
    message: string,
    options?: { statusCode?: number; fieldErrors?: FieldErrors },
  ) {
    super(message);
    this.name = 'ConnectedAccountError';
    this.code = code;
    this.statusCode = options?.statusCode ?? 400;
    this.fieldErrors = options?.fieldErrors;
  }
}
