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
    expect(getPublicCategoryLabel('en', { slug: 'ski', name: 'Ski & Snowboard' })).toBe('Ski');
    expect(getPublicCategoryLabel('fr', { slug: 'ski', name: 'Ski & Snowboard' })).toBe('Ski');
    expect(getPublicCategoryLabel('en', { slug: 'snowboard', name: 'Snowboard' })).toBe(
      'Snowboard',
    );
    expect(getPublicCategoryLabel('fr', { slug: 'snowboard', name: 'Snowboard' })).toBe(
      'Snowboard',
    );
  });
});
