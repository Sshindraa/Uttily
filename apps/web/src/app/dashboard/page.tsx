import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listOrganizationsForUser } from '@uttily/core';
import { ClientShell } from '@/components/shells/client-shell';
import { OrganizationSelectorView } from '@/features/dashboard';

export default async function DashboardPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const organizations = await listOrganizationsForUser(db, user.id);
  if (organizations.length === 0) redirect('/onboarding/organization');

  return (
    <ClientShell>
      <OrganizationSelectorView userEmail={user.email} organizations={organizations} />
    </ClientShell>
  );
}
