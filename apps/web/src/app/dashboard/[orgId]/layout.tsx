import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, getOrganizationById } from '@uttily/core';
import { ProShell } from './pro-shell';

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
  const org = await getOrganizationById(db, orgId);

  return (
    <ProShell
      orgId={orgId}
      organizationName={org?.legalName ?? 'Organisation'}
      role={membership?.role ?? 'membre'}
      email={user.email}
    >
      {children}
    </ProShell>
  );
}
