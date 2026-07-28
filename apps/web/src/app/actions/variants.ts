'use server';

// Note : Les actions delete (deleteProduct/deleteVariant/deleteInventoryItem) ne sont
// pas exposées au Lot 2B. La suppression métier réversible est couverte par archive/
// deactivate/retire. Le delete technique (deletedAt) sera exposé via un usage admin.

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  createVariant,
  updateVariant,
  deactivateVariant,
  type ProductVariantRecord,
  type CreateVariantInput,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { parseUpdateVariant, type ParsedFailure } from './parsers';

// ---------------------------------------------------------------------------
// Parseurs FormData explicites.
//
// `organizationId` n'est PAS lu depuis le formData : il est injecté serveur
// via le binding par closure (`action.bind(null, orgId)`). Les parseurs ne
// lisent que les champs métier (productId, variantId, name, etc.).
// ---------------------------------------------------------------------------

function parseCreateVariant(formData: FormData): ParsedFailure | { input: CreateVariantInput } {
  const fieldErrors: Record<string, string> = {};
  const productId = String(formData.get('productId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const skuSuffix = String(formData.get('skuSuffix') ?? '').trim() || undefined;
  const attributesRaw = String(formData.get('attributes') ?? '').trim();

  if (!isValidUuid(productId)) fieldErrors.productId = 'Produit invalide.';
  if (name.length < 1) fieldErrors.name = 'Le nom de la variante est requis.';

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

  const input: CreateVariantInput = { organizationId: '', productId, name };
  if (skuSuffix !== undefined) input.skuSuffix = skuSuffix;
  if (attributes !== undefined) input.attributes = attributes;
  return { input };
}

function parseVariantId(formData: FormData): ParsedFailure | { variantId: string } {
  const fieldErrors: Record<string, string> = {};
  const variantId = String(formData.get('variantId') ?? '');

  if (!isValidUuid(variantId)) fieldErrors.variantId = 'Variante invalide.';

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { variantId };
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
// `createVariant` prend `{ productId, name, ... }` avec `organizationId` dans
// l'input (le domaine `requireProductInOrg` vérifie l'appartenance du produit
// à l'org). L'action vérifie quand même l'autorisation via
// `requireCatalogManagerOf(orgId)` avant d'appeler le domaine.
// ---------------------------------------------------------------------------

export async function createVariantAction(
  organizationId: string,
  _prev: ActionResult<ProductVariantRecord>,
  formData: FormData,
): Promise<ActionResult<ProductVariantRecord>> {
  const parsed = parseCreateVariant(formData);
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
    const variant = await createVariant(db, { ...parsed.input, organizationId: authorizedOrgId });
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.input.productId}`);
    return variant;
  });
}

export async function updateVariantAction(
  organizationId: string,
  _prev: ActionResult<ProductVariantRecord>,
  formData: FormData,
): Promise<ActionResult<ProductVariantRecord>> {
  const parsed = parseUpdateVariant(formData);
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
    const variant = await updateVariant(db, authorizedOrgId, parsed.variantId, parsed.input);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${variant.productId}`);
    return variant;
  });
}

export async function deactivateVariantAction(
  organizationId: string,
  _prev: ActionResult<ProductVariantRecord>,
  formData: FormData,
): Promise<ActionResult<ProductVariantRecord>> {
  const parsed = parseVariantId(formData);
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
    const variant = await deactivateVariant(db, authorizedOrgId, parsed.variantId);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${variant.productId}`);
    return variant;
  });
}
