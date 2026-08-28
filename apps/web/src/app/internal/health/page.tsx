import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import {
  emitOperationalLog,
  getOperationalHealth,
  type OperationalHealthStatus,
} from '@uttily/core';
import styles from './health.module.css';

export const dynamic = 'force-dynamic';

function statusClass(status: OperationalHealthStatus): string {
  switch (status) {
    case 'OK':
      return styles.statusOk ?? '';
    case 'À surveiller':
      return styles.statusWatch ?? '';
    case 'Action requise':
      return styles.statusAction ?? '';
  }
}

function formatReadAt(readAt: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(readAt));
}

export default async function InternalHealthPage(): Promise<React.ReactElement> {
  const { db } = await requireSupportPlatformAdmin();

  let health;
  try {
    health = await getOperationalHealth(db);
  } catch {
    emitOperationalLog({
      operation: 'internal_health',
      outcome: 'failed',
      errorCode: 'HEALTH_READ_FAILED',
    });
  }

  if (!health) {
    return (
      <div className={styles.container}>
        <section className={styles.header}>
          <h1 className={styles.title}>Santé opérationnelle</h1>
          <p className={styles.subtitle}>
            Lecture indisponible : aucune donnée opérationnelle n’est présentée comme saine.
          </p>
        </section>
        <section className={styles.errorCard} aria-live="polite">
          <strong className={styles.errorTitle}>Action requise</strong>
          <p>La lecture des signaux persistés a échoué. Consultez les outils Support existants.</p>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <section className={styles.header}>
        <h1 className={styles.title}>Santé opérationnelle</h1>
        <p className={styles.subtitle}>
          Vue synthétique en lecture seule des traitements critiques déjà persistés par Uttily.
        </p>
        <p className={styles.timestamp}>Lecture : {formatReadAt(health.readAt)} UTC</p>
      </section>

      <section className={styles.grid} aria-label="Signaux opérationnels">
        {health.signals.map((signal) => (
          <article className={styles.card} key={signal.key}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>{signal.label}</h2>
              <span className={`${styles.status} ${statusClass(signal.status)}`}>
                {signal.status}
              </span>
            </div>
            <dl className={styles.counts}>
              <div>
                <dt>En attente</dt>
                <dd>{signal.counts.pendingCount}</dd>
              </div>
              <div>
                <dt>Dues</dt>
                <dd>{signal.counts.dueCount}</dd>
              </div>
              <div>
                <dt>Échecs</dt>
                <dd>{signal.counts.failedCount}</dd>
              </div>
              <div>
                <dt>Revue manuelle</dt>
                <dd>{signal.counts.manualReviewCount}</dd>
              </div>
              <div>
                <dt>Leases actifs</dt>
                <dd>{signal.counts.activeLeaseCount}</dd>
              </div>
              <div>
                <dt>Leases expirés</dt>
                <dd>{signal.counts.expiredLeaseCount}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>
    </div>
  );
}
