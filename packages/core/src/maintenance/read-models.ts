import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  inventoryBlocks,
  inventoryItems,
  productVariants,
  products,
  locations,
  damageReports,
} from '@uttily/database';
import type { MaintenanceCaseSummary, MaintenanceCaseStatus } from './types';

export async function listMaintenanceCases(
  db: DatabaseClient,
  organizationId: string,
): Promise<MaintenanceCaseSummary[]> {
  const rows = await db
    .select({
      id: inventoryBlocks.id,
      inventoryItemId: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      productName: products.name,
      variantName: productVariants.name,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      blockStatus: inventoryBlocks.status,
      condition: inventoryItems.condition,
      sourceId: inventoryBlocks.sourceId,
      openedAt: inventoryBlocks.createdAt,
      resolvedAt: inventoryBlocks.updatedAt,
      damageDescription: damageReports.description,
    })
    .from(inventoryBlocks)
    .innerJoin(inventoryItems, eq(inventoryBlocks.inventoryItemId, inventoryItems.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .leftJoin(damageReports, eq(inventoryBlocks.sourceId, damageReports.id))
    .where(
      and(
        eq(inventoryBlocks.organizationId, organizationId),
        eq(inventoryBlocks.type, 'MAINTENANCE'),
        isNull(inventoryBlocks.deletedAt),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .orderBy(desc(inventoryBlocks.createdAt));

  return rows.map((r) => {
    const status: MaintenanceCaseStatus =
      r.blockStatus === 'RELEASED' ? 'RESOLVED' : r.condition === 'BROKEN' ? 'OPEN' : 'IN_PROGRESS';

    const reason = r.damageDescription ?? 'Maintenance préventive / Atelier';

    return {
      id: r.id,
      inventoryItemId: r.inventoryItemId,
      internalSku: r.internalSku,
      serialNumber: r.serialNumber,
      productName: r.productName,
      variantName: r.variantName,
      locationId: r.locationId,
      locationName: r.locationName,
      locationTimeZone: r.locationTimeZone,
      status,
      condition: r.condition,
      reason,
      notes: null,
      sourceDamageReportId: r.sourceId,
      openedAt: r.openedAt,
      resolvedAt: r.blockStatus === 'RELEASED' ? r.resolvedAt : null,
    };
  });
}

export async function getMaintenanceCaseDetails(
  db: DatabaseClient,
  organizationId: string,
  maintenanceBlockId: string,
): Promise<MaintenanceCaseSummary | null> {
  const cases = await listMaintenanceCases(db, organizationId);
  return cases.find((c) => c.id === maintenanceBlockId) ?? null;
}
