import { REQUIRED_BIKE_PHOTO_SLOTS, type RequiredBikePhotoSlot } from '@uttily/contracts';

export { REQUIRED_BIKE_PHOTO_SLOTS };

export const BIKE_CATEGORY_SLUG = 'bike' as const;

export function missingRequiredBikePhotoSlots(
  categorySlug: string | null | undefined,
  availableSlotTypes: ReadonlySet<string | null>,
): readonly RequiredBikePhotoSlot[] {
  if (categorySlug !== BIKE_CATEGORY_SLUG) return [];
  return REQUIRED_BIKE_PHOTO_SLOTS.filter((slotType) => !availableSlotTypes.has(slotType));
}
