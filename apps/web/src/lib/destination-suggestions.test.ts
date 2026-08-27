import { describe, expect, it } from 'vitest';
import type { PublicSearchDestinationOption } from '@uttily/core';
import {
  destinationDisplayLabel,
  normalizeDestinationQuery,
  rankDestinationSuggestions,
} from './destination-suggestions';

const lyon = destination('lyon', 'Lyon');
const ileDeRe = destination('ile-de-re', 'Île de Ré');
const saintExupery = destination('aeroport-lyon-saint-exupery', 'Aéroport Lyon Saint-Exupéry');

describe('destination suggestions', () => {
  it('normalise les accents, la casse et la ponctuation', () => {
    expect(normalizeDestinationQuery('  ÎLE-de-Ré  ')).toBe('ile de re');
  });

  it('classe une correspondance exacte avant les préfixes et sous-chaînes', () => {
    const result = rankDestinationSuggestions([saintExupery, lyon], 'lyon');

    expect(result.map((item) => item.slug)).toEqual(['lyon', 'aeroport-lyon-saint-exupery']);
  });

  it('retrouve une destination sans imposer les accents', () => {
    expect(rankDestinationSuggestions([lyon, ileDeRe], 'ile de re')).toEqual([ileDeRe]);
  });

  it('conserve l’ordre produit lorsque la saisie est vide et borne les résultats', () => {
    expect(rankDestinationSuggestions([lyon, ileDeRe, saintExupery], '', 2)).toEqual([
      lyon,
      ileDeRe,
    ]);
  });

  it('construit un libellé non ambigu', () => {
    expect(destinationDisplayLabel(lyon)).toBe('Lyon · FR');
  });
});

function destination(slug: string, label: string): PublicSearchDestinationOption {
  return {
    publicId: `00000000-0000-4000-8000-${slug.padEnd(12, '0').slice(0, 12)}`,
    slug,
    label,
    countryCode: 'FR',
    placeType: 'CITY',
    center: { latitude: 45.764, longitude: 4.8357 },
    bbox: { south: 45.7, west: 4.7, north: 45.9, east: 4.95 },
  };
}
