'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  createLocation,
  listLocations,
  getLocation,
  listOpeningHours,
  updateLocation,
  getMembership,
  requireMembership,
  LOCATION_MANAGERS,
  type CreateLocationInput,
  type UpdateLocationInput,
} from '@uttily/core';

async function requireLocationManager(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, LOCATION_MANAGERS);
  return { user, db };
}

export async function createLocationAction(input: CreateLocationInput) {
  const { db } = await requireLocationManager(input.organizationId);
  const location = await createLocation(db, input);
  revalidatePath(`/dashboard/${input.organizationId}/locations`);
  return { location };
}

export async function listLocationsAction(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  return listLocations(db, organizationId);
}

export async function getLocationAction(organizationId: string, locationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  const location = await getLocation(db, organizationId, locationId);
  if (!location) throw new Error('Établissement introuvable.');
  const openingHours = await listOpeningHours(db, locationId);
  return { location, openingHours };
}

export async function updateLocationAction(
  organizationId: string,
  locationId: string,
  input: UpdateLocationInput,
) {
  await requireLocationManager(organizationId);
  const db = getDb();
  const location = await updateLocation(db, organizationId, locationId, input);
  revalidatePath(`/dashboard/${organizationId}/locations`);
  return { location };
}
