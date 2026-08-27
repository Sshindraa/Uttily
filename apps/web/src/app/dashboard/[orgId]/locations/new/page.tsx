import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, LOCATION_MANAGERS } from '@uttily/core';
import { createLocationAction } from '@/app/actions/locations';
import { LocationFormFields } from '../location-form-fields';
import { parseLocationFormData } from '../location-form';

export default async function NewLocationPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, LOCATION_MANAGERS);

  async function createLocation(formData: FormData) {
    'use server';
    await createLocationAction({ organizationId: orgId, ...parseLocationFormData(formData) });
    redirect(`/dashboard/${orgId}/locations`);
  }

  return (
    <main>
      <h1>Nouvel établissement</h1>
      <form action={createLocation}>
        <LocationFormFields />
        <button type="submit">Créer</button>
      </form>
    </main>
  );
}
