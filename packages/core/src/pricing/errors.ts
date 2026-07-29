import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Erreur métier typée pour le domaine pricing.
 * Les Server Actions catchent PricingError et mappent le code vers ActionResult.
 * Évite le string matching sur les messages français.
 */
export class PricingError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(code: ActionErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
