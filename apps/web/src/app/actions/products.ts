'use server';

// Note : Les actions delete (deleteProduct/deleteVariant/deleteInventoryItem) ne sont
// pas exposées au Lot 2B. La suppression métier réversible est couverte par archive/
// deactivate/retire. Le delete technique (deletedAt) sera exposé via un usage admin.

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  createProduct,
  updateProduct,
  publishProduct,
  archiveProduct,
  restoreArchivedProduct,
  listVariants,
  updateVariant,
  activateDailyPricingPlan,
  type ProductRecord,
  type CreateProductInput,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { parseUpdateProduct, type ParsedFailure } from './parsers';

// ---------------------------------------------------------------------------
// Parseurs FormData explicites.
//
// `organizationId` n'est PAS lu depuis le formData : il est injecté serveur
// via le binding par closure (`action.bind(null, orgId)`). Les parseurs ne
// lisent que les champs métier (name, categoryId, productId, etc.).
//
// Les parseurs valident (UUID, longueurs), normalisent (trim) et produisent
// `fieldErrors` en cas d'erreur de validation.
// Jamais de `Object.fromEntries(formData)` converti directement en type.
// ---------------------------------------------------------------------------

function parseCreateProduct(formData: FormData): ParsedFailure | { input: CreateProductInput } {
  const fieldErrors: Record<string, string> = {};
  const name = String(formData.get('name') ?? '').trim();
  const categoryId = String(formData.get('categoryId') ?? '');
  const description = String(formData.get('description') ?? '').trim() || undefined;
  const slug = String(formData.get('slug') ?? '').trim() || undefined;

  if (name.length < 2) fieldErrors.name = 'Le nom doit faire au moins 2 caractères.';
  if (!isValidUuid(categoryId)) fieldErrors.categoryId = 'Catégorie invalide.';

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const input: CreateProductInput = { organizationId: '', categoryId, name };
  if (description !== undefined) input.description = description;
  if (slug !== undefined) input.slug = slug;
  return { input };
}

function parseProductId(formData: FormData): ParsedFailure | { productId: string } {
  const fieldErrors: Record<string, string> = {};
  const productId = String(formData.get('productId') ?? '');

  if (!isValidUuid(productId)) fieldErrors.productId = 'Produit invalide.';

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { productId };
}

// ---------------------------------------------------------------------------
// Server Actions.
//
// `organizationId` est injecté serveur via le binding par closure de React 19 /
// Next.js (`action.bind(null, orgId)`). Il n'est jamais trusté du client ni lu
// depuis le formData. L'action valide cet `organizationId` via
// `requireCatalogManagerOf` qui vérifie la membership de l'utilisateur sur
// CETTE org.
// ---------------------------------------------------------------------------

export async function createProductAction(
  organizationId: string,
  _prev: ActionResult<ProductRecord>,
  formData: FormData,
): Promise<ActionResult<ProductRecord>> {
  const parsed = parseCreateProduct(formData);
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
    const product = await createProduct(db, { ...parsed.input, organizationId: authorizedOrgId });
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${product.id}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}`);
    return product;
  });
}

export async function updateProductAction(
  organizationId: string,
  _prev: ActionResult<ProductRecord>,
  formData: FormData,
): Promise<ActionResult<ProductRecord>> {
  const parsed = parseUpdateProduct(formData);
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
    const product = await updateProduct(db, authorizedOrgId, parsed.productId, parsed.input);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${parsed.productId}`);
    return product;
  });
}

export async function publishProductAction(
  organizationId: string,
  _prev: ActionResult<ProductRecord>,
  formData: FormData,
): Promise<ActionResult<ProductRecord>> {
  const parsed = parseProductId(formData);
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
    const product = await publishProduct(db, authorizedOrgId, parsed.productId);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${parsed.productId}`);
    return product;
  });
}

export async function archiveProductAction(
  organizationId: string,
  _prev: ActionResult<ProductRecord>,
  formData: FormData,
): Promise<ActionResult<ProductRecord>> {
  const parsed = parseProductId(formData);
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
    const product = await archiveProduct(db, authorizedOrgId, parsed.productId);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${parsed.productId}`);
    return product;
  });
}

export async function restoreArchivedProductAction(
  organizationId: string,
  _prev: ActionResult<ProductRecord>,
  formData: FormData,
): Promise<ActionResult<ProductRecord>> {
  const parsed = parseProductId(formData);
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
    const product = await restoreArchivedProduct(db, authorizedOrgId, parsed.productId);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${parsed.productId}`);
    return product;
  });
}

export async function createBikeDraftAction(
  organizationId: string,
  _prev: ActionResult<{ bikeId: string }>,
  formData: FormData,
): Promise<ActionResult<{ bikeId: string }>> {
  const name = String(formData.get('name') ?? '').trim();
  const categoryId = String(formData.get('categoryId') ?? '');
  const size = String(formData.get('size') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  const fieldErrors: Record<string, string> = {};
  if (name.length < 2) {
    fieldErrors.name = 'Le nom de l’équipement doit comporter au moins 2 caractères.';
  }
  if (!isValidUuid(categoryId)) {
    fieldErrors.categoryId = 'Veuillez sélectionner une catégorie valide.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez renseigner correctement les informations de l’équipement.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const product = await createProduct(db, {
      organizationId: authorizedOrgId,
      categoryId,
      name,
      ...(description ? { description } : {}),
    });

    if (size) {
      const variants = await listVariants(db, authorizedOrgId, product.id);
      if (variants[0]) {
        await updateVariant(db, authorizedOrgId, variants[0].id, {
          name: size,
          skuSuffix: size.toUpperCase(),
          attributes: { size },
        });
      }
    }

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}/setup`);
    return { bikeId: product.id };
  });
}

export async function publishBikeFromSetupAction(
  organizationId: string,
  _prev: ActionResult<{ bikeId: string }>,
  formData: FormData,
): Promise<ActionResult<{ bikeId: string }>> {
  const productId = String(formData.get('productId') ?? '');
  const pricingPlanId = String(formData.get('pricingPlanId') ?? '');

  if (!isValidUuid(productId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Identifiant d’équipement invalide.',
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);

    // Si un plan tarifaire draft a été transmis, on l'active
    if (isValidUuid(pricingPlanId)) {
      await activateDailyPricingPlan(db, authorizedOrgId, pricingPlanId);
    }

    await publishProduct(db, authorizedOrgId, productId);

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    return { bikeId: productId };
  });
}
