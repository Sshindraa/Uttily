import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, listLocations, LOCATION_MANAGERS } from '@uttily/core';
import { LocationsListView } from '@/features/locations';

export default async function LocationsListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  const locations = await listLocations(db, orgId);
  const canManage = LOCATION_MANAGERS.includes(active.role);

  return <LocationsListView organizationId={orgId} locations={locations} canManage={canManage} />;
}
