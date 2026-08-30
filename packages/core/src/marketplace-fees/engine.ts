import { MarketplaceFeeError } from './errors';
import type {
  MarketplaceFeeDeltaSnapshot,
  MarketplaceFeeRule,
  MarketplaceFeeSnapshot,
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
