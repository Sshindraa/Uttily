import { MarketplaceFeeError } from './errors';
import type {
  MarketplaceFeeDeltaSnapshot,
  MarketplaceFeeRule,
  MarketplaceFeeSnapshot,
  SplitCancellationRefundAllocation,
} from './types';

export const MARKETPLACE_FEE_RULE_VERSION = 'split-13-7-v1';
export const MARKETPLACE_FEE_ROUNDING_RULE = 'HALF_UP_PER_COMPONENT' as const;
export const MERCHANT_FEE_RATE_BPS = 1300;
export const CUSTOMER_SERVICE_FEE_RATE_BPS = 700;
export const MARKETPLACE_FEE_MAX_RATE_BPS = 10_000;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const RULES: Readonly<Record<string, MarketplaceFeeRule>> = Object.freeze({
  [MARKETPLACE_FEE_RULE_VERSION]: Object.freeze({
    ruleVersion: MARKETPLACE_FEE_RULE_VERSION,
    merchantRateBps: MERCHANT_FEE_RATE_BPS,
    customerRateBps: CUSTOMER_SERVICE_FEE_RATE_BPS,
    roundingRule: MARKETPLACE_FEE_ROUNDING_RULE,
    noFixedFee: true,
    uttilyOsMonthlyFeeAmountMinor: 0,
  }),
});

function assertSafeMinorAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketplaceFeeError(
      'INVALID_AMOUNT',
      `${label} doit être un entier safe non négatif (reçu : ${value}).`,
    );
  }
}

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) {
    throw new MarketplaceFeeError(
      'OVERFLOW',
      `${label} dépasse Number.MAX_SAFE_INTEGER ou devient négatif.`,
    );
  }
  return Number(value);
}

/** Arrondi HALF_UP d'une base en unités mineures et d'un taux en bps. */
export function roundHalfUpPerComponent(baseAmountMinor: number, rateBps: number): number {
  assertSafeMinorAmount(baseAmountMinor, 'baseAmountMinor');
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > MARKETPLACE_FEE_MAX_RATE_BPS) {
    throw new MarketplaceFeeError('INVALID_RULE', `rateBps invalide (reçu : ${rateBps}).`);
  }

  const numerator = BigInt(baseAmountMinor) * BigInt(rateBps);
  return toSafeNumber((numerator + 5_000n) / 10_000n, 'frais calculé');
}

/** Résout une règle exclusivement depuis le registre serveur fermé. */
export function resolveMarketplaceFeeRule(
  ruleVersion = MARKETPLACE_FEE_RULE_VERSION,
): MarketplaceFeeRule {
  const rule = RULES[ruleVersion];
  if (!rule) {
    throw new MarketplaceFeeError(
      'UNKNOWN_RULE_VERSION',
      `Version de règle marketplace inconnue : ${ruleVersion}.`,
    );
  }
  return { ...rule };
}

export function calculateMarketplaceFeeSnapshot(input: {
  marketplaceFeeBaseAmountMinor: number;
  ruleVersion?: string;
}): MarketplaceFeeSnapshot {
  assertSafeMinorAmount(input.marketplaceFeeBaseAmountMinor, 'marketplaceFeeBaseAmountMinor');
  const rule = resolveMarketplaceFeeRule(input.ruleVersion);

  const merchantFeeAmountMinor = roundHalfUpPerComponent(
    input.marketplaceFeeBaseAmountMinor,
    rule.merchantRateBps,
  );
  const customerServiceFeeAmountMinor = roundHalfUpPerComponent(
    input.marketplaceFeeBaseAmountMinor,
    rule.customerRateBps,
  );
  const base = BigInt(input.marketplaceFeeBaseAmountMinor);
  const merchantFee = BigInt(merchantFeeAmountMinor);
  const customerFee = BigInt(customerServiceFeeAmountMinor);
  const customerTotalAmountMinor = toSafeNumber(base + customerFee, 'customerTotalAmountMinor');
  const merchantNetAmountMinor = toSafeNumber(base - merchantFee, 'merchantNetAmountMinor');
  const platformApplicationFeeAmountMinor = toSafeNumber(
    merchantFee + customerFee,
    'platformApplicationFeeAmountMinor',
  );

  if (
    BigInt(customerTotalAmountMinor) - BigInt(platformApplicationFeeAmountMinor) !==
    BigInt(merchantNetAmountMinor)
  ) {
    throw new MarketplaceFeeError(
      'INVARIANT_VIOLATION',
      'Le snapshot marketplace ne respecte pas customerTotal - applicationFee = merchantNet.',
    );
  }

  return Object.freeze({
    ruleVersion: rule.ruleVersion,
    roundingRule: rule.roundingRule,
    marketplaceFeeBaseAmountMinor: input.marketplaceFeeBaseAmountMinor,
    merchantRateBps: rule.merchantRateBps,
    merchantFeeAmountMinor,
    customerRateBps: rule.customerRateBps,
    customerServiceFeeAmountMinor,
    customerTotalAmountMinor,
    merchantNetAmountMinor,
    platformApplicationFeeAmountMinor,
  });
}

