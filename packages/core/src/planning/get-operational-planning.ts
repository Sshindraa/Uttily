import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingItems,
  inventoryBlocks,
  inventoryItems,
  locations,
  maintenanceCases,
  products,
  productVariants,
  users,
} from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import type {
  GetOperationalPlanningOptions,
  OperationalPlanning,
  OperationalPlanningEvent,
  OperationalPlanningFleetItem,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getOperationalPlanning(
  db: DatabaseClient,
  organizationId: string,
  options?: GetOperationalPlanningOptions,
): Promise<OperationalPlanning> {
  if (!UUID_REGEX.test(organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }

  // 1. Fenêtre temporelle : par défaut semaine courante (lundi 00:00 -> dimanche 23:59:59)
  const now = new Date();
  let from = options?.from;
  let to = options?.to;

  if (!from || !to) {
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1); // ajuster pour lundi
    startOfWeek.setDate(diff);
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    endOfWeek.setMilliseconds(endOfWeek.getMilliseconds() - 1);

    from = from ?? startOfWeek;
    to = to ?? endOfWeek;
  }

  if (to <= from) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  // 2. Établissement
  const locationRows = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.organizationId, organizationId),
        isNull(locations.deletedAt),
        options?.locationId ? eq(locations.id, options.locationId) : undefined,
      ),
    )
    .orderBy(asc(locations.name));

  const primaryLocation = locationRows[0];
  const locationTimeZone = primaryLocation?.timeZone ?? 'Europe/Paris';
  const locationId = options?.locationId ?? primaryLocation?.id ?? null;
  const locationName = primaryLocation?.name ?? null;

  // 3. Flotte d'exemplaires physiques
  const fleetRows = await db
    .select({
      id: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      productName: products.name,
      variantName: productVariants.name,
      condition: inventoryItems.condition,
      status: inventoryItems.status,
      locationId: locations.id,
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
        locationId ? eq(inventoryItems.currentLocationId, locationId) : undefined,
        options?.inventoryItemId ? eq(inventoryItems.id, options.inventoryItemId) : undefined,
      ),
    )
    .orderBy(asc(inventoryItems.internalSku));

  const fleetItems: OperationalPlanningFleetItem[] = fleetRows.map((r) => ({
    id: r.id,
    internalSku: r.internalSku,
    serialNumber: r.serialNumber,
    productName: r.productName,
    variantName: r.variantName,
    condition: r.condition,
    status: r.status,
    locationId: r.locationId,
    locationName: r.locationName,
  }));

  // 4. Réservations actives sur la période
  const bookingRows = await db
    .select({
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      customerEmail: users.email,
      inventoryItemId: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      productName: products.name,
      variantName: productVariants.name,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
    })
    .from(bookings)
    .innerJoin(bookingItems, eq(bookingItems.bookingId, bookings.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .innerJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .where(
      and(
        eq(bookings.organizationId, organizationId),
        inArray(bookings.status, ['CONFIRMED', 'ACTIVE', 'RETURNED']),
        isNull(inventoryItems.deletedAt),
        locationId ? eq(bookings.locationId, locationId) : undefined,
        options?.inventoryItemId
          ? eq(bookingItems.inventoryItemId, options.inventoryItemId)
          : undefined,
        // Overlap avec la période
        sql`tstzrange(${bookings.customerStartAt}, ${bookings.customerEndAt}) && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`,
      ),
    );

  // 5. Maintenances actives sur la période
  const maintenanceRows = await db
    .select({
      maintenanceCaseId: maintenanceCases.id,
      caseStatus: maintenanceCases.status,
      reason: maintenanceCases.reason,
      inventoryItemId: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      productName: products.name,
      variantName: productVariants.name,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      blockedStartAt: inventoryBlocks.blockedStartAt,
      blockedEndAt: inventoryBlocks.blockedEndAt,
      blockStatus: inventoryBlocks.status,
    })
    .from(maintenanceCases)
    .innerJoin(inventoryBlocks, eq(maintenanceCases.maintenanceBlockId, inventoryBlocks.id))
    .innerJoin(inventoryItems, eq(maintenanceCases.inventoryItemId, inventoryItems.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .where(
      and(
        eq(maintenanceCases.organizationId, organizationId),
        isNull(maintenanceCases.deletedAt),
        isNull(inventoryBlocks.deletedAt),
        locationId ? eq(inventoryItems.currentLocationId, locationId) : undefined,
        options?.inventoryItemId ? eq(inventoryItems.id, options.inventoryItemId) : undefined,
        sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`,
      ),
    );

  // 6. Construction des événements normalisés
  const events: OperationalPlanningEvent[] = [];
  let totalPickups = 0;
  let totalReturns = 0;

  for (const b of bookingRows) {
    // Événement global de location
    events.push({
      id: `rental_${b.bookingId}_${b.inventoryItemId}`,
      type: 'RENTAL',
      bookingId: b.bookingId,
      inventoryItemId: b.inventoryItemId,
      internalSku: b.internalSku,
      productName: b.productName,
      variantName: b.variantName,
      locationId: b.locationId,
      locationName: b.locationName,
      locationTimeZone: b.locationTimeZone,
      startAt: b.customerStartAt,
      endAt: b.customerEndAt,
      status: b.bookingStatus,
      customerName: b.customerEmail,
    });

    // Départ
    if (b.customerStartAt >= from && b.customerStartAt <= to) {
      totalPickups++;
      events.push({
        id: `pickup_${b.bookingId}_${b.inventoryItemId}`,
        type: 'PICKUP',
        bookingId: b.bookingId,
        inventoryItemId: b.inventoryItemId,
        internalSku: b.internalSku,
        productName: b.productName,
        variantName: b.variantName,
        locationId: b.locationId,
        locationName: b.locationName,
        locationTimeZone: b.locationTimeZone,
        startAt: b.customerStartAt,
        endAt: b.customerStartAt,
        status: b.bookingStatus,
        customerName: b.customerEmail,
      });
    }

    // Retour
    if (b.customerEndAt >= from && b.customerEndAt <= to) {
      totalReturns++;
      events.push({
        id: `return_${b.bookingId}_${b.inventoryItemId}`,
        type: 'RETURN',
        bookingId: b.bookingId,
        inventoryItemId: b.inventoryItemId,
        internalSku: b.internalSku,
        productName: b.productName,
        variantName: b.variantName,
        locationId: b.locationId,
        locationName: b.locationName,
        locationTimeZone: b.locationTimeZone,
        startAt: b.customerEndAt,
        endAt: b.customerEndAt,
        status: b.bookingStatus,
        customerName: b.customerEmail,
      });
    }
  }

  for (const m of maintenanceRows) {
    // Clipper la date sentinelle 9999-12-31 à la date de fin de fenêtre pour l'affichage propre
    const effectiveEndAt = m.blockedEndAt > to ? to : m.blockedEndAt;

    events.push({
      id: `maint_${m.maintenanceCaseId}`,
      type: 'MAINTENANCE',
      maintenanceCaseId: m.maintenanceCaseId,
      inventoryItemId: m.inventoryItemId,
      internalSku: m.internalSku,
      productName: m.productName,
      variantName: m.variantName,
      locationId: m.locationId,
      locationName: m.locationName,
      locationTimeZone: m.locationTimeZone,
      startAt: m.blockedStartAt,
      endAt: effectiveEndAt,
      status: m.caseStatus,
      reason: m.reason,
    });
  }

  return {
    from,
    to,
    locationId,
    locationName,
    locationTimeZone,
    events,
    stats: {
      totalRentals: bookingRows.length,
      totalPickups,
      totalReturns,
      totalMaintenances: maintenanceRows.length,
    },
    fleetItems,
  };
}
