import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listOrganizationsForUser } from '@uttily/core';
import Link from 'next/link';

export default async function DashboardPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const organizations = await listOrganizationsForUser(db, user.id);
  if (organizations.length === 0) redirect('/onboarding/organization');

  return (
    <main>
      <h1>Tableau de bord</h1>
      <p>Connecté en tant que {user.email}</p>

      <section>
        <h2>Mes organisations</h2>
        <ul>
          {organizations.map((org) => (
            <li key={org.id}>
              <Link href={`/dashboard/${org.id}`}>{org.legalName}</Link> ({org.slug})
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