export function calculateMarketplaceFeeSnapshotFromPricing(input: {
  subtotalAmountMinor: number;
  mandatoryFeesAmountMinor: number;
  ruleVersion?: string;
}): MarketplaceFeeSnapshot {
  assertSafeMinorAmount(input.subtotalAmountMinor, 'subtotalAmountMinor');
  assertSafeMinorAmount(input.mandatoryFeesAmountMinor, 'mandatoryFeesAmountMinor');
  const base = BigInt(input.subtotalAmountMinor) + BigInt(input.mandatoryFeesAmountMinor);
  return calculateMarketplaceFeeSnapshot(
    input.ruleVersion === undefined
      ? { marketplaceFeeBaseAmountMinor: toSafeNumber(base, 'marketplaceFeeBaseAmountMinor') }
      : {
          marketplaceFeeBaseAmountMinor: toSafeNumber(base, 'marketplaceFeeBaseAmountMinor'),
          ruleVersion: input.ruleVersion,
        },
  );
}

function subtract(a: number, b: number, label: string): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new MarketplaceFeeError('INVALID_AMOUNT', `${label} doit rester un entier safe.`);
  }
  const result = BigInt(a) - BigInt(b);
  if (result < -MAX_SAFE_INTEGER_BIGINT || result > MAX_SAFE_INTEGER_BIGINT) {
    throw new MarketplaceFeeError('OVERFLOW', `${label} dépasse Number.MAX_SAFE_INTEGER.`);
  }
  return Number(result);
}

/** Calcule le delta en soustrayant les deux états finaux composant par composant. */
export function calculateMarketplaceFeeDelta(input: {
  oldBaseAmountMinor: number;
  nextBaseAmountMinor: number;
  ruleVersion: string;
}): MarketplaceFeeDeltaSnapshot {
  const old = calculateMarketplaceFeeSnapshot({
    marketplaceFeeBaseAmountMinor: input.oldBaseAmountMinor,
    ruleVersion: input.ruleVersion,
  });
  const next = calculateMarketplaceFeeSnapshot({
    marketplaceFeeBaseAmountMinor: input.nextBaseAmountMinor,
    ruleVersion: input.ruleVersion,
  });
  const delta = Object.freeze({
    kind: 'FINAL_STATE_DELTA_PER_COMPONENT' as const,
    ruleVersion: old.ruleVersion,
    roundingRule: old.roundingRule,
    old,
    next,
    marketplaceFeeBaseDeltaAmountMinor: subtract(
      next.marketplaceFeeBaseAmountMinor,
      old.marketplaceFeeBaseAmountMinor,
      'marketplaceFeeBaseDeltaAmountMinor',
    ),
    merchantFeeDeltaAmountMinor: subtract(
      next.merchantFeeAmountMinor,
      old.merchantFeeAmountMinor,
      'merchantFeeDeltaAmountMinor',
    ),
    customerServiceFeeDeltaAmountMinor: subtract(
      next.customerServiceFeeAmountMinor,
      old.customerServiceFeeAmountMinor,
      'customerServiceFeeDeltaAmountMinor',
    ),
    customerTotalDeltaAmountMinor: subtract(
      next.customerTotalAmountMinor,
      old.customerTotalAmountMinor,
      'customerTotalDeltaAmountMinor',
    ),
    merchantNetDeltaAmountMinor: subtract(
      next.merchantNetAmountMinor,
      old.merchantNetAmountMinor,
      'merchantNetDeltaAmountMinor',
    ),
    platformApplicationFeeDeltaAmountMinor: subtract(
      next.platformApplicationFeeAmountMinor,
      old.platformApplicationFeeAmountMinor,
      'platformApplicationFeeDeltaAmountMinor',
    ),
  });

  if (
    delta.platformApplicationFeeDeltaAmountMinor !==
    delta.merchantFeeDeltaAmountMinor + delta.customerServiceFeeDeltaAmountMinor
  ) {
    throw new MarketplaceFeeError(
      'INVARIANT_VIOLATION',
      'Le delta application fee ne correspond pas à la somme des deltas de composants.',
    );
  }
  return delta;
}

function readSnapshotInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', `${field} doit être un entier safe positif.`);
  }
  return value;
}

/** Valide un snapshot chargé depuis JSON avant toute utilisation financière. */
export function parseMarketplaceFeeSnapshot(value: unknown): MarketplaceFeeSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Snapshot marketplace absent ou invalide.');
  }
  const candidate = value as Record<string, unknown>;
  const ruleVersion = candidate.ruleVersion;
  const roundingRule = candidate.roundingRule;
  if (typeof ruleVersion !== 'string' || typeof roundingRule !== 'string') {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Version/règle du snapshot manquante.');
  }
  const rule = resolveMarketplaceFeeRule(ruleVersion);
  if (roundingRule !== rule.roundingRule) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Règle d’arrondi du snapshot invalide.');
  }
  const snapshot = calculateMarketplaceFeeSnapshot({
    marketplaceFeeBaseAmountMinor: readSnapshotInteger(
      candidate.marketplaceFeeBaseAmountMinor,
      'marketplaceFeeBaseAmountMinor',
    ),
    ruleVersion,
  });
  const fields: Array<keyof MarketplaceFeeSnapshot> = [
    'merchantRateBps',
    'merchantFeeAmountMinor',
    'customerRateBps',
    'customerServiceFeeAmountMinor',
    'customerTotalAmountMinor',
    'merchantNetAmountMinor',
    'platformApplicationFeeAmountMinor',
  ];
  for (const field of fields) {
    const candidateValue = candidate[field];
    if (typeof candidateValue !== 'number' || !Number.isSafeInteger(candidateValue)) {
      throw new MarketplaceFeeError('INVALID_SNAPSHOT', `${field} doit être un entier safe.`);
    }
    if (candidateValue !== snapshot[field]) {
      throw new MarketplaceFeeError('INVALID_SNAPSHOT', `${field} ne correspond pas à la règle.`);
    }
  }
  return snapshot;
}

function readSnapshotSignedInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', `${field} doit être un entier safe signé.`);
  }
  return value;
}

/** Valide le snapshot final-state delta persisté sur un amendement. */
export function parseMarketplaceFeeDeltaSnapshot(value: unknown): MarketplaceFeeDeltaSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Snapshot delta marketplace invalide.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'FINAL_STATE_DELTA_PER_COMPONENT' ||
    typeof candidate.ruleVersion !== 'string' ||
    candidate.roundingRule !== MARKETPLACE_FEE_ROUNDING_RULE
  ) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Discriminateur du snapshot delta invalide.');
  }
  const old = parseMarketplaceFeeSnapshot(candidate.old);
  const next = parseMarketplaceFeeSnapshot(candidate.next);
  if (old.ruleVersion !== candidate.ruleVersion || next.ruleVersion !== candidate.ruleVersion) {
    throw new MarketplaceFeeError('INVALID_SNAPSHOT', 'Version divergente dans le snapshot delta.');
  }
  const expected = calculateMarketplaceFeeDelta({
    oldBaseAmountMinor: old.marketplaceFeeBaseAmountMinor,
    nextBaseAmountMinor: next.marketplaceFeeBaseAmountMinor,
    ruleVersion: old.ruleVersion,
  });
  const fields: Array<keyof MarketplaceFeeDeltaSnapshot> = [
    'marketplaceFeeBaseDeltaAmountMinor',
    'merchantFeeDeltaAmountMinor',
    'customerServiceFeeDeltaAmountMinor',
    'customerTotalDeltaAmountMinor',
    'merchantNetDeltaAmountMinor',
    'platformApplicationFeeDeltaAmountMinor',
  ];
  for (const field of fields) {
    if (readSnapshotSignedInteger(candidate[field], field) !== expected[field]) {
      throw new MarketplaceFeeError(
        'INVALID_SNAPSHOT',
        `${field} ne correspond pas aux états finaux.`,
      );
    }
  }
  return expected;
}

/**
 * Calcule la répartition financière composant par composant d'une annulation
 * sous le modèle split 13/7 conformément à ADR-030.
 *
 * Invariants économiques préservés au centime près :
 * - customerRefundAmountMinor = merchantClawbackAmountMinor + platformFeeRefundedMinor
 * - oldSnapshot.customerTotalAmountMinor = customerRefundAmountMinor + customerRetainedAmountMinor
 * - oldSnapshot.merchantNetAmountMinor = merchantClawbackAmountMinor + finalMerchantRevenueMinor
 * - oldSnapshot.platformApplicationFeeAmountMinor = platformFeeRefundedMinor + finalPlatformFeeMinor
 */
