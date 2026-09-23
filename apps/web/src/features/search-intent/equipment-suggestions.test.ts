import { describe, expect, it } from 'vitest';
import {
  categoryBreadcrumb,
  equipmentFamilies,
  filterEquipmentFamilies,
  getEquipmentTerrain,
  rankBikeSubtypeSuggestions,
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

  it('retrouve le canoë par son slug canonique et son libellé accentué', () => {
    const canoe = { id: 'canoe', slug: 'canoe', name: 'Canoës', parentId: null };

    expect(rankEquipmentSuggestions([canoe], 'canoë', 'fr').map((c) => c.id)).toEqual(['canoe']);
  });

  it('retrouve le bodyboard comme une famille eau distincte du surf', () => {
    const bodyboard = { id: 'bodyboard', slug: 'bodyboard', name: 'Bodyboard', parentId: null };

    expect(getEquipmentTerrain(bodyboard)).toBe('water');
    expect(rankEquipmentSuggestions([bodyboard], 'body board', 'fr').map((c) => c.id)).toEqual([
      'bodyboard',
    ]);
  });

  it('retrouve le wingfoil avec son écriture courante sans élargir à foil seul', () => {
    const wingfoil = { id: 'wingfoil', slug: 'wingfoil', name: 'Wingfoil', parentId: null };

    expect(getEquipmentTerrain(wingfoil)).toBe('water');
    expect(rankEquipmentSuggestions([wingfoil], 'wing foil', 'fr').map((c) => c.id)).toEqual([
      'wingfoil',
    ]);
    expect(rankEquipmentSuggestions([wingfoil], 'foil', 'fr')).toEqual([]);
  });

  it('suggère les quatre sous-types de vélo sans inventer de catégories en base', () => {
    expect(rankBikeSubtypeSuggestions('vélo', 'fr').map((item) => item.subtype)).toEqual([
      'mtb',
      'city',
      'road',
      'cargo',
    ]);
    expect(rankBikeSubtypeSuggestions('VTT', 'fr')[0]).toMatchObject({
      id: 'bike-subtype:mtb',
      subtype: 'mtb',
    });
  });

  it('expose le ski mais jamais le snowboard via l’ancien libellé de catégorie', () => {
    expect(rankEquipmentSuggestions(categories, 'ski alpin', 'fr').map((c) => c.id)).toEqual([
      'ski',
    ]);
    expect(rankEquipmentSuggestions(categories, 'snowboard', 'fr')).toEqual([]);
  });
  it('classe les familles dans les trois terrains de pratique', () => {
    expect(getEquipmentTerrain(categories[0]!)).toBe('land');
    expect(getEquipmentTerrain(categories[4]!)).toBe('water');
    expect(getEquipmentTerrain(categories[5]!)).toBe('snow');
    expect(filterEquipmentFamilies(categories, 'water').map((category) => category.id)).toEqual([
      'sup',
    ]);
  });
  it('classe uniquement les nouvelles familles raquettes et luge sur la neige', () => {
    const snowCategories = [
      { id: 'snowshoes', slug: 'snowshoes', name: 'Raquettes', parentId: null },
      { id: 'sled', slug: 'sled', name: 'Luge', parentId: null },
    ];

    expect(snowCategories.map(getEquipmentTerrain)).toEqual(['snow', 'snow']);
    expect(filterEquipmentFamilies(snowCategories, 'snow').map((c) => c.id)).toEqual([
      'snowshoes',
      'sled',
    ]);
    expect(filterEquipmentFamilies(snowCategories, 'water')).toEqual([]);
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
