import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  maintenanceCases,
  inventoryBlocks,
  inventoryItems,
  productVariants,
  products,
  categories,
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
      id: maintenanceCases.id,
      maintenanceBlockId: maintenanceCases.maintenanceBlockId,
      inventoryItemId: maintenanceCases.inventoryItemId,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      productName: products.name,
      variantName: productVariants.name,
      categorySlug: categories.slug,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      status: maintenanceCases.status,
      condition: inventoryItems.condition,
      reason: maintenanceCases.reason,
      openedNotes: maintenanceCases.openedNotes,
      resolutionNotes: maintenanceCases.resolutionNotes,
      sourceDamageReportId: maintenanceCases.sourceDamageReportId,
      openedBy: maintenanceCases.openedBy,
      openedAt: maintenanceCases.openedAt,
      startedBy: maintenanceCases.startedBy,
      startedAt: maintenanceCases.startedAt,
      resolvedBy: maintenanceCases.resolvedBy,
      resolvedAt: maintenanceCases.resolvedAt,
      blockStatus: inventoryBlocks.status,
      damageDescription: damageReports.description,
    })
    .from(maintenanceCases)
    .innerJoin(inventoryItems, eq(maintenanceCases.inventoryItemId, inventoryItems.id))
    .innerJoin(inventoryBlocks, eq(maintenanceCases.maintenanceBlockId, inventoryBlocks.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .leftJoin(damageReports, eq(maintenanceCases.sourceDamageReportId, damageReports.id))
    .where(
      and(
        eq(maintenanceCases.organizationId, organizationId),
        isNull(maintenanceCases.deletedAt),
        isNull(inventoryItems.deletedAt),
        isNull(inventoryBlocks.deletedAt),
      ),
    )
    .orderBy(desc(maintenanceCases.openedAt));

  return rows.map((r) => {
    const status: MaintenanceCaseStatus = r.status;
    const reason = r.reason || r.damageDescription || 'Maintenance préventive / Atelier';

    return {
      id: r.id,
      maintenanceBlockId: r.maintenanceBlockId,
      inventoryItemId: r.inventoryItemId,
      internalSku: r.internalSku,
      serialNumber: r.serialNumber,
      productName: r.productName,
      variantName: r.variantName,
      categorySlug: r.categorySlug,
      locationId: r.locationId,
      locationName: r.locationName,
      locationTimeZone: r.locationTimeZone,
      status,
      condition: r.condition,
      reason,
      openedNotes: r.openedNotes,
      resolutionNotes: r.resolutionNotes,
      sourceDamageReportId: r.sourceDamageReportId,
      openedBy: r.openedBy,
      openedAt: r.openedAt,
      startedBy: r.startedBy,
      startedAt: r.startedAt,
      resolvedBy: r.resolvedBy,
      resolvedAt: r.resolvedAt,
    };
  });
}

export async function getMaintenanceCaseDetails(
  db: DatabaseClient,
  organizationId: string,
  caseIdOrBlockId: string,
): Promise<MaintenanceCaseSummary | null> {
  const cases = await listMaintenanceCases(db, organizationId);
  return (
    cases.find((c) => c.id === caseIdOrBlockId || c.maintenanceBlockId === caseIdOrBlockId) ?? null
  );
}
