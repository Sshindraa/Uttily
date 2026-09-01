import { describe, expect, it } from 'vitest';
import { filterPublicSearchCategories } from './list-filters';

describe('filtrage des catégories publiques', () => {
  it('n’expose pas le slug paddle historique mais expose paddleboard actif', () => {
    const rows = [
      { id: 'legacy-paddle', slug: 'paddle', name: 'Paddle' },
      { id: 'paddleboard', slug: 'paddleboard', name: 'Paddle' },
      { id: 'equipment', slug: 'equipment', name: 'Équipement' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ];

    expect(filterPublicSearchCategories(rows)).toEqual([
      { id: 'paddleboard', slug: 'paddleboard', name: 'Paddle' },
      { id: 'equipment', slug: 'equipment', name: 'Équipement' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ]);
  });
});
