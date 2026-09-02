import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingItems,
  bookings,
  categories,
  inventoryBlocks,
  inventoryItems,
  locations,
  maintenanceCases,
  manualBlockSeries,
  manualBlockSeriesOccurrences,
  products,
  productVariants,
  users,
} from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import { clipPlanningInterval, getDefaultWeekWindow } from './get-operational-planning';
import type {
  GetOperationalItemCalendarOptions,
  OperationalItemCalendar,
  OperationalItemCalendarEvent,
  OperationalPlanningFleetItem,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ligne enrichie lue par le read model avant normalisation en événement. */
export interface OperationalItemCalendarSourceRow {
  inventoryBlockId: string;
  blockType: string;
  blockStatus: string;
  blockCustomerStartAt: Date;
  blockCustomerEndAt: Date;
  blockStartAt: Date;
  blockEndAt: Date;
  holdExpiresAt: Date | null;
  bookingId: string | null;
  bookingStatus: string | null;
  bookingCustomerStartAt: Date | null;
  bookingCustomerEndAt: Date | null;
  customerDisplayName: string | null;
  customerEmail: string | null;
  maintenanceCaseId: string | null;
  maintenanceStatus: string | null;
  maintenanceReason: string | null;
  recurringSeriesId: string | null;
}

/**
 * Timeline mono-exemplaire fondée sur les blocs d'autorité existants.
 *
 * La fonction ne crée aucune nouvelle règle de disponibilité : elle lit les
 * blocs ACTIVE/PAYMENT_PROCESSING déjà utilisés par le moteur de réservation,
 * puis les enrichit avec les détails réservation, maintenance et série
 * récurrente. Toutes les bornes restent des instants UTC ; le fuseau du lieu
 * est renvoyé pour que l'interface formate les dates sans recalcul métier.
 */
export async function getOperationalItemCalendar(
  db: DatabaseClient,
  organizationId: string,
  inventoryItemId: string,
  options?: GetOperationalItemCalendarOptions,
): Promise<OperationalItemCalendar | null> {
  assertUuid(organizationId, 'organizationId');
  assertUuid(inventoryItemId, 'inventoryItemId');
  if (options?.locationId) assertUuid(options.locationId, 'locationId');
  validateDate(options?.asOf, 'asOf');
  validateDate(options?.from, 'La date de début');
  validateDate(options?.to, 'La date de fin');
  if (options?.from && options?.to && options.to <= options.from) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  // L'exemplaire et son établissement sont résolus ensemble sous le tenant.
  // Une absence (ou un mauvais établissement) reste indistinguable d'un item
  // inexistant afin de ne jamais révéler une organisation étrangère.
  const [itemRow] = await db
    .select({
      id: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      productName: products.name,
      variantName: productVariants.name,
      categorySlug: categories.slug,
      condition: inventoryItems.condition,
      status: inventoryItems.status,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
    })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.id, inventoryItemId),
        isNull(inventoryItems.deletedAt),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        isNull(locations.deletedAt),
        options?.locationId ? eq(inventoryItems.currentLocationId, options.locationId) : undefined,
      ),
    )
    .limit(1);

  if (!itemRow) return null;

  const asOf = options?.asOf ?? new Date();
  validateDate(asOf, 'asOf');
  const defaultWindow = getDefaultWeekWindow(asOf, itemRow.locationTimeZone);
  const from = options?.from ?? defaultWindow.from;
  const to = options?.to ?? defaultWindow.to;
  validateDate(from, 'Les dates du calendrier');
  validateDate(to, 'Les dates du calendrier');
  if (to <= from) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  const rows = await db
    .select({
      inventoryBlockId: inventoryBlocks.id,
      blockType: inventoryBlocks.type,
      blockStatus: inventoryBlocks.status,
      blockCustomerStartAt: inventoryBlocks.customerStartAt,
      blockCustomerEndAt: inventoryBlocks.customerEndAt,
      blockStartAt: inventoryBlocks.blockedStartAt,
      blockEndAt: inventoryBlocks.blockedEndAt,
      holdExpiresAt: inventoryBlocks.expiresAt,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      bookingCustomerStartAt: bookings.customerStartAt,
      bookingCustomerEndAt: bookings.customerEndAt,
      customerDisplayName: users.displayName,
      customerEmail: users.email,
      maintenanceCaseId: maintenanceCases.id,
      maintenanceStatus: maintenanceCases.status,
      maintenanceReason: maintenanceCases.reason,
      recurringSeriesId: manualBlockSeries.id,
    })
    .from(inventoryBlocks)
    .innerJoin(inventoryItems, eq(inventoryBlocks.inventoryItemId, inventoryItems.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .leftJoin(bookingItems, eq(bookingItems.bookingBlockId, inventoryBlocks.id))
    .leftJoin(
      bookings,
      and(eq(bookings.id, bookingItems.bookingId), eq(bookings.organizationId, organizationId)),
    )
    .leftJoin(users, eq(users.id, bookings.customerUserId))
    .leftJoin(
      maintenanceCases,
      and(
        eq(maintenanceCases.maintenanceBlockId, inventoryBlocks.id),
        eq(maintenanceCases.organizationId, organizationId),
        isNull(maintenanceCases.deletedAt),
      ),
    )
    .leftJoin(
      manualBlockSeriesOccurrences,
      eq(manualBlockSeriesOccurrences.inventoryBlockId, inventoryBlocks.id),
    )
    .leftJoin(
      manualBlockSeries,
      and(
        eq(manualBlockSeries.id, manualBlockSeriesOccurrences.seriesId),
        eq(manualBlockSeries.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(inventoryBlocks.organizationId, organizationId),
        eq(inventoryBlocks.inventoryItemId, inventoryItemId),
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.currentLocationId, itemRow.locationId),
        eq(locations.organizationId, organizationId),
        eq(locations.id, itemRow.locationId),
        inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
        isNull(inventoryBlocks.deletedAt),
        isNull(inventoryItems.deletedAt),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        isNull(locations.deletedAt),
        sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(
      asc(inventoryBlocks.blockedStartAt),
      asc(inventoryBlocks.blockedEndAt),
      asc(inventoryBlocks.id),
    );

  const item: OperationalPlanningFleetItem = {
    id: itemRow.id,
    internalSku: itemRow.internalSku,
    serialNumber: itemRow.serialNumber,
    productName: itemRow.productName,
    variantName: itemRow.variantName,
    categorySlug: itemRow.categorySlug,
    condition: itemRow.condition,
    status: itemRow.status,
    locationId: itemRow.locationId,
    locationName: itemRow.locationName,
  };

  const events = buildOperationalItemCalendarEvents(rows, item, itemRow.locationTimeZone, from, to);

  return {
    from,
    to,
    locationId: item.locationId,
    locationName: item.locationName,
    locationTimeZone: itemRow.locationTimeZone,
    item,
    events,
  };
}

/**
 * Normalise les blocs déjà filtrés par la requête en événements UI.
 * Exportée pour tester l'agrégation sans base de données : aucune décision de
 * disponibilité ne doit être réimplémentée dans le composant Web.
 */
export function buildOperationalItemCalendarEvents(
  rows: readonly OperationalItemCalendarSourceRow[],
  item: OperationalPlanningFleetItem,
  locationTimeZone: string,
  from: Date,
  to: Date,
): OperationalItemCalendarEvent[] {
  const events: OperationalItemCalendarEvent[] = [];
  for (const row of rows) {
    const clipped = clipPlanningInterval(row.blockStartAt, row.blockEndAt, from, to);
    if (!clipped) continue;

    const eventType = toCalendarEventType(row.blockType);
    if (!eventType) continue;

    const event: OperationalItemCalendarEvent = {
      id: calendarEventId(row.blockType, row.inventoryBlockId, row.bookingId),
      type: eventType,
      inventoryBlockId: row.inventoryBlockId,
      inventoryItemId: item.id,
      internalSku: item.internalSku,
      productName: item.productName,
      variantName: item.variantName,
      categorySlug: item.categorySlug,
      locationId: item.locationId,
      locationName: item.locationName,
      locationTimeZone,
      startAt: clipped.startAt,
      endAt: clipped.endAt,
      blockedStartAt: row.blockStartAt,
      blockedEndAt: row.blockEndAt,
      customerStartAt: row.bookingCustomerStartAt ?? row.blockCustomerStartAt,
      customerEndAt: row.bookingCustomerEndAt ?? row.blockCustomerEndAt,
      status: row.maintenanceStatus ?? row.bookingStatus ?? row.blockStatus,
    };

    if (eventType === 'HOLD') {
      event.holdId = row.inventoryBlockId;
      event.holdExpiresAt = row.holdExpiresAt ?? undefined;
      event.reason = 'Hold temporaire';
    } else if (eventType === 'RENTAL') {
      event.bookingId = row.bookingId ?? undefined;
      event.customerName = row.customerDisplayName ?? row.customerEmail ?? undefined;
      event.reason = 'Réservation';
    } else if (eventType === 'MAINTENANCE') {
      event.maintenanceCaseId = row.maintenanceCaseId ?? undefined;
      event.reason = row.maintenanceReason ?? 'Maintenance';
    } else {
      event.manualBlockId = row.inventoryBlockId;
      event.recurringSeriesId = row.recurringSeriesId ?? undefined;
      event.reason = row.recurringSeriesId
        ? 'Indisponibilité manuelle récurrente'
        : 'Indisponibilité manuelle';
    }

    events.push(event);
  }
  return events;
}

function toCalendarEventType(blockType: string): OperationalItemCalendarEvent['type'] | null {
  switch (blockType) {
    case 'HOLD':
      return 'HOLD';
    case 'BOOKING':
      return 'RENTAL';
    case 'MAINTENANCE':
      return 'MAINTENANCE';
    case 'MANUAL_BLOCK':
      return 'MANUAL_BLOCK';
    default:
      return null;
  }
}

function calendarEventId(blockType: string, blockId: string, bookingId: string | null): string {
  if (blockType === 'BOOKING' && bookingId) return `rental_${bookingId}_${blockId}`;
  if (blockType === 'HOLD') return `hold_${blockId}`;
  if (blockType === 'MAINTENANCE') return `maintenance_${blockId}`;
  if (blockType === 'MANUAL_BLOCK') return `manual_block_${blockId}`;
  return `block_${blockId}`;
}

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new CatalogError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}

function validateDate(value: Date | undefined, label: string): void {
  if (value && !Number.isFinite(value.getTime())) {
    throw new CatalogError('VALIDATION', `${label} doit être une Date valide.`);
  }
}
