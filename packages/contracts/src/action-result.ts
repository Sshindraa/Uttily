/**
 * Contrat ActionResult pour les Server Actions Uttily.
 *
 * Codes d'erreur normalisés pour les Server Actions Uttily.
 * Union fermée : toute nouvelle action doit réutiliser ou étendre cette union
 * via une décision documentée (ADR).
 */
export type ActionErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT_SLUG'
  | 'CONFLICT_SKU'
  | 'CONFLICT_SERIAL'
  | 'CONFLICT_IDEMPOTENCY'
  | 'CONFLICT_BLOCK'
  | 'BLOCK_NOT_FOUND'
  | 'BLOCK_INVALID_TRANSITION'
  | 'PUBLISH_INCOMPLETE'
  | 'LAST_ACTIVE_VARIANT'
  | 'UNKNOWN';

export type FieldErrors = Record<string, string>;

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string; fieldErrors?: FieldErrors };
