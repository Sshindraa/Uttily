import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, listLocations, LOCATION_MANAGERS } from '@uttily/core';
import Link from 'next/link';

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

  return (
    <main>
      <h1>Établissements</h1>
      {canManage && (
        <Link href={`/dashboard/${orgId}/locations/new`}>Ajouter un établissement</Link>
      )}
      {locations.length === 0 ? (
        <p>Aucun établissement.</p>
      ) : (
        <ul>
          {locations.map((loc) => (
            <li key={loc.id}>
              <Link href={`/dashboard/${orgId}/locations/${loc.id}`}>{loc.name}</Link>
              {' — '}
              {loc.timeZone}
              {' — retrait: '}
              {loc.pickupEnabled ? 'oui' : 'non'}
              {' — publication: '}
              {loc.isPubliclyListed ? 'publique' : 'brouillon'}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
