import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  locations,
  locationOpeningHours,
  locationScheduleExceptions,
  organizations,
} from '@uttily/database';
import { isValidSlug, slugify } from './slug';
import { isValidTimeZone } from './time-zone';
import type {
  LocationCoordinates,
  LocationRecord,
  LocationScheduleExceptionRecord,
  OpeningHourInput,
} from './types';
import { AuthorizationError } from './permissions';

export interface CreateLocationInput {
  organizationId: string;
  name: string;
  slug?: string;
  timeZone: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  coordinates?: LocationCoordinates | null;
  pickupEnabled?: boolean;
  isPubliclyListed?: boolean;
  publicPhone?: string | null;
  pickupInstructions?: string | null;
  returnInstructions?: string | null;
  openingHours?: OpeningHourInput[];
}

export interface UpdateLocationInput {
  name?: string;
  timeZone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  coordinates?: LocationCoordinates | null;
  pickupEnabled?: boolean;
  isPubliclyListed?: boolean;
  publicPhone?: string | null;
  pickupInstructions?: string | null;
  returnInstructions?: string | null;
  openingHours?: OpeningHourInput[];
}

export interface UpsertScheduleExceptionInput {
  organizationId: string;
  locationId: string;
  localDate: string; // YYYY-MM-DD
  kind: 'CLOSED' | 'OPEN_INTERVAL';
  openTime?: string | null;
  closeTime?: string | null;
  reason?: string | null;
}

export interface ScheduleConflictBooking {
  bookingId: string;
  status: string;
  customerStartAt: Date;
  customerEndAt: Date;
}

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const DATE_FORMAT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeOptionalText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCountryCode(value: string | undefined): string | null {
  const normalized = normalizeOptionalText(value)?.toUpperCase() ?? null;
  if (normalized !== null && !COUNTRY_CODE_PATTERN.test(normalized)) {
    throw new Error('Le pays doit être un code ISO 3166-1 alpha-2.');
  }
  return normalized;
}

export function validateLocationCoordinates(coordinates: LocationCoordinates | null): void {
  if (coordinates === null) return;
  if (
    !Number.isFinite(coordinates.latitude) ||
    coordinates.latitude < -90 ||
    coordinates.latitude > 90
  ) {
    throw new Error('La latitude doit être comprise entre -90 et 90.');
  }
  if (
    !Number.isFinite(coordinates.longitude) ||
    coordinates.longitude < -180 ||
    coordinates.longitude > 180
  ) {
    throw new Error('La longitude doit être comprise entre -180 et 180.');
  }
}

