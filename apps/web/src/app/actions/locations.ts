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
  listLocationScheduleExceptions,
  checkScheduleExceptionConflicts,
  upsertLocationScheduleException,
  deleteLocationScheduleException,
  getMembership,
  requireCapability,
  type CreateLocationInput,
  type UpdateLocationInput,
  type UpsertScheduleExceptionInput,
} from '@uttily/core';

async function requireLocationManager(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCapability(membership, 'locations.manage');
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
  requireCapability(membership, 'locations.manage');
  return listLocations(db, organizationId);
}

export async function getLocationAction(organizationId: string, locationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCapability(membership, 'locations.manage');
  const location = await getLocation(db, organizationId, locationId);
  if (!location) throw new Error('Établissement introuvable.');
  const openingHours = await listOpeningHours(db, locationId);
  const exceptions = await listLocationScheduleExceptions(db, organizationId, locationId);
  return { location, openingHours, exceptions };
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
  revalidatePath(`/dashboard/${organizationId}/locations/${locationId}`);
  return { location };
}

export async function checkScheduleExceptionConflictsAction(
  organizationId: string,
  locationId: string,
  localDate: string,
) {
  await requireLocationManager(organizationId);
  const db = getDb();
  return checkScheduleExceptionConflicts(db, organizationId, locationId, localDate);
}

export async function upsertLocationScheduleExceptionAction(input: UpsertScheduleExceptionInput) {
  await requireLocationManager(input.organizationId);
  const db = getDb();
  const exception = await upsertLocationScheduleException(db, input);
  revalidatePath(`/dashboard/${input.organizationId}/locations/${input.locationId}`);
  return { exception };
}

export async function deleteLocationScheduleExceptionAction(
  organizationId: string,
  locationId: string,
  exceptionId: string,
) {
  await requireLocationManager(organizationId);
  const db = getDb();
  await deleteLocationScheduleException(db, organizationId, locationId, exceptionId);
  revalidatePath(`/dashboard/${organizationId}/locations/${locationId}`);
}
