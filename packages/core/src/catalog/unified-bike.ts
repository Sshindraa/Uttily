import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  inventoryItems,
  pricingPlans,
  productPhotos,
  productVariants,
  products,
} from '@uttily/database';
import { getVariantPricingSummary, type PricingPlanSummary } from '../pricing-plans/management';

export type UnifiedBikeStatusSummary =
  'BOOKABLE' | 'PUBLISHED_UNAVAILABLE' | 'READY_TO_PUBLISH' | 'INCOMPLETE' | 'ARCHIVED';

export interface UnifiedBikePhotoItem {
  id: string;
  publicId: string;
  storageKey: string;
  sortOrder: number;
  slotKey: string | null;
  fileState: string;
  byteSize: number;
  mimeType: string;
  checksumSha256: string;
  createdAt: Date;
}

export interface UnifiedBikeInventoryItem {
  id: string;
  locationId: string;
  sku: string | null;
  serialNumber: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
}

export interface UnifiedBike {
  product: {
    id: string;
    organizationId: string;
    categoryId: string;
    categoryName: string;
    categorySlug: string;
    name: string;
    slug: string;
    description: string | null;
    publicationStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    createdAt: Date;
    updatedAt: Date;
  };
  variant: {
    id: string;
    name: string;
    skuSuffix: string | null;
    isActive: boolean;
    attributes: Record<string, unknown> | null;
  };
  photos: {
    count: number;
    minRequired: number; // 3
    isComplete: boolean;
    items: UnifiedBikePhotoItem[];
  };
  pricing: {
    activePlan: PricingPlanSummary | null;
    draftPlan: PricingPlanSummary | null;
    isPriced: boolean;
  };
  inventory: {
    totalCount: number;
    activeCount: number;
    maintenanceCount: number;
    retiredCount: number;
    items: UnifiedBikeInventoryItem[];
  };
  readiness: {
    isPublishable: boolean;
    statusSummary: UnifiedBikeStatusSummary;
    checklist: {
      hasIdentity: boolean;
      hasPhotos: boolean;
      hasPricing: boolean;
      hasInventory: boolean;
    };
  };
}

export interface UnifiedBikeSummary {
  id: string;
  name: string;
  slug: string;
  categoryName: string;
  variantName: string;
  variantId: string;
  publicationStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  photoCount: number;
  hasRequiredPhotos: boolean;
  heroPhotoPublicId: string | null;
  priceAmountMinor: number | null;
  activeInventoryCount: number;
  totalInventoryCount: number;
  isPublishable: boolean;
  statusSummary: UnifiedBikeStatusSummary;
}

/**
 * Calcule le statut sémantique fail-closed d'un vélo.
 */
function resolveBikeStatusSummary(
  publicationStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
  isPublishable: boolean,
): UnifiedBikeStatusSummary {
  if (publicationStatus === 'ARCHIVED') return 'ARCHIVED';
  if (publicationStatus === 'PUBLISHED') {
    return isPublishable ? 'BOOKABLE' : 'PUBLISHED_UNAVAILABLE';
  }
  return isPublishable ? 'READY_TO_PUBLISH' : 'INCOMPLETE';
}

/**
 * Charge la projection unifiée d'un vélo pour le loueur (Fiche Vélo Unifiée).
 * Read model pur agrégeant Identité, Photos (Photo Coach), Tarification et Flotte.
 */