export function validateLocationForPublication(input: {
  addressLine1: string | null;
  city: string | null;
  countryCode: string | null;
  coordinates: LocationCoordinates | null;
  pickupEnabled: boolean;
  isPubliclyListed: boolean;
  openingHours: OpeningHourInput[];
}): void {
  validateLocationCoordinates(input.coordinates);
  if (!input.isPubliclyListed) return;
  if (!input.pickupEnabled) {
    throw new Error('Le retrait doit être activé avant de publier l’établissement.');
  }
  if (!input.addressLine1 || !input.city || !input.countryCode) {
    throw new Error('Une adresse complète est requise avant de publier l’établissement.');
  }
  if (!COUNTRY_CODE_PATTERN.test(input.countryCode)) {
    throw new Error('Le pays doit être un code ISO 3166-1 alpha-2.');
  }
  if (!input.coordinates) {
    throw new Error('Des coordonnées géographiques sont requises avant la publication.');
  }
  if (input.openingHours.length === 0) {
    throw new Error('Au moins un horaire de retrait ou de retour est requis avant la publication.');
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

export function validateOpeningHours(hours: OpeningHourInput[]): void {
  for (const h of hours) {
    if (h.weekday < 0 || h.weekday > 6) {
      throw new Error(`Jour invalide: ${h.weekday} (0-6).`);
    }
    if (!TIME_PATTERN.test(h.openTime) || !TIME_PATTERN.test(h.closeTime)) {
      throw new Error(`Horaire invalide pour le jour ${h.weekday}: format HH:MM:SS attendu.`);
    }
    if (h.openTime >= h.closeTime) {
      throw new Error(
        `Créneau invalide pour le jour ${h.weekday}: open_time doit être avant close_time.`,
      );
    }
  }
}

function isValidClockTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export async function createLocation(
  db: DatabaseClient,
  input: CreateLocationInput,
): Promise<LocationRecord> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new Error('Le nom doit contenir au moins 2 caractères.');
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new Error(`Fuseau horaire invalide: "${input.timeZone}".`);
  }

  const slug = input.slug !== undefined ? input.slug.trim() : slugify(name);
  if (!isValidSlug(slug)) {
    throw new Error(`Slug invalide: "${slug}".`);
  }

  const addressLine1 = normalizeOptionalText(input.addressLine1);
  const addressLine2 = normalizeOptionalText(input.addressLine2);
  const city = normalizeOptionalText(input.city);
  const postalCode = normalizeOptionalText(input.postalCode);
  const countryCode = normalizeCountryCode(input.countryCode);
  const publicPhone = normalizeOptionalText(input.publicPhone);
  const pickupInstructions = normalizeOptionalText(input.pickupInstructions);
  const returnInstructions = normalizeOptionalText(input.returnInstructions);
  const coordinates = input.coordinates ?? null;
  const pickupEnabled = input.pickupEnabled ?? true;
  const isPubliclyListed = input.isPubliclyListed ?? false;

  validateOpeningHours(input.openingHours ?? []);
  validateLocationForPublication({
    addressLine1,
    city,
    countryCode,
    coordinates,
    pickupEnabled,
    isPubliclyListed,
    openingHours: input.openingHours ?? [],
  });

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(locations)
      .where(
        and(
          eq(locations.organizationId, input.organizationId),
          eq(locations.slug, slug),
          isNull(locations.deletedAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new Error('Ce slug est déjà utilisé pour cette organisation.');
    }

    const [org] = await tx
      .select({ defaultCurrency: organizations.defaultCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    if (!org) throw new Error('Organisation introuvable.');

    const [loc] = await tx
      .insert(locations)
      .values({
        organizationId: input.organizationId,
        name,
        slug,
        timeZone: input.timeZone,
        operatingCurrency: org.defaultCurrency,
        addressLine1,
        addressLine2,
        city,
        postalCode,
        countryCode,
        publicPhone,
        pickupInstructions,
        returnInstructions,
        geoPoint: coordinates
          ? sql`ST_SetSRID(ST_MakePoint(${coordinates.longitude}, ${coordinates.latitude}), 4326)`
          : null,
        pickupEnabled,
        isPubliclyListed,
      })
      .returning({ id: locations.id });
    if (!loc) throw new Error('Échec de création de l\u2019établissement.');

    if (input.openingHours && input.openingHours.length > 0) {
      await tx.insert(locationOpeningHours).values(
        input.openingHours.map((h) => ({
          locationId: loc.id,
          weekday: h.weekday,
          openTime: h.openTime,
          closeTime: h.closeTime,
        })),
      );
    }

    const [created] = await tx
      .select(locationSelection)
      .from(locations)
      .where(eq(locations.id, loc.id))
      .limit(1);
    if (!created) throw new Error('Échec de lecture de l’établissement créé.');
    return mapLocation(created);
  });
}

export async function listLocations(
  db: DatabaseClient,
  organizationId: string,
): Promise<LocationRecord[]> {
  const rows = await db
    .select(locationSelection)
    .from(locations)
    .where(and(eq(locations.organizationId, organizationId), isNull(locations.deletedAt)));
  return rows.map(mapLocation);
}

export async function getLocation(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
): Promise<LocationRecord | null> {
  const [row] = await db
    .select(locationSelection)
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.organizationId, organizationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return mapLocation(row);
}

export async function listOpeningHours(
  db: DatabaseClient,
  locationId: string,
): Promise<OpeningHourInput[]> {
  const rows = await db
    .select({
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(eq(locationOpeningHours.locationId, locationId));
  return rows.map((r) => ({
    weekday: r.weekday,
    openTime: r.openTime,
    closeTime: r.closeTime,
  }));
}

export async function updateLocation(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
  input: UpdateLocationInput,
): Promise<LocationRecord> {
  const patch: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) {
      throw new Error('Le nom doit contenir au moins 2 caractères.');
    }
    patch['name'] = name;
  }

  if (input.timeZone !== undefined) {
    if (!isValidTimeZone(input.timeZone)) {
      throw new Error(`Fuseau horaire invalide: "${input.timeZone}".`);
    }
    patch['timeZone'] = input.timeZone;
  }

  if (input.addressLine1 !== undefined) {
    patch['addressLine1'] = normalizeOptionalText(input.addressLine1);
  }
  if (input.addressLine2 !== undefined) {
    patch['addressLine2'] = normalizeOptionalText(input.addressLine2);
  }
  if (input.city !== undefined) {
    patch['city'] = normalizeOptionalText(input.city);
  }
  if (input.postalCode !== undefined) {
    patch['postalCode'] = normalizeOptionalText(input.postalCode);
  }
  if (input.countryCode !== undefined) {
    patch['countryCode'] = normalizeCountryCode(input.countryCode);
  }
  if (input.publicPhone !== undefined) {
    patch['publicPhone'] = normalizeOptionalText(input.publicPhone);
  }
  if (input.pickupInstructions !== undefined) {
    patch['pickupInstructions'] = normalizeOptionalText(input.pickupInstructions);
  }
  if (input.returnInstructions !== undefined) {
    patch['returnInstructions'] = normalizeOptionalText(input.returnInstructions);
  }

  if (input.coordinates !== undefined) {
    validateLocationCoordinates(input.coordinates);
    patch['geoPoint'] = input.coordinates
      ? sql`ST_SetSRID(ST_MakePoint(${input.coordinates.longitude}, ${input.coordinates.latitude}), 4326)`
      : null;
  }

  if (input.pickupEnabled !== undefined) {
    patch['pickupEnabled'] = input.pickupEnabled;
  }
  if (input.isPubliclyListed !== undefined) {
    patch['isPubliclyListed'] = input.isPubliclyListed;
  }

  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select(locationSelection)
      .from(locations)
      .where(
        and(
          eq(locations.id, locationId),
          eq(locations.organizationId, organizationId),
          isNull(locations.deletedAt),
        ),
      )
      .limit(1);
    if (!current) throw new AuthorizationError('Établissement introuvable.');

    const nextAddressLine1 =
      input.addressLine1 !== undefined
        ? normalizeOptionalText(input.addressLine1)
        : current.addressLine1;
    const nextCity = input.city !== undefined ? normalizeOptionalText(input.city) : current.city;
    const nextCountryCode =
      input.countryCode !== undefined
        ? normalizeCountryCode(input.countryCode)
        : current.countryCode;
    const nextCoordinates =
      input.coordinates !== undefined
        ? input.coordinates
        : current.latitude !== null && current.longitude !== null
          ? { latitude: current.latitude, longitude: current.longitude }
          : null;
    const nextPickupEnabled = input.pickupEnabled ?? current.pickupEnabled;
    const nextIsPubliclyListed = input.isPubliclyListed ?? current.isPubliclyListed;

    const currentHours = await tx
      .select({
        weekday: locationOpeningHours.weekday,
        openTime: locationOpeningHours.openTime,
        closeTime: locationOpeningHours.closeTime,
      })
      .from(locationOpeningHours)
      .where(eq(locationOpeningHours.locationId, locationId));
    const nextOpeningHours = input.openingHours ?? currentHours;
    validateLocationForPublication({
      addressLine1: nextAddressLine1,
      city: nextCity,
      countryCode: nextCountryCode,
      coordinates: nextCoordinates,
      pickupEnabled: nextPickupEnabled,
      isPubliclyListed: nextIsPubliclyListed,
      openingHours: nextOpeningHours,
    });

    if (input.openingHours !== undefined) {
      validateOpeningHours(input.openingHours);
      await tx.delete(locationOpeningHours).where(eq(locationOpeningHours.locationId, locationId));
      if (input.openingHours.length > 0) {
        await tx.insert(locationOpeningHours).values(
          input.openingHours.map((h) => ({
            locationId,
            weekday: h.weekday,
            openTime: h.openTime,
            closeTime: h.closeTime,
          })),
        );
      }
    }
    const [row] = await tx
      .update(locations)
      .set(patch)
      .where(
        and(
          eq(locations.id, locationId),
          eq(locations.organizationId, organizationId),
          isNull(locations.deletedAt),
        ),
      )
      .returning({ id: locations.id });
    if (!row) throw new AuthorizationError('Établissement introuvable.');
    const [updated] = await tx
      .select(locationSelection)
      .from(locations)
      .where(eq(locations.id, row.id))
      .limit(1);
    if (!updated) throw new Error('Échec de lecture de l’établissement mis à jour.');
    return mapLocation(updated);
  });
}

