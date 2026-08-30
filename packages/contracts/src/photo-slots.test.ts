import { describe, expect, it } from 'vitest';
import {
  BIKE_PHOTO_SLOTS,
  PHOTO_SLOT_TYPES,
  REQUIRED_BIKE_PHOTO_SLOTS,
  type PhotoSlotType,
} from './photo-slots';

describe('BIKE_PHOTO_SLOTS — Narration désirabilité & confiance', () => {
  it('expose une liste canonique alignée avec toutes les définitions de slots', () => {
    expect(Object.keys(BIKE_PHOTO_SLOTS)).toEqual([...PHOTO_SLOT_TYPES]);
  });

  it('déclare les trois slots canoniques obligatoires du pilote vélo', () => {
    expect([...REQUIRED_BIKE_PHOTO_SLOTS]).toEqual([
      'HERO_PROFILE',
      'THREE_QUARTER_FRONT',
      'SECONDARY_VIEW',
    ]);
  });

  it('définit les trois slots obligatoires de la narration en 3 vues', () => {
    const requiredSlots: PhotoSlotType[] = [
      'HERO_PROFILE',
      'THREE_QUARTER_FRONT',
      'SECONDARY_VIEW',
    ];

    for (const slotType of requiredSlots) {
      const slot = BIKE_PHOTO_SLOTS[slotType];
      expect(slot).toBeDefined();
      expect(slot.required).toBe(true);
      expect(slot.minMediaCount).toBeGreaterThanOrEqual(1);
      expect(slot.checklistItems.length).toBeGreaterThanOrEqual(2);
      expect(slot.guide.animationKey).toBeTruthy();
      expect(slot.guide.overlayKey).toBeTruthy();
      expect(slot.guide.helperHint).toBeTruthy();
    }
  });

  it('définit les slots complémentaires VAE non bloquants', () => {
    const vaeSlots: PhotoSlotType[] = ['BATTERY', 'MOTOR', 'DISPLAY', 'CHARGER'];

    for (const slotType of vaeSlots) {
      const slot = BIKE_PHOTO_SLOTS[slotType];
      expect(slot).toBeDefined();
      expect(slot.required).toBe(false);
      expect(slot.minMediaCount).toBe(0);
      expect(slot.guide.animationKey).toBeTruthy();
      expect(slot.guide.overlayKey).toBeTruthy();
    }
  });

  it('recommande le multi-médias pour la vue libre valorisante (SECONDARY_VIEW)', () => {
    expect(BIKE_PHOTO_SLOTS.SECONDARY_VIEW.multiMediaRecommended).toBe(true);
    expect(BIKE_PHOTO_SLOTS.SECONDARY_VIEW.maxMediaCount).toBe(5);
  });
});
