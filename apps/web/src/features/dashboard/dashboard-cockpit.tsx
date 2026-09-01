import type { ReactElement } from 'react';
import Link from 'next/link';
import { Icon, LinkButton, PageHeader } from '@uttily/ui';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import { OnboardingReadinessCard } from './components/onboarding-readiness-card';
import { ProfessionalVerificationCard } from './components/professional-verification-card';
import type { DashboardCockpitData } from './dashboard.types';
import styles from './dashboard-cockpit.module.css';

function maintenanceSignalLabel(
  kind: 'BROKEN_ITEM' | 'ACTIVE_MAINTENANCE' | 'UPCOMING_MAINTENANCE',
): string {
  switch (kind) {
    case 'BROKEN_ITEM':
      return 'Matériel cassé';
    case 'ACTIVE_MAINTENANCE':
      return 'Maintenance active';
    case 'UPCOMING_MAINTENANCE':
      return 'Maintenance à venir';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function DashboardCockpit({ data }: { data: DashboardCockpitData }): ReactElement {
  return (
    <div className={styles.container}>
      <PageHeader
        eyebrow={`Aujourd'hui · ${data.formattedDate}`}
        title="Bonjour"
        description={`Voici l'activité de ${data.organizationName} à suivre aujourd'hui.`}
        actions={
          <LinkButton href={`/dashboard/${data.organizationId}/bikes/new`} size="md">
            Ajouter un équipement <Icon name="arrow-right" size={17} />
          </LinkButton>
        }
      />

      {!data.readiness.isReadyForReservations && (
        <OnboardingReadinessCard orgId={data.organizationId} readiness={data.readiness} />
      )}

      <ProfessionalVerificationCard verification={data.professionalVerification} />

      <section className={styles.kpiGrid} aria-label="Indicateurs clés du jour">
        <Link
          href={`/dashboard/${data.organizationId}/bookings?status=CONFIRMED`}
          className={styles.kpiCard}
        >
          <div className={`${styles.kpiIcon} ${styles.kpiIconGreen}`}>🟢</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{data.pickupCount}</span>
            <span className={styles.kpiLabel}>Départs aujourd’hui</span>
          </div>
        </Link>

        <Link
          href={`/dashboard/${data.organizationId}/bookings?status=ACTIVE`}
          className={styles.kpiCard}
        >
          <div className={`${styles.kpiIcon} ${styles.kpiIconBlue}`}>🔵</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{data.returnCount}</span>
            <span className={styles.kpiLabel}>Retours aujourd’hui</span>
          </div>
        </Link>

        <Link href={`/dashboard/${data.organizationId}/fleet`} className={styles.kpiCard}>
          <div className={`${styles.kpiIcon} ${styles.kpiIconSky}`}>🚲</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{data.activeFleetCount}</span>
            <span className={styles.kpiLabel}>Équipements en service</span>
          </div>
        </Link>

        <Link href={`/dashboard/${data.organizationId}/fleet`} className={styles.kpiCard}>
          <div className={`${styles.kpiIcon} ${styles.kpiIconAmber}`}>⚠️</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{data.maintenanceSignals.length}</span>
            <span className={styles.kpiLabel}>En maintenance</span>
          </div>
        </Link>
      </section>

      <div className={styles.cockpitGrid}>
        <section className={styles.sectionCard} aria-labelledby="today-tasks-heading">
          <div className={styles.sectionHeader}>
            <h2 id="today-tasks-heading" className={styles.sectionTitle}>
              <span>📋</span> À faire aujourd’hui ({data.todayTasks.length})
            </h2>
            <Link href={`/dashboard/${data.organizationId}/bookings`} className={styles.seeAllLink}>
              Voir toutes les réservations →
            </Link>
          </div>

          {data.todayTasks.length === 0 ? (
            <div className={styles.emptyTasks}>
              ✓ Aucun départ ni retour programmé aujourd’hui. Tout est calme et en ordre !
            </div>
          ) : (
            <div className={styles.tasksList}>
              {data.todayTasks.map((task) => {
                const isPickup = task.type === 'PICKUP';

                return (
                  <div key={`${task.type}-${task.bookingId}`} className={styles.taskItem}>
                    <div className={styles.taskLeft}>
                      <div className={styles.taskTimeBadge}>
                        {formatDateTimeInTimeZone(task.time, task.timeZone).slice(-5)}
                      </div>
                      <div className={styles.taskDetails}>
                        <span className={styles.taskModel}>
                          {isPickup ? '🟢 Départ' : '🔵 Retour'} • {task.modelName} ({task.sku})
                        </span>
                        <span className={styles.taskSub}>📍 {task.locationName}</span>
                      </div>
                    </div>

                    <div>
                      <Link
                        href={`/dashboard/${data.organizationId}/bookings/${task.bookingId}`}
                        className={isPickup ? styles.taskBtnPickup : styles.taskBtnReturn}
                      >
                        {isPickup ? 'Préparer le départ →' : 'Effectuer le retour →'}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className={styles.cockpitAside}>
          <section className={styles.sectionCard} aria-labelledby="maintenance-signals-heading">
            <div className={styles.sectionHeader}>
              <h2 id="maintenance-signals-heading">
                <span>⚠️</span> Alertes matériel et maintenance ({data.maintenanceSignals.length})
              </h2>
            </div>

            {data.maintenanceSignals.length === 0 ? (
              <div className={styles.emptyAlerts}>
                <span>✓</span> Aucune alerte de matériel ou de maintenance.
              </div>
            ) : (
              <ul className={styles.alertsList} aria-label="Alertes de matériel et de maintenance">
                {data.maintenanceSignals.map((signal) => {
                  const signalId =
                    signal.kind === 'BROKEN_ITEM'
                      ? `broken-${signal.inventoryItemId}`
                      : `${signal.kind.toLowerCase()}-${signal.maintenanceBlockId}`;
                  const signalLabel = maintenanceSignalLabel(signal.kind);

                  return (
                    <li key={signalId} className={styles.alertItem}>
                      <div className={styles.alertLeft}>
                        <span className={styles.alertTitle}>
                          {signal.productName} ({signal.internalSku})
                        </span>
                        <span className={styles.alertSub}>
                          <strong>{signalLabel}</strong> • 📍 {signal.locationName} (
                          {signal.locationTimeZone})
                        </span>
                      </div>

                      <Link
                        href={`/dashboard/${data.organizationId}/fleet`}
                        className={styles.alertLink}
                      >
                        Voir →
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={styles.sectionCard} aria-labelledby="week-summary-heading">
            <div className={styles.sectionHeader}>
              <h2 id="week-summary-heading" className={styles.sectionTitle}>
                <span>📊</span> Activité globale
              </h2>
            </div>

            <div className={styles.weekSummary}>
              <div className={styles.weekStatRow}>
                <span>Revenus nets ({data.financePeriodLabel})</span>
                <Link
                  href={`/dashboard/${data.organizationId}/finances`}
                  className={styles.financeLink}
                >
                  {(data.netAfterCommissionMinor / 100).toLocaleString('fr-FR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  € →
                </Link>
              </div>
              <div className={styles.weekStatRow}>
                <span>Réservations actives</span>
                <strong>{data.activeBookingCount}</strong>
              </div>
              <div className={styles.weekStatRow}>
                <span>Établissements ouverts</span>
                <strong>{data.locationCount}</strong>
              </div>
              <div className={styles.weekStatRow}>
                <span>Membres d'équipe</span>
                <strong>{data.memberCount}</strong>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
