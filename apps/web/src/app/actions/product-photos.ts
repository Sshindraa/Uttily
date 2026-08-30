'use server';

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { getProductPhotoStorage } from '@/lib/product-photo-storage';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  deleteProductPhoto,
  replaceProductPhoto,
  uploadProductPhoto,
  type ProductPhotoSummary,
} from '@uttily/core';
import type { ActionResult, PhotoSlotType } from '@uttily/contracts';
import { parseProductPhotoSlotType } from './product-photo-slot';

export async function uploadProductPhotoAction(
  organizationId: string,
  _prev: ActionResult<ProductPhotoSummary>,
  formData: FormData,
): Promise<ActionResult<ProductPhotoSummary>> {
  const productId = String(formData.get('productId') ?? '');
  const photoId = String(formData.get('photoId') ?? '');
  const replacePhotoId = String(formData.get('replacePhotoId') ?? '').trim() || null;
  const slotType = parseProductPhotoSlotType(formData.get('slotType'));
  const file = formData.get('file');
  if (
    !isValidUuid(productId) ||
    !isValidUuid(photoId) ||
    (replacePhotoId && !isValidUuid(replacePhotoId))
  ) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Identifiant de produit ou de photo invalide.',
    };
  }
  if (!(file instanceof File)) {
    return { ok: false, code: 'VALIDATION', message: 'Sélectionnez une photo.' };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const storage = getProductPhotoStorage();
    const content = new Uint8Array(await file.arrayBuffer());
    const baseInput = {
      organizationId: authorizedOrgId,
      productId,
      slotType,
      content,
      ...(file.type ? { declaredContentType: file.type } : {}),
    };
    const result = replacePhotoId
      ? await replaceProductPhoto(db, storage, {
          ...baseInput,
          photoId: replacePhotoId,
          replacementPhotoId: photoId,
        })
      : await uploadProductPhoto(db, storage, {
          ...baseInput,
          organizationId: authorizedOrgId,
          photoId,
        });
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}/edit`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    return toPhotoSummary(result);
  });
}

export async function deleteProductPhotoAction(
  organizationId: string,
  _prev: ActionResult<null>,
  formData: FormData,
): Promise<ActionResult<null>> {
  const photoId = String(formData.get('photoId') ?? '');
  if (!isValidUuid(photoId)) {
    return { ok: false, code: 'VALIDATION', message: 'Identifiant de photo invalide.' };
  }
  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    await deleteProductPhoto(db, authorizedOrgId, photoId, getProductPhotoStorage());
    const productId = String(formData.get('productId') ?? '');
    if (isValidUuid(productId)) {
      revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}`);
      revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}/edit`);
      revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
      revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    }
    return null;
  });
}

function toPhotoSummary(photo: {
  id: string;
  publicId: string;
  slotType?: PhotoSlotType | null;
  fileState: ProductPhotoSummary['fileState'];
  contentType: string | null;
  byteSize: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sortOrder: number;
  rejectionReason: string | null;
}): ProductPhotoSummary {
  return {
    id: photo.id,
    publicId: photo.publicId,
    slotType: photo.slotType ?? null,
    fileState: photo.fileState,
    contentType: photo.contentType,
    byteSize: photo.byteSize,
    widthPx: photo.widthPx,
    heightPx: photo.heightPx,
    sortOrder: photo.sortOrder,
    rejectionReason: photo.rejectionReason,
  };
}
