import Link from 'next/link';
import { listOperationalBookings, type BookingStatus } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import {
  bookingStatusLabel,
  formatDateTimeInTimeZone,
  QUICK_FILTERS,
  parseStatusFilter,
} from '@/lib/operations-helpers';
import styles from './bookings.module.css';

export default async function BookingsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string | string[]; tab?: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);

  const sp = await searchParams;
  let statuses: BookingStatus[] | null = null;
  let filterError: string | null = null;
  try {
    statuses = parseStatusFilter(sp.status);
  } catch (err) {
    filterError = err instanceof Error ? err.message : 'Filtre invalide.';
  }

  const listOptions = filterError === null && statuses !== null ? { statuses } : undefined;
  const bookings =
    filterError === null ? await listOperationalBookings(db, organizationId, listOptions) : [];

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>📅 Mes Réservations</h1>
          <p className={styles.pageSubtitle}>
            Gestion des départs, retours et suivi des réservations locataires.
          </p>
        </div>
      </div>

      {/* Onglets de vue : Liste / Planning (IA Pro — le planning vit dans Réservations) */}
      <nav aria-label="Vue des réservations" className={styles.tabsNav}>
        <div className={styles.tabsList}>
          <Link
            href={`/dashboard/${organizationId}/bookings`}
            className={`${styles.tabBtn} ${styles.tabBtnActive}`}
            aria-current="page"
          >
            Liste
          </Link>
          <Link href={`/dashboard/${organizationId}/bookings/planning`} className={styles.tabBtn}>
            📅 Planning
          </Link>
        </div>
      </nav>

      {/* Onglets de filtrage rapide */}
      <nav aria-label="Filtres de réservation" className={styles.tabsNav}>
        <div className={styles.tabsList}>
          <Link
            href={`/dashboard/${organizationId}/bookings`}
            className={`${styles.tabBtn} ${!sp.status ? styles.tabBtnActive : ''}`}
          >
            Toutes ({bookings.length})
          </Link>
          {QUICK_FILTERS.map((qf) => {
            const isMatch =
              sp.status === (Array.isArray(qf.statuses) ? qf.statuses[0] : qf.statuses);
            const href = `/dashboard/${organizationId}/bookings?status=${Array.isArray(qf.statuses) ? qf.statuses.join(',') : qf.statuses}`;

            return (
              <Link
                key={qf.key}
                href={href}
                className={`${styles.tabBtn} ${isMatch ? styles.tabBtnActive : ''}`}
              >
                {qf.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {filterError && (
        <div role="alert" className={styles.errorAlert}>
          {filterError}
        </div>
      )}

      {bookings.length === 0 ? (
        <div className={styles.emptyState}>
          <span style={{ fontSize: '2.5rem' }}>📅</span>
          <h3>Aucune réservation trouvée</h3>
          <p>Les nouvelles réservations clients apparaîtront automatiquement ici en temps réel.</p>
        </div>
      ) : (
        <div className={styles.bookingsGrid}>
          {bookings.map((booking) => {
            const isPickupPending =
              booking.status === 'CONFIRMED' || booking.status === 'READY_FOR_PICKUP';
            const isReturnPending = booking.status === 'ACTIVE';

            return (
              <article key={booking.id} className={styles.bookingCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.idAndStatus}>
                    <span className={styles.bookingIdBadge}>
                      #{booking.id.slice(0, 8).toUpperCase()}
                    </span>
                    <span
                      className={`${styles.statusBadge} ${
                        booking.status === 'CONFIRMED' || booking.status === 'READY_FOR_PICKUP'
                          ? styles.statusConfirmed
                          : booking.status === 'ACTIVE'
                            ? styles.statusInUse
                            : booking.status === 'RETURNED'
                              ? styles.statusReturned
                              : styles.statusCancelled
                      }`}
                    >
                      {bookingStatusLabel(booking.status)}
                    </span>
                  </div>

                  <div className={styles.dateChip}>📍 {booking.locationName}</div>
                </div>

                <div className={styles.cardBody}>
                  <div className={styles.timeRow}>
                    <div className={styles.timeBlock}>
                      <span className={styles.timeLabel}>Départ :</span>
                      <strong>
                        {formatDateTimeInTimeZone(
                          booking.customerStartAt,
                          booking.locationTimeZone,
                        )}
                      </strong>
                    </div>
                    <span style={{ color: '#94a3b8' }}>→</span>
                    <div className={styles.timeBlock}>
                      <span className={styles.timeLabel}>Retour :</span>
                      <strong>
                        {formatDateTimeInTimeZone(booking.customerEndAt, booking.locationTimeZone)}
                      </strong>
                    </div>
                  </div>

                  <div className={styles.itemsBlock}>
                    <span className={styles.itemsLabel}>
                      Équipements : {booking.bookingItemCount} vélo(s) alloué(s)
                    </span>
                  </div>
                </div>

                <div className={styles.cardFooter}>
                  {isPickupPending && (
                    <Link
                      href={`/dashboard/${organizationId}/bookings/${booking.id}`}
                      className={styles.ctaPrimary}
                    >
                      Préparer le départ →
                    </Link>
                  )}

                  {isReturnPending && (
                    <Link
                      href={`/dashboard/${organizationId}/bookings/${booking.id}`}
                      className={styles.ctaSecondary}
                    >
                      Effectuer le retour →
                    </Link>
                  )}

                  {!isPickupPending && !isReturnPending && (
                    <Link
                      href={`/dashboard/${organizationId}/bookings/${booking.id}`}
                      className={styles.ctaNeutral}
                    >
                      Voir le dossier →
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
