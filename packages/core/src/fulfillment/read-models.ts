import { and, asc, count, eq, gte, inArray, isNotNull, lte, max, or, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingItems,
  bookingFulfillmentEvents,
  conditionReports,
  damageReports,
  inventoryItems,
  locations,
  users,
} from '@uttily/database';
import { FulfillmentError } from './fulfillment-errors';
import { isBookingStatus } from './fulfillment-shared';
import type { BookingStatus } from './types';
import type {
  OperationalBookingSummary,
  OperationalBookingDetails,
  OperationalBookingItem,
  OperationalConditionReport,
  OperationalDamageReport,
  OperationalFulfillmentEvent,
} from './read-model-types';

/**
 * @uttily/core — Read models opérationnels fulfillment (G4A).
 *
 * Aucun champ financier, Stripe, terms snapshot ou payload JSON n'est exposé.
 * L'email du client n'apparaît que sur la fiche détaillée (nécessaire au retrait).
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_LENGTH = 200;

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new FulfillmentError('VALIDATION', `${field} invalide (UUID attendu).`);
  }
}

/**
 * Liste les bookings opérationnels d'une organisation (résumés).
 * Évite le N+1 : 1 query bookings+location, puis 4 queries de counts groupés.
 * Aucun champ financier n'est sélectionné.
 */
