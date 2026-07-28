import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  inventoryItems,
  inventoryMovements,
  locations,
  productVariants,
  products,
} from '@uttily/database';
import type {
  ActiveVariantOption,
  InventoryDetails,
  InventoryMovementRecord,
  InventorySummary,
  ProductDetails,
  ProductSummary,
  PublicationReadiness,
  PublicationStatus,
} from './types';
import { collectPublicationFailures } from './products';

// ---------------------------------------------------------------------------
// Helpers de mapping internes (évite de dupliquer la logique des mappers
// privés de inventory.ts / variants.ts / products.ts).
// ---------------------------------------------------------------------------

function mapMovementRow(row: typeof inventoryMovements.$inferSelect): InventoryMovementRecord {
  return {
    id: row.id,
    inventoryItemId: row.inventoryItemId,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    reason: row.reason,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 1. listProductSummaries
// ---------------------------------------------------------------------------

/**
 * Liste les résumés de produits d'une organisation (non supprimés, archivés inclus).
 * Évite le N+1 : 2 queries (products+categories, puis counts groupés par productId).
 */
export async function listProductSummaries(
  db: DatabaseClient,
  organizationId: string,
): Promise<ProductSummary[]> {
  // Query 1 : produits + nom de catégorie.
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      publicationStatus: products.publicationStatus,
      categoryId: products.categoryId,
      categoryName: categories.name,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)));

  if (productRows.length === 0) return [];

  const productIds = productRows.map((p) => p.id);

  // Query 2a : comptage des variantes actives par productId.
  const variantCountRows = await db
    .select({ productId: productVariants.productId, value: count() })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .groupBy(productVariants.productId);
  const variantCountMap = new Map<string, number>(
    variantCountRows.map((r) => [r.productId, Number(r.value)]),
  );

  // Query 2b : comptage des exemplaires actifs par productId.
  // On joint product_variants pour remonter au productId.
  const inventoryCountRows = await db
    .select({ productId: products.id, value: count() })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(inventoryItems.status, 'ACTIVE'),
        isNull(inventoryItems.deletedAt),
        isNull(productVariants.deletedAt),
      ),
    )
    .groupBy(products.id);
  const inventoryCountMap = new Map<string, number>(
    inventoryCountRows.map((r) => [r.productId, Number(r.value)]),
  );

  return productRows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    publicationStatus: p.publicationStatus as PublicationStatus,
    categoryId: p.categoryId,
    categoryName: p.categoryName,
    activeVariantCount: variantCountMap.get(p.id) ?? 0,
    activeInventoryCount: inventoryCountMap.get(p.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// 2. getProductDetails
// ---------------------------------------------------------------------------

/**
 * Retourne les détails complets d'un produit : produit, catégorie, variantes,
 * comptages et readiness de publication. null si non trouvé ou autre org.
 */
export async function getProductDetails(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductDetails | null> {
  // Charge le produit (filtre orgId + non supprimé).
  const [productRow] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.id, productId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!productRow) return null;

  // Charge la catégorie.
  const [catRow] = await db
    .select({ id: categories.id, name: categories.name, isActive: categories.isActive })
    .from(categories)
    .where(eq(categories.id, productRow.categoryId))
    .limit(1);

  // Charge les variantes (tri par createdAt croissant).
  const variantRows = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.createdAt), asc(productVariants.id));

  const variantIds = variantRows.map((v) => v.id);

  // Comptage des variantes actives.
  const [activeVariantCountRow] = await db
    .select({ value: count() })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    );
  const activeVariantCount = Number(activeVariantCountRow?.value ?? 0);

  // Comptage des exemplaires actifs (via variantes du produit).
  let activeInventoryCount = 0;
  if (variantIds.length > 0) {
    const [activeInventoryCountRow] = await db
      .select({ value: count() })
      .from(inventoryItems)
      .where(
        and(
          inArray(inventoryItems.productVariantId, variantIds),
          eq(inventoryItems.status, 'ACTIVE'),
          isNull(inventoryItems.deletedAt),
        ),
      );
    activeInventoryCount = Number(activeInventoryCountRow?.value ?? 0);
  }

  // Readiness de publication (lecture ponctuelle, sans transaction).
  const failures = await collectPublicationFailures(db, productId);

  return {
    product: {
      id: productRow.id,
      organizationId: productRow.organizationId,
      categoryId: productRow.categoryId,
      name: productRow.name,
      slug: productRow.slug,
      description: productRow.description,
      publicationStatus: productRow.publicationStatus as PublicationStatus,
    },
    category: catRow
      ? { id: catRow.id, name: catRow.name, isActive: catRow.isActive }
      : { id: productRow.categoryId, name: '', isActive: false },
    variants: variantRows.map((v) => ({
      id: v.id,
      productId: v.productId,
      name: v.name,
      skuSuffix: v.skuSuffix,
      attributes: v.attributes as Record<string, unknown>,
      isActive: v.isActive,
    })),
    activeVariantCount,
    activeInventoryCount,
    publicationReadiness: { ready: failures.length === 0, failures },
  };
}

