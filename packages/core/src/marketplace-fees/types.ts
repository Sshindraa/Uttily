/** Règle d'arrondi du moteur de frais marketplace. */
export type MarketplaceFeeRoundingRule = 'HALF_UP_PER_COMPONENT';

/** Version publique et fermée des règles de frais marketplace. */
export interface MarketplaceFeeRule {
  readonly ruleVersion: string;
  readonly merchantRateBps: number;
  readonly customerRateBps: number;
  readonly roundingRule: MarketplaceFeeRoundingRule;
  readonly noFixedFee: true;
  readonly uttilyOsMonthlyFeeAmountMinor: 0;
}

/** Snapshot économique immuable d'une transaction marketplace. */
export interface MarketplaceFeeSnapshot {
  readonly ruleVersion: string;
  readonly roundingRule: MarketplaceFeeRoundingRule;
  readonly marketplaceFeeBaseAmountMinor: number;
  readonly merchantRateBps: number;
  readonly merchantFeeAmountMinor: number;
  readonly customerRateBps: number;
  readonly customerServiceFeeAmountMinor: number;
  readonly customerTotalAmountMinor: number;
  readonly merchantNetAmountMinor: number;
  readonly platformApplicationFeeAmountMinor: number;
}

/** Écart entre deux états économiques sous la règle historique d'origine. */
export interface MarketplaceFeeDeltaSnapshot {
  readonly kind: 'FINAL_STATE_DELTA_PER_COMPONENT';
  readonly ruleVersion: string;
  readonly roundingRule: MarketplaceFeeRoundingRule;
  readonly old: MarketplaceFeeSnapshot;
  readonly next: MarketplaceFeeSnapshot;
  readonly marketplaceFeeBaseDeltaAmountMinor: number;
  readonly merchantFeeDeltaAmountMinor: number;
  readonly customerServiceFeeDeltaAmountMinor: number;
  readonly customerTotalDeltaAmountMinor: number;
  readonly merchantNetDeltaAmountMinor: number;
  readonly platformApplicationFeeDeltaAmountMinor: number;
}
