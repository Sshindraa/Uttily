import { getDb } from '@/lib/db';
import { listLocations, listPendingInvitations } from '@uttily/core';
import Link from 'next/link';

// Page d'accueil du dashboard organisation.
// L'authentification et la membership sont vérifiées par le layout
// `[orgId]/layout.tsx` ; cette page ne fait que les lectures.
export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const db = getDb();
  const locations = await listLocations(db, orgId);
  const invitations = await listPendingInvitations(db, orgId);

  return (
    <>
      <h1>Organisation</h1>

      <section>
        <h2>Établissements ({locations.length})</h2>
        {locations.length === 0 ? (
          <p>
            Aucun établissement. <Link href={`/dashboard/${orgId}/locations/new`}>Ajouter</Link>.
          </p>
        ) : (
          <ul>
            {locations.map((loc) => (
              <li key={loc.id}>
                <Link href={`/dashboard/${orgId}/locations/${loc.id}`}>{loc.name}</Link>
                {' — '}
                {loc.timeZone}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Invitations en attente ({invitations.length})</h2>
        {invitations.length === 0 ? (
          <p>Aucune invitation en attente.</p>
        ) : (
          <ul>
            {invitations.map((inv) => (
              <li key={inv.id}>
                {inv.email} — {inv.role}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
