/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Erreur métier typée pour les opérations analytics. Les codes sont
 * spécifiques au domaine product-analytics et distincts des autres modules.
 *
 * Conventions : UPPER_SNAKE_CASE, classe avec `code` union fermée.
 * Aucune fuite interne : SQL, noms de contraintes, IDs internes, structure
 * de tables ne sont jamais exposés dans les messages publics.
 */

export type ProductAnalyticsErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_UUID'
  | 'INVALID_DATE'
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_EVENT_TYPE'
  | 'INVALID_DAY_RANGE'
  | 'RANGE_TOO_LARGE'
  | 'OVERFLOW'
  | 'DUPLICATE_CONFLICT'
  | 'AGGREGATE_MISSING'
  | 'ANALYTICS_UNAVAILABLE';

export class ProductAnalyticsError extends Error {
  readonly code: ProductAnalyticsErrorCode;
  constructor(code: ProductAnalyticsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProductAnalyticsError';
    this.code = code;
  }
}
