/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Erreur métier typée pour le moteur de tarification flexible.
 * Les codes sont spécifiques au domaine pricing-plans et distincts
 * d'ActionErrorCode (codes internes au moteur pur).
 */

export type FlexiblePricingErrorCode =
  | 'VALIDATION'
  | 'LOCATION_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'PRODUCT_NOT_ELIGIBLE'
  | 'NO_ELIGIBLE_PLAN'
  | 'OUTSIDE_OPENING_HOURS'
  | 'LOCATION_CLOSED'
  | 'PRICING_CONFIGURATION_INVALID'
  | 'UNSUPPORTED_LOCALE'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_OVERFLOW'
  | 'PRICING_CONTEXT_UNAVAILABLE';

export class FlexiblePricingError extends Error {
  readonly code: FlexiblePricingErrorCode;
  constructor(code: FlexiblePricingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FlexiblePricingError';
    this.code = code;
  }
}
