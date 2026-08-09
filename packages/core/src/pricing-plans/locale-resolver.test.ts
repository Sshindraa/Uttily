import { describe, it, expect } from 'vitest';
import { resolveLocale, getTranslation } from './locale-resolver';
import type { ResolvedTranslation } from './types';
import { FlexiblePricingError } from './errors';

describe('locale-resolver', () => {
  describe('resolveLocale', () => {
    it('exact match: fr → fr', () => {
      expect(resolveLocale('fr', ['fr', 'en'])).toBe('fr');
    });

    it('exact match: en → en', () => {
      expect(resolveLocale('en', ['fr', 'en'])).toBe('en');
    });

    it('regional: fr-FR → fr', () => {
      expect(resolveLocale('fr-FR', ['fr', 'en'])).toBe('fr');
    });

    it('regional: en-GB → en', () => {
      expect(resolveLocale('en-GB', ['fr', 'en'])).toBe('en');
    });

    it('unsupported: de → UNSUPPORTED_LOCALE', () => {
      expect(() => resolveLocale('de', ['fr', 'en'])).toThrow(FlexiblePricingError);
      try {
        resolveLocale('de', ['fr', 'en']);
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('UNSUPPORTED_LOCALE');
      }
    });

    it('no fr fallback for en: en requested but only fr available', () => {
      expect(() => resolveLocale('en', ['fr'])).toThrow(FlexiblePricingError);
      try {
        resolveLocale('en', ['fr']);
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('UNSUPPORTED_LOCALE');
      }
    });

    it('no en fallback for fr: fr requested but only en available', () => {
      expect(() => resolveLocale('fr', ['en'])).toThrow(FlexiblePricingError);
    });

    it('case insensitive: FR → fr', () => {
      expect(resolveLocale('FR', ['fr', 'en'])).toBe('fr');
    });
  });

  describe('getTranslation', () => {
    it('returns label for resolved locale', () => {
      const translations: ResolvedTranslation[] = [
        { pricingPlanId: 'plan-1', locale: 'fr', publicLabel: 'Tarif horaire' },
        { pricingPlanId: 'plan-1', locale: 'en', publicLabel: 'Hourly rate' },
      ];
      expect(getTranslation('plan-1', 'fr', translations)).toBe('Tarif horaire');
      expect(getTranslation('plan-1', 'en', translations)).toBe('Hourly rate');
    });

    it('throws if no translation found', () => {
      const translations: ResolvedTranslation[] = [
        { pricingPlanId: 'plan-1', locale: 'fr', publicLabel: 'Tarif horaire' },
      ];
      expect(() => getTranslation('plan-1', 'en', translations)).toThrow(FlexiblePricingError);
    });
  });
});
