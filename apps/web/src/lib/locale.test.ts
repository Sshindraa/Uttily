import { describe, expect, it } from 'vitest';
import { getIntlLocale, getLocaleFromPathname } from './locale';

describe('getLocaleFromPathname', () => {
  it('conserve la langue publique portée par le premier segment', () => {
    expect(getLocaleFromPathname('/en/offers/product/location')).toBe('en');
    expect(getLocaleFromPathname('/fr/account/bookings')).toBe('fr');
  });

  it('utilise le français pour les routes sans locale', () => {
    expect(getLocaleFromPathname('/checkout/draft')).toBe('fr');
    expect(getLocaleFromPathname(null)).toBe('fr');
  });

  it('sélectionne une locale Intl cohérente pour les dates et les montants', () => {
    expect(getIntlLocale('fr')).toBe('fr-FR');
    expect(getIntlLocale('en')).toBe('en-GB');
  });
});
