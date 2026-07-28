import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryMovements, inventoryItems } from '@uttily/database';
import type { InventoryMovementRecord } from './types';

/**
 * Liste l'historique des mouvements d'un exemplaire (append-only).
 * Tri par date de création croissante (chronologique).
 * Vérifie l'appartenance de l'exemplaire à l'organisation (isolation multi-tenant).
 */
export async function listMovements(
  db: DatabaseClient,
  organizationId: string,
  inventoryItemId: string,
): Promise<InventoryMovementRecord[]> {
  // Vérifie que l'exemplaire appartient à l'organisation.
  const [item] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.id, inventoryItemId),
        eq(inventoryItems.organizationId, organizationId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  if (!item) return [];

  const rows = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.inventoryItemId, inventoryItemId))
    .orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id));
  return rows.map((r) => ({
    id: r.id,
    inventoryItemId: r.inventoryItemId,
    fromLocationId: r.fromLocationId,
    toLocationId: r.toLocationId,
    reason: r.reason,
    createdBy: r.createdBy,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
  }));
}
