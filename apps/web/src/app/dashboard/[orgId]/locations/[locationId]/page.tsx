import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getLocation,
  getMembership,
  listOpeningHours,
  requireMembership,
  LOCATION_MANAGERS,
} from '@uttily/core';
import { updateLocationAction } from '@/app/actions/locations';
import { LocationFormFields } from '../location-form-fields';
import { parseLocationFormData } from '../location-form';

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

  async function updateLocation(formData: FormData) {
    'use server';
    await updateLocationAction(orgId, locationId, parseLocationFormData(formData));
    redirect(`/dashboard/${orgId}/locations`);
  }

  return (
    <main>
      <h1>Établissement</h1>
      {canManage ? (
        <form action={updateLocation}>
          <LocationFormFields location={location} openingHours={openingHours} />
          <button type="submit">Mettre à jour</button>
        </form>
      ) : (
        <p>Lecture seule. Rôle insuffisant pour modifier.</p>
      )}
    </main>
  );
}
