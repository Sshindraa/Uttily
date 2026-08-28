import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  inventoryBlocks,
  inventoryItems,
  locations,
  productVariants,
  products,
} from '@uttily/database';
import { DashboardError } from './errors';
import type {
  ListMaintenanceDashboardSignalsOptions,
  MaintenanceBlockForClassification,
  MaintenanceBlockSignalKind,
  MaintenanceDashboardBrokenItemSignal,
  MaintenanceDashboardSignal,
  MaintenanceDashboardMaintenanceSignal,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertUuid(value: string, field: string): void {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new DashboardError('VALIDATION', `${field} invalide (UUID attendu).`);
  }
}

function assertDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DashboardError('VALIDATION', `${field} doit être une Date valide.`);
  }
  return new Date(value.getTime());
}

function addTwentyFourHours(asOf: Date): Date {
  const horizonMilliseconds = asOf.getTime() + DAY_IN_MILLISECONDS;
  const horizon = new Date(horizonMilliseconds);
  if (!Number.isFinite(horizon.getTime())) {
    throw new DashboardError(
      'VALIDATION',
      'asOf doit permettre de représenter les 24 heures suivantes.',
    );
  }
  return horizon;
}

export function normalizeMaintenanceDashboardLimit(rawLimit?: number): number {
  if (rawLimit === undefined) return 50;
  if (!Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
    throw new DashboardError('VALIDATION', 'limit doit être un entier sûr strictement positif.');
  }
  return Math.min(rawLimit, 100);
}

function normalizeOptions(options?: ListMaintenanceDashboardSignalsOptions): {
  asOf: Date;
  horizon: Date;
  limit: number;
} {
  const asOf = assertDate(options?.asOf ?? new Date(), 'asOf');
  const horizon = addTwentyFourHours(asOf);

  return {
    asOf,
    horizon,
    limit: normalizeMaintenanceDashboardLimit(options?.limit),
  };
}

/**
 * Classe un bloc de maintenance selon l'intervalle semi-ouvert [start, end).
 * Les dates sont comparées en millisecondes UTC ; le fuseau est uniquement
 * une donnée de présentation portée par la location.
 */
export function classifyMaintenanceBlock(
  block: MaintenanceBlockForClassification,
  asOf: Date,
): MaintenanceBlockSignalKind | null {
  const asOfMilliseconds = asOf.getTime();
  const startMilliseconds = block.blockedStartAt.getTime();
  const endMilliseconds = block.blockedEndAt.getTime();
  const horizonMilliseconds = asOfMilliseconds + DAY_IN_MILLISECONDS;

  if (startMilliseconds <= asOfMilliseconds && endMilliseconds > asOfMilliseconds) {
    return 'ACTIVE_MAINTENANCE';
  }
  if (startMilliseconds > asOfMilliseconds && startMilliseconds <= horizonMilliseconds) {
    return 'UPCOMING_MAINTENANCE';
  }
  return null;
}

