/** Erreur métier du moteur de frais marketplace. */
export class MarketplaceFeeError extends Error {
  readonly code:
    | 'UNKNOWN_RULE_VERSION'
    | 'INVALID_RULE'
    | 'INVALID_AMOUNT'
    | 'OVERFLOW'
    | 'INVALID_SNAPSHOT'
    | 'INVARIANT_VIOLATION';

  constructor(code: MarketplaceFeeError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MarketplaceFeeError';
    this.code = code;
  }
}