export function calculateSplitCancellationRefund(input: {
  oldSnapshot: MarketplaceFeeSnapshot;
  refundPercentage: number;
}): SplitCancellationRefundAllocation {
  const { oldSnapshot, refundPercentage } = input;
  if (!Number.isSafeInteger(refundPercentage) || refundPercentage < 0 || refundPercentage > 100) {
    throw new MarketplaceFeeError(
      'INVALID_AMOUNT',
      `refundPercentage doit être un entier entre 0 et 100 (reçu : ${refundPercentage}).`,
    );
  }

  // Cas 100% de remboursement : base résiduelle = 0
  if (refundPercentage === 100) {
    const delta = calculateMarketplaceFeeDelta({
      oldBaseAmountMinor: oldSnapshot.marketplaceFeeBaseAmountMinor,
      nextBaseAmountMinor: 0,
      ruleVersion: oldSnapshot.ruleVersion,
    });

    return Object.freeze({
      refundPercentage: 100,
      customerRefundAmountMinor: oldSnapshot.customerTotalAmountMinor,
      customerRetainedAmountMinor: 0,
      merchantClawbackAmountMinor: oldSnapshot.merchantNetAmountMinor,
      finalMerchantRevenueMinor: 0,
      platformFeeRefundedMinor: oldSnapshot.platformApplicationFeeAmountMinor,
      finalPlatformFeeMinor: 0,
      deltaSnapshot: delta,
    });
  }

  // Cas 0% de remboursement : aucune restitution, base résiduelle = base initiale
  if (refundPercentage === 0) {
    const delta = calculateMarketplaceFeeDelta({
      oldBaseAmountMinor: oldSnapshot.marketplaceFeeBaseAmountMinor,
      nextBaseAmountMinor: oldSnapshot.marketplaceFeeBaseAmountMinor,
      ruleVersion: oldSnapshot.ruleVersion,
    });

    return Object.freeze({
      refundPercentage: 0,
      customerRefundAmountMinor: 0,
      customerRetainedAmountMinor: oldSnapshot.customerTotalAmountMinor,
      merchantClawbackAmountMinor: 0,
      finalMerchantRevenueMinor: oldSnapshot.merchantNetAmountMinor,
      platformFeeRefundedMinor: 0,
      finalPlatformFeeMinor: oldSnapshot.platformApplicationFeeAmountMinor,
      deltaSnapshot: delta,
    });
  }

  // Cas remboursement partiel (ex: 50%) :
  // Le taux de base conservée est (100 - refundPercentage) en bps: (100 - P) * 100
  // La base résiduelle conservée est calculée avec arrondi HALF_UP
  const retainedBaseBps = (100 - refundPercentage) * 100;
  const nextBaseAmountMinor = roundHalfUpPerComponent(
    oldSnapshot.marketplaceFeeBaseAmountMinor,
    retainedBaseBps,
  );

  const delta = calculateMarketplaceFeeDelta({
    oldBaseAmountMinor: oldSnapshot.marketplaceFeeBaseAmountMinor,
    nextBaseAmountMinor,
    ruleVersion: oldSnapshot.ruleVersion,
  });

  const customerRefundAmountMinor = -delta.customerTotalDeltaAmountMinor;
  const customerRetainedAmountMinor = delta.next.customerTotalAmountMinor;
  const merchantClawbackAmountMinor = -delta.merchantNetDeltaAmountMinor;
  const finalMerchantRevenueMinor = delta.next.merchantNetAmountMinor;
  const platformFeeRefundedMinor = -delta.platformApplicationFeeDeltaAmountMinor;
  const finalPlatformFeeMinor = delta.next.platformApplicationFeeAmountMinor;

  // Contrôle strict des invariants économiques
  if (customerRefundAmountMinor !== merchantClawbackAmountMinor + platformFeeRefundedMinor) {
    throw new MarketplaceFeeError(
      'INVARIANT_VIOLATION',
      'Le remboursement client split ne correspond pas à la somme de la reprise loueur et de la restitution plateforme.',
    );
  }

  if (
    oldSnapshot.customerTotalAmountMinor !==
    customerRefundAmountMinor + customerRetainedAmountMinor
  ) {
    throw new MarketplaceFeeError(
      'INVARIANT_VIOLATION',
      'La somme remboursée et retenue ne correspond pas au total client initial.',
    );
  }

  return Object.freeze({
    refundPercentage,
    customerRefundAmountMinor,
    customerRetainedAmountMinor,
    merchantClawbackAmountMinor,
    finalMerchantRevenueMinor,
    platformFeeRefundedMinor,
    finalPlatformFeeMinor,
    deltaSnapshot: delta,
  });
}
