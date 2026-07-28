import { describe, it, expect } from 'vitest';
import { isValidSlug, slugify } from './slug';

describe('slug', () => {
  describe('isValidSlug', () => {
    it('accepte les slugs valides', () => {
      expect(isValidSlug('hossegor-surf')).toBe(true);
      expect(isValidSlug('capbreton')).toBe(true);
      expect(isValidSlug('shop-1')).toBe(true);
    });

    it('rejette les slugs invalides', () => {
      expect(isValidSlug('Hossegor')).toBe(false); // majuscules
      expect(isValidSlug('hossegor_')).toBe(false); // underscore
      expect(isValidSlug('-hossegor')).toBe(false); // tiret initial
      expect(isValidSlug('hossegor--surf')).toBe(false); // double tiret
      expect(isValidSlug('a')).toBe(false); // trop court
      expect(isValidSlug('')).toBe(false);
      expect(isValidSlug('HOSSEGOR')).toBe(false);
    });
  });

  describe('slugify', () => {
    it('normalise une chaîne avec accents', () => {
      expect(slugify('Hossegor Surf')).toBe('hossegor-surf');
      expect(slugify('Café de la Plage')).toBe('cafe-de-la-plage');
      expect(slugify('  Spécial  ')).toBe('special');
    });

    it('remplace les caractères non alphanumériques', () => {
      expect(slugify('shop 1!')).toBe('shop-1');
    });
  });
});
