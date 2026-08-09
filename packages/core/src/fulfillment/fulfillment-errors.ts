import type { BookingStatus } from './types';

/**
 * Codes d'erreur fermés pour les use cases transactionnels de fulfillment (G3A/G3B).
 * Distincts des ActionErrorCode web (contracts) : ce module core ne dépend pas
 * de la couche web.
 */
export type FulfillmentErrorCode =
  | 'VALIDATION'
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_ITEM_NOT_FOUND'
  | 'BOOKING_ITEM_MISMATCH'
  | 'ORGANIZATION_MISMATCH'
  | 'FORBIDDEN'
  | 'INVALID_TRANSITION'
  | 'TERMINAL_STATE'
  | 'REPORT_PHASE_NOT_ALLOWED'
  | 'DAMAGE_REPORT_NOT_ALLOWED'
  | 'INVALID_CONDITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_REPLAY_INVALID'
  | 'CONCURRENT_MODIFICATION'
  | 'UNKNOWN';

/**
 * Liste fermée des codes d'erreur fulfillment valides.
 * Utilisée pour valider le responseBody FAILED lors du replay idempotent.
 */
const FULFILLMENT_ERROR_CODES: readonly FulfillmentErrorCode[] = [
  'VALIDATION',
  'BOOKING_NOT_FOUND',
  'BOOKING_ITEM_NOT_FOUND',
  'BOOKING_ITEM_MISMATCH',
  'ORGANIZATION_MISMATCH',
  'FORBIDDEN',
  'INVALID_TRANSITION',
  'TERMINAL_STATE',
  'REPORT_PHASE_NOT_ALLOWED',
  'DAMAGE_REPORT_NOT_ALLOWED',
  'INVALID_CONDITION',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_REPLAY_INVALID',
  'CONCURRENT_MODIFICATION',
  'UNKNOWN',
];

/**
 * Type guard : vérifie qu'une valeur est un FulfillmentErrorCode valide.
 * Utilisé pour valider le code d'erreur persisté lors du replay d'un FAILED.
 */
export function isFulfillmentErrorCode(value: unknown): value is FulfillmentErrorCode {
  return (
    typeof value === 'string' && (FULFILLMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Erreur métier typée pour les use cases de fulfillment terrain.
 * Les Server Actions (apps/web) catchent FulfillmentError et mappent le code
 * vers ActionResult. Évite le string matching sur les messages français.
 */
export class FulfillmentError extends Error {
  readonly code: FulfillmentErrorCode;
  readonly fromStatus: BookingStatus | undefined;
  readonly toStatus: BookingStatus | undefined;

  constructor(
    code: FulfillmentErrorCode,
    message: string,
    opts?: { fromStatus?: BookingStatus; toStatus?: BookingStatus },
  ) {
    super(message);
    this.name = 'FulfillmentError';
    this.code = code;
    this.fromStatus = opts?.fromStatus;
    this.toStatus = opts?.toStatus;
  }
}
