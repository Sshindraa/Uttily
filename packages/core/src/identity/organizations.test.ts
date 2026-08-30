import { describe, expect, it } from 'vitest';
import { MVP_ORGANIZATION_CURRENCY, normalizeMvpOrganizationCurrency } from './organizations';

describe('organisation currency in the MVP', () => {
  it('normalizes the only supported currency', () => {
    expect(MVP_ORGANIZATION_CURRENCY).toBe('EUR');
    expect(normalizeMvpOrganizationCurrency(' eur ')).toBe('EUR');
    expect(normalizeMvpOrganizationCurrency()).toBe('EUR');
  });

  it('rejects a currency that the public booking and payment flows cannot handle', () => {
    expect(() => normalizeMvpOrganizationCurrency('USD')).toThrow('EUR');
    expect(() => normalizeMvpOrganizationCurrency('EUROPE')).toThrow('EUR');
  });
});
