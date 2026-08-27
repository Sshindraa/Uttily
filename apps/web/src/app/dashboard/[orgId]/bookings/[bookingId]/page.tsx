import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOperationalBookingDetails, type BookingStatus } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import {
  bookingStatusLabel,
  formatDateTimeInTimeZone,
  conditionLabel,
  isValidUuid,
} from '@/lib/operations-helpers';
import { DepartureFlow } from './departure-flow';
import { ReturnFlow } from './return-flow';
import styles from './booking-detail.module.css';

export default async function UnifiedBookingDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bookingId } = await params;

  if (!isValidUuid(bookingId)) notFound();

  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const details = await getOperationalBookingDetails(db, organizationId, bookingId);
  if (details === null) notFound();

  const status: BookingStatus = details.status;
  const isPickupPending = status === 'CONFIRMED' || status === 'READY_FOR_PICKUP';
  const isReturnPending = status === 'ACTIVE';

  const formItems = details.items.map((item) => ({
    bookingItemId: item.bookingItemId,
    internalSku: item.internalSku,
    serialNumber: item.serialNumber,
    currentCondition: item.currentCondition,
  }));

  // Construction de la Timeline Humaine (Chantier 8E)
  const timelineEvents: {
    id: string;
    date: Date;
    title: string;
    subtitle?: string | undefined;
    icon: string;
  }[] = [];

  // Événements de fulfillment
  details.fulfillmentEvents.forEach((ev) => {
    let title = `Événement : ${ev.eventType}`;
    let icon = 'ℹ️';

    if (ev.eventType === 'PREPARED') {
      title = 'Vélo préparé au point de retrait';
      icon = '✓';
    } else if (ev.eventType === 'PICKED_UP') {
      title = 'Vélo remis au client';
      icon = '🟢';
    } else if (ev.eventType === 'RETURNED') {
      title = 'Vélo retourné et contrôlé';
      icon = '🔵';
    } else if (ev.eventType === 'CLOSED') {
      title = 'Dossier de location clôturé avec succès';
      icon = '🏁';
    }

    timelineEvents.push({
      id: ev.id,
      date: ev.occurredAt,
      title,
      icon,
    });
  });

  // Rapports d'état
  details.conditionReports.forEach((cr) => {
    const isPickup = cr.phase === 'PICKUP';
    timelineEvents.push({
      id: cr.id,
      date: cr.createdAt,
      title: isPickup
        ? `Constat de départ · État : ${conditionLabel(cr.condition)}`
        : `Constat de retour · État : ${conditionLabel(cr.condition)}`,
      ...(cr.notes ? { subtitle: `« ${cr.notes} »` } : {}),
      icon: isPickup ? '🚲' : '🔍',
    });
  });

  // Rapports de dommage
  details.damageReports.forEach((dr) => {
    timelineEvents.push({
      id: dr.id,
      date: dr.createdAt,
      title: '⚠️ Anomalie ou dommage signalé',
      subtitle: `« ${dr.description} »`,
      icon: '⚠️',
    });
  });

  // Tri chronologique antéchronologique (plus récent en premier)
  timelineEvents.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className={styles.container}>
      {/* Retour navigation */}
      <div className={styles.backLinkRow}>
        <Link href={`/dashboard/${organizationId}/bookings`} className={styles.backLink}>
          ← Retour à la liste des réservations
        </Link>
      </div>

      {/* Hero Header de Réservation */}
      <div className={styles.headerCard}>
        <div className={styles.headerMain}>
          <div>
            <span className={styles.bookingRef}>
              Réservation #{details.id.slice(0, 8).toUpperCase()}
            </span>
            <h1 className={styles.customerHeading}>
              {details.customerEmail ?? 'Client Réservataire'}
            </h1>
          </div>

          <span
            className={`${styles.statusBadge} ${
              status === 'CONFIRMED' || status === 'READY_FOR_PICKUP'
                ? styles.statusConfirmed
                : status === 'ACTIVE'
                  ? styles.statusInUse
                  : status === 'RETURNED'
                    ? styles.statusReturned
                    : styles.statusCancelled
            }`}
          >
            {bookingStatusLabel(status)}
          </span>
        </div>

        {/* CTA d'action opérationnelle immédiate */}
        <div className={styles.actionHeroRow}>
          {isPickupPending && (
            <DepartureFlow orgId={organizationId} bookingId={bookingId} items={formItems} />
          )}

          {isReturnPending && (
            <ReturnFlow orgId={organizationId} bookingId={bookingId} items={formItems} />
          )}
        </div>
      </div>

      {/* 4 Piliers Unifiés de la Réservation */}
      <div className={styles.grid}>
        {/* Pilier 1 : Vélo(s) Attribué(s) */}
        <section className={styles.card} aria-labelledby="bike-heading">
          <h2 id="bike-heading" className={styles.cardTitle}>
            <span>🚲</span> Vélo physique attribué
          </h2>

          <div className={styles.bikeList}>
            {details.items.map((item) => (
              <div key={item.bookingItemId} className={styles.bikeItem}>
                <div className={styles.bikeHeader}>
                  <Link
                    href={`/dashboard/${organizationId}/inventory/${item.inventoryItemId}`}
                    className={styles.bikeSku}
                  >
                    {item.internalSku}
                  </Link>
                  <span className={styles.conditionChip}>
                    État actuel : {conditionLabel(item.currentCondition)}
                  </span>
                </div>

                <div className={styles.bikeSub}>
                  N° de série : <code>{item.serialNumber ?? 'Non renseigné'}</code>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Pilier 2 : Créneaux & Point de Retrait */}
        <section className={styles.card} aria-labelledby="dates-heading">
          <h2 id="dates-heading" className={styles.cardTitle}>
            <span>📍</span> Dates &amp; Point de retrait
          </h2>

          <div className={styles.dateBlock}>
            <div className={styles.dateRow}>
              <span className={styles.dateLabel}>Départ :</span>
              <strong>
                {formatDateTimeInTimeZone(details.customerStartAt, details.locationTimeZone)}
              </strong>
            </div>

            <div className={styles.dateRow}>
              <span className={styles.dateLabel}>Retour prévu :</span>
              <strong>
                {formatDateTimeInTimeZone(details.customerEndAt, details.locationTimeZone)}
              </strong>
            </div>

            <div className={styles.locationAddress}>
              📍 <strong>{details.locationName}</strong>
              <span style={{ color: '#64748b', fontSize: '0.85rem' }}>
                ({details.locationTimeZone})
              </span>
            </div>
          </div>
        </section>

        {/* Pilier 3 : Client & Contact */}
        <section className={styles.card} aria-labelledby="client-heading">
          <h2 id="client-heading" className={styles.cardTitle}>
            <span>👤</span> Locataire
          </h2>

          <div className={styles.clientInfo}>
            <div>
              <span className={styles.infoLabel}>Email :</span>
              <strong>{details.customerEmail ?? 'Non renseigné'}</strong>
            </div>
            <div>
              <span className={styles.infoLabel}>Statut financier :</span>
              <span className={styles.paymentPaid}>✓ Paiement validé</span>
            </div>
          </div>
        </section>

        {/* Pilier 4 : Historique Humain du Dossier */}
        <section className={styles.card} aria-labelledby="history-heading">
          <h2 id="history-heading" className={styles.cardTitle}>
            <span>📜</span> Journal d’activité du dossier
          </h2>

          {timelineEvents.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '0.9rem' }}>Aucun événement enregistré.</p>
          ) : (
            <div className={styles.timeline}>
              {timelineEvents.map((ev) => (
                <div key={ev.id} className={styles.timelineItem}>
                  <div className={styles.timelineIcon}>{ev.icon}</div>
                  <div className={styles.timelineContent}>
                    <div className={styles.timelineTitle}>{ev.title}</div>
                    {ev.subtitle && <div className={styles.timelineSub}>{ev.subtitle}</div>}
                    <div className={styles.timelineDate}>
                      {formatDateTimeInTimeZone(ev.date, details.locationTimeZone)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
