import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Erreur métier typée pour le domaine idempotence.
 * Les Server Actions catchent IdempotencyError et mappent le code vers ActionResult.
 * Évite le string matching sur les messages français.
 */
export class IdempotencyError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(code: ActionErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'IdempotencyError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
