import { PHOTO_SLOT_TYPES, type PhotoSlotType } from '@uttily/contracts';

const VALID_SLOT_TYPES = new Set<PhotoSlotType>(PHOTO_SLOT_TYPES);

/**
 * Parse un slot photo fourni par le navigateur sans faire confiance à sa valeur.
 * La liste acceptée est partagée avec le contrat `@uttily/contracts`.
 */
export function parseProductPhotoSlotType(value: unknown): PhotoSlotType | null {
  const rawSlotType = String(value ?? '').trim();
  return rawSlotType && VALID_SLOT_TYPES.has(rawSlotType as PhotoSlotType)
    ? (rawSlotType as PhotoSlotType)
    : null;
}
