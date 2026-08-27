import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryItems } from '@uttily/database';
import type { AvailableItemSummary } from './types';
import { CatalogError } from '../catalog/errors';

/**
 * Trouve les exemplaires ACTIVE dans un établissement qui n'ont AUCUN bloc
 * ACTIVE ou PAYMENT_PROCESSING chevauchant la période [startAt, endAt],
 * et dont l'état physique n'est pas BROKEN.
 *
 * Utilise un NOT EXISTS subquery sur inventory_blocks avec tstzrange overlap.
 * La disponibilité est calculée côté PostgreSQL (autorité transactionnelle).
 *
 * Les noms de colonnes SQL sont en dur car Drizzle ne supporte pas les
 * références de table cross-query dans les templates sql pour les subqueries
 * NOT EXISTS. Les dates sont converties en ISO strings avec cast ::timestamptz
 * car postgres.js ne sérialise pas les Date sans encodeur de colonne.
 */
export async function findAvailableItems(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
  startAt: Date,
  endAt: Date,
): Promise<AvailableItemSummary[]> {
  if (
    !startAt ||
    !endAt ||
    !Number.isFinite(startAt.getTime()) ||
    !Number.isFinite(endAt.getTime()) ||
    endAt <= startAt
  ) {
    throw new CatalogError(
      'VALIDATION',
      'La période de recherche est invalide (fin doit être après début).',
    );
  }
  const rows = await db
    .select({
      id: inventoryItems.id,
      organizationId: inventoryItems.organizationId,
      productVariantId: inventoryItems.productVariantId,
      internalSku: inventoryItems.internalSku,
      condition: inventoryItems.condition,
      status: inventoryItems.status,
      currentLocationId: inventoryItems.currentLocationId,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.currentLocationId, locationId),
        eq(inventoryItems.status, 'ACTIVE'),
        ne(inventoryItems.condition, 'BROKEN'),
        isNull(inventoryItems.deletedAt),
        // NOT EXISTS : aucun bloc ACTIVE/PAYMENT_PROCESSING chevauchant la période.
        sql`NOT EXISTS (
          SELECT 1 FROM "inventory_blocks"
          WHERE "inventory_blocks"."inventory_item_id" = ${inventoryItems.id}
            AND "inventory_blocks"."status" IN ('ACTIVE', 'PAYMENT_PROCESSING')
            AND "inventory_blocks"."deleted_at" IS NULL
            AND tstzrange("inventory_blocks"."blocked_start_at", "inventory_blocks"."blocked_end_at")
                && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)
        )`,
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    productVariantId: r.productVariantId,
    internalSku: r.internalSku,
    condition: r.condition,
    status: r.status,
    currentLocationId: r.currentLocationId,
  }));
}
