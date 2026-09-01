import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MODES,
  ACCESSORY_STANDALONE_PUBLICATION_DEFAULT,
  CLOSED_OUTDOOR_EQUIPMENT_TAXONOMY,
  EQUIPMENT_FAMILY_REGISTRY,
  EQUIPMENT_UNIVERSE_REGISTRY,
  isCommerciallyActiveEquipmentFamily,
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
      ['surf', 'APPROVED_LATER'],
      ['ski', 'APPROVED_LATER'],
      ['equipment', 'INTERNAL_FALLBACK'],
    ]);
  });

  it('keeps characteristics and subtypes below the family level', () => {
    const bike = resolveEquipmentFamily('bike');
    const kayak = resolveEquipmentFamily('kayak');
    const surf = resolveEquipmentFamily('surf');
    const ski = resolveEquipmentFamily('ski');

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
    expect(surf.kind === 'SUPPORTED' && surf.definition.subtypes).toEqual([
      'classic',
      'longboard',
      'softboard',
    ]);
    expect(ski.kind === 'SUPPORTED' && ski.definition.subtypes).toEqual([
      'alpine',
      'touring',
      'cross-country',
    ]);
  });

  it('rejects unknown families and never treats the internal fallback as commercial', () => {
    expect(resolveEquipmentFamily('camping')).toEqual({ kind: 'UNSUPPORTED', slug: 'camping' });
    expect(resolveEquipmentFamily('BIKE')).toEqual({ kind: 'UNSUPPORTED', slug: 'BIKE' });
    expect(resolveEquipmentFamily(null)).toEqual({ kind: 'UNSUPPORTED', slug: null });
    expect(resolveEquipmentFamily('equipment').kind).toBe('SUPPORTED');
    expect(isCommerciallyActiveEquipmentFamily('bike')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('kayak')).toBe(true);
    expect(isCommerciallyActiveEquipmentFamily('equipment')).toBe(false);
    expect(isCommerciallyActiveEquipmentFamily('unknown')).toBe(false);
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