// -----------------------------------------------------------------------------
// Chantier 15A — Exceptions de calendrier (Fermetures et horaires spéciaux)
// -----------------------------------------------------------------------------

export async function listLocationScheduleExceptions(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
): Promise<LocationScheduleExceptionRecord[]> {
  const rows = await db
    .select()
    .from(locationScheduleExceptions)
    .where(
      and(
        eq(locationScheduleExceptions.organizationId, organizationId),
        eq(locationScheduleExceptions.locationId, locationId),
      ),
    )
    .orderBy(desc(locationScheduleExceptions.localDate));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    locationId: r.locationId,
    localDate: r.localDate,
    kind: r.kind,
    openTime: r.openTime,
    closeTime: r.closeTime,
    reason: r.reason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function checkScheduleExceptionConflicts(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
  localDate: string,
): Promise<ScheduleConflictBooking[]> {
  if (!DATE_FORMAT_PATTERN.test(localDate)) {
    throw new Error(`Format de date invalide: ${localDate} (attendu YYYY-MM-DD).`);
  }

  // Récupérer le fuseau horaire de l'établissement
  const loc = await getLocation(db, organizationId, locationId);
  if (!loc) throw new AuthorizationError('Établissement introuvable.');

  // Recherche des réservations confirmées ou actives dont le départ ou le retour tombe sur cette date locale
  const activeBookings = await db
    .select({
      bookingId: bookings.id,
      status: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.organizationId, organizationId),
        eq(bookings.locationId, locationId),
        inArray(bookings.status, ['CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE']),
        sql`(
          to_char(${bookings.customerStartAt} AT TIME ZONE ${loc.timeZone}, 'YYYY-MM-DD') = ${localDate}
          OR
          to_char(${bookings.customerEndAt} AT TIME ZONE ${loc.timeZone}, 'YYYY-MM-DD') = ${localDate}
        )`,
      ),
    );

  return activeBookings;
}

