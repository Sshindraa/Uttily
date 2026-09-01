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

  it('retombe sur une présentation générique pour toute catégorie inconnue', () => {
    expect(getCategoryPresentation('kayak')).toBe(GENERIC_CATEGORY_PRESENTATION);
    expect(getCategoryPresentation(undefined)).toBe(GENERIC_CATEGORY_PRESENTATION);
  });

  it('n’affiche pas d’attributs qui ne sont pas déclarés par la catégorie', () => {
    const presentation = getCategoryPresentation('equipment');

    expect(
      getDisplayableCharacteristics({ size: 'M', privateNote: 'interne' }, presentation),
    ).toEqual([]);
  });
});
