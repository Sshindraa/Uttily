/**
 * @uttily/worker — Failure codes normalisés pour le worker (G5F, ADR-013).
 *
 * Union fermée correspondant exactement aux 8 codes publics de l'enum
 * PostgreSQL `document_processing_failure_code`. Aucune valeur inconnue
 * ne doit apparaître dans les logs, métriques ou labels.
 *
 * La fonction `normalizeFailureCode` mappe tout code interne (G5D/G5E) ou
 * valeur inattendue vers un code public normalisé. Le switch est exhaustif :
 * le default mappe toujours vers `UNKNOWN_ERROR`.
 */

/**
 * Union fermée des 8 codes publics de l'enum PostgreSQL
 * `document_processing_failure_code`. Aucune autre valeur n'est autorisée
 * dans les logs, métriques ou labels.
 */
export type WorkerFailureCode =
  | 'PAYLOAD_MALFORMED'
  | 'STORAGE_PUT_FAILED'
  | 'STORAGE_CHECKSUM_MISMATCH'
  | 'STORAGE_NOT_FOUND'
  | 'RENDER_FAILED'
  | 'EMAIL_SEND_FAILED'
  | 'LEASE_LOST'
  | 'PROVIDER_RESULT_UNCERTAIN'
  | 'EMAIL_RETRY_WINDOW_EXPIRED'
  | 'UNKNOWN_ERROR';

/**
 * Liste exhaustive des codes publics, pour validation runtime et tests.
 */
export const WORKER_FAILURE_CODES: readonly WorkerFailureCode[] = [
  'PAYLOAD_MALFORMED',
  'STORAGE_PUT_FAILED',
  'STORAGE_CHECKSUM_MISMATCH',
  'STORAGE_NOT_FOUND',
  'RENDER_FAILED',
  'EMAIL_SEND_FAILED',
  'LEASE_LOST',
  'PROVIDER_RESULT_UNCERTAIN',
  'EMAIL_RETRY_WINDOW_EXPIRED',
  'UNKNOWN_ERROR',
] as const;

/**
 * Normalise un code interne (retourné par les pipelines G5D/G5E) ou une
 * valeur inattendue vers un `WorkerFailureCode` public.
 *
 * Règles :
 * - Les 8 codes publics → eux-mêmes.
 * - Les codes internes G5C/G5D/G5E (VALIDATION, EVENT_NOT_FOUND,
 *   EVENT_CONTRACT_MISMATCH, AUTHORITY_MISMATCH, SNAPSHOT_INVARIANT,
 *   UNKNOWN, EFFECT_SET_INVARIANT_VIOLATED, NOTIFICATION_MISSING,
 *   FAIL_CLOSED_*, etc.) → `UNKNOWN_ERROR`.
 * - null, undefined, chaîne vide, toute valeur inattendue → `UNKNOWN_ERROR`.
 *
 * Le switch est exhaustif : le default mappe toujours vers `UNKNOWN_ERROR`.
 * Aucun string matching sur un message brut n'est effectué.
 */
export function normalizeFailureCode(internal: string | undefined | null): WorkerFailureCode {
  switch (internal) {
    case 'PAYLOAD_MALFORMED':
      return 'PAYLOAD_MALFORMED';
    case 'STORAGE_PUT_FAILED':
      return 'STORAGE_PUT_FAILED';
    case 'STORAGE_CHECKSUM_MISMATCH':
      return 'STORAGE_CHECKSUM_MISMATCH';
    case 'STORAGE_NOT_FOUND':
      return 'STORAGE_NOT_FOUND';
    case 'RENDER_FAILED':
      return 'RENDER_FAILED';
    case 'EMAIL_SEND_FAILED':
      return 'EMAIL_SEND_FAILED';
    case 'LEASE_LOST':
      return 'LEASE_LOST';
    case 'PROVIDER_RESULT_UNCERTAIN':
      return 'PROVIDER_RESULT_UNCERTAIN';
    case 'EMAIL_RETRY_WINDOW_EXPIRED':
      return 'EMAIL_RETRY_WINDOW_EXPIRED';
    case 'UNKNOWN_ERROR':
      return 'UNKNOWN_ERROR';
    // Codes internes G5C (DocumentRenderErrorCode) → UNKNOWN_ERROR.
    case 'VALIDATION':
    case 'EVENT_NOT_FOUND':
    case 'EVENT_CONTRACT_MISMATCH':
    case 'AUTHORITY_MISMATCH':
    case 'SNAPSHOT_INVARIANT':
    case 'UNKNOWN':
    // Codes internes G5D/G5E (fail-closed, invariants) → UNKNOWN_ERROR.
    case 'EFFECT_SET_INVARIANT_VIOLATED':
    case 'NOTIFICATION_MISSING':
    case 'FAIL_CLOSED_INCONSISTENT_STATE':
    case 'FAIL_CLOSED_LEASE_LOST':
    case 'FAIL_CLOSED_INVALID_RESULT':
    case 'RECIPIENT_EMAIL_INVALID':
    case 'EMAIL_IDEMPOTENCY_CONFLICT':
      return 'UNKNOWN_ERROR';
    // null, undefined, chaîne vide, ou toute autre valeur inattendue.
    default:
      return 'UNKNOWN_ERROR';
  }
}