export async function upsertLocationScheduleException(
  db: DatabaseClient,
  input: UpsertScheduleExceptionInput,
): Promise<LocationScheduleExceptionRecord> {
  if (!DATE_FORMAT_PATTERN.test(input.localDate)) {
    throw new Error(`Format de date invalide: ${input.localDate} (attendu YYYY-MM-DD).`);
  }

  if (input.kind === 'OPEN_INTERVAL') {
    if (
      !input.openTime ||
      !input.closeTime ||
      !isValidClockTime(input.openTime) ||
      !isValidClockTime(input.closeTime)
    ) {
      throw new Error(
        'Horaires d’ouverture et de fermeture valides requis pour un créneau spécial.',
      );
    }
    if (input.openTime >= input.closeTime) {
      throw new Error('L’horaire d’ouverture doit être antérieur à l’horaire de fermeture.');
    }
  }

  return await db.transaction(async (tx) => {
    // Vérifier l'établissement
    const [loc] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.id, input.locationId),
          eq(locations.organizationId, input.organizationId),
          isNull(locations.deletedAt),
        ),
      )
      .limit(1);
    if (!loc) throw new AuthorizationError('Établissement introuvable.');

    // Upsert sur la contrainte (location_id, local_date)
    const [existing] = await tx
      .select()
      .from(locationScheduleExceptions)
      .where(
        and(
          eq(locationScheduleExceptions.locationId, input.locationId),
          eq(locationScheduleExceptions.localDate, input.localDate),
        ),
      )
      .limit(1);

    const openTime = input.kind === 'OPEN_INTERVAL' ? (input.openTime ?? null) : null;
    const closeTime = input.kind === 'OPEN_INTERVAL' ? (input.closeTime ?? null) : null;
    const reason = normalizeOptionalText(input.reason);

    if (existing) {
      const [updated] = await tx
        .update(locationScheduleExceptions)
        .set({
          kind: input.kind,
          openTime,
          closeTime,
          reason,
          updatedAt: new Date(),
        })
        .where(eq(locationScheduleExceptions.id, existing.id))
        .returning();

      if (!updated) throw new Error('Échec de mise à jour de l’exception de calendrier.');
      return updated;
    }

    const [created] = await tx
      .insert(locationScheduleExceptions)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        localDate: input.localDate,
        kind: input.kind,
        openTime,
        closeTime,
        reason,
      })
      .returning();

    if (!created) throw new Error('Échec de création de l’exception de calendrier.');
    return created;
  });
}

