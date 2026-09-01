import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getLocation,
  getMembership,
  listOpeningHours,
  listLocationScheduleExceptions,
  requireMembership,
  LOCATION_MANAGERS,
} from '@uttily/core';
import {
  updateLocationAction,
  upsertLocationScheduleExceptionAction,
  deleteLocationScheduleExceptionAction,
} from '@/app/actions/locations';
import { parseLocationFormData, LocationDetailView } from '@/features/locations';

export default async function EditLocationPage({
  params,
}: {
  params: Promise<{ orgId: string; locationId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, locationId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const canManage = LOCATION_MANAGERS.includes(active.role);
  const location = await getLocation(db, orgId, locationId);
  if (!location) redirect(`/dashboard/${orgId}/locations`);

  const openingHours = await listOpeningHours(db, locationId);
  const exceptions = await listLocationScheduleExceptions(db, orgId, locationId);

  async function updateLocation(formData: FormData): Promise<void> {
    'use server';
    await updateLocationAction(orgId, locationId, parseLocationFormData(formData));
    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  async function addException(formData: FormData): Promise<void> {
    'use server';
    const localDate = String(formData.get('localDate') ?? '');
    const kind = String(formData.get('kind') ?? 'CLOSED') as 'CLOSED' | 'OPEN_INTERVAL';
    const openTime = kind === 'OPEN_INTERVAL' ? String(formData.get('openTime') ?? '') : null;
    const closeTime = kind === 'OPEN_INTERVAL' ? String(formData.get('closeTime') ?? '') : null;
    const reason = String(formData.get('reason') ?? '');

    await upsertLocationScheduleExceptionAction({
      organizationId: orgId,
      locationId,
      localDate,
      kind,
      openTime: openTime ? `${openTime}:00` : null,
      closeTime: closeTime ? `${closeTime}:00` : null,
      reason: reason.trim().length > 0 ? reason : null,
    });

    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  async function deleteException(formData: FormData): Promise<void> {
    'use server';
    const exceptionId = String(formData.get('exceptionId') ?? '');
    await deleteLocationScheduleExceptionAction(orgId, locationId, exceptionId);
    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  return (
    <LocationDetailView
      location={location}
      openingHours={openingHours}
      exceptions={exceptions}
      canManage={canManage}
      updateLocation={updateLocation}
      addException={addException}
      deleteException={deleteException}
    />
  );
}
