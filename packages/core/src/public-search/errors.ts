/**
 * @uttily/core — Module Public Search (G7D-A).
 *
 * Erreur métier typée pour le moteur de recherche publique.
 * Les codes sont spécifiques au domaine public-search et distincts
 * d'ActionErrorCode (codes internes au moteur pur).
 *
 * Conventions : UPPER_SNAKE_CASE (cohérent avec pricing-plans/errors.ts
 * et local-to-utc.ts). Classe avec `code` union fermée.
 *
 * Aucune fuite interne : SQL, noms de contraintes, IDs internes, structure
 * de tables, messages contenant des entrées hostiles brutes ne sont jamais
 * exposés.
 */

export type PublicSearchErrorCode =
  | 'INVALID_INPUT'
  | 'DESTINATION_NOT_FOUND'
  | 'DESTINATION_INACTIVE'
  | 'COUNTRY_INACTIVE'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_INACTIVE'
  | 'INVALID_CURSOR'
  | 'INVALID_LOCAL_TIME'
  | 'PRICING_UNAVAILABLE'
  | 'PUBLICATION_GATE_UNAVAILABLE'
  | 'CURSOR_CODEC_UNAVAILABLE';

export class PublicSearchError extends Error {
  readonly code: PublicSearchErrorCode;
  constructor(code: PublicSearchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicSearchError';
    this.code = code;
  }
}