export async function deleteLocationScheduleException(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
  exceptionId: string,
): Promise<void> {
  const result = await db
    .delete(locationScheduleExceptions)
    .where(
      and(
        eq(locationScheduleExceptions.id, exceptionId),
        eq(locationScheduleExceptions.organizationId, organizationId),
        eq(locationScheduleExceptions.locationId, locationId),
      ),
    )
    .returning({ id: locationScheduleExceptions.id });

  if (result.length === 0) {
    throw new AuthorizationError('Exception de calendrier introuvable.');
  }
}

const locationSelection = {
  id: locations.id,
  organizationId: locations.organizationId,
  name: locations.name,
  slug: locations.slug,
  timeZone: locations.timeZone,
  addressLine1: locations.addressLine1,
  addressLine2: locations.addressLine2,
  city: locations.city,
  postalCode: locations.postalCode,
  countryCode: locations.countryCode,
  latitude: sql<number | null>`ST_Y(${locations.geoPoint})`.as('latitude'),
  longitude: sql<number | null>`ST_X(${locations.geoPoint})`.as('longitude'),
  pickupEnabled: locations.pickupEnabled,
  isPubliclyListed: locations.isPubliclyListed,
  publicPhone: locations.publicPhone,
  pickupInstructions: locations.pickupInstructions,
  returnInstructions: locations.returnInstructions,
};

type LocationQueryRow = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timeZone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  pickupEnabled: boolean;
  isPubliclyListed: boolean;
  publicPhone: string | null;
  pickupInstructions: string | null;
  returnInstructions: string | null;
};

function mapLocation(row: LocationQueryRow): LocationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    timeZone: row.timeZone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    latitude: row.latitude,
    longitude: row.longitude,
    pickupEnabled: row.pickupEnabled,
    isPubliclyListed: row.isPubliclyListed,
    publicPhone: row.publicPhone,
    pickupInstructions: row.pickupInstructions,
    returnInstructions: row.returnInstructions,
  };
}
