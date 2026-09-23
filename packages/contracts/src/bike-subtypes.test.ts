import { describe, expect, it } from 'vitest';
import {
  BIKE_SUBTYPE_DEFINITIONS,
  getBikeSubtypeLabel,
  isBikeSubtype,
  normalizeBikeSubtype,
} from './bike-subtypes';

describe('bike subtype contract', () => {
  it('exposes the four public bike filters in product order', () => {
    expect(BIKE_SUBTYPE_DEFINITIONS.map((definition) => definition.slug)).toEqual([
      'mtb',
      'city',
      'road',
      'cargo',
    ]);
    expect(getBikeSubtypeLabel('fr', 'mtb')).toBe('VTT');
    expect(getBikeSubtypeLabel('fr', 'city')).toBe('Vélo de ville');
    expect(getBikeSubtypeLabel('fr', 'road')).toBe('Vélo de route');
    expect(getBikeSubtypeLabel('fr', 'cargo')).toBe('Vélo cargo');
  });

  it('normalizes common French and English labels without accepting unknown values', () => {
    expect(normalizeBikeSubtype('Vélo de ville')).toBe('city');
    expect(normalizeBikeSubtype('road bike')).toBe('road');
    expect(normalizeBikeSubtype('VTT')).toBe('mtb');
    expect(normalizeBikeSubtype('cargo bicycle')).toBe('cargo');
    expect(isBikeSubtype('gravel')).toBe(false);
  });
});
