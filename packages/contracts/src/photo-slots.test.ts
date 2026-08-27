import { describe, expect, it } from 'vitest';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from './photo-slots';

describe('BIKE_PHOTO_SLOTS', () => {
  it('définit les trois slots obligatoires tout vélo', () => {
    const requiredSlots: PhotoSlotType[] = ['FULL_BIKE', 'DRIVETRAIN', 'BRAKES_TIRES'];

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

  it('utilise un overlay anatomique spécifique pour la transmission', () => {
    expect(BIKE_PHOTO_SLOTS.DRIVETRAIN.guide.overlayKey).toBe('drivetrain-anatomy');
  });

  it('recommande le multi-médias pour les freins et pneus', () => {
    expect(BIKE_PHOTO_SLOTS.BRAKES_TIRES.multiMediaRecommended).toBe(true);
    expect(BIKE_PHOTO_SLOTS.BRAKES_TIRES.maxMediaCount).toBe(5);
  });
});
