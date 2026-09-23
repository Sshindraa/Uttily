import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MODES,
  ACCESSORY_STANDALONE_PUBLICATION_DEFAULT,
  CLOSED_OUTDOOR_EQUIPMENT_TAXONOMY,
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  EQUIPMENT_FAMILY_REGISTRY,
  EQUIPMENT_UNIVERSE_REGISTRY,
  PADDLE_CATEGORY_CONTRACT,
  isCommerciallyActiveEquipmentFamily,
  isHistoricalPaddleCategorySlug,
  isPaddleCategorySlug,
  resolveEquipmentFamily,
} from './equipment-taxonomy';

describe('closed outdoor equipment taxonomy', () => {
  it('defines exactly the four closed commercial universes', () => {
    expect(EQUIPMENT_UNIVERSE_REGISTRY).toEqual([
      { slug: 'cycle', label: 'Cycle' },
      { slug: 'paddle', label: 'Kayak, canoë et pagaie' },
      { slug: 'surf', label: 'Surf et glisse nautique' },
      { slug: 'snow', label: 'Neige et glisse' },
    ]);
  });

  it('assigns the locked lifecycle status to every registered family', () => {
    expect(EQUIPMENT_FAMILY_REGISTRY.map(({ slug, status }) => [slug, status])).toEqual([
      ['bike', 'ACTIVE'],
      ['kayak', 'ACTIVE'],
      ['canoe', 'ACTIVE'],
      ['paddleboard', 'ACTIVE'],
      ['pedalboat', 'ACTIVE'],
      ['surf', 'ACTIVE'],
      ['bodyboard', 'ACTIVE'],
      ['wingfoil', 'ACTIVE'],
      ['ski', 'ACTIVE'],
      ['snowboard', 'ACTIVE'],
      ['snowshoes', 'ACTIVE'],
      ['sled', 'ACTIVE'],
      ['equipment', 'INTERNAL_FALLBACK'],
    ]);
  });

  it('exposes exactly the twelve ACTIVE commercial families', () => {
    expect(COMMERCIAL_EQUIPMENT_FAMILY_SLUGS).toEqual([
      'bike',
      'kayak',
      'canoe',
      'paddleboard',
      'pedalboat',
      'surf',
      'bodyboard',
      'wingfoil',
      'ski',
      'snowboard',
      'snowshoes',
      'sled',
    ]);
  });

  it('keeps characteristics and subtypes below the family level', () => {
    const bike = resolveEquipmentFamily('bike');
    const kayak = resolveEquipmentFamily('kayak');
    const canoe = resolveEquipmentFamily('canoe');
    const paddleboard = resolveEquipmentFamily('paddleboard');
    const pedalboat = resolveEquipmentFamily('pedalboat');
    const surf = resolveEquipmentFamily('surf');
    const bodyboard = resolveEquipmentFamily('bodyboard');
    const wingfoil = resolveEquipmentFamily('wingfoil');
    const ski = resolveEquipmentFamily('ski');
    const snowboard = resolveEquipmentFamily('snowboard');
    const snowshoes = resolveEquipmentFamily('snowshoes');
    const sled = resolveEquipmentFamily('sled');

    expect(bike.kind).toBe('SUPPORTED');
    expect(bike.kind === 'SUPPORTED' && bike.definition.subtypes).toEqual([
      'city',
      'vtc',
      'mtb',
      'road',
      'gravel',
      'electric',
      'cargo',
      'child',
      'tandem',
      'fatbike',
    ]);
    expect(kayak.kind === 'SUPPORTED' && kayak.definition.characteristics).toEqual([
      { key: 'capacity' },
      { key: 'construction', allowedValues: ['rigid', 'inflatable'] },
      { key: 'practice', allowedValues: ['sea', 'touring', 'whitewater'] },
    ]);
    expect(canoe.kind).toBe('SUPPORTED');
    expect(canoe.kind === 'SUPPORTED' && canoe.definition.subtypes).toEqual([]);
    expect(canoe.kind === 'SUPPORTED' && canoe.definition.characteristics).toEqual([]);
    expect(paddleboard.kind).toBe('SUPPORTED');
    expect(paddleboard.kind === 'SUPPORTED' && paddleboard.definition.subtypes).toEqual([]);
    expect(paddleboard.kind === 'SUPPORTED' && paddleboard.definition.characteristics).toEqual([
      { key: 'capacity', allowedValues: ['single', 'tandem'] },
      { key: 'construction', allowedValues: ['rigid', 'inflatable'] },
    ]);
    expect(pedalboat.kind === 'SUPPORTED' && pedalboat.definition.subtypes).toEqual([]);
    expect(pedalboat.kind === 'SUPPORTED' && pedalboat.definition.characteristics).toEqual([
      { key: 'capacity' },
    ]);
    expect(surf.kind === 'SUPPORTED' && surf.definition.subtypes).toEqual([
      'classic',
      'longboard',
      'softboard',
      'skimboard',
    ]);
    expect(bodyboard).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({
        slug: 'bodyboard',
        universe: 'surf',
        status: 'ACTIVE',
        singularLabel: 'bodyboard',
        pluralLabel: 'bodyboards',
        subtypes: [],
        characteristics: [],
      }),
    });
    expect(wingfoil).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({
        slug: 'wingfoil',
        universe: 'surf',
        status: 'ACTIVE',
        singularLabel: 'wingfoil',
        pluralLabel: 'wingfoils',
        subtypes: [],
        characteristics: [],
      }),
    });
    expect(ski.kind === 'SUPPORTED' && ski.definition.subtypes).toEqual([
      'alpine',
      'touring',
      'cross-country',
    ]);
    expect(snowboard.kind).toBe('SUPPORTED');
    expect(snowboard.kind === 'SUPPORTED' && snowboard.definition.subtypes).toEqual([]);
    expect(snowboard.kind === 'SUPPORTED' && snowboard.definition.characteristics).toEqual([]);
    expect(snowshoes).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({
        slug: 'snowshoes',
        status: 'ACTIVE',
        singularLabel: 'raquette',
        pluralLabel: 'raquettes',
        subtypes: [],
        characteristics: [],
      }),
    });
    expect(sled).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({
        slug: 'sled',
        status: 'ACTIVE',
        singularLabel: 'luge',
        pluralLabel: 'luges',
        subtypes: [],
        characteristics: [],
      }),
    });
  });

  it('rejects unknown families and never treats the internal fallback as commercial', () => {
    expect(resolveEquipmentFamily('camping')).toEqual({ kind: 'UNSUPPORTED', slug: 'camping' });
    expect(resolveEquipmentFamily('BIKE')).toEqual({ kind: 'UNSUPPORTED', slug: 'BIKE' });
    expect(resolveEquipmentFamily(null)).toEqual({ kind: 'UNSUPPORTED', slug: null });
    expect(resolveEquipmentFamily('equipment').kind).toBe('SUPPORTED');
    expect(isCommerciallyActiveEquipmentFamily('bike')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('kayak')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('canoe')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('paddleboard')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('pedalboat')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('surf')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('bodyboard')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('wingfoil')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('ski')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('snowboard')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('snowshoes')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('sled')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('equipment')).toBe(false);
    expect(isCommerciallyActiveEquipmentFamily('unknown')).toBe(false);
  });

  it('active paddleboard sous un slug canonique et conserve paddle historique', () => {
    expect(PADDLE_CATEGORY_CONTRACT).toEqual({
      canonicalSlug: 'paddleboard',
      status: 'ACTIVE',
      historicalStorageSlugs: ['paddle'],
    });
    expect(resolveEquipmentFamily('paddle')).toEqual({ kind: 'UNSUPPORTED', slug: 'paddle' });
    expect(resolveEquipmentFamily('paddleboard')).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({ slug: 'paddleboard', status: 'ACTIVE' }),
    });
    expect(isHistoricalPaddleCategorySlug('paddle')).toBe(true);
    expect(isHistoricalPaddleCategorySlug('paddleboard')).toBe(false);
    expect(isPaddleCategorySlug('paddle')).toBe(true);
    expect(isPaddleCategorySlug('paddleboard')).toBe(true);
    expect(isPaddleCategorySlug('kayak')).toBe(false);
    expect(isCommerciallyActiveEquipmentFamily('paddle')).toBe(false);
  });

  it('active le pédalo sous un slug unique sans règle spécialisée', () => {
    expect(resolveEquipmentFamily('pedalboat')).toEqual({
      kind: 'SUPPORTED',
      definition: expect.objectContaining({
        slug: 'pedalboat',
        status: 'ACTIVE',
        singularLabel: 'pédalo',
        pluralLabel: 'pédalos',
        subtypes: [],
        characteristics: [{ key: 'capacity' }],
      }),
    });
    expect(COMMERCIAL_EQUIPMENT_FAMILY_SLUGS).toContain('pedalboat');
  });

  it('publishes the future accessory vocabulary without creating an engine', () => {
    expect(ACCESSORY_MODES).toEqual([
      'INCLUDED',
      'MANDATORY',
      'OPTIONAL_FREE',
      'PAID_SUPPLEMENT',
      'SEPARATELY_RENTABLE',
    ]);
    expect(ACCESSORY_STANDALONE_PUBLICATION_DEFAULT).toBe('DISABLED_BY_DEFAULT');
    expect(CLOSED_OUTDOOR_EQUIPMENT_TAXONOMY.families).toBe(EQUIPMENT_FAMILY_REGISTRY);
  });
});