function signalPriority(signal: MaintenanceDashboardSignal): number {
  switch (signal.kind) {
    case 'ACTIVE_MAINTENANCE':
      return 0;
    case 'BROKEN_ITEM':
      return 1;
    case 'UPCOMING_MAINTENANCE':
      return 2;
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

function compareSignals(
  left: MaintenanceDashboardSignal,
  right: MaintenanceDashboardSignal,
): number {
  const priorityDifference = signalPriority(left) - signalPriority(right);
  if (priorityDifference !== 0) return priorityDifference;

  if (left.kind === 'BROKEN_ITEM' && right.kind === 'BROKEN_ITEM') {
    return (
      compareStrings(left.internalSku, right.internalSku) ||
      compareStrings(left.inventoryItemId, right.inventoryItemId)
    );
  }

  if (left.kind !== 'BROKEN_ITEM' && right.kind !== 'BROKEN_ITEM') {
    return (
      left.blockedStartAt.getTime() - right.blockedStartAt.getTime() ||
      compareStrings(left.inventoryItemId, right.inventoryItemId) ||
      compareStrings(left.maintenanceBlockId, right.maintenanceBlockId)
    );
  }

  return 0;
}

/**
 * Applique l'ordre fermé du dashboard sans muter le tableau fourni.
 */
export function orderMaintenanceDashboardSignals(
  signals: readonly MaintenanceDashboardSignal[],
): MaintenanceDashboardSignal[] {
  return [...signals].sort(compareSignals);
}

export async function listMaintenanceDashboardSignals(
  db: DatabaseClient,
  organizationId: string,
  options?: ListMaintenanceDashboardSignalsOptions,
): Promise<MaintenanceDashboardSignal[]> {
  assertUuid(organizationId, 'organizationId');
  const { asOf, horizon, limit } = normalizeOptions(options);

  // Chaque branche lit au plus `limit` candidats. Comme chaque branche est
  // déjà ordonnée par ses clés finales, cette fenêtre bornée conserve les
  // candidats nécessaires au limit global après fusion.
  const brokenRows = await db
    .select({
      inventoryItemId: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      productName: products.name,
      variantName: productVariants.name,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
    })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.status, 'ACTIVE'),
        eq(inventoryItems.condition, 'BROKEN'),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .orderBy(asc(inventoryItems.internalSku), asc(inventoryItems.id))
    .limit(limit);

  const maintenanceRows = await db
    .select({
      inventoryItemId: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      productName: products.name,
      variantName: productVariants.name,
      locationId: locations.id,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      maintenanceBlockId: inventoryBlocks.id,
      blockedStartAt: inventoryBlocks.blockedStartAt,
      blockedEndAt: inventoryBlocks.blockedEndAt,
    })
    .from(inventoryBlocks)
    .innerJoin(inventoryItems, eq(inventoryBlocks.inventoryItemId, inventoryItems.id))
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(locations, eq(inventoryItems.currentLocationId, locations.id))
    .where(
      and(
        eq(inventoryBlocks.organizationId, organizationId),
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryBlocks.type, 'MAINTENANCE'),
        eq(inventoryBlocks.status, 'ACTIVE'),
        isNull(inventoryBlocks.deletedAt),
        isNull(inventoryItems.deletedAt),
        or(
          and(lte(inventoryBlocks.blockedStartAt, asOf), gt(inventoryBlocks.blockedEndAt, asOf)),
          and(
            gt(inventoryBlocks.blockedStartAt, asOf),
            lte(inventoryBlocks.blockedStartAt, horizon),
          ),
        ),
      ),
    )
    .orderBy(asc(inventoryBlocks.blockedStartAt), asc(inventoryItems.id), asc(inventoryBlocks.id))
    .limit(limit);

  const brokenSignals: MaintenanceDashboardBrokenItemSignal[] = brokenRows.map((row) => ({
    inventoryItemId: row.inventoryItemId,
    internalSku: row.internalSku,
    productName: row.productName,
    variantName: row.variantName,
    locationId: row.locationId,
    locationName: row.locationName,
    locationTimeZone: row.locationTimeZone,
    kind: 'BROKEN_ITEM',
  }));

  const maintenanceSignals: MaintenanceDashboardMaintenanceSignal[] = maintenanceRows.flatMap(
    (row) => {
      const kind = classifyMaintenanceBlock(row, asOf);
      if (kind === null) return [];
      return [
        {
          inventoryItemId: row.inventoryItemId,
          internalSku: row.internalSku,
          productName: row.productName,
          variantName: row.variantName,
          locationId: row.locationId,
          locationName: row.locationName,
          locationTimeZone: row.locationTimeZone,
          kind,
          maintenanceBlockId: row.maintenanceBlockId,
          blockedStartAt: row.blockedStartAt,
          blockedEndAt: row.blockedEndAt,
        },
      ];
    },
  );

  return orderMaintenanceDashboardSignals([...maintenanceSignals, ...brokenSignals]).slice(
    0,
    limit,
  );
}
