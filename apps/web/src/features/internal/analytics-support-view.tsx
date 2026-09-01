import Link from 'next/link';
import {
  formatFunnelCount,
  formatFunnelRate,
  FUNNEL_RANGES,
  type InternalFunnelView,
} from './funnel';
import styles from './analytics-support.module.css';

export function AnalyticsSupportView({ view }: { view: InternalFunnelView }): React.ReactElement {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>📊 Funnel Produit (interne)</h1>
        <p className={styles.subtitle}>
          Mesures produit agrégées, sans aucune dimension personnelle. Lecture seule.
        </p>

        <div className={styles.rangeBar}>
          <span className={styles.rangeLabel}>Période :</span>
          {FUNNEL_RANGES.map((days) => (
            <Link
              key={days}
              href={`/internal/analytics?range=${days}`}
              className={`${styles.rangeLink} ${days === view.rangeDays ? styles.rangeLinkActive : ''}`}
            >
              {days} derniers jours
            </Link>
          ))}
        </div>

        <p className={styles.windowInfo}>
          Fenêtre UTC : du <strong>{view.window.fromDay}</strong> au{' '}
          <strong>{view.window.toDayExclusive}</strong> (borne haute exclusive) — jour courant
          inclus. Environnement de collecte actuel : <strong>{view.collectionEnvironment}</strong>.
        </p>
      </div>

      <div className={styles.notice} role="status">
        <span className={styles.noticeIcon}>⚠️</span>
        <span>
          <span className={styles.noticeTitle}>Données PRODUCTION non disponibles.</span>{' '}
          {view.productionNotice}
        </span>
      </div>

      <div className={styles.envGrid}>
        {view.environments.map((env) => (
          <section key={env.environment} className={styles.envCard}>
            <div className={styles.envHeader}>
              <h2 className={styles.envTitle}>{env.environment}</h2>
              <span className={styles.envBadge}>{env.environment}</span>
            </div>

            <div className={styles.metricGrid}>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>Recherches</div>
                <div className={styles.metricValue}>{formatFunnelCount(env.summary.searches)}</div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>Recherches avec résultat</div>
                <div className={styles.metricValue}>
                  {formatFunnelCount(env.summary.searchesWithResults)}
                </div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>Tentatives de réservation</div>
                <div className={styles.metricValue}>
                  {formatFunnelCount(env.summary.bookingAttempts)}
                </div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>Réservations confirmées</div>
                <div className={styles.metricValue}>
                  {formatFunnelCount(env.summary.bookingsConfirmed)}
                </div>
              </div>
            </div>

            <div className={styles.ratioGrid}>
              <div className={styles.ratioRow}>
                <span className={styles.ratioLabel}>Taux recherche → résultat</span>
                <span
                  className={`${styles.ratioValue} ${env.ratios.searchToResultRate === null ? styles.ratioEmpty : ''}`}
                >
                  {formatFunnelRate(env.ratios.searchToResultRate)}
                </span>
              </div>
              <div className={styles.ratioRow}>
                <span className={styles.ratioLabel}>Taux tentative → confirmation</span>
                <span
                  className={`${styles.ratioValue} ${env.ratios.attemptToConfirmationRate === null ? styles.ratioEmpty : ''}`}
                >
                  {formatFunnelRate(env.ratios.attemptToConfirmationRate)}
                </span>
              </div>
            </div>
          </section>
        ))}
      </div>

      <p className={styles.privacyNote}>
        Cette page n&apos;affiche que des compteurs agrégés par jour UTC : aucune donnée personnelle
        ni identifiant technique n&apos;est lu ni affiché.
      </p>
    </div>
  );
}
