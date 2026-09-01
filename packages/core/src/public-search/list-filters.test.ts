import { describe, expect, it } from 'vitest';
import { filterPublicSearchCategories } from './list-filters';

describe('filtrage des catégories publiques', () => {
  it('n’expose pas le paddle historique ni le slug proposé avant activation', () => {
    const rows = [
      { id: 'legacy-paddle', slug: 'paddle', name: 'Paddle' },
      { id: 'proposed-paddle', slug: 'paddleboard', name: 'Paddleboard' },
      { id: 'equipment', slug: 'equipment', name: 'Équipement' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ];

    expect(filterPublicSearchCategories(rows)).toEqual([
      { id: 'equipment', slug: 'equipment', name: 'Équipement' },
      { id: 'kayak', slug: 'kayak', name: 'Kayak' },
    ]);
  });
});
