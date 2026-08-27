import type { DatabaseClient, ProductPhotoRecord } from '@uttily/database';
import type { PhotoSlotType } from '@uttily/contracts';
import type { ProductPhotoStorage } from './storage';
import { deleteProductPhoto } from './delete-product-photo';
import { uploadProductPhoto } from './upload-product-photo';
import { PhotoError } from './errors';

export interface ReplaceProductPhotoInput {
  readonly organizationId: string;
  readonly productId: string;
  readonly photoId: string;
  readonly replacementPhotoId: string;
  readonly slotType?: PhotoSlotType | null | undefined;
  readonly content: Uint8Array;
  readonly declaredContentType?: string | undefined;
}

/** Upload la nouvelle photo puis retire l'ancienne, de façon rejouable. */
export async function replaceProductPhoto(
  db: DatabaseClient,
  storage: ProductPhotoStorage,
  input: ReplaceProductPhotoInput,
): Promise<ProductPhotoRecord> {
  if (input.photoId === input.replacementPhotoId) {
    throw new PhotoError(
      'PHOTO_VALIDATION_FAILED',
      'Une photo de remplacement doit avoir un identifiant distinct.',
    );
  }

  const uploadInput = {
    organizationId: input.organizationId,
    productId: input.productId,
    photoId: input.replacementPhotoId,
    slotType: input.slotType,
    content: input.content,
    ...(input.declaredContentType ? { declaredContentType: input.declaredContentType } : {}),
  };
  const replacement = await uploadProductPhoto(db, storage, uploadInput);
  await deleteProductPhoto(db, input.organizationId, input.photoId, storage);
  return replacement;
}
