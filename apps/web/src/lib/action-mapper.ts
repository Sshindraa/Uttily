import { CatalogError, AuthorizationError } from '@uttily/core';
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
  if (err instanceof Error && err.message === 'UNAUTHENTICATED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
  }
  // Erreur inattendue : ne pas exposer le message brut.
  return { ok: false, code: 'UNKNOWN', message: 'Une erreur inattendue est survenue.' };
}
