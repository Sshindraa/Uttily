import type { FinancialTermsConfig, StripeEnvironment } from '@uttily/core';

const BASIS_POINTS = 10_000;

export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
  }
}

/** Résout l'environnement Stripe sans basculer silencieusement en TEST en production. */
export function resolveStripeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): StripeEnvironment {
  const rawValue = environment.STRIPE_ENVIRONMENT;
  if ((rawValue === undefined || rawValue === '') && environment.NODE_ENV === 'production') {
    throw new PaymentConfigurationError(
      'STRIPE_ENVIRONMENT doit être explicitement configuré en production.',
    );
  }

  const value = rawValue === undefined || rawValue === '' ? 'TEST' : rawValue;
  if (value !== 'TEST' && value !== 'LIVE') {
    throw new PaymentConfigurationError('STRIPE_ENVIRONMENT doit valoir TEST ou LIVE.');
  }
  if (value === 'LIVE' && environment.PAYMENTS_LIVE_ENABLED !== 'true') {
    throw new PaymentConfigurationError(
      'STRIPE_ENVIRONMENT=LIVE requiert PAYMENTS_LIVE_ENABLED=true.',
    );
  }
  return value;
}

function parseCommissionRateBps(environment: NodeJS.ProcessEnv): number {
  const rawValue = environment.PLATFORM_COMMISSION_RATE_BPS;
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
    throw new PaymentConfigurationError(
      'PLATFORM_COMMISSION_RATE_BPS doit être configurée explicitement en points de base.',
    );
  }

  const rateBps = Number(rawValue);
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > BASIS_POINTS) {
    throw new PaymentConfigurationError(
      'PLATFORM_COMMISSION_RATE_BPS doit être comprise entre 0 et 10000.',
    );
  }
  return rateBps;
}

/** Arrondi half-up sans multiplication non sûre pour les montants maximums. */
export function calculatePlatformCommissionAmountMinor(
  totalAmountMinor: number,
  rateBps: number,
): number {
  if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor < 0) {
    throw new PaymentConfigurationError('Le total de paiement est invalide.');
  }
  const wholeUnits = Math.floor(totalAmountMinor / BASIS_POINTS);
  const remainder = totalAmountMinor % BASIS_POINTS;
  return wholeUnits * rateBps + Math.floor((remainder * rateBps + 5_000) / BASIS_POINTS);
}

/**
 * Construit les termes financiers depuis la configuration serveur.
 * La commission n'a plus de valeur implicite : même 0 doit être explicitement
 * configuré. Une commission nulle est refusée en LIVE pour éviter qu'un réglage
 * de test ne passe en production par défaut.
 */
export function loadFinancialTermsConfig(
  totalAmountMinor: number,
  environment: NodeJS.ProcessEnv = process.env,
): FinancialTermsConfig {
  const stripeEnvironment = resolveStripeEnvironment(environment);
  const rateBps = parseCommissionRateBps(environment);
  if (stripeEnvironment === 'LIVE' && rateBps === 0) {
    throw new PaymentConfigurationError(
      'Une commission LIVE strictement positive doit être configurée explicitement.',
    );
  }

  const commissionAmountMinor = calculatePlatformCommissionAmountMinor(totalAmountMinor, rateBps);
  return {
    tax: {
      version: 'v1',
      status: 'NOT_APPLICABLE',
      amountMinor: null,
      rateBps: null,
      invoiceIssuer: 'Uttily',
    },
    commission: {
      version: 'v1',
      basis: 'total_amount_minor_percentage',
      amountMinor: commissionAmountMinor,
    },
    connectedAccount: null,
    legalTermsVersion: 'v1',
  };
}
