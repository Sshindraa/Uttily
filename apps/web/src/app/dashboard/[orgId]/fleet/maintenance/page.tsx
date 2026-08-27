import Link from 'next/link';
import { listMaintenanceCases } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import styles from './maintenance.module.css';

export default async function MaintenanceListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId } = await requireCatalogViewerOf((await params).orgId);
  const allCases = await listMaintenanceCases(db, organizationId);

  const activeCases = allCases.filter((c) => c.status !== 'RESOLVED');
  const resolvedCases = allCases.filter((c) => c.status === 'RESOLVED');

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.breadRow}>
            <Link href={`/dashboard/${organizationId}/fleet`} className={styles.breadLink}>
              ← Flotte
            </Link>
          </div>
          <h1 className={styles.pageTitle}>🔧 Atelier &amp; Maintenance</h1>
          <p className={styles.pageSubtitle}>
            Suivi des anomalies, réparations d'atelier et remise en service de votre flotte.
          </p>
        </div>
      </div>

      {/* Badges de synthèse */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={`${styles.statValue} ${styles.statAmber}`}>{activeCases.length}</span>
          <span className={styles.statLabel}>Vélos en cours d'intervention</span>
        </div>
        <div className={styles.statCard}>
          <span className={`${styles.statValue} ${styles.statGreen}`}>{resolvedCases.length}</span>
          <span className={styles.statLabel}>Réparations terminées</span>
        </div>
      </div>

      {/* Dossiers Actifs */}
      <section className={styles.sectionCard}>
        <h2 className={styles.sectionTitle}>
          <span>⚠️</span> Interventions à traiter ({activeCases.length})
        </h2>

        {activeCases.length === 0 ? (
          <div className={styles.emptyBox}>
            ✓ Aucun vélo n'est actuellement bloqué en maintenance. Toute votre flotte est
            opérationnelle !
          </div>
        ) : (
          <div className={styles.casesGrid}>
            {activeCases.map((c) => (
              <article key={c.id} className={styles.caseCard}>
                <div className={styles.caseHeader}>
                  <div>
                    <span className={styles.caseSku}>{c.internalSku}</span>
                    <h3 className={styles.caseTitle}>
                      {c.productName} ({c.variantName})
                    </h3>
                  </div>

                  <span className={styles.badgeOpen}>
                    {c.status === 'OPEN' ? 'À traiter' : 'En cours'}
                  </span>
                </div>

                <div className={styles.caseBody}>
                  <div className={styles.reasonBox}>
                    <span className={styles.reasonLabel}>Problème signalé :</span>
                    <strong className={styles.reasonText}>« {c.reason} »</strong>
                  </div>

                  <div className={styles.metaRow}>
                    <span>📍 {c.locationName}</span>
                    <span>
                      Ouvert le {formatDateTimeInTimeZone(c.openedAt, c.locationTimeZone)}
                    </span>
                  </div>
                </div>

                <div className={styles.caseFooter}>
                  <Link
                    href={`/dashboard/${organizationId}/fleet/maintenance/${c.id}`}
                    className={styles.viewBtn}
                  >
                    Ouvrir le dossier d'atelier →
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Historique des Réparations */}
      {resolvedCases.length > 0 && (
        <section className={styles.sectionCard}>
          <h2 className={styles.sectionTitle}>
            <span>📜</span> Historique des réparations résolues ({resolvedCases.length})
          </h2>

          <div className={styles.historyList}>
            {resolvedCases.map((c) => (
              <div key={c.id} className={styles.historyItem}>
                <div className={styles.historyLeft}>
                  <span className={styles.historySku}>{c.internalSku}</span>
                  <div>
                    <strong>{c.productName}</strong> · « {c.reason} »
                  </div>
                </div>

                <div className={styles.historyRight}>
                  <span className={styles.badgeResolved}>✓ Remis en service</span>
                  <span className={styles.historyDate}>
                    {c.resolvedAt
                      ? formatDateTimeInTimeZone(c.resolvedAt, c.locationTimeZone)
                      : 'Résolu'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
