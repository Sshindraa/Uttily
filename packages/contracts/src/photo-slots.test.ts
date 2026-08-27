import { describe, expect, it } from 'vitest';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from './photo-slots';

describe('BIKE_PHOTO_SLOTS — Narration désirabilité & confiance', () => {
  it('définit les trois slots obligatoires de la narration en 3 vues', () => {
    const requiredSlots: PhotoSlotType[] = ['HERO_PROFILE', 'THREE_QUARTER', 'SIGNATURE_DETAIL'];

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

  it('recommande le multi-médias pour le détail signature', () => {
    expect(BIKE_PHOTO_SLOTS.SIGNATURE_DETAIL.multiMediaRecommended).toBe(true);
    expect(BIKE_PHOTO_SLOTS.SIGNATURE_DETAIL.maxMediaCount).toBe(5);
  });
});
