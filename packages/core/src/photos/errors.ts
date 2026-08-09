/**
 * @uttily/core — Module Photos (G7F-A2).
 *
 * Erreur métier typée pour les opérations sur les photos produit.
 * Les codes sont spécifiques au domaine photos et distincts des autres
 * modules (CatalogError, PublicSearchError, etc.).
 *
 * Conventions : UPPER_SNAKE_CASE, classe avec `code` union fermée.
 * Aucune fuite interne : SQL, noms de contraintes, IDs internes, structure
 * de tables ne sont jamais exposés dans les messages publics.
 */

export type PhotoErrorCode = 'PHOTO_NOT_FOUND' | 'PHOTO_DELETION_WOULD_BREAK_PUBLICATION';

export class PhotoError extends Error {
  readonly code: PhotoErrorCode;
  constructor(code: PhotoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PhotoError';
    this.code = code;
  }
}
