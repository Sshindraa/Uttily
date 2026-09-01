import { describe, expect, it } from 'vitest';
import { buildControlledDuplicateSlug } from './duplicate-product';

describe('duplication contrôlée — slugs', () => {
  it('génère une suite déterministe de slugs lisibles', () => {
    expect(buildControlledDuplicateSlug('kayak-randonnee', 1)).toBe('kayak-randonnee-copy');
    expect(buildControlledDuplicateSlug('kayak-randonnee', 2)).toBe('kayak-randonnee-copy-2');
  });

  it('préserve la limite de slug avec un suffixe de copie', () => {
    const slug = buildControlledDuplicateSlug('a'.repeat(60), 12);

    expect(slug).toBe('a'.repeat(52) + '-copy-12');
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('refuse un numéro de copie invalide', () => {
    expect(() => buildControlledDuplicateSlug('kayak', 0)).toThrow('positif');
  });
});
