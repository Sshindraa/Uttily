import { describe, expect, it } from 'vitest';
import { DEFAULT_STRIPE_COUNTRY, STRIPE_SUPPORTED_COUNTRIES } from './supported-stripe-countries';

describe('Stripe supported countries', () => {
  it('expose une liste unique, non vide et un pays par défaut autorisé', () => {
    expect(STRIPE_SUPPORTED_COUNTRIES.length).toBeGreaterThan(0);
    expect(new Set(STRIPE_SUPPORTED_COUNTRIES.map((country) => country.code)).size).toBe(
      STRIPE_SUPPORTED_COUNTRIES.length,
    );
    expect(
      STRIPE_SUPPORTED_COUNTRIES.some((country) => country.code === DEFAULT_STRIPE_COUNTRY),
    ).toBe(true);
  });
});
