import { Card, LinkButton, PageHeader } from '@uttily/ui';
import styles from './organization-selector-view.module.css';

type OrganizationSummary = {
  id: string;
  legalName: string;
  slug: string;
};

export function OrganizationSelectorView({
  userEmail,
  organizations,
}: {
  userEmail: string;
  organizations: readonly OrganizationSummary[];
}): React.ReactElement {
  return (
    <main className={styles.page}>
      <PageHeader
        eyebrow="Espace loueur"
        title="Vos organisations"
        description={`Connecté en tant que ${userEmail}. Sélectionnez l’organisation à administrer.`}
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
  );
}