export async function getUnifiedBike(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
  variantId?: string,
): Promise<UnifiedBike | null> {
  // 1. Charge le produit et sa catégorie
  const [prodRow] = await db
    .select({
      id: products.id,
      organizationId: products.organizationId,
      categoryId: products.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      name: products.name,
      slug: products.slug,
      description: products.description,
      publicationStatus: products.publicationStatus,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!prodRow) return null;

  // 2. Charge les variantes du produit
  const variants = await db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      skuSuffix: productVariants.skuSuffix,
      isActive: productVariants.isActive,
      attributes: productVariants.attributes,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.createdAt));

  if (variants.length === 0) return null;

  const targetVariant =
    (variantId ? variants.find((v) => v.id === variantId) : null) ??
    variants.find((v) => v.isActive) ??
    variants[0]!;

  // 3. Charge les photos valides
  const photoRows = await db
    .select({
      id: productPhotos.id,
      publicId: productPhotos.publicId,
      storageKey: productPhotos.storageKey,
      sortOrder: productPhotos.sortOrder,
      slotType: productPhotos.slotType,
      fileState: productPhotos.fileState,
      byteSize: productPhotos.byteSize,
      contentType: productPhotos.contentType,
      checksumSha256: productPhotos.checksumSha256,
      createdAt: productPhotos.createdAt,
    })
    .from(productPhotos)
    .where(
      and(
        eq(productPhotos.productId, productId),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
      ),
    )
    .orderBy(asc(productPhotos.sortOrder));

  const validPhotos: UnifiedBikePhotoItem[] = photoRows.map((p) => ({
    id: p.id,
    publicId: p.publicId,
    storageKey: p.storageKey,
    sortOrder: p.sortOrder,
    slotKey: p.slotType ?? null,
    fileState: p.fileState,
    byteSize: Number(p.byteSize ?? 0),
    mimeType: p.contentType ?? 'image/jpeg',
    checksumSha256: p.checksumSha256 ?? '',
    createdAt: p.createdAt,
  }));

  const uniqueChecksumCount = new Set(
    validPhotos.map((p) => p.checksumSha256).filter((c) => c.length > 0),
  ).size;
  const hasPhotos = uniqueChecksumCount >= 3;

  // 4. Charge la tarification de la variante
  const pricingOverview = await getVariantPricingSummary(db, organizationId, targetVariant.id);
  const hasPricing = pricingOverview.activePlan !== null;

  // 5. Charge l'inventaire physique de la variante
  const invRows = await db
    .select({
      id: inventoryItems.id,
      currentLocationId: inventoryItems.currentLocationId,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      status: inventoryItems.status,
      notes: inventoryItems.notes,
      createdAt: inventoryItems.createdAt,
    })
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.productVariantId, targetVariant.id), isNull(inventoryItems.deletedAt)),
    )
    .orderBy(asc(inventoryItems.createdAt));

  const inventoryItemsList: UnifiedBikeInventoryItem[] = invRows.map((inv) => ({
    id: inv.id,
    locationId: inv.currentLocationId,
    sku: inv.internalSku,
    serialNumber: inv.serialNumber,
    status: inv.status,
    notes: inv.notes,
    createdAt: inv.createdAt,
  }));

  const activeCount = inventoryItemsList.filter((i) => i.status === 'ACTIVE').length;
  const maintenanceCount = inventoryItemsList.filter((i) => i.status === 'MAINTENANCE').length;
  const retiredCount = inventoryItemsList.filter((i) => i.status === 'RETIRED').length;
  const hasInventory = activeCount >= 1;

  // 6. Calcule la readiness fail-closed
  const hasIdentity = (prodRow.description ?? '').trim().length > 0 && targetVariant.isActive;

  const isPublishable = hasIdentity && hasPhotos && hasPricing && hasInventory;

  const statusSummary = resolveBikeStatusSummary(
    prodRow.publicationStatus as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
    isPublishable,
  );

  return {
    product: {
      id: prodRow.id,
      organizationId: prodRow.organizationId,
      categoryId: prodRow.categoryId,
      categoryName: prodRow.categoryName,
      categorySlug: prodRow.categorySlug,
      name: prodRow.name,
      slug: prodRow.slug,
      description: prodRow.description,
      publicationStatus: prodRow.publicationStatus as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
      createdAt: prodRow.createdAt,
      updatedAt: prodRow.updatedAt,
    },
    variant: {
      id: targetVariant.id,
      name: targetVariant.name,
      skuSuffix: targetVariant.skuSuffix,
      isActive: targetVariant.isActive,
      attributes: (targetVariant.attributes as Record<string, unknown>) ?? null,
    },
    photos: {
      count: uniqueChecksumCount,
      minRequired: 3,
      isComplete: hasPhotos,
      items: validPhotos,
    },
    pricing: {
      activePlan: pricingOverview.activePlan,
      draftPlan: pricingOverview.draftPlan,
      isPriced: hasPricing,
    },
    inventory: {
      totalCount: inventoryItemsList.length,
      activeCount,
      maintenanceCount,
      retiredCount,
      items: inventoryItemsList,
    },
    readiness: {
      isPublishable,
      statusSummary,
      checklist: {
        hasIdentity,
        hasPhotos,
        hasPricing,
        hasInventory,
      },
    },
  };
}

