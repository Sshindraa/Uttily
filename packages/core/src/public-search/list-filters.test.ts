import { describe, expect, it } from 'vitest';
import { filterPublicSearchCategories } from './list-filters';

describe('filtrage des catégories publiques', () => {
  it('n’expose que les familles commerciales actives', () => {
    const rows = [
      { id: 'legacy-paddle', slug: 'paddle', name: 'Paddle' },
      { id: 'paddleboard', slug: 'paddleboard', name: 'Paddle' },
      { id: 'pedalboat', slug: 'pedalboat', name: 'Pédalo' },
      { id: 'equipment', slug: 'equipment', name: 'Équipement' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ];

    expect(filterPublicSearchCategories(rows)).toEqual([
      { id: 'paddleboard', slug: 'paddleboard', name: 'Paddle' },
      { id: 'pedalboat', slug: 'pedalboat', name: 'Pédalo' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ]);
  });
});
