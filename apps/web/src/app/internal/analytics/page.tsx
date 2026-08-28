import Link from 'next/link';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { getAnalyticsEnvironment } from '@/lib/product-analytics';
import { getProductAnalyticsSummary } from '@uttily/core';
import type { ProductAnalyticsSummary } from '@uttily/core';
import type { MaintenanceAnalyticsEnvironment } from '@/lib/product-analytics-maintenance';
import {
  buildInternalFunnelView,
  formatFunnelCount,
  formatFunnelRate,
  parseFunnelRange,
  resolveFunnelWindow,
  FUNNEL_ENVIRONMENTS,
  FUNNEL_RANGES,
} from './funnel';
import styles from './analytics.module.css';

export const dynamic = 'force-dynamic';

/**
 * Surface interne Uttily — funnel produit agrégé (Chantier 18-A).
 *
 * Strictement réservée à l'équipe interne : la garde `requireSupportPlatformAdmin`
 * est ré-appliquée ici (défense en profondeur en plus du layout /internal).
 * Un utilisateur Pro, même OWNER, est rejeté.
 *
 * La page n'affiche QUE les quatre compteurs privacy-safe agrégés par Core.
 * Aucune dimension personnelle n'est lue ni rendue.
 */
export default async function InternalAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}): Promise<React.ReactElement> {
  const { db } = await requireSupportPlatformAdmin();
  const { range } = await searchParams;

  const rangeDays = parseFunnelRange(range);
  const window = resolveFunnelWindow(new Date(), rangeDays);

  const summaries = {} as Record<MaintenanceAnalyticsEnvironment, ProductAnalyticsSummary>;
  for (const environment of FUNNEL_ENVIRONMENTS) {
    summaries[environment] = await getProductAnalyticsSummary(db, {
      environment,
      fromDay: window.fromDay,
      toDayExclusive: window.toDayExclusive,
    });
  }

  const view = buildInternalFunnelView({
    rangeDays,
    window,
    collectionEnvironment: getAnalyticsEnvironment(),
    summaries,
  });

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

      {/* Bandeau de vérité : jamais de données PRODUCTION. */}
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
        Cette page n&apos;affiche que des compteurs agrégés par jour UTC : aucune donnée personnelle ni identifiant technique n&apos;est lu ni affiché.
      </p>
    </div>
  );
}