export async function listOperationalBookings(
  db: DatabaseClient,
  organizationId: string,
  options?: {
    statuses?: readonly BookingStatus[];
    dateFrom?: Date;
    dateTo?: Date;
    /**
     * Filtre la date civile locale de l'événement dans le fuseau de chaque
     * établissement. Les limites absolues dateFrom/dateTo restent utiles pour
     * les listes classiques ; ce filtre sert aux tâches « aujourd'hui ».
     */
    localDateAt?: Date;
    localDateField?: 'START' | 'END';
    /** Filtre serveur sur l'UUID/référence #UT-xxxxxx ou le SKU. */
    search?: string;
    /** Établissement tenant-scoped à afficher. */
    locationId?: string;
    /** null = lecture complète explicite, sans pagination implicite. */
    limit?: number | null;
  },
): Promise<OperationalBookingSummary[]> {
  // Validation runtime des inputs (G4A — defense in depth).
  assertUuid(organizationId, 'organizationId');

  // Limit : défaut 50, max 100, entier sûr uniquement. Une lecture complète
  // doit être demandée explicitement avec null pour éviter les KPI tronqués.
  let limit: number | null;
  const rawLimit = options?.limit;
  if (rawLimit === undefined) {
    limit = 50;
  } else if (rawLimit === null) {
    limit = null;
  } else {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit <= 0 ||
      !Number.isFinite(rawLimit)
    ) {
      throw new FulfillmentError('VALIDATION', 'limit doit être un entier strictement positif.');
    }
    limit = Math.min(rawLimit, 100);
  }

  // Statuses : valider contre BOOKING_STATUSES, normaliser doublons, vide = aucun filtre.
  let statuses: BookingStatus[] = [];
  if (options?.statuses && options.statuses.length > 0) {
    // isBookingStatus narrow s à BookingStatus ; aucun cast non vérifié nécessaire.
    const seen = new Set<BookingStatus>();
    for (const s of options.statuses) {
      if (!isBookingStatus(s)) {
        throw new FulfillmentError('VALIDATION', `Statut de booking invalide: ${String(s)}.`);
      }
      seen.add(s);
    }
    statuses = [...seen];
  }

  if (options?.locationId !== undefined) {
    if (typeof options.locationId !== 'string') {
      throw new FulfillmentError('VALIDATION', 'locationId doit être une chaîne.');
    }
    assertUuid(options.locationId, 'locationId');
  }

  if (options?.search !== undefined && typeof options.search !== 'string') {
    throw new FulfillmentError('VALIDATION', 'search doit être une chaîne.');
  }
  const search = options?.search?.trim() ?? '';
  if (search.length > MAX_SEARCH_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `search ne doit pas dépasser ${MAX_SEARCH_LENGTH} caractères.`,
    );
  }

  // Dates : objets Date valides, dateFrom <= dateTo.
  const dateFrom = options?.dateFrom;
  const dateTo = options?.dateTo;
  const localDateAt = options?.localDateAt;
  const localDateField = options?.localDateField ?? 'START';
  if (dateFrom !== undefined) {
    if (!(dateFrom instanceof Date) || !Number.isFinite(dateFrom.getTime())) {
      throw new FulfillmentError('VALIDATION', 'dateFrom doit être une Date valide.');
    }
  }
  if (dateTo !== undefined) {
    if (!(dateTo instanceof Date) || !Number.isFinite(dateTo.getTime())) {
      throw new FulfillmentError('VALIDATION', 'dateTo doit être une Date valide.');
    }
  }
  if (localDateAt !== undefined) {
    if (!(localDateAt instanceof Date) || !Number.isFinite(localDateAt.getTime())) {
      throw new FulfillmentError('VALIDATION', 'localDateAt doit être une Date valide.');
    }
  }
  if (
    options?.localDateField !== undefined &&
    options.localDateField !== 'START' &&
    options.localDateField !== 'END'
  ) {
    throw new FulfillmentError('VALIDATION', 'localDateField doit être START ou END.');
  }
  if (localDateAt === undefined && options?.localDateField !== undefined) {
    throw new FulfillmentError('VALIDATION', 'localDateField nécessite localDateAt.');
  }
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw new FulfillmentError('VALIDATION', 'dateFrom doit être antérieur ou égal à dateTo.');
  }

  // Query 1 : bookings + location (AUCUN champ financier).
  const conditions = [
    eq(bookings.organizationId, organizationId),
    // Défense en profondeur : le booking et le lieu doivent appartenir au même tenant.
    eq(locations.organizationId, organizationId),
  ];
  if (options?.locationId) {
    conditions.push(eq(bookings.locationId, options.locationId));
  }
  if (statuses.length > 0) {
    conditions.push(inArray(bookings.status, [...statuses]));
  }
  if (dateFrom) conditions.push(gte(bookings.customerStartAt, dateFrom));
  if (dateTo) conditions.push(lte(bookings.customerEndAt, dateTo));
  if (localDateAt) {
    const dateColumn = localDateField === 'END' ? bookings.customerEndAt : bookings.customerStartAt;
    conditions.push(
      sql`to_char(${dateColumn} AT TIME ZONE ${locations.timeZone}, 'YYYY-MM-DD') = to_char(${localDateAt.toISOString()}::timestamptz AT TIME ZONE ${locations.timeZone}, 'YYYY-MM-DD')`,
    );
  }
  if (search.length > 0) {
    // Les jokers saisis par l'utilisateur restent littéraux. La recherche SKU
    // est un EXISTS pour ne jamais multiplier les lignes d'un booking.
    const searchPattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const searchCondition = or(
      sql`${bookings.id}::text ILIKE ${searchPattern}`,
      sql`('#UT-' || upper(substring(${bookings.id}::text, 1, 6))) ILIKE ${searchPattern}`,
      sql`EXISTS (
        SELECT 1
        FROM ${bookingItems}
        INNER JOIN ${inventoryItems}
          ON ${bookingItems.inventoryItemId} = ${inventoryItems.id}
        WHERE ${bookingItems.bookingId} = ${bookings.id}
          AND ${inventoryItems.organizationId} = ${organizationId}
          AND ${inventoryItems.internalSku} ILIKE ${searchPattern}
      )`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const bookingQuery = db
    .select({
      id: bookings.id,
      status: bookings.status,
      locationId: bookings.locationId,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
    })
    .from(bookings)
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .where(and(...conditions))
    .orderBy(asc(bookings.customerStartAt), asc(bookings.id));
  const bookingRows = await (limit === null ? bookingQuery : bookingQuery.limit(limit));

  if (bookingRows.length === 0) return [];

  const bookingIds = bookingRows.map((b) => b.id);

  // Query 2 : counts groupés (évite N+1).
  const itemCountRows = await db
    .select({ bookingId: bookingItems.bookingId, value: count() })
    .from(bookingItems)
    .where(inArray(bookingItems.bookingId, bookingIds))
    .groupBy(bookingItems.bookingId);
  const itemCountMap = new Map<string, number>(
    itemCountRows.map((r) => [r.bookingId, Number(r.value)]),
  );

  const conditionCountRows = await db
    .select({ bookingId: conditionReports.bookingId, value: count() })
    .from(conditionReports)
    .where(
      and(
        eq(conditionReports.organizationId, organizationId),
        inArray(conditionReports.bookingId, bookingIds),
      ),
    )
    .groupBy(conditionReports.bookingId);
  const conditionCountMap = new Map<string, number>(
    conditionCountRows.map((r) => [r.bookingId, Number(r.value)]),
  );

  const damageCountRows = await db
    .select({ bookingId: damageReports.bookingId, value: count() })
    .from(damageReports)
    .where(
      and(
        eq(damageReports.organizationId, organizationId),
        inArray(damageReports.bookingId, bookingIds),
      ),
    )
    .groupBy(damageReports.bookingId);
  const damageCountMap = new Map<string, number>(
    damageCountRows.map((r) => [r.bookingId, Number(r.value)]),
  );

  const lastEventRows = await db
    .select({
      bookingId: bookingFulfillmentEvents.bookingId,
      lastAt: max(bookingFulfillmentEvents.occurredAt),
    })
    .from(bookingFulfillmentEvents)
    .where(
      and(
        eq(bookingFulfillmentEvents.organizationId, organizationId),
        inArray(bookingFulfillmentEvents.bookingId, bookingIds),
      ),
    )
    .groupBy(bookingFulfillmentEvents.bookingId);
  const lastEventMap = new Map<string, Date | null>(
    lastEventRows.map((r) => [r.bookingId, r.lastAt]),
  );

  return bookingRows.map((b) => ({
    id: b.id,
    status: b.status,
    locationId: b.locationId,
    locationName: b.locationName,
    locationTimeZone: b.locationTimeZone,
    customerStartAt: b.customerStartAt,
    customerEndAt: b.customerEndAt,
    bookingItemCount: itemCountMap.get(b.id) ?? 0,
    conditionReportCount: conditionCountMap.get(b.id) ?? 0,
    damageReportCount: damageCountMap.get(b.id) ?? 0,
    lastFulfillmentEventAt: lastEventMap.get(b.id) ?? null,
  }));
}

/**
 * Compte les réservations opérationnelles sans charger leurs lignes ni
 * appliquer la limite d'affichage des listes.
 */
export async function countOperationalBookings(
  db: DatabaseClient,
  organizationId: string,
  statuses: readonly BookingStatus[],
): Promise<number> {
  assertUuid(organizationId, 'organizationId');

  if (statuses.length === 0) return 0;

  const normalizedStatuses = [...new Set(statuses)];
  for (const status of normalizedStatuses) {
    if (!isBookingStatus(status)) {
      throw new FulfillmentError('VALIDATION', `Statut de booking invalide: ${String(status)}.`);
    }
  }

  const [row] = await db
    .select({ value: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.organizationId, organizationId),
        inArray(bookings.status, normalizedStatuses),
      ),
    );

  return Number(row?.value ?? 0);
}

