import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listOrganizationsForUser } from '@uttily/core';
import { Card, LinkButton, PageHeader } from '@uttily/ui';
import { ClientShell } from '@/components/client-shell';
import styles from './page.module.css';

export default async function DashboardPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const organizations = await listOrganizationsForUser(db, user.id);
  if (organizations.length === 0) redirect('/onboarding/organization');

  return (
    <ClientShell>
      <main className={styles.page}>
        <PageHeader
          eyebrow="Espace loueur"
          title="Vos organisations"
          description={`Connecté en tant que ${user.email}. Sélectionnez l’organisation à administrer.`}
        />

        <section className={styles.section} aria-labelledby="organizations-heading">
          <h2 id="organizations-heading" className={styles.sectionTitle}>
            Mes organisations
          </h2>
          <div className={styles.organizationGrid}>
            {organizations.map((org) => (
              <Card key={org.id} as="article" className={styles.organizationCard}>
                <div>
                  <h3>{org.legalName}</h3>
                  <p className={styles.organizationMeta}>Identifiant public : {org.slug}</p>
                </div>
                <div className={styles.organizationAction}>
                  <LinkButton href={`/dashboard/${org.id}`} variant="secondary" size="sm">
                    Ouvrir l’espace Pro
                  </LinkButton>
                </div>
              </Card>
            ))}
          </div>
        </section>
      </main>
    </ClientShell>
  );
}
