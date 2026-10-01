import { describe, expect, it } from 'vitest';
import { getPublicCategoryLabel } from './public-search-labels';

describe('getPublicCategoryLabel', () => {
  it('traduit les slugs stables de la taxonomie MVP en anglais', () => {
    expect(getPublicCategoryLabel('en', { slug: 'bike', name: 'Vélos' })).toBe('Bikes');
    expect(getPublicCategoryLabel('en', { slug: 'climbing', name: 'Escalade' })).toBe('Climbing');
    expect(getPublicCategoryLabel('fr', { slug: 'bike', name: 'Vélos' })).toBe('Vélos');
    expect(getPublicCategoryLabel('en', { slug: 'kayak', name: 'Kayaks' })).toBe('Kayak');
    expect(getPublicCategoryLabel('fr', { slug: 'kayak', name: 'Kayaks' })).toBe('Kayak');
    expect(getPublicCategoryLabel('en', { slug: 'canoe', name: 'Canoës' })).toBe('Canoe');
    expect(getPublicCategoryLabel('fr', { slug: 'canoe', name: 'Canoës' })).toBe('Canoë');
    expect(getPublicCategoryLabel('en', { slug: 'pedalboat', name: 'Pédalo' })).toBe('Pedal boat');
    expect(getPublicCategoryLabel('fr', { slug: 'pedalboat', name: 'Pédalo' })).toBe('Pédalo');
    expect(getPublicCategoryLabel('en', { slug: 'bodyboard', name: 'Bodyboard' })).toBe(
      'Bodyboard',
    );
    expect(getPublicCategoryLabel('fr', { slug: 'bodyboard', name: 'Bodyboard' })).toBe(
      'Bodyboard',
    );
    expect(getPublicCategoryLabel('en', { slug: 'wingfoil', name: 'Wingfoil' })).toBe('Wingfoil');
    expect(getPublicCategoryLabel('fr', { slug: 'wingfoil', name: 'Wingfoil' })).toBe('Wingfoil');
    expect(getPublicCategoryLabel('en', { slug: 'ski', name: 'Ski & Snowboard' })).toBe('Ski');
    expect(getPublicCategoryLabel('fr', { slug: 'ski', name: 'Ski & Snowboard' })).toBe('Ski');
    expect(getPublicCategoryLabel('en', { slug: 'snowboard', name: 'Snowboard' })).toBe(
      'Snowboard',
    );
    expect(getPublicCategoryLabel('fr', { slug: 'snowboard', name: 'Snowboard' })).toBe(
      'Snowboard',
    );
    expect(getPublicCategoryLabel('en', { slug: 'snowshoes', name: 'Raquettes' })).toBe(
      'Snowshoes',
    );
    expect(getPublicCategoryLabel('fr', { slug: 'snowshoes', name: 'Snowshoes' })).toBe(
      'Raquettes',
    );
    expect(getPublicCategoryLabel('en', { slug: 'sled', name: 'Luge' })).toBe('Sled');
    expect(getPublicCategoryLabel('fr', { slug: 'sled', name: 'Sled' })).toBe('Luge');
    expect(getPublicCategoryLabel('en', { slug: 'paddleboard', name: 'Paddle' })).toBe(
      'Stand-up paddle',
    );
    expect(getPublicCategoryLabel('fr', { slug: 'paddleboard', name: 'Paddle' })).toBe('Paddle');
  });
});