/**
 * Récupère le détail opérationnel d'un booking (items, rapports, événements).
 * Retourne null si introuvable OU cross-org (pas de fuite).
 * Aucun champ financier n'est sélectionné. L'email client est inclus (retrait).
 */
export async function getOperationalBookingDetails(
  db: DatabaseClient,
  organizationId: string,
  bookingId: string,
): Promise<OperationalBookingDetails | null> {
  // Validation runtime des inputs (G4A — defense in depth).
  assertUuid(organizationId, 'organizationId');
  assertUuid(bookingId, 'bookingId');

  // Query 1 : booking + location + customer email (AUCUN champ financier).
  const bookingRows = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      locationId: bookings.locationId,
      locationName: locations.name,
      locationTimeZone: locations.timeZone,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      customerEmail: users.email,
    })
    .from(bookings)
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.organizationId, organizationId)))
    .limit(1);

  if (bookingRows.length === 0) return null; // null si introuvable OU cross-org (pas de fuite)
  const b = bookingRows[0]!;

  // Query 2 : bookingItems + inventoryItems.
  const itemRows = await db
    .select({
      bookingItemId: bookingItems.id,
      inventoryItemId: bookingItems.inventoryItemId,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      currentCondition: inventoryItems.condition,
      inventoryStatus: inventoryItems.status,
    })
    .from(bookingItems)
    .innerJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
    .where(eq(bookingItems.bookingId, bookingId));

  // Query 3 : conditionReports (filtré par organizationId ET bookingId).
  const conditionRows = await db
    .select({
      id: conditionReports.id,
      bookingItemId: conditionReports.bookingItemId,
      inventoryItemId: conditionReports.inventoryItemId,
      phase: conditionReports.phase,
      condition: conditionReports.condition,
      notes: conditionReports.notes,
      reporterUserId: conditionReports.reporterUserId,
      createdAt: conditionReports.createdAt,
    })
    .from(conditionReports)
    .where(
      and(
        eq(conditionReports.organizationId, organizationId),
        eq(conditionReports.bookingId, bookingId),
        // G7M-A : filtre transitoire booking_item_id IS NOT NULL jusqu'à
        // l'implémentation de getEffectiveBooking. Les rapports d'allocation
        // d'amendement ne sont ni supportés ni exposés en G7M-A.
        isNotNull(conditionReports.bookingItemId),
      ),
    )
    .orderBy(asc(conditionReports.createdAt), asc(conditionReports.id));

  // Query 4 : damageReports (filtré par organizationId ET bookingId).
  const damageRows = await db
    .select({
      id: damageReports.id,
      bookingItemId: damageReports.bookingItemId,
      inventoryItemId: damageReports.inventoryItemId,
      description: damageReports.description,
      reporterUserId: damageReports.reporterUserId,
      createdAt: damageReports.createdAt,
    })
    .from(damageReports)
    .where(
      and(
        eq(damageReports.organizationId, organizationId),
        eq(damageReports.bookingId, bookingId),
        // G7M-A : filtre transitoire booking_item_id IS NOT NULL jusqu'à
        // l'implémentation de getEffectiveBooking. Les rapports d'allocation
        // d'amendement ne sont ni supportés ni exposés en G7M-A.
        isNotNull(damageReports.bookingItemId),
      ),
    )
    .orderBy(asc(damageReports.createdAt), asc(damageReports.id));

  // Query 5 : fulfillmentEvents (filtré par organizationId ET bookingId).
  const eventRows = await db
    .select({
      id: bookingFulfillmentEvents.id,
      eventType: bookingFulfillmentEvents.eventType,
      previousStatus: bookingFulfillmentEvents.previousStatus,
      nextStatus: bookingFulfillmentEvents.nextStatus,
      actorUserId: bookingFulfillmentEvents.actorUserId,
      occurredAt: bookingFulfillmentEvents.occurredAt,
    })
    .from(bookingFulfillmentEvents)
    .where(
      and(
        eq(bookingFulfillmentEvents.organizationId, organizationId),
        eq(bookingFulfillmentEvents.bookingId, bookingId),
      ),
    )
    .orderBy(asc(bookingFulfillmentEvents.occurredAt), asc(bookingFulfillmentEvents.id));

  return {
    id: b.id,
    status: b.status,
    locationId: b.locationId,
    locationName: b.locationName,
    locationTimeZone: b.locationTimeZone,
    customerStartAt: b.customerStartAt,
    customerEndAt: b.customerEndAt,
    customerEmail: b.customerEmail,
    items: itemRows.map((r): OperationalBookingItem => ({
      bookingItemId: r.bookingItemId,
      inventoryItemId: r.inventoryItemId,
      internalSku: r.internalSku,
      serialNumber: r.serialNumber,
      currentCondition: r.currentCondition,
      inventoryStatus: r.inventoryStatus,
    })),
    conditionReports: conditionRows.map((r): OperationalConditionReport => ({
      id: r.id,
      // G7M-A : bookingItemId filtré IS NOT NULL en requête (filtre
      // transitoire — voir commentaire de la requête).
      bookingItemId: r.bookingItemId!,
      inventoryItemId: r.inventoryItemId,
      phase: r.phase,
      condition: r.condition,
      notes: r.notes,
      reporterUserId: r.reporterUserId,
      createdAt: r.createdAt,
    })),
    damageReports: damageRows.map((r): OperationalDamageReport => ({
      id: r.id,
      // G7M-A : bookingItemId filtré IS NOT NULL en requête (filtre
      // transitoire — voir commentaire de la requête).
      bookingItemId: r.bookingItemId!,
      inventoryItemId: r.inventoryItemId,
      description: r.description,
      reporterUserId: r.reporterUserId,
      createdAt: r.createdAt,
    })),
    fulfillmentEvents: eventRows.map((r): OperationalFulfillmentEvent => ({
      id: r.id,
      eventType: r.eventType,
      previousStatus: r.previousStatus,
      nextStatus: r.nextStatus,
      actorUserId: r.actorUserId,
      occurredAt: r.occurredAt,
    })),
  };
}
