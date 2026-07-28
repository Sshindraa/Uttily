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

  return (
    <main>
      <h1>Tableau de bord</h1>
      <p>Connecté en tant que {user.email}</p>

      <section>
        <h2>Mes organisations</h2>
        {organizations.length === 0 ? (
          <p>
            Aucune organisation. <Link href="/onboarding/organization">Créer une organisation</Link>
            .
          </p>
        ) : (
          <ul>
            {organizations.map((org) => (
              <li key={org.id}>
                <Link href={`/dashboard/${org.id}`}>{org.legalName}</Link> ({org.slug})
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
