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
    PLATFORM_COMMISSION_RATE_BPS: '1000',
  });

  it('calcule la commission depuis la configuration serveur', () => {
    const terms = loadFinancialTermsConfig(12_000, testEnvironment);

    expect(terms.commission).toEqual({
      version: 'v1',
      basis: 'total_amount_minor_percentage',
      amountMinor: 1_200,
    });
  });

  it('accepte une commission nulle uniquement lorsqu elle est explicite en TEST', () => {
    const terms = loadFinancialTermsConfig(
      12_000,
      environment({
        ...testEnvironment,
        PLATFORM_COMMISSION_RATE_BPS: '0',
      }),
    );

    expect(terms.commission?.amountMinor).toBe(0);
  });

  it('refuse une commission absente, invalide ou nulle en LIVE', () => {
    expect(() => loadFinancialTermsConfig(12_000, testEnvironmentWithoutCommission())).toThrow(
      /PLATFORM_COMMISSION_RATE_BPS/,
    );
    expect(() =>
      loadFinancialTermsConfig(
        12_000,
        environment({
          ...testEnvironment,
          PLATFORM_COMMISSION_RATE_BPS: '10001',
        }),
      ),
    ).toThrow(/entre 0 et 10000/);
    expect(() =>
      loadFinancialTermsConfig(
        12_000,
        environment({
          ...testEnvironment,
          STRIPE_ENVIRONMENT: 'LIVE',
          PAYMENTS_LIVE_ENABLED: 'true',
          PLATFORM_COMMISSION_RATE_BPS: '0',
        }),
      ),
    ).toThrow(/strictement positive/);
  });

  it('arrondit la commission en half-up', () => {
    expect(calculatePlatformCommissionAmountMinor(101, 50)).toBe(1);
  });
});

function testEnvironmentWithoutCommission(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    STRIPE_ENVIRONMENT: 'TEST',
  };
}
