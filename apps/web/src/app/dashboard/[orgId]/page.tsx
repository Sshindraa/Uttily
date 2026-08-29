import {
  listLocations,
  listMaintenanceDashboardSignals,
  listPendingInvitations,
  listOperationalBookings,
  listInventorySummaries,
  getOrganizationOnboardingReadiness,
  getOrganizationById,
  getMerchantFinanceOverview,
  type MaintenanceDashboardSignal,
} from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import Link from 'next/link';
import { Icon, LinkButton, PageHeader } from '@uttily/ui';
import { OnboardingReadinessCard } from './onboarding-readiness-card';
import styles from './dashboard-cockpit.module.css';

function maintenanceSignalLabel(kind: MaintenanceDashboardSignal['kind']): string {
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

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const asOf = new Date();
  const org = await getOrganizationById(db, organizationId);
  const readiness = await getOrganizationOnboardingReadiness(db, organizationId);
  const locations = await listLocations(db, organizationId);
  const invitations = await listPendingInvitations(db, organizationId);
  const maintenanceSignals = await listMaintenanceDashboardSignals(db, organizationId, { asOf });
  const allBookings = await listOperationalBookings(db, organizationId);
  const inventoryItems = await listInventorySummaries(db, organizationId);
  const financesOverview = await getMerchantFinanceOverview(db, organizationId);

  // Calculs du Cockpit "Aujourd'hui"
  const endOfDay = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate(), 23, 59, 59);

  // Départs prévus aujourd'hui
  const todayPickups = allBookings.filter(
    (b) =>
      (b.status === 'CONFIRMED' || b.status === 'READY_FOR_PICKUP') &&
      new Date(b.customerStartAt) <= endOfDay,
  );

  // Retours prévus aujourd'hui
  const todayReturns = allBookings.filter(
    (b) => b.status === 'ACTIVE' && new Date(b.customerEndAt) <= endOfDay,
  );

  // Vélos en service & maintenance
  const activeFleetCount = inventoryItems.filter(
    (i) => i.status === 'ACTIVE' && i.condition !== 'BROKEN',
  ).length;
  const maintenanceCount = maintenanceSignals.length;

  // Tâches chronologiques du jour
  const todayTasks = [
    ...todayPickups.map((b) => ({
      type: 'PICKUP' as const,
      bookingId: b.id,
      time: b.customerStartAt,
      timeZone: b.locationTimeZone,
      modelName: `${b.bookingItemCount} vélo(s) à remettre`,
      sku: `#${b.id.slice(0, 6).toUpperCase()}`,
      clientName: 'Client Réservataire',
      locationName: b.locationName,
    })),
    ...todayReturns.map((b) => ({
      type: 'RETURN' as const,
      bookingId: b.id,
      time: b.customerEndAt,
      timeZone: b.locationTimeZone,
      modelName: `${b.bookingItemCount} vélo(s) à réceptionner`,
      sku: `#${b.id.slice(0, 6).toUpperCase()}`,
      clientName: 'Client Réservataire',
      locationName: b.locationName,
    })),
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const formattedDate = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(asOf);

  return (
    <div className={styles.container}>
      <PageHeader
        eyebrow={`Aujourd'hui · ${formattedDate}`}
        title="Bonjour"
        description={`Voici l'activité de ${org?.legalName ?? 'votre organisation'} à suivre aujourd'hui.`}
        actions={
          <LinkButton href={`/dashboard/${organizationId}/bikes/new`} size="md">
            Ajouter un vélo <Icon name="arrow-right" size={17} />
          </LinkButton>
        }
      />

      {/* Carte d'Onboarding 4 Étapes (si la boutique n'est pas encore 100% active) */}
      {!readiness.isReadyForReservations && (
        <OnboardingReadinessCard orgId={organizationId} readiness={readiness} />
      )}

      {/* Les 4 Chiffres Clés du Jour */}
      <section className={styles.kpiGrid} aria-label="Indicateurs clés du jour">
        <Link
          href={`/dashboard/${organizationId}/bookings?status=CONFIRMED`}
          className={styles.kpiCard}
        >
          <div className={`${styles.kpiIcon} ${styles.kpiIconGreen}`}>🟢</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{todayPickups.length}</span>
            <span className={styles.kpiLabel}>Départs aujourd’hui</span>
          </div>
        </Link>

        <Link
          href={`/dashboard/${organizationId}/bookings?status=ACTIVE`}
          className={styles.kpiCard}
        >
          <div className={`${styles.kpiIcon} ${styles.kpiIconBlue}`}>🔵</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{todayReturns.length}</span>
            <span className={styles.kpiLabel}>Retours aujourd’hui</span>
          </div>
        </Link>

        <Link href={`/dashboard/${organizationId}/fleet`} className={styles.kpiCard}>
          <div className={`${styles.kpiIcon} ${styles.kpiIconSky}`}>🚲</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{activeFleetCount}</span>
            <span className={styles.kpiLabel}>Vélos en service</span>
          </div>
        </Link>

        <Link href={`/dashboard/${organizationId}/fleet`} className={styles.kpiCard}>
          <div className={`${styles.kpiIcon} ${styles.kpiIconAmber}`}>⚠️</div>
          <div className={styles.kpiText}>
            <span className={styles.kpiValue}>{maintenanceCount}</span>
            <span className={styles.kpiLabel}>En maintenance</span>
          </div>
        </Link>
      </section>

      {/* Grille principale : À Faire + Alertes & Synthèse */}
      <div className={styles.cockpitGrid}>
        {/* Colonne Gauche : À Faire Aujourd'hui */}
        <section className={styles.sectionCard} aria-labelledby="today-tasks-heading">
          <div className={styles.sectionHeader}>
            <h2 id="today-tasks-heading" className={styles.sectionTitle}>
              <span>📋</span> À faire aujourd’hui ({todayTasks.length})
            </h2>
            <Link href={`/dashboard/${organizationId}/bookings`} className={styles.seeAllLink}>
              Voir toutes les réservations →
            </Link>
          </div>

          {todayTasks.length === 0 ? (
            <div className={styles.emptyTasks}>
              ✓ Aucun départ ni retour programmé aujourd’hui. Tout est calme et en ordre !
            </div>
          ) : (
            <div className={styles.tasksList}>
              {todayTasks.map((task) => {
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
                      {isPickup ? (
                        <Link
                          href={`/dashboard/${organizationId}/bookings/${task.bookingId}`}
                          className={styles.taskBtnPickup}
                        >
                          Préparer le départ →
                        </Link>
                      ) : (
                        <Link
                          href={`/dashboard/${organizationId}/bookings/${task.bookingId}`}
                          className={styles.taskBtnReturn}
                        >
                          Effectuer le retour →
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Colonne Droite : Flotte à surveiller & Activité Semaine */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Alertes Matériel */}
          <section className={styles.sectionCard} aria-labelledby="maintenance-signals-heading">
            <div className={styles.sectionHeader}>
              <h2 id="maintenance-signals-heading">
                <span>⚠️</span> Alertes matériel et maintenance ({maintenanceSignals.length})
              </h2>
            </div>

            {maintenanceSignals.length === 0 ? (
              <div className={styles.emptyAlerts}>
                <span>✓</span> Aucune alerte de matériel ou de maintenance.
              </div>
            ) : (
              <ul className={styles.alertsList} aria-label="Alertes de matériel et de maintenance">
                {maintenanceSignals.map((signal) => {
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
                        href={`/dashboard/${organizationId}/fleet`}
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

          {/* Synthèse Semaine */}
          <section className={styles.sectionCard} aria-labelledby="week-summary-heading">
            <div className={styles.sectionHeader}>
              <h2 id="week-summary-heading" className={styles.sectionTitle}>
                <span>📊</span> Activité globale
              </h2>
            </div>

            <div className={styles.weekSummary}>
              <div className={styles.weekStatRow}>
                <span>Revenus nets ({financesOverview.period.label})</span>
                <Link
                  href={`/dashboard/${organizationId}/finances`}
                  style={{ color: '#059669', fontWeight: 800, textDecoration: 'none' }}
                >
                  {(financesOverview.merchant.netAfterCommissionMinor / 100).toLocaleString(
                    'fr-FR',
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                  )}{' '}
                  € →
                </Link>
              </div>
              <div className={styles.weekStatRow}>
                <span>Réservations actives</span>
                <strong>{allBookings.length}</strong>
              </div>
              <div className={styles.weekStatRow}>
                <span>Établissements ouverts</span>
                <strong>{locations.length}</strong>
              </div>
              <div className={styles.weekStatRow}>
                <span>Membres d'équipe</span>
                <strong>{invitations.length + 1}</strong>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
