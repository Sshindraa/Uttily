import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as homeOptions from './home-search-options';
import { compileSearchIntentAction } from './intent-search';

vi.mock('./home-search-options', () => ({
  loadHomeSearchOptions: vi.fn(),
}));

describe('compileSearchIntentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejette une requête vide', async () => {
    const res = await compileSearchIntentAction('   ');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('décrire votre projet');
    }
  });

  it('rejette une requête dépassant 500 caractères', async () => {
    const longQuery = 'a'.repeat(501);
    const res = await compileSearchIntentAction(longQuery);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('500 caractères');
    }
  });

  it('compile une intention avec succès en fournissant les options de destination', async () => {
    vi.mocked(homeOptions.loadHomeSearchOptions).mockResolvedValue({
      destinations: [
        {
          publicId: 'dest-annecy',
          slug: 'annecy',
          label: 'Annecy',
          countryCode: 'FR',
          placeType: 'city',
          center: { latitude: 45.9, longitude: 6.1 },
          bbox: { south: 45.8, west: 6.0, north: 46.0, east: 6.2 },
        },
      ],
      categories: [
        {
          id: 'cat-bike',
          slug: 'bike',
          name: 'Vélo',
        },
      ],
    });

    const res = await compileSearchIntentAction('2 vélos électriques à Annecy ce samedi', 'fr');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.destination.value).toBe('Annecy');
      expect(res.data.destinationPublicId.value).toBe('dest-annecy');
      expect(res.data.peopleCount.value).toBe(2);
      expect(res.data.dates.value?.mode).toBe('DAY_RANGE');
    }
  });

  it('gère les erreurs et retourne un code UNKNOWN propre', async () => {
    vi.mocked(homeOptions.loadHomeSearchOptions).mockRejectedValue(
      new Error('Erreur base de données mockée'),
    );

    const res = await compileSearchIntentAction('test Annecy');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNKNOWN');
      expect(res.message).toContain('Erreur base de données mockée');
    }
  });
});
