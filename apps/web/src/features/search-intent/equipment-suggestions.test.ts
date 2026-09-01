import { describe, expect, it } from 'vitest';
import {
  categoryBreadcrumb,
  equipmentFamilies,
  rankEquipmentSuggestions,
} from './equipment-suggestions';

const categories = [
  { id: 'bike', slug: 'bike', name: 'Vélos', parentId: null },
  { id: 'mtb', slug: 'vtt', name: 'VTT', parentId: 'bike' },
  { id: 'emtb', slug: 'vtt-electrique', name: 'VTT électrique', parentId: 'mtb' },
  { id: 'ebike', slug: 'velo-electrique', name: 'Vélo électrique', parentId: 'bike' },
  { id: 'sup', slug: 'paddle', name: 'Paddle', parentId: null },
  { id: 'ski', slug: 'ski', name: 'Ski & Snowboard', parentId: null },
];
describe('deterministic equipment suggestions', () => {
  it.each(['VAE', 'e-bike', 'vélo elec'])('maps %s to an actual electric category', (query) => {
    expect(rankEquipmentSuggestions(categories, query, 'fr').map((c) => c.id)).toEqual(['ebike']);
  });
  it.each(['e-MTB', 'vtt elec'])('understands %s without including ordinary bikes', (query) => {
    expect(rankEquipmentSuggestions(categories, query, 'fr').map((c) => c.id)).toEqual(['emtb']);
  });
  it('supports English aliases and broader exploration without auto-selecting', () => {
    expect(rankEquipmentSuggestions(categories, 'MTB', 'en')[0]?.id).toBe('mtb');
    expect(rankEquipmentSuggestions(categories, 'SUP', 'en')[0]?.id).toBe('sup');
    expect(rankEquipmentSuggestions(categories, 'vtt', 'fr').map((c) => c.id)).toEqual([
      'mtb',
      'emtb',
    ]);
  });
  it('does not invent unavailable electric equipment or broaden a precise request to a parent', () => {
    expect(rankEquipmentSuggestions([categories[0]!], 'VAE', 'fr')).toEqual([]);
    expect(rankEquipmentSuggestions([categories[0]!], 'vtt elec', 'fr')).toEqual([]);
    expect(rankEquipmentSuggestions(categories, 'kayak double', 'fr')).toEqual([]);
  });

  it('expose le ski mais jamais le snowboard via l’ancien libellé de catégorie', () => {
    expect(rankEquipmentSuggestions(categories, 'ski alpin', 'fr').map((c) => c.id)).toEqual([
      'ski',
    ]);
    expect(rankEquipmentSuggestions(categories, 'snowboard', 'fr')).toEqual([]);
  });
  it('uses supplied parents, handles missing parents and terminates on cycles', () => {
    expect(categoryBreadcrumb(categories[2]!, categories, 'fr')).toBe(
      'Vélos › VTT › VTT électrique',
    );
    expect(equipmentFamilies(categories).map((c) => c.id)).toEqual(['bike', 'sup', 'ski']);
    expect(equipmentFamilies([{ ...categories[1]!, parentId: 'missing' }])).toHaveLength(1);
    const cycle = [{ ...categories[0]!, parentId: 'mtb' }, categories[1]!];
    expect(categoryBreadcrumb(cycle[0]!, cycle, 'fr')).toBe('VTT › Vélos');
  });
});
