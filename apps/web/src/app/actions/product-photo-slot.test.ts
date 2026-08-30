import { describe, expect, it } from 'vitest';
import { parseProductPhotoSlotType } from './product-photo-slot';

describe('parseProductPhotoSlotType', () => {
  it.each(['HERO_PROFILE', 'THREE_QUARTER_FRONT', 'SECONDARY_VIEW', 'BATTERY'])(
    'accepte le slot contractuel %s',
    (slotType) => {
      expect(parseProductPhotoSlotType(slotType)).toBe(slotType);
    },
  );

  it.each(['', ' UNKNOWN ', null, undefined, 42])('rejette la valeur %s', (value) => {
    expect(parseProductPhotoSlotType(value)).toBeNull();
  });
});
