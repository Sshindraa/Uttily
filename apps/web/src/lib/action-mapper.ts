import { CatalogError, AuthorizationError, FulfillmentError, PhotoError } from '@uttily/core';
import type { FulfillmentErrorCode } from '@uttily/core';
import type { ActionResult, ActionErrorCode } from '@uttily/contracts';

/**
 * Helper de mapping erreurs → ActionResult.
 *
 * Utilisé par toutes les Server Actions de mutation du catalogue/inventaire.
 * Les actions wrappent leur logique métier dans `runAction` ; les erreurs
 * domaine (`CatalogError`, `AuthorizationError`) et l'erreur d'authentification
 * (`Error('UNAUTHENTICATED')`) sont mappées vers un `ActionResult` structuré.
 *
 * Aucune erreur brute n'est exposée au client : les `Error` génériques
 * deviennent `{ code: 'UNKNOWN', message: 'Une erreur inattendue...' }`.
 */

/**
 * Exécute une fonction et mappe les erreurs vers ActionResult.
 * Utilisé par toutes les Server Actions de mutation.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return mapError<T>(err);
  }
}

/**
 * Mappe une erreur vers un ActionResult d'échec.
 *
 * Exception documentée : `AuthorizationError` ne porte pas de code typé
 * (c'est une classe d'erreur générique du module identity). Le seul endroit
 * où on fait du string matching sur `AuthorizationError` est ici, dans le
 * mapper centralisé — c'est acceptable car la classe est interne au projet
 * et les messages sont contrôlés. `CatalogError`, en revanche, porte un
 * `code: ActionErrorCode` typé et ne nécessite aucun string matching.
 */
function mapError<T>(err: unknown): ActionResult<T> {
  if (err instanceof CatalogError) {
    if (err.fieldErrors) {
      return { ok: false, code: err.code, message: err.message, fieldErrors: err.fieldErrors };
    }
    return { ok: false, code: err.code, message: err.message };
  }
  if (err instanceof AuthorizationError) {
    // Les AuthorizationError "introuvable" → NOT_FOUND, autres → FORBIDDEN.
    // Pas de fuite d'existence : une ressource d'une autre org est "introuvable".
    const code: ActionErrorCode = err.message.toLowerCase().includes('introuvable')
      ? 'NOT_FOUND'
      : 'FORBIDDEN';
    return { ok: false, code, message: err.message };
  }
  if (err instanceof FulfillmentError) {
    return mapFulfillmentError<T>(err);
  }
  if (err instanceof PhotoError) {
    return mapPhotoError<T>(err);
  }
  if (err instanceof Error && err.message === 'UNAUTHENTICATED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
  }
  // Erreur inattendue : ne pas exposer le message brut.
  return { ok: false, code: 'UNKNOWN', message: 'Une erreur inattendue est survenue.' };
}

function mapPhotoError<T>(err: PhotoError): ActionResult<T> {
  switch (err.code) {
    case 'PHOTO_NOT_FOUND':
      return { ok: false, code: 'NOT_FOUND', message: err.message };
    case 'PHOTO_VALIDATION_FAILED':
      return { ok: false, code: 'VALIDATION', message: err.message };
    case 'PHOTO_CONFLICT':
      return { ok: false, code: 'CONFLICT_IDEMPOTENCY', message: err.message };
    case 'PHOTO_DELETION_WOULD_BREAK_PUBLICATION':
      return { ok: false, code: 'VALIDATION', message: err.message };
    case 'PHOTO_UPLOAD_FAILED':
      return { ok: false, code: 'UNKNOWN', message: 'La photo n’a pas pu être enregistrée.' };
    default: {
      const _exhaustive: never = err.code as never;
      return _exhaustive;
    }
  }
}

/**
 * Mappe un FulfillmentError vers un ActionResult.
 *
 * Mapping fermé (ADR-008, G4A) :
 * - VALIDATION / INVALID_CONDITION → VALIDATION
 * - BOOKING_NOT_FOUND / BOOKING_ITEM_NOT_FOUND → NOT_FOUND
 * - ORGANIZATION_MISMATCH / FORBIDDEN → FORBIDDEN
 * - IDEMPOTENCY_CONFLICT → CONFLICT_IDEMPOTENCY
 * - INVALID_TRANSITION / TERMINAL_STATE / CONCURRENT_MODIFICATION / BOOKING_ITEM_MISMATCH → FULFILLMENT_INVALID_TRANSITION
 * - REPORT_PHASE_NOT_ALLOWED / DAMAGE_REPORT_NOT_ALLOWED → FULFILLMENT_REPORT_NOT_ALLOWED
 * - IDEMPOTENCY_REPLAY_INVALID / UNKNOWN → UNKNOWN
 *
 * Sanitisation UNKNOWN (G4A) : pour les codes mappés vers UNKNOWN, on ne
 * JAMAIS exposer `err.message` (qui peut contenir fromStatus/toStatus,
 * responseBody ou détails DB internes). On retourne un message générique
 * fixe. Les codes métier attendus portent des messages publics contrôlés
 * par le Core (pas de fuite DB). Ne jamais exposer fromStatus/toStatus.
 */
function mapFulfillmentError<T>(err: FulfillmentError): ActionResult<T> {
  const code = fulfillmentErrorToActionCode(err.code);
  // Sanitisation UNKNOWN : ne jamais exposer err.message, fromStatus, toStatus,
  // responseBody ou détails DB. Les codes métier attendus portent des messages
  // publics contrôlés par le Core (ADR-008, G4A).
  if (code === 'UNKNOWN') {
    return { ok: false, code, message: 'Une erreur inattendue est survenue.' };
  }
  return { ok: false, code, message: err.message };
}

function fulfillmentErrorToActionCode(code: FulfillmentErrorCode): ActionErrorCode {
  switch (code) {
    case 'VALIDATION':
    case 'INVALID_CONDITION':
      return 'VALIDATION';
    case 'BOOKING_NOT_FOUND':
    case 'BOOKING_ITEM_NOT_FOUND':
      return 'NOT_FOUND';
    case 'ORGANIZATION_MISMATCH':
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT_IDEMPOTENCY';
    case 'INVALID_TRANSITION':
    case 'TERMINAL_STATE':
    case 'CONCURRENT_MODIFICATION':
    case 'BOOKING_ITEM_MISMATCH':
      return 'FULFILLMENT_INVALID_TRANSITION';
    case 'REPORT_PHASE_NOT_ALLOWED':
    case 'DAMAGE_REPORT_NOT_ALLOWED':
      return 'FULFILLMENT_REPORT_NOT_ALLOWED';
    case 'IDEMPOTENCY_REPLAY_INVALID':
    case 'UNKNOWN':
      return 'UNKNOWN';
    default: {
      // Garde compile-time : si un nouveau FulfillmentErrorCode est ajouté sans
      // être mappé, le typecheck échoue. Ne jamais exécuté à runtime.
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
