import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  inventoryItems,
  productPhotos,
  productVariants,
  products,
} from '@uttily/database';
import { getVariantPricingSummary, type PricingPlanSummary } from '../pricing-plans/management';

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
    statusSummary: 'READY_TO_PUBLISH' | 'PUBLISHED' | 'INCOMPLETE' | 'ARCHIVED';
    checklist: {
      hasIdentity: boolean;
      hasPhotos: boolean;
      hasPricing: boolean;
      hasInventory: boolean;
    };
  };
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

  // 6. Calcule la readiness
  const hasIdentity = (prodRow.description ?? '').trim().length > 0 && targetVariant.isActive;

  const isPublishable = hasIdentity && hasPhotos && hasPricing && hasInventory;

  let statusSummary: UnifiedBike['readiness']['statusSummary'] = 'INCOMPLETE';
  if (prodRow.publicationStatus === 'ARCHIVED') {
    statusSummary = 'ARCHIVED';
  } else if (prodRow.publicationStatus === 'PUBLISHED') {
    statusSummary = 'PUBLISHED';
  } else if (isPublishable) {
    statusSummary = 'READY_TO_PUBLISH';
  }

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
