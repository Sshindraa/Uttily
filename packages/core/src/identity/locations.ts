import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { locations, locationOpeningHours, organizations } from '@uttily/database';
import { isValidSlug, slugify } from './slug';
import { isValidTimeZone } from './time-zone';
import type { LocationRecord, OpeningHourInput } from './types';
import { AuthorizationError } from './permissions';

export interface CreateLocationInput {
  organizationId: string;
  name: string;
  slug?: string;
  timeZone: string;
  addressLine1?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  pickupEnabled?: boolean;
  openingHours?: OpeningHourInput[];
}

export interface UpdateLocationInput {
  name?: string;
  timeZone?: string;
  addressLine1?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  pickupEnabled?: boolean;
  openingHours?: OpeningHourInput[];
}

/**
 * Valide une liste de créneaux d'ouverture.
 * Contrainte : open_time < close_time (déjà en base, vérifiée aussi ici).
 */
export function validateOpeningHours(hours: OpeningHourInput[]): void {
  for (const h of hours) {
    if (h.weekday < 0 || h.weekday > 6) {
      throw new Error(`Jour invalide: ${h.weekday} (0-6).`);
    }
    if (h.openTime >= h.closeTime) {
      throw new Error(
        `Créneau invalide pour le jour ${h.weekday}: open_time doit être avant close_time.`,
      );
    }
  }
}

export async function createLocation(
  db: DatabaseClient,
  input: CreateLocationInput,
): Promise<LocationRecord> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new Error('Le nom de l\u2019établissement doit faire au moins 2 caractères.');
  }
  const slug = input.slug ? input.slug : slugify(name);
  if (!isValidSlug(slug)) {
    throw new Error('Slug invalide.');
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new Error('Fuseau IANA invalide.');
  }
  if (input.openingHours && input.openingHours.length > 0) {
    validateOpeningHours(input.openingHours);
  }

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
        addressLine1: input.addressLine1 ?? null,
        city: input.city ?? null,
        postalCode: input.postalCode ?? null,
        countryCode: input.countryCode ?? null,
        pickupEnabled: input.pickupEnabled ?? true,
      })
      .returning();
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

    return mapLocation(loc);
  });
}

export async function listLocations(
  db: DatabaseClient,
  organizationId: string,
): Promise<LocationRecord[]> {
  const rows = await db
    .select()
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
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.organizationId, organizationId),
        eq(locations.id, locationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);
  return row ? mapLocation(row) : null;
}

export async function listOpeningHours(
  db: DatabaseClient,
  locationId: string,
): Promise<OpeningHourInput[]> {
  const rows = await db
    .select()
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
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) throw new Error('Nom trop court.');
    patch.name = name;
  }
  if (input.timeZone !== undefined) {
    if (!isValidTimeZone(input.timeZone)) throw new Error('Fuseau IANA invalide.');
    patch.timeZone = input.timeZone;
  }
  if (input.addressLine1 !== undefined) patch.addressLine1 = input.addressLine1;
  if (input.city !== undefined) patch.city = input.city;
  if (input.postalCode !== undefined) patch.postalCode = input.postalCode;
  if (input.countryCode !== undefined) patch.countryCode = input.countryCode;
  if (input.pickupEnabled !== undefined) patch.pickupEnabled = input.pickupEnabled;

  return await db.transaction(async (tx) => {
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
      .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)))
      .returning();
    if (!row) throw new AuthorizationError('Établissement introuvable.');
    return mapLocation(row);
  });
}

function mapLocation(row: typeof locations.$inferSelect): LocationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    timeZone: row.timeZone,
    pickupEnabled: row.pickupEnabled,
  };
}