// ---------------------------------------------------------------------------
// 3. listInventorySummaries
// ---------------------------------------------------------------------------

/**
 * Liste les résumés d'exemplaires d'une organisation (non supprimés).
 * JOIN inventory_items + product_variants + products + locations.
 */
export async function listInventorySummaries(
  db: DatabaseClient,
  organizationId: string,
): Promise<InventorySummary[]> {
  const rows = await db
    .select({
      id: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      condition: inventoryItems.condition,
      status: inventoryItems.status,
      productVariantId: inventoryItems.productVariantId,
      variantName: productVariants.name,
      productId: products.id,
      productName: products.name,
      currentLocationId: inventoryItems.currentLocationId,
      locationName: locations.name,
    })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        isNull(inventoryItems.deletedAt),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        isNull(locations.deletedAt),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    internalSku: r.internalSku,
    serialNumber: r.serialNumber,
    condition: r.condition as InventorySummary['condition'],
    status: r.status as InventorySummary['status'],
    productVariantId: r.productVariantId,
    variantName: r.variantName,
    productId: r.productId,
    productName: r.productName,
    currentLocationId: r.currentLocationId,
    locationName: r.locationName,
  }));
}

// ---------------------------------------------------------------------------
// 4. getInventoryDetails
// ---------------------------------------------------------------------------

/**
 * Retourne les détails d'un exemplaire : item, variante, produit, location,
 * et les 50 derniers mouvements (tri createdAt DESC, id DESC).
 * null si non trouvé ou autre org.
 */
export async function getInventoryDetails(
  db: DatabaseClient,
  organizationId: string,
  itemId: string,
): Promise<InventoryDetails | null> {
  // Charge l'exemplaire (filtre orgId + non supprimé).
  const [itemRow] = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.id, itemId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  if (!itemRow) return null;

  // Charge la variante — filtre soft delete.
  const [variantRow] = await db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      productId: productVariants.productId,
    })
    .from(productVariants)
    .where(and(eq(productVariants.id, itemRow.productVariantId), isNull(productVariants.deletedAt)))
    .limit(1);

  // Charge le produit — filtre soft delete.
  let productInfo: { id: string; name: string } | null = null;
  if (variantRow) {
    const [productRow] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.id, variantRow.productId), isNull(products.deletedAt)))
      .limit(1);
    productInfo = productRow ?? null;
  }

  // Charge la location — filtre soft delete + défense en profondeur multi-tenant.
  const [locationRow] = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(
      and(
        eq(locations.id, itemRow.currentLocationId),
        eq(locations.organizationId, organizationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  // Charge les 50 derniers mouvements (tri DESC).
  const movementRows = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.inventoryItemId, itemId))
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(50);

  return {
    item: {
      id: itemRow.id,
      organizationId: itemRow.organizationId,
      productVariantId: itemRow.productVariantId,
      internalSku: itemRow.internalSku,
      serialNumber: itemRow.serialNumber,
      condition: itemRow.condition as InventoryDetails['item']['condition'],
      status: itemRow.status as InventoryDetails['item']['status'],
      currentLocationId: itemRow.currentLocationId,
      notes: itemRow.notes,
    },
    variant: variantRow
      ? { id: variantRow.id, name: variantRow.name, productId: variantRow.productId }
      : { id: itemRow.productVariantId, name: '', productId: '' },
    product: productInfo ?? { id: '', name: '' },
    location: locationRow
      ? { id: locationRow.id, name: locationRow.name }
      : { id: itemRow.currentLocationId, name: '' },
    movements: movementRows.map(mapMovementRow),
  };
}

// ---------------------------------------------------------------------------
// 5. listActiveVariantOptions
// ---------------------------------------------------------------------------

/**
 * Liste les variantes actives (non supprimées) d'une organisation,
 * avec le nom du produit parent. Utilisé pour les listes déroulantes (selects).
 */
export async function listActiveVariantOptions(
  db: DatabaseClient,
  organizationId: string,
): Promise<ActiveVariantOption[]> {
  const rows = await db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      productId: products.id,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    productId: r.productId,
    productName: r.productName,
  }));
}

// ---------------------------------------------------------------------------
// 6. getProductPublicationReadiness
// ---------------------------------------------------------------------------

/**
 * Retourne l'état de readiness de publication d'un produit.
 * null si le produit n'existe pas ou n'appartient pas à l'organisation.
 */
export async function getProductPublicationReadiness(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<PublicationReadiness | null> {
  // Vérifie que le produit existe et appartient à l'org.
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.id, productId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!productRow) return null;

  // Lecture ponctuelle (sans transaction) via le helper partagé.
  const failures = await collectPublicationFailures(db, productId);
  return { ready: failures.length === 0, failures };
}
