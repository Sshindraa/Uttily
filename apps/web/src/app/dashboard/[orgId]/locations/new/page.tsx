import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, LOCATION_MANAGERS } from '@uttily/core';
import { createLocationAction } from '@/app/actions/locations';
import { NewLocationView, parseLocationFormData } from '@/features/locations';

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

  return <NewLocationView organizationId={orgId} createLocation={createLocation} />;
}
