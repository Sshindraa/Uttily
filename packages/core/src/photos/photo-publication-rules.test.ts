import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BIKE_PHOTO_SLOTS,
  missingRequiredBikePhotoSlots,
} from './photo-publication-rules';

describe('photo publication rules', () => {
  it('retourne les slots vélo manquants dans l’ordre canonique', () => {
    expect(missingRequiredBikePhotoSlots('bike', new Set(['HERO_PROFILE', 'FULL_BIKE']))).toEqual([
      'THREE_QUARTER_FRONT',
      'SECONDARY_VIEW',
    ]);
  });

  it('considère un vélo complet comme prêt', () => {
    expect(missingRequiredBikePhotoSlots('bike', new Set(REQUIRED_BIKE_PHOTO_SLOTS))).toEqual([]);
  });

  it('ne force pas encore de slots pour les autres catégories', () => {
    expect(missingRequiredBikePhotoSlots('surf', new Set())).toEqual([]);
  });
});
