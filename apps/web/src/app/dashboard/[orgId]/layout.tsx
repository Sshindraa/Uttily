import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership } from '@uttily/core';
import Link from 'next/link';

// Layout partagé de la section organisation.
// Authentifie l'utilisateur et vérifie la membership une seule fois
// pour toutes les pages enfants (défense en profondeur : les pages
// enfants peuvent refaire leurs propres vérifications).
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  return (
    <div>
      <nav aria-label="Navigation principale">
        <ul>
          <li>
            <Link href={`/dashboard/${orgId}/locations`}>Établissements</Link>
          </li>
          <li>
            <Link href={`/dashboard/${orgId}/catalog`}>Catalogue</Link>
          </li>
          <li>
            <Link href={`/dashboard/${orgId}/inventory`}>Inventaire</Link>
          </li>
          <li>
            <Link href={`/dashboard/${orgId}/operations`}>Opérations</Link>
          </li>
          <li>
            <Link href={`/dashboard/${orgId}/team`}>Équipe</Link>
          </li>
          <li>
            <Link href={`/dashboard/${orgId}/settings/payments`}>Paiements</Link>
          </li>
        </ul>
      </nav>
      {children}
    </div>
  );
}
