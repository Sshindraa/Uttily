import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Erreur métier typée pour le domaine payments.
 * Les Server Actions catchent PaymentProviderError et mappent le code vers ActionResult.
 * Évite le string matching sur les messages français.
 *
 * Le `providerErrorCode` est un code d'erreur fournisseur mappé (fermé, sans
 * divulgation de détails internes Stripe). Il ne contient jamais de données
 * sensibles (carte, client_secret, etc.).
 */
export class PaymentProviderError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors | undefined;
  /** Code d'erreur fournisseur mappé (fermé, sans divulgation). */
  readonly providerErrorCode: string | null;

  constructor(
    code: ActionErrorCode,
    message: string,
    providerErrorCode?: string | null,
    fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.providerErrorCode = providerErrorCode ?? null;
    this.fieldErrors = fieldErrors;
  }
}
