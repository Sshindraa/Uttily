import { describe, expect, it } from 'vitest';
import {
  GENERIC_CATEGORY_PRESENTATION,
  getCategoryDisplayLabel,
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

  it('normalise le libellé historique pluriel du kayak en contexte singulier', () => {
    expect(getCategoryDisplayLabel('kayak', 'Kayaks')).toBe('kayak');
    expect(getCategoryDisplayLabel('kayak', 'Ski & Snowboard')).toBe('kayak');
    expect(getCategoryDisplayLabel('equipment', 'Équipements')).toBe('Équipements');
  });

  it('affiche simple, double et triple et ignore les valeurs nautiques inconnues', () => {
    const presentation = getCategoryPresentation('kayak');

    expect(
      ['simple', 'double', 'triple'].map(
        (capacity) => getDisplayableCharacteristics({ capacity }, presentation)[0],
      ),
    ).toEqual([
      { label: 'Capacité', value: 'simple' },
      { label: 'Capacité', value: 'double' },
      { label: 'Capacité', value: 'triple' },
    ]);
    expect(
      getDisplayableCharacteristics({ construction: 'unknown', practice: 'unknown' }, presentation),
    ).toEqual([]);
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

  it('présente le ski actif avec ses trois sous-types existants, sans règles vélo', () => {
    const presentation = getCategoryPresentation('ski');

    expect(presentation.singularLabel).toBe('ski');
    expect(presentation.pluralLabel).toBe('skis');
    expect(presentation.icon).toBe('🎿');
    expect(presentation.specificSections).toEqual([]);
    expect(getDisplayableCharacteristics({ subtype: 'alpine' }, presentation)).toEqual([
      { label: 'Sous-type', value: 'alpine' },
    ]);
    expect(getDisplayableCharacteristics({ subtype: 'snowboard' }, presentation)).toEqual([]);
  });

  it('présente le snowboard comme une famille neutre sans sous-type inventé', () => {
    const presentation = getCategoryPresentation('snowboard');

    expect(presentation.singularLabel).toBe('snowboard');
    expect(presentation.pluralLabel).toBe('snowboards');
    expect(presentation.icon).toBe('🏂');
    expect(presentation.characteristics).toEqual([]);
    expect(presentation.specificSections).toEqual([]);
    expect(
      getDisplayableCharacteristics({ subtype: 'alpine', level: 'expert' }, presentation),
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
