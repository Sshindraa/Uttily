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
import {
  civilDayNumber,
  civilDayNumberToDate,
  localDateToUtcMidnight,
  toLocalParts,
} from '../pricing-plans/time-utils';
import type {
  GetOperationalPlanningOptions,
  OperationalPlanning,
  OperationalPlanningEvent,
  OperationalPlanningFleetItem,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getDefaultWeekWindow(asOf: Date, timeZone: string): { from: Date; to: Date } {
  const local = toLocalParts(asOf, timeZone);
  const localDayNumber = civilDayNumber(local.year, local.month, local.day);
  const mondayDate = civilDayNumberToDate(localDayNumber - local.weekday);
  const nextMondayDate = civilDayNumberToDate(localDayNumber - local.weekday + 7);

  return {
    from: localDateToUtcMidnight(mondayDate, timeZone),
    to: localDateToUtcMidnight(nextMondayDate, timeZone),
  };
}

export async function getOperationalPlanning(
  db: DatabaseClient,
  organizationId: string,
  options?: GetOperationalPlanningOptions,
): Promise<OperationalPlanning> {
  if (!UUID_REGEX.test(organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }

  const suppliedAsOf = options?.asOf;
  const suppliedFrom = options?.from;
  const suppliedTo = options?.to;
  if (suppliedAsOf && !Number.isFinite(suppliedAsOf.getTime())) {
    throw new CatalogError('VALIDATION', 'asOf doit être une Date valide.');
  }
  if (suppliedFrom && !Number.isFinite(suppliedFrom.getTime())) {
    throw new CatalogError('VALIDATION', 'La date de début doit être valide.');
  }
  if (suppliedTo && !Number.isFinite(suppliedTo.getTime())) {
    throw new CatalogError('VALIDATION', 'La date de fin doit être valide.');
  }
  if (suppliedFrom && suppliedTo && suppliedTo <= suppliedFrom) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  // 1. Établissement
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
  // Une organisation sans établissement peut encore afficher un état vide.
  // UTC est alors un fuseau d'affichage neutre ; dès qu'un établissement existe,
  // son fuseau IANA est toujours utilisé comme autorité.
  const locationTimeZone = primaryLocation?.timeZone ?? 'UTC';
  const locationId = options?.locationId ?? primaryLocation?.id ?? null;
  const locationName = primaryLocation?.name ?? null;

  // 2. Fenêtre temporelle : semaine locale courante (lundi 00:00 inclus ->
  // lundi suivant 00:00 exclu), calculée dans le fuseau de l'établissement.
  const asOf = options?.asOf ?? new Date();
  if (!Number.isFinite(asOf.getTime())) {
    throw new CatalogError('VALIDATION', 'asOf doit être une Date valide.');
  }
  const defaultWindow = getDefaultWeekWindow(asOf, locationTimeZone);
  const from = options?.from ?? defaultWindow.from;
  const to = options?.to ?? defaultWindow.to;

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new CatalogError('VALIDATION', 'Les dates du planning doivent être valides.');
  }
  if (to <= from) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

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
      customerDisplayName: users.displayName,
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
        inArray(bookings.status, ['CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE', 'RETURNED']),
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
      customerName: b.customerDisplayName ?? b.customerEmail,
    });

    // Départ
    if (b.customerStartAt >= from && b.customerStartAt < to) {
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
        customerName: b.customerDisplayName ?? b.customerEmail,
      });
    }

    // Retour
    if (b.customerEndAt >= from && b.customerEndAt < to) {
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
        customerName: b.customerDisplayName ?? b.customerEmail,
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
      totalRentals: new Set(bookingRows.map((booking) => booking.bookingId)).size,
      totalPickups,
      totalReturns,
      totalMaintenances: maintenanceRows.length,
    },
    fleetItems,
  };
}
