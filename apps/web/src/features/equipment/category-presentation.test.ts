import { describe, expect, it } from 'vitest';
import {
  GENERIC_CATEGORY_PRESENTATION,
  getCategoryPresentation,
  getDisplayableCharacteristics,
} from './category-presentation';

describe('registre de présentation des catégories', () => {
  it('conserve les extensions approfondies du vélo', () => {
    const presentation = getCategoryPresentation('bike');

    expect(presentation.singularLabel).toBe('vélo');
    expect(presentation.pluralLabel).toBe('vélos');
    expect(presentation.specificSections).toEqual(['photo-slots', 'safety']);
    expect(getDisplayableCharacteristics({ size: 'M', autonomy: '70 km' }, presentation)).toEqual([
      { label: 'Taille', value: 'M' },
      { label: 'Autonomie', value: '70 km' },
    ]);
  });

  it('présente la catégorie equipment déjà portée par les données', () => {
    const presentation = getCategoryPresentation('equipment');

    expect(presentation.singularLabel).toBe('équipement');
    expect(presentation.pluralLabel).toBe('équipements');
    expect(presentation.specificSections).toEqual([]);
  });

  it('présente le kayak avec ses caractéristiques disponibles et sans règles vélo', () => {
    const presentation = getCategoryPresentation('kayak');

    expect(presentation.singularLabel).toBe('kayak');
    expect(presentation.pluralLabel).toBe('kayaks');
    expect(presentation.specificSections).toEqual([]);
    expect(
      getDisplayableCharacteristics(
        { capacity: 'double', construction: 'inflatable', practice: 'touring' },
        presentation,
      ),
    ).toEqual([
      { label: 'Capacité', value: 'double' },
      { label: 'Construction', value: 'inflatable' },
      { label: 'Pratique', value: 'touring' },
    ]);
  });

  it('présente le socle surf sans Photo Coach ni champ spécialisé inventé', () => {
    const presentation = getCategoryPresentation('surf');

    expect(presentation.singularLabel).toBe('planche de surf');
    expect(presentation.pluralLabel).toBe('planches de surf');
    expect(presentation.icon).toBe('🏄');
    expect(presentation.specificSections).toEqual([]);
    expect(
      getDisplayableCharacteristics(
        { dimensions: '8 ft', volume: '60 L', level: 'débutant', subtype: 'longboard' },
        presentation,
      ),
    ).toEqual([]);
  });

  it('retombe sur une présentation générique pour toute catégorie inconnue', () => {
    expect(getCategoryPresentation('canoe')).toBe(GENERIC_CATEGORY_PRESENTATION);
    expect(getCategoryPresentation(undefined)).toBe(GENERIC_CATEGORY_PRESENTATION);
  });

  it('n’affiche pas d’attributs qui ne sont pas déclarés par la catégorie', () => {
    const presentation = getCategoryPresentation('equipment');

    expect(
      getDisplayableCharacteristics({ size: 'M', privateNote: 'interne' }, presentation),
    ).toEqual([]);
  });
});
