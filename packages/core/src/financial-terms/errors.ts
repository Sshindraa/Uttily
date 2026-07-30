import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Erreur métier typée pour le domaine financial-terms.
 * Les Server Actions catchent FinancialTermsError et mappent le code vers ActionResult.
 * Évite le string matching sur les messages français.
 */
export class FinancialTermsError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(code: ActionErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'FinancialTermsError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
