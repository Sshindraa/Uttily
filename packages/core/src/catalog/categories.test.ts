import { describe, it, expect } from 'vitest';
import { isValidSlug, slugify } from '../identity/slug';

describe('catalog slug validation (réutilise identity/slug)', () => {
  it('slugify produit un slug valide', () => {
    expect(slugify("Paddle Aqua Marina 10'4")).toBe('paddle-aqua-marina-10-4');
    expect(isValidSlug(slugify("Paddle Aqua Marina 10'4"))).toBe(true);
  });

  it('isValidSlug rejette les slugs invalides', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('UPPER')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
    expect(isValidSlug('trailing-')).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
  });

  it('isValidSlug accepte les slugs valides', () => {
    expect(isValidSlug('surf')).toBe(true);
    expect(isValidSlug('paddle-10-4')).toBe(true);
    expect(isValidSlug('ab')).toBe(true);
  });
});
