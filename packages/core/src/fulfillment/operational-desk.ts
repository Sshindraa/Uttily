import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { bookingItems, inventoryItems, locations } from '@uttily/database';
import { isValidTimeZone } from '../identity/time-zone';
import { toLocalParts } from '../pricing-plans/time-utils';
import { FulfillmentError } from './fulfillment-errors';
import { listOperationalBookings } from './read-models';
import type {
  OperationalBookingSummary,
  OperationalDayDesk,
  OperationalDayDeskBuckets,
  OperationalDeskBookingItem,
  OperationalDeskBucket,
} from './read-model-types';
import { OPERATIONAL_DESK_BUCKETS } from './read-model-types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIVIL_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DESK_SEARCH_LENGTH = 200;

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new FulfillmentError('VALIDATION', `${field} invalide (UUID attendu).`);
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new FulfillmentError('VALIDATION', `${field} doit être une Date valide.`);
  }
}

/** Valide aussi le calendrier (par exemple 2026-02-30 est refusé). */
function assertCivilDate(value: string, field: string): void {
  const match = CIVIL_DATE_REGEX.exec(value);
  if (!match) {
    throw new FulfillmentError('VALIDATION', `${field} doit être au format YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new FulfillmentError('VALIDATION', `${field} n'est pas une date civile valide.`);
  }
}

/** Date civile locale d'un instant, sans dépendre du fuseau de la machine. */
export function getOperationalLocalCivilDate(date: Date, timeZone: string): string {
  assertValidDate(date, 'date');
  if (!isValidTimeZone(timeZone)) {
    throw new FulfillmentError('VALIDATION', `Fuseau IANA invalide : ${timeZone}`);
  }
  const local = toLocalParts(date, timeZone);
  const pad = (part: number, width: number): string => String(part).padStart(width, '0');
  return `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`;
}

/**
 * Classe une réservation dans exactement un bucket du cockpit, ou l'écarte.
 * OVERDUE est évalué en premier sur l'instant absolu, puis viennent les
 * opérations de la date civile sélectionnée.
 */
export function classifyOperationalDeskBooking(
  booking: Pick<
    OperationalBookingSummary,
    'status' | 'customerStartAt' | 'customerEndAt' | 'locationTimeZone'
  >,
  targetDate: string,
  now: Date,
): OperationalDeskBucket | null {
  if (booking.status === 'ACTIVE' && booking.customerEndAt.getTime() < now.getTime()) {
    return 'OVERDUE';
  }

  const startDate = getOperationalLocalCivilDate(booking.customerStartAt, booking.locationTimeZone);
  const endDate = getOperationalLocalCivilDate(booking.customerEndAt, booking.locationTimeZone);

  if (
    (booking.status === 'CONFIRMED' || booking.status === 'READY_FOR_PICKUP') &&
    startDate === targetDate
  ) {
    return 'PICKUPS_TODAY';
  }

  if (booking.status !== 'ACTIVE') return null;
  if (endDate === targetDate) return 'RETURNS_TODAY';
  if (startDate <= targetDate && targetDate <= endDate) return 'ONGOING';
  return null;
}

export interface GetOperationalDeskBookingsOptions {
  /** Établissement choisi ; sa timezone définit la date civile du cockpit. */
  locationId: string;
  targetDate?: string;
  now?: Date;
  /** Recherche serveur sur UUID/référence #UT-xxxxxx ou SKU. */
  search?: string;
}

/**
 * Read model quotidien du comptoir.
 *
 * La liste source reste listOperationalBookings : les exemplaires sont chargés
 * ensuite par bookingId uniquement pour alimenter les flows, jamais pour
 * filtrer la liste. La recherche SKU repose donc sur EXISTS et ne duplique pas
 * une réservation lorsqu'elle contient plusieurs exemplaires.
 *
 * Retourne null si locationId est valide mais absent de l'organisation, afin de
 * conserver le comportement fail-closed des read models opérationnels.
 */
export async function getOperationalDeskBookings(
  db: DatabaseClient,
  organizationId: string,
  options: GetOperationalDeskBookingsOptions,
): Promise<OperationalDayDesk | null> {
  assertUuid(organizationId, 'organizationId');
  assertUuid(options.locationId, 'locationId');

  const now = options.now ?? new Date();
  assertValidDate(now, 'now');

  if (options.search !== undefined && typeof options.search !== 'string') {
    throw new FulfillmentError('VALIDATION', 'search doit être une chaîne.');
  }
  const search = options.search?.trim() ?? '';
  if (search.length > MAX_DESK_SEARCH_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `search ne doit pas dépasser ${MAX_DESK_SEARCH_LENGTH} caractères.`,
    );
  }

  const [location] = await db
    .select({ id: locations.id, name: locations.name, timeZone: locations.timeZone })
    .from(locations)
    .where(
      and(
        eq(locations.id, options.locationId),
        eq(locations.organizationId, organizationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  if (!location) return null;
  if (!isValidTimeZone(location.timeZone)) {
    throw new FulfillmentError('VALIDATION', `Fuseau IANA invalide : ${location.timeZone}`);
  }

  const targetDate = options.targetDate ?? getOperationalLocalCivilDate(now, location.timeZone);
  assertCivilDate(targetDate, 'targetDate');

  const summaries = await listOperationalBookings(db, organizationId, {
    locationId: location.id,
    statuses: ['CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE'],
    ...(search.length > 0 ? { search } : {}),
    // Les compteurs du cockpit ne doivent pas être tronqués par la limite de
    // la liste classique.
    limit: null,
  });

  const classified = summaries.flatMap((summary) => {
    const bucket = classifyOperationalDeskBooking(summary, targetDate, now);
    return bucket ? [{ summary, bucket }] : [];
  });

  const bookingIds = classified.map(({ summary }) => summary.id);
  const itemRows =
    bookingIds.length === 0
      ? []
      : await db
          .select({
            bookingId: bookingItems.bookingId,
            bookingItemId: bookingItems.id,
            inventoryItemId: bookingItems.inventoryItemId,
            internalSku: inventoryItems.internalSku,
            serialNumber: inventoryItems.serialNumber,
            currentCondition: inventoryItems.condition,
            inventoryStatus: inventoryItems.status,
          })
          .from(bookingItems)
          .innerJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
          .where(
            and(
              inArray(bookingItems.bookingId, bookingIds),
              eq(inventoryItems.organizationId, organizationId),
            ),
          )
          .orderBy(
            asc(bookingItems.bookingId),
            asc(inventoryItems.internalSku),
            asc(bookingItems.id),
          );

  const itemsByBooking = new Map<string, OperationalDeskBookingItem[]>();
  for (const row of itemRows) {
    const items = itemsByBooking.get(row.bookingId) ?? [];
    items.push({
      bookingItemId: row.bookingItemId,
      inventoryItemId: row.inventoryItemId,
      internalSku: row.internalSku,
      serialNumber: row.serialNumber,
      currentCondition: row.currentCondition,
      inventoryStatus: row.inventoryStatus,
    });
    itemsByBooking.set(row.bookingId, items);
  }

  const buckets = {
    PICKUPS_TODAY: [],
    OVERDUE: [],
    RETURNS_TODAY: [],
    ONGOING: [],
  } as OperationalDayDeskBuckets;

  for (const { summary, bucket } of classified) {
    buckets[bucket].push({
      ...summary,
      bucket,
      items: itemsByBooking.get(summary.id) ?? [],
    });
  }

  for (const bucket of OPERATIONAL_DESK_BUCKETS) {
    buckets[bucket].sort((left, right) => {
      const leftTime =
        bucket === 'OVERDUE' || bucket === 'RETURNS_TODAY'
          ? left.customerEndAt.getTime()
          : left.customerStartAt.getTime();
      const rightTime =
        bucket === 'OVERDUE' || bucket === 'RETURNS_TODAY'
          ? right.customerEndAt.getTime()
          : right.customerStartAt.getTime();
      return leftTime - rightTime || left.id.localeCompare(right.id);
    });
  }

  const counts = {
    PICKUPS_TODAY: buckets.PICKUPS_TODAY.length,
    OVERDUE: buckets.OVERDUE.length,
    RETURNS_TODAY: buckets.RETURNS_TODAY.length,
    ONGOING: buckets.ONGOING.length,
  };

  return {
    locationId: location.id,
    locationName: location.name,
    locationTimeZone: location.timeZone,
    targetDate,
    now,
    buckets,
    counts,
    totalCount: classified.length,
  };
}
