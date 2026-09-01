'use server';

// Note : Les actions delete (deleteProduct/deleteVariant/deleteInventoryItem) ne sont
// pas exposées au Lot 2B. La suppression métier réversible est couverte par archive/
// deactivate/retire. Le delete technique (deletedAt) sera exposé via un usage admin.

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import type { DatabaseClient } from '@uttily/database';
import {
  createProduct,
  updateProduct,
  publishProduct,
  archiveProduct,
  restoreArchivedProduct,
  listVariants,
  updateVariant,
  activateDailyPricingPlan,
  publishFirstEquipment,
  duplicateProduct,
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

function parseDuplicateProduct(formData: FormData):
  | ParsedFailure
  | {
      sourceProductId: string;
      idempotencyKey: string;
      name?: string;
      slug?: string;
    } {
  const fieldErrors: Record<string, string> = {};
  const sourceProductId = String(formData.get('productId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();

  if (!isValidUuid(sourceProductId)) fieldErrors.productId = 'Produit source invalide.';
  if (idempotencyKey.length < 1) {
    fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  } else if (idempotencyKey.length > 200) {
    fieldErrors.idempotencyKey = 'La clé ne doit pas dépasser 200 caractères.';
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  return {
    sourceProductId,
    idempotencyKey,
    ...(name ? { name } : {}),
    ...(slug ? { slug } : {}),
  };
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

/** Duplique uniquement le catalogue d’un équipement dans la même organisation. */
export async function duplicateProductAction(
  organizationId: string,
  _prev: ActionResult<{ equipmentId: string }>,
  formData: FormData,
): Promise<ActionResult<{ equipmentId: string }>> {
  const parsed = parseDuplicateProduct(formData);
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
    const product = await duplicateProduct(db, {
      organizationId: authorizedOrgId,
      sourceProductId: parsed.sourceProductId,
      idempotencyKey: parsed.idempotencyKey,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.slug ? { slug: parsed.slug } : {}),
    });

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}/setup`);
    return { equipmentId: product.id };
  });
}

interface CreateDraftProductInput {
  categoryId: string;
  name: string;
  description: string;
  variantName?: string;
}

async function createDraftProduct(
  db: DatabaseClient,
  organizationId: string,
  input: CreateDraftProductInput,
): Promise<ProductRecord> {
  return createProduct(db, {
    organizationId,
    categoryId: input.categoryId,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.variantName ? { initialVariantName: input.variantName } : {}),
  });
}

/** Création guidée du premier équipement, quelle que soit sa famille active. */
export async function createFirstEquipmentDraftAction(
  organizationId: string,
  _prev: ActionResult<{ equipmentId: string }>,
  formData: FormData,
): Promise<ActionResult<{ equipmentId: string }>> {
  const name = String(formData.get('name') ?? '').trim();
  const categoryId = String(formData.get('categoryId') ?? '');
  const variantName = String(formData.get('variantName') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  const fieldErrors: Record<string, string> = {};
  if (name.length < 2) {
    fieldErrors.name = 'Le nom de l’équipement doit comporter au moins 2 caractères.';
  }
  if (!isValidUuid(categoryId)) {
    fieldErrors.categoryId = 'Veuillez sélectionner une catégorie valide.';
  }
  if (variantName.length > 80) {
    fieldErrors.variantName = 'Le nom de la variante est trop long.';
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
    const product = await createDraftProduct(db, authorizedOrgId, {
      categoryId,
      name,
      description,
      ...(variantName ? { variantName } : {}),
    });

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${product.id}/setup`);
    return { equipmentId: product.id };
  });
}

/**
 * Alias historique conservé pour les intégrations existantes de la route
 * `/bikes/new`. Le nouveau parcours utilise `createFirstEquipmentDraftAction`.
 */
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
    const product = await createDraftProduct(db, authorizedOrgId, {
      categoryId,
      name,
      description,
    });

    // Contrat historique : la taille d'un vélo reste portée par la variante
    // et ses attributs pour les intégrations qui utilisent encore cette action.
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

/** Publication guidée avec le contrôle serveur de l'offre réservable. */
export async function publishFirstEquipmentFromSetupAction(
  organizationId: string,
  _prev: ActionResult<{ equipmentId: string }>,
  formData: FormData,
): Promise<ActionResult<{ equipmentId: string }>> {
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

    if (isValidUuid(pricingPlanId)) {
      await activateDailyPricingPlan(db, authorizedOrgId, pricingPlanId);
    }

    await publishFirstEquipment(db, authorizedOrgId, productId);

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    return { equipmentId: productId };
  });
}
