/**
 * @uttily/core — Erreurs typées pour la projection d'amendements (G7M-B1).
 *
 * Pattern identique à FulfillmentError : codes fermés, pas de string matching,
 * catchable par les Server Actions pour mapping ActionResult.
 */

export type EffectiveBookingErrorCode =
  'VALIDATION' | 'SNAPSHOT_INVALID' | 'FINANCIAL_INVARIANT_VIOLATION';

/**
 * Liste fermée des codes d'erreur valides.
 */
const EFFECTIVE_BOOKING_ERROR_CODES: readonly EffectiveBookingErrorCode[] = [
  'VALIDATION',
  'SNAPSHOT_INVALID',
  'FINANCIAL_INVARIANT_VIOLATION',
];

/**
 * Type guard : vérifie qu'une valeur est un EffectiveBookingErrorCode valide.
 */
export function isEffectiveBookingErrorCode(value: unknown): value is EffectiveBookingErrorCode {
  return (
    typeof value === 'string' &&
    (EFFECTIVE_BOOKING_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Erreur métier typée pour la projection canonique getEffectiveBooking.
 */
export class EffectiveBookingError extends Error {
  readonly code: EffectiveBookingErrorCode;

  constructor(code: EffectiveBookingErrorCode, message: string) {
    super(message);
    this.name = 'EffectiveBookingError';
    this.code = code;
  }
}
