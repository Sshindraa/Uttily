'use server';

import { revalidatePath } from 'next/cache';
import {
  createManualBlock,
  releaseManualBlock,
  type CreateManualBlockResult,
  type InventoryBlockRecord,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';

export async function createManualBlockAction(
  organizationId: string,
  _prev: ActionResult<CreateManualBlockResult>,
  formData: FormData,
): Promise<ActionResult<CreateManualBlockResult>> {
  const inventoryItemId = String(formData.get('inventoryItemId') ?? '');
  const locationId = String(formData.get('locationId') ?? '');
  const startAt = String(formData.get('startAt') ?? '');
  const endAt = String(formData.get('endAt') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const fieldErrors: Record<string, string> = {};

  if (!isValidUuid(inventoryItemId)) fieldErrors.inventoryItemId = 'Exemplaire invalide.';
  if (!isValidUuid(locationId)) fieldErrors.locationId = 'Établissement invalide.';
  if (startAt.trim().length === 0) fieldErrors.startAt = 'La date de début est requise.';
  if (endAt.trim().length === 0) fieldErrors.endAt = 'La date de fin est requise.';
  if (idempotencyKey.length === 0) {
    fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const result = await createManualBlock(db, {
      organizationId: authorizedOrgId,
      inventoryItemId,
      locationId,
      startAt,
      endAt,
      idempotencyKey,
      actorUserId: user.id,
    });

    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${inventoryItemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return result;
  });
}

export async function releaseManualBlockAction(
  organizationId: string,
  _prev: ActionResult<InventoryBlockRecord>,
  formData: FormData,
): Promise<ActionResult<InventoryBlockRecord>> {
  const blockId = String(formData.get('blockId') ?? '');
  if (!isValidUuid(blockId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Blocage invalide.',
      fieldErrors: { blockId: 'Blocage invalide.' },
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const result = await releaseManualBlock(db, authorizedOrgId, blockId);

    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${result.inventoryItemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return result;
  });
}
