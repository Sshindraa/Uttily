'use server';

// Note : Les actions delete (deleteProduct/deleteVariant/deleteInventoryItem) ne sont
// pas exposées au Lot 2B. La suppression métier réversible est couverte par archive/
// deactivate/retire. Le delete technique (deletedAt) sera exposé via un usage admin.

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid, isOneOf } from '@/lib/validation';
import {
  createInventoryItem,
  updateInventoryItem,
  transferInventoryItem,
  retireInventoryItem,
  INVENTORY_CONDITIONS,
  INVENTORY_STATUSES,
  type InventoryItemRecord,
  type InventoryMovementRecord,
  type CreateInventoryItemInput,
  type TransferInventoryItemInput,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { MAX_BULK_INVENTORY_ITEMS } from '@uttily/contracts';
import { parseUpdateInventoryItem, type ParsedFailure } from './parsers';
import { buildInventorySku } from '@/lib/inventory-sku';

// ---------------------------------------------------------------------------
// Parseurs FormData explicites.
//
// `organizationId` n'est PAS lu depuis le formData : il est injecté serveur
// via le binding par closure (`action.bind(null, orgId)`). Les parseurs ne
// lisent que les champs métier (itemId, variantId, toLocationId, etc.).
// ---------------------------------------------------------------------------

function parseCreateInventoryItem(
  formData: FormData,
): ParsedFailure | { input: CreateInventoryItemInput } {
  const fieldErrors: Record<string, string> = {};
  const productVariantId = String(formData.get('productVariantId') ?? '');
  const internalSku = String(formData.get('internalSku') ?? '').trim();
  const serialNumber = String(formData.get('serialNumber') ?? '').trim() || undefined;
  const conditionRaw = String(formData.get('condition') ?? '').trim();
  const statusRaw = String(formData.get('status') ?? '').trim();
  const currentLocationId = String(formData.get('currentLocationId') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || undefined;

  if (!isValidUuid(productVariantId)) fieldErrors.productVariantId = 'Variante invalide.';
  if (internalSku.length < 1) fieldErrors.internalSku = "L'SKU interne est requis.";
  if (!isValidUuid(currentLocationId)) fieldErrors.currentLocationId = 'Établissement invalide.';

  let condition: CreateInventoryItemInput['condition'];
  if (conditionRaw) {
    if (isOneOf(conditionRaw, INVENTORY_CONDITIONS)) {
      condition = conditionRaw;
    } else {
      fieldErrors.condition = 'État invalide.';
    }
  }

  let status: CreateInventoryItemInput['status'];
  if (statusRaw) {
    if (isOneOf(statusRaw, INVENTORY_STATUSES)) {
      status = statusRaw;
    } else {
      fieldErrors.status = 'Statut invalide.';
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: CreateInventoryItemInput = {
    organizationId: '',
    productVariantId,
    internalSku,
    currentLocationId,
  };
  if (serialNumber !== undefined) input.serialNumber = serialNumber;
  if (condition !== undefined) input.condition = condition;
  if (status !== undefined) input.status = status;
  if (notes !== undefined) input.notes = notes;
  return { input };
}

function parseTransferInventoryItem(
  formData: FormData,
): ParsedFailure | { itemId: string; input: TransferInventoryItemInput } {
  const fieldErrors: Record<string, string> = {};
  const itemId = String(formData.get('itemId') ?? '');
  const toLocationId = String(formData.get('toLocationId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || undefined;

  if (!isValidUuid(itemId)) fieldErrors.itemId = 'Exemplaire invalide.';
  if (!isValidUuid(toLocationId))
    fieldErrors.toLocationId = 'Établissement de destination invalide.';
  if (idempotencyKey.length < 1) {
    fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: TransferInventoryItemInput = {
    organizationId: '',
    inventoryItemId: itemId,
    toLocationId,
    idempotencyKey,
  };
  if (reason !== undefined) input.reason = reason;
  return { itemId, input };
}

function parseItemId(formData: FormData): ParsedFailure | { itemId: string } {
  const fieldErrors: Record<string, string> = {};
  const itemId = String(formData.get('itemId') ?? '');

  if (!isValidUuid(itemId)) fieldErrors.itemId = 'Exemplaire invalide.';

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { itemId };
}

// ---------------------------------------------------------------------------
// Server Actions.
//
// `organizationId` est injecté serveur via le binding par closure de React 19 /
// Next.js (`action.bind(null, orgId)`). Il n'est jamais trusté du client ni lu
// depuis le formData. L'action valide cet `organizationId` via
// `requireCatalogManagerOf` qui vérifie la membership de l'utilisateur sur
// CETTE org.
//
// `transferInventoryItemAction` reçoit `idempotencyKey` depuis le FormData
// (champ caché du formulaire). L'action ne génère PAS de clé — elle utilise
// celle fournie par le client (générée à l'affichage du formulaire).
// ---------------------------------------------------------------------------

export async function createInventoryItemAction(
  organizationId: string,
  _prev: ActionResult<InventoryItemRecord>,
  formData: FormData,
): Promise<ActionResult<InventoryItemRecord>> {
  const parsed = parseCreateInventoryItem(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const item = await createInventoryItem(db, {
      ...parsed.input,
      organizationId: authorizedOrgId,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${item.id}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return item;
  });
}

export async function updateInventoryItemAction(
  organizationId: string,
  _prev: ActionResult<InventoryItemRecord>,
  formData: FormData,
): Promise<ActionResult<InventoryItemRecord>> {
  const parsed = parseUpdateInventoryItem(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const item = await updateInventoryItem(db, authorizedOrgId, parsed.itemId, parsed.input);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${parsed.itemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return item;
  });
}

export async function transferInventoryItemAction(
  organizationId: string,
  _prev: ActionResult<{
    currentItem: InventoryItemRecord;
    movement: InventoryMovementRecord | null;
  }>,
  formData: FormData,
): Promise<
  ActionResult<{ currentItem: InventoryItemRecord; movement: InventoryMovementRecord | null }>
> {
  const parsed = parseTransferInventoryItem(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    // `createdBy` est injecté serveur depuis l'utilisateur authentifié.
    const result = await transferInventoryItem(db, {
      ...parsed.input,
      organizationId: authorizedOrgId,
      createdBy: user.id,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${parsed.itemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return result;
  });
}

export async function retireInventoryItemAction(
  organizationId: string,
  _prev: ActionResult<InventoryItemRecord>,
  formData: FormData,
): Promise<ActionResult<InventoryItemRecord>> {
  const parsed = parseItemId(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const item = await retireInventoryItem(db, authorizedOrgId, parsed.itemId);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${parsed.itemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return item;
  });
}

export async function bulkCreateInventoryItemsAction(
  organizationId: string,
  _prev: ActionResult<{ createdCount: number }>,
  formData: FormData,
): Promise<ActionResult<{ createdCount: number }>> {
  const productVariantId = String(formData.get('productVariantId') ?? '');
  const currentLocationId = String(formData.get('currentLocationId') ?? '');
  const countStr = String(formData.get('count') ?? '1');
  const prefix =
    String(formData.get('prefix') ?? 'VELO')
      .trim()
      .toUpperCase() || 'VELO';
  const count = parseInt(countStr, 10);

  if (!isValidUuid(productVariantId)) {
    return { ok: false, code: 'VALIDATION', message: 'Variante invalide.' };
  }
  if (!isValidUuid(currentLocationId)) {
    return { ok: false, code: 'VALIDATION', message: 'Établissement invalide.' };
  }
  if (isNaN(count) || count < 1 || count > MAX_BULK_INVENTORY_ITEMS) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: `Le nombre d’exemplaires doit être compris entre 1 et ${MAX_BULK_INVENTORY_ITEMS}.`,
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);

    const batchId = randomUUID();
    for (let i = 1; i <= count; i++) {
      await createInventoryItem(db, {
        organizationId: authorizedOrgId,
        productVariantId,
        currentLocationId,
        internalSku: buildInventorySku(prefix, i, batchId),
        status: 'ACTIVE',
        condition: 'NEW',
      });
    }

    revalidatePath(`/dashboard/${authorizedOrgId}/inventory`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return { createdCount: count };
  });
}
