import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership } from '@uttily/core';
import Link from 'next/link';

// Layout de la section Paramètres.
// Ré-autentifie et vérifie la membership (défense en profondeur) ;
// les pages enfants peuvent resserrer les rôles (ex. ROLE_MANAGERS).
export default async function SettingsLayout({
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
      <nav aria-label="Paramètres">
        <ul>
          <li>
            <Link href={`/dashboard/${orgId}/settings/payments`}>Paiements</Link>
          </li>
        </ul>
      </nav>
      {children}
    </div>
  );
}
