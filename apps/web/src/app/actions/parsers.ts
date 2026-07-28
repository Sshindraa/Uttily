import { isValidUuid, isOneOf } from '@/lib/validation';
import {
  INVENTORY_CONDITIONS,
  INVENTORY_STATUSES,
  type UpdateProductInput,
  type UpdateVariantInput,
  type UpdateInventoryItemInput,
} from '@uttily/core';

export interface ParsedFailure {
  fieldErrors: Record<string, string>;
}

export function parseUpdateProduct(
  formData: FormData,
): ParsedFailure | { productId: string; input: UpdateProductInput } {
  const fieldErrors: Record<string, string> = {};
  const productId = String(formData.get('productId') ?? '');
  const name = String(formData.get('name') ?? '').trim() || undefined;
  const descriptionRaw = formData.get('description');
  const description = descriptionRaw === null ? undefined : String(descriptionRaw).trim();
  const slug = String(formData.get('slug') ?? '').trim() || undefined;
  const categoryIdRaw = String(formData.get('categoryId') ?? '').trim();
  const categoryId = categoryIdRaw || undefined;

  if (!isValidUuid(productId)) fieldErrors.productId = 'Produit invalide.';
  if (name !== undefined && name.length < 2) {
    fieldErrors.name = 'Le nom doit faire au moins 2 caractères.';
  }
  if (categoryId !== undefined && !isValidUuid(categoryId)) {
    fieldErrors.categoryId = 'Catégorie invalide.';
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: UpdateProductInput = {};
  if (name !== undefined) input.name = name;
  if (description !== undefined) input.description = description;
  if (slug !== undefined) input.slug = slug;
  if (categoryId !== undefined) input.categoryId = categoryId;
  return { productId, input };
}

export function parseUpdateVariant(
  formData: FormData,
): ParsedFailure | { variantId: string; input: UpdateVariantInput } {
  const fieldErrors: Record<string, string> = {};
  const variantId = String(formData.get('variantId') ?? '');
  const name = String(formData.get('name') ?? '').trim() || undefined;
  const skuSuffixRaw = formData.get('skuSuffix');
  const skuSuffix = skuSuffixRaw === null ? undefined : String(skuSuffixRaw).trim() || null;
  const attributesRaw = String(formData.get('attributes') ?? '').trim();

  if (!isValidUuid(variantId)) fieldErrors.variantId = 'Variante invalide.';
  if (name !== undefined && name.length < 1) {
    fieldErrors.name = 'Le nom de la variante est requis.';
  }

  let attributes: Record<string, unknown> | undefined;
  if (attributesRaw) {
    try {
      const parsed = JSON.parse(attributesRaw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        attributes = parsed as Record<string, unknown>;
      } else {
        fieldErrors.attributes = 'Les attributs doivent être un objet JSON valide.';
      }
    } catch {
      fieldErrors.attributes = 'Les attributs doivent être un JSON valide.';
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: UpdateVariantInput = {};
  if (name !== undefined) input.name = name;
  if (skuSuffix !== undefined) input.skuSuffix = skuSuffix;
  if (attributes !== undefined) input.attributes = attributes;
  return { variantId, input };
}

export function parseUpdateInventoryItem(
  formData: FormData,
): ParsedFailure | { itemId: string; input: UpdateInventoryItemInput } {
  const fieldErrors: Record<string, string> = {};
  const itemId = String(formData.get('itemId') ?? '');
  const serialNumberRaw = formData.get('serialNumber');
  const serialNumber =
    serialNumberRaw === null ? undefined : String(serialNumberRaw).trim() || null;
  const conditionRaw = String(formData.get('condition') ?? '').trim();
  const statusRaw = String(formData.get('status') ?? '').trim();
  const notesRaw = formData.get('notes');
  const notes = notesRaw === null ? undefined : String(notesRaw).trim() || null;

  if (!isValidUuid(itemId)) fieldErrors.itemId = 'Exemplaire invalide.';

  let condition: UpdateInventoryItemInput['condition'];
  if (conditionRaw) {
    if (isOneOf(conditionRaw, INVENTORY_CONDITIONS)) {
      condition = conditionRaw;
    } else {
      fieldErrors.condition = 'État invalide.';
    }
  }

  let status: UpdateInventoryItemInput['status'];
  if (statusRaw) {
    if (isOneOf(statusRaw, INVENTORY_STATUSES)) {
      status = statusRaw;
    } else {
      fieldErrors.status = 'Statut invalide.';
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: UpdateInventoryItemInput = {};
  if (serialNumber !== undefined) input.serialNumber = serialNumber;
  if (condition !== undefined) input.condition = condition;
  if (status !== undefined) input.status = status;
  if (notes !== undefined) input.notes = notes;
  return { itemId, input };
}
