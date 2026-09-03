import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  inventoryBlocks,
  inventoryItems,
  locations,
  products,
  productVariants,
} from '@uttily/database';
import { requireMembership } from '../identity/permissions';
import { FULFILLMENT_OPERATORS } from './operators';
import { getMembership } from '../identity/memberships';
import type { AuthenticatedUser } from '../identity/types';
import { CatalogError } from '../catalog/errors';

export interface GetCounterAvailableItemsInput {
  organizationId: string;
  locationId: string;
  operator: AuthenticatedUser;
  startAt: Date;
  endAt: Date;
}

export interface CounterAvailableItem {
  id: string;
  internalSku: string;
  serialNumber: string | null;
  condition: 'NEW' | 'GOOD' | 'FAIR';
  variantId: string;
  variantName: string | null;
  variantAttributes: Record<string, unknown> | null;
  productId: string;
  productName: string;
  categorySlug: string;
  categoryName: string;
}

export async function getCounterAvailableItems(
  db: DatabaseClient,
  input: GetCounterAvailableItemsInput,
): Promise<{
  location: { id: string; name: string; timeZone: string };
  startAt: Date;
  endAt: Date;
  items: CounterAvailableItem[];
}> {
  // 1. Autorisation de l'opérateur
  const membership = await getMembership(db, input.organizationId, input.operator.id);
  requireMembership(membership, FULFILLMENT_OPERATORS);

  // 2. Vérification de l'établissement
  const [location] = await db
    .select({
      id: locations.id,
      name: locations.name,
      timeZone: locations.timeZone,
      prepBufferMinutes: locations.prepBufferMinutes,
      cleanupBufferMinutes: locations.cleanupBufferMinutes,
      deletedAt: locations.deletedAt,
    })
    .from(locations)
    .where(
      and(
        eq(locations.id, input.locationId),
        eq(locations.organizationId, input.organizationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  if (!location) {
    throw new CatalogError('NOT_FOUND', 'Établissement introuvable ou inaccessible.');
  }

  if (input.endAt <= input.startAt) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  // Calcul des fenêtres bloquées avec les marges de préparation / nettoyage
  const prepMs = (location.prepBufferMinutes ?? 30) * 60_000;
  const cleanupMs = (location.cleanupBufferMinutes ?? 30) * 60_000;
  const blockedStartAt = new Date(input.startAt.getTime() - prepMs);
  const blockedEndAt = new Date(input.endAt.getTime() + cleanupMs);

  // 3. Sous-requête des blocs conflictuels
  const overlappingBlocks = db
    .select({ id: inventoryBlocks.id })
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.inventoryItemId, inventoryItems.id),
        inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
        sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${blockedStartAt.toISOString()}::timestamptz, ${blockedEndAt.toISOString()}::timestamptz)`,
      ),
    );

  // 4. Sélection des exemplaires disponibles
  const rows = await db
    .select({
      id: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      condition: inventoryItems.condition,
      variantId: productVariants.id,
      variantAttributes: productVariants.attributes,
      productId: products.id,
      productName: products.name,
      categorySlug: categories.slug,
      categoryName: categories.name,
    })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(
      and(
        eq(inventoryItems.organizationId, input.organizationId),
        eq(inventoryItems.currentLocationId, input.locationId),
        eq(inventoryItems.status, 'ACTIVE'),
        inArray(inventoryItems.condition, ['NEW', 'GOOD', 'FAIR']),
        isNull(inventoryItems.deletedAt),
        isNull(products.deletedAt),
        notExists(overlappingBlocks),
      ),
    )
    .orderBy(asc(categories.name), asc(products.name), asc(inventoryItems.internalSku));

  const items: CounterAvailableItem[] = rows.map((r) => ({
    id: r.id,
    internalSku: r.internalSku,
    serialNumber: r.serialNumber,
    condition: r.condition as 'NEW' | 'GOOD' | 'FAIR',
    variantId: r.variantId,
    variantName: null,
    variantAttributes: (r.variantAttributes as Record<string, unknown>) ?? null,
    productId: r.productId,
    productName: r.productName,
    categorySlug: r.categorySlug,
    categoryName: r.categoryName,
  }));

  return {
    location: {
      id: location.id,
      name: location.name,
      timeZone: location.timeZone,
    },
    startAt: input.startAt,
    endAt: input.endAt,
    items,
  };
}
