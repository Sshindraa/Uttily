/**
 * Liste fermée des codes d'erreur valides (miroir runtime de `ActionErrorCode`).
 * Permet de valider qu'une valeur persistée appartient bien à l'union avant de
 * la rejouer.
 */
export const ACTION_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT_SLUG',
  'CONFLICT_SKU',
  'CONFLICT_SERIAL',
  'CONFLICT_IDEMPOTENCY',
  'CONFLICT_BLOCK',
  'BLOCK_NOT_FOUND',
  'BLOCK_INVALID_TRANSITION',
  'PUBLISH_INCOMPLETE',
  'LAST_ACTIVE_VARIANT',
  'FINANCIAL_TERMS_UNRESOLVED',
  'PAYMENT_ACCOUNT_NOT_READY',
  'PAYMENT_ENVIRONMENT_MISMATCH',
  'UNSUPPORTED_PROVIDER_STATE',
  'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
  'FULFILLMENT_INVALID_TRANSITION',
  'FULFILLMENT_REPORT_NOT_ALLOWED',
  'PREVIEW_STALE',
  'UNKNOWN',
] as const;

/**
 * Contrat ActionResult pour les Server Actions Uttily.
 *
 * Codes d'erreur normalisés pour les Server Actions Uttily.
 * Union fermée : toute nouvelle action doit réutiliser ou étendre cette union
 * via une décision documentée (ADR).
 */
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

/** Vérifie qu'une valeur est un `ActionErrorCode` valide. */
export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === 'string' && (ACTION_ERROR_CODES as readonly string[]).includes(value);
}

export type FieldErrors = Record<string, string>;

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string; fieldErrors?: FieldErrors };
