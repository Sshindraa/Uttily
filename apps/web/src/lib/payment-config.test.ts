import { describe, expect, it } from 'vitest';
import {
  calculatePlatformCommissionAmountMinor,
  loadFinancialTermsConfig,
  resolveStripeEnvironment,
} from './payment-config';

function environment(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe('resolveStripeEnvironment', () => {
  it('utilise TEST par défaut hors production', () => {
    expect(resolveStripeEnvironment(environment({ NODE_ENV: 'test' }))).toBe('TEST');
  });

  it('refuse un environnement Stripe implicite en production', () => {
    expect(() => resolveStripeEnvironment(environment({ NODE_ENV: 'production' }))).toThrow(
      /explicitement configuré/,
    );
  });

  it('refuse LIVE sans le verrou d activation explicite', () => {
    expect(() =>
      resolveStripeEnvironment(
        environment({
          NODE_ENV: 'test',
          STRIPE_ENVIRONMENT: 'LIVE',
          PAYMENTS_LIVE_ENABLED: 'false',
        }),
      ),
    ).toThrow(/PAYMENTS_LIVE_ENABLED/);
    expect(
      resolveStripeEnvironment(
        environment({
          NODE_ENV: 'test',
          STRIPE_ENVIRONMENT: 'LIVE',
          PAYMENTS_LIVE_ENABLED: 'true',
        }),
      ),
    ).toBe('LIVE');
  });
});

describe('loadFinancialTermsConfig', () => {
  const testEnvironment = environment({
    NODE_ENV: 'test',
    STRIPE_ENVIRONMENT: 'TEST',
  });

  it('ne lit aucun taux de commission depuis la configuration serveur', () => {
    const terms = loadFinancialTermsConfig(12_000, testEnvironment);

    expect(terms.commission).toBeNull();
  });

  it('ignore une ancienne variable de taux si elle existe encore dans l’environnement', () => {
    const terms = loadFinancialTermsConfig(
      12_000,
      environment({
        ...testEnvironment,
        PLATFORM_COMMISSION_RATE_BPS: '1000',
      }),
    );

    expect(terms.commission).toBeNull();
  });

  it('arrondit la commission en half-up', () => {
    expect(calculatePlatformCommissionAmountMinor(101, 50)).toBe(1);
  });
});