/**
 * Liste l'ensemble des vélos unifiés d'une organisation pour la vue « Mes Vélos ».
 * Requêtes groupées sans N+1.
 */
export async function listUnifiedBikes(
  db: DatabaseClient,
  organizationId: string,
): Promise<UnifiedBikeSummary[]> {
  // 1. Tous les produits non supprimés avec catégorie
  const prodRows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      description: products.description,
      publicationStatus: products.publicationStatus,
      categoryName: categories.name,
      createdAt: products.createdAt,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)))
    .orderBy(asc(products.createdAt));

  if (prodRows.length === 0) return [];

  const productIds = prodRows.map((p) => p.id);

  // 2. Variantes associées
  const varRows = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      name: productVariants.name,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.createdAt));

  const variantIds = varRows.map((v) => v.id);

  // 3. Photos
  const photoRows = await db
    .select({
      productId: productPhotos.productId,
      publicId: productPhotos.publicId,
      checksumSha256: productPhotos.checksumSha256,
      sortOrder: productPhotos.sortOrder,
    })
    .from(productPhotos)
    .where(
      and(
        inArray(productPhotos.productId, productIds),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
      ),
    )
    .orderBy(asc(productPhotos.sortOrder));

  // 4. Plans actifs
  const activePlanRows =
    variantIds.length > 0
      ? await db
          .select({
            productVariantId: pricingPlans.productVariantId,
            priceAmountMinor: pricingPlans.priceAmountMinor,
          })
          .from(pricingPlans)
          .where(
            and(
              inArray(pricingPlans.productVariantId, variantIds),
              eq(pricingPlans.lifecycleState, 'ACTIVE'),
            ),
          )
      : [];

  // 5. Exemplaires physiques
  const invRows =
    variantIds.length > 0
      ? await db
          .select({
            productVariantId: inventoryItems.productVariantId,
            status: inventoryItems.status,
          })
          .from(inventoryItems)
          .where(
            and(
              inArray(inventoryItems.productVariantId, variantIds),
              isNull(inventoryItems.deletedAt),
            ),
          )
      : [];

  // Assemblage optimisé
  return prodRows.map((prod) => {
    const prodVariants = varRows.filter((v) => v.productId === prod.id);
    const primaryVariant = prodVariants.find((v) => v.isActive) ??
      prodVariants[0] ?? {
        id: '',
        name: 'Standard',
        isActive: false,
      };

    const prodPhotos = photoRows.filter((p) => p.productId === prod.id);
    const uniqueChecksums = new Set(prodPhotos.map((p) => p.checksumSha256).filter(Boolean));
    const hasRequiredPhotos = uniqueChecksums.size >= 3;
    const heroPhotoPublicId = prodPhotos[0]?.publicId ?? null;

    const activePlan = activePlanRows.find((p) => p.productVariantId === primaryVariant.id);
    const priceAmountMinor = activePlan ? Number(activePlan.priceAmountMinor) : null;

    const variantInvs = invRows.filter((i) => i.productVariantId === primaryVariant.id);
    const activeInventoryCount = variantInvs.filter((i) => i.status === 'ACTIVE').length;
    const totalInventoryCount = variantInvs.length;

    const hasIdentity = (prod.description ?? '').trim().length > 0 && primaryVariant.isActive;
    const hasPricing = priceAmountMinor !== null;
    const hasInventory = activeInventoryCount >= 1;

    const isPublishable = hasIdentity && hasRequiredPhotos && hasPricing && hasInventory;

    const statusSummary = resolveBikeStatusSummary(
      prod.publicationStatus as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
      isPublishable,
    );

    return {
      id: prod.id,
      name: prod.name,
      slug: prod.slug,
      categoryName: prod.categoryName,
      variantName: primaryVariant.name,
      variantId: primaryVariant.id,
      publicationStatus: prod.publicationStatus as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
      photoCount: uniqueChecksums.size,
      hasRequiredPhotos,
      heroPhotoPublicId,
      priceAmountMinor,
      activeInventoryCount,
      totalInventoryCount,
      isPublishable,
      statusSummary,
    };
  });
}
