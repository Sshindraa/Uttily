import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { getBookingSupportDetails, SupportBookingNotFoundError } from '@uttily/core';
import { RetryNotificationButton } from './retry-notification-button';
import styles from './booking-support.module.css';

export const dynamic = 'force-dynamic';

export default async function BookingSupportPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { bookingId } = await params;

  let booking;
  try {
    booking = await getBookingSupportDetails(db, bookingId);
  } catch (err) {
    if (err instanceof SupportBookingNotFoundError) {
      notFound();
    }
    throw err;
  }

  const dotClass = (type: string) => {
    switch (type) {
      case 'SUCCESS':
        return styles.dotSuccess;
      case 'WARNING':
        return styles.dotWarning;
      case 'ERROR':
        return styles.dotError;
      default:
        return styles.dotInfo;
    }
  };

  return (
    <div className={styles.container}>
      {/* Header Réservation */}
      <div className={styles.headerCard}>
        <div className={styles.headerMain}>
          <Link
            href="/internal"
            style={{
              color: 'var(--ut-color-support-link)',
              fontSize: '0.85rem',
              textDecoration: 'none',
              marginBottom: '0.5rem',
            }}
          >
            ← Retour à la recherche support
          </Link>
          <h1 className={styles.title}>
            <span>📋</span> Réservation #{booking.id.slice(0, 8)}
          </h1>
          <div className={styles.metaRow}>
            <span>
              <strong>Organisation :</strong>{' '}
              <Link
                href={`/internal/organizations/${booking.organizationId}`}
                style={{ color: 'var(--ut-color-support-link)' }}
              >
                {booking.organizationName}
              </Link>
            </span>
            <span>•</span>
            <span>
              <strong>Établissement :</strong> {booking.locationName} ({booking.locationCity})
            </span>
            <span>•</span>
            <span>
              <strong>Fuseau :</strong> <code>{booking.dates.timeZone}</code>
            </span>
            <span>•</span>
            <span>
              <strong>ID Complet :</strong> <code>{booking.id}</code>
            </span>
          </div>
        </div>

        <div>
          <span
            className={`${styles.statusBadge} ${
              booking.status === 'CONFIRMED' || booking.status === 'ACTIVE'
                ? styles.statusConfirmed
                : booking.status === 'CANCELLED'
                  ? styles.statusCancelled
                  : styles.statusPending
            }`}
          >
            Statut : {booking.status} ({booking.fulfillmentStatus})
          </span>
        </div>
      </div>

      {/* Grille 2 Colonnes : Diagnostic Financier & Client/Dates */}
      <div className={styles.grid2Col}>
        {/* Diagnostic Financier */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>💶 Diagnostic Financier Consolidé</span>
          </h2>
          <div className={styles.infoGrid}>
            <div className={styles.infoLabel}>Total payé brut :</div>
            <div className={styles.infoVal}>
              <strong>
                {(booking.financial.grossPaidMinor / 100).toFixed(2)} {booking.financial.currency}
              </strong>
            </div>

            <div className={styles.infoLabel}>Montant initial réservation :</div>
            <div className={styles.infoVal}>
              {(booking.financial.originalTotalMinor / 100).toFixed(2)} {booking.financial.currency}
            </div>

            <div className={styles.infoLabel}>Suppléments (Avenants) :</div>
            <div className={styles.infoVal}>
              +{(booking.financial.supplementTotalMinor / 100).toFixed(2)}{' '}
              {booking.financial.currency}
            </div>

            <div className={styles.infoLabel}>Total remboursé :</div>
            <div
              className={styles.infoVal}
              style={{
                color:
                  booking.financial.refundTotalMinor > 0
                    ? 'var(--ut-color-support-danger)'
                    : undefined,
              }}
            >
              -{(booking.financial.refundTotalMinor / 100).toFixed(2)} {booking.financial.currency}
            </div>

            <div className={styles.infoLabel}>Net conservé :</div>
            <div className={styles.infoVal}>
              <strong>
                {(booking.financial.netRetainedMinor / 100).toFixed(2)} {booking.financial.currency}
              </strong>
            </div>

            <div className={styles.infoLabel}>Commission Uttily plateforme :</div>
            <div className={styles.infoVal}>
              {(booking.financial.platformCommissionMinor / 100).toFixed(2)}{' '}
              {booking.financial.currency}
            </div>

            <div className={styles.infoLabel}>Revenu net loueur :</div>
            <div className={styles.infoVal} style={{ color: 'var(--ut-color-support-success)' }}>
              <strong>
                {(booking.financial.finalMerchantRevenueMinor / 100).toFixed(2)}{' '}
                {booking.financial.currency}
              </strong>
            </div>
          </div>

          {booking.payment && (
            <div
              style={{
                marginTop: '0.75rem',
                borderTop: '1px solid var(--ut-color-support-border)',
                paddingTop: '0.75rem',
                fontSize: '0.85rem',
              }}
            >
              <p>
                <strong>Paiement Initial :</strong> <code>{booking.payment.id}</code> (Statut :{' '}
                {booking.payment.status})
              </p>
              {booking.payment.providerPaymentIntentId && (
                <p style={{ marginTop: '0.25rem' }}>
                  <strong>Stripe PaymentIntent :</strong>{' '}
                  <code>{booking.payment.providerPaymentIntentId}</code>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Client & Période */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>👤 Client & Période</span>
          </h2>
          <div className={styles.infoGrid}>
            <div className={styles.infoLabel}>Nom du client :</div>
            <div className={styles.infoVal}>{booking.customer.displayName ?? '—'}</div>

            <div className={styles.infoLabel}>Email du client :</div>
            <div className={styles.infoVal}>
              <strong>{booking.customer.email}</strong>
            </div>

            <div className={styles.infoLabel}>ID Client :</div>
            <div className={styles.infoVal}>
              <code>{booking.customer.id}</code>
            </div>

            <div className={styles.infoLabel}>Début location (UTC) :</div>
            <div className={styles.infoVal}>{booking.dates.pickupUtc.toLocaleString('fr-FR')}</div>

            <div className={styles.infoLabel}>Fin location (UTC) :</div>
            <div className={styles.infoVal}>{booking.dates.returnUtc.toLocaleString('fr-FR')}</div>
          </div>

          {booking.cancellation && (
            <div
              style={{
                marginTop: '0.75rem',
                borderTop: '1px solid var(--ut-color-support-danger-strong)',
                paddingTop: '0.75rem',
                fontSize: '0.85rem',
                color: 'var(--ut-color-support-danger-soft)',
              }}
            >
              <p>
                <strong>⚠️ Réservation annulée :</strong> le{' '}
                {booking.cancellation.occurredAt.toLocaleString('fr-FR')}
              </p>
              <p>
                Motif : {booking.cancellation.actorReason} • Politique :{' '}
                {booking.cancellation.policyCode}
              </p>
              <p>
                Remboursement accordé : {(booking.cancellation.refundAmountMinor / 100).toFixed(2)}{' '}
                EUR
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Lignes & Allocations Physiques */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          <span>🚲 Allocations Physiques & Matériel ({booking.lines.length} ligne(s))</span>
        </h2>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Produit & Modèle</th>
                <th className={styles.th}>Variante</th>
                <th className={styles.th}>Qté</th>
                <th className={styles.th}>Identifiant interne (SKU)</th>
                <th className={styles.th}>Numéro de série</th>
                <th className={styles.th}>État</th>
                <th className={styles.th}>Statut Exemplaire</th>
              </tr>
            </thead>
            <tbody>
              {booking.lines.flatMap((line) =>
                line.allocations.length > 0 ? (
                  line.allocations.map((alloc) => (
                    <tr key={alloc.id}>
                      <td className={styles.td}>
                        <strong>{line.productName}</strong>
                      </td>
                      <td className={styles.td}>{line.variantName}</td>
                      <td className={styles.td}>1</td>
                      <td className={styles.td}>
                        <code>{alloc.internalIdentifier ?? 'N/A'}</code>
                      </td>
                      <td className={styles.td}>
                        <code>{alloc.serialNumber ?? 'N/A'}</code>
                      </td>
                      <td className={styles.td}>{alloc.condition}</td>
                      <td className={styles.td}>{alloc.status}</td>
                    </tr>
                  ))
                ) : (
                  <tr key={line.id}>
                    <td className={styles.td}>
                      <strong>{line.productName}</strong>
                    </td>
                    <td className={styles.td}>{line.variantName}</td>
                    <td className={styles.td}>{line.quantity}</td>
                    <td
                      className={styles.td}
                      colSpan={4}
                      style={{ color: 'var(--ut-color-support-warning)' }}
                    >
                      Aucun exemplaire physique alloué
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Timeline Métier Chronologique */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          <span>⏱️ Timeline Métier Chronologique</span>
        </h2>
        <div className={styles.timeline}>
          {booking.timeline.map((evt) => (
            <div key={evt.id} className={styles.timelineEvent}>
              <div className={`${styles.timelineDot} ${dotClass(evt.type)}`} />
              <div className={styles.timelineHeader}>
                <span className={styles.timelineLabel}>{evt.label}</span>
                <span className={styles.timelineDate}>{evt.timestamp.toLocaleString('fr-FR')}</span>
              </div>
              <div className={styles.timelineDesc}>
                {evt.description}
                {evt.actorEmail && <span> • Par : {evt.actorEmail}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Notifications Transactionnelles */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          <span>🔔 Notifications Transactionnelles ({booking.notifications.length})</span>
        </h2>
        {booking.notifications.length === 0 ? (
          <p style={{ color: 'var(--ut-color-support-subtle)', fontSize: '0.9rem' }}>
            Aucune notification enregistrée pour cette réservation.
          </p>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Template</th>
                  <th className={styles.th}>Destinataire</th>
                  <th className={styles.th}>Statut</th>
                  <th className={styles.th}>Tentatives</th>
                  <th className={styles.th}>Dernière erreur</th>
                  <th className={styles.th}>Action Support</th>
                </tr>
              </thead>
              <tbody>
                {booking.notifications.map((n) => (
                  <tr key={n.id}>
                    <td className={styles.td}>
                      <code>{n.template}</code>
                    </td>
                    <td className={styles.td}>{n.recipient}</td>
                    <td className={styles.td}>
                      <span
                        className={`${styles.statusBadge} ${
                          n.status === 'SENT'
                            ? styles.statusConfirmed
                            : n.status === 'FAILED'
                              ? styles.statusCancelled
                              : styles.statusPending
                        }`}
                      >
                        {n.status}
                      </span>
                    </td>
                    <td className={styles.td}>{n.attemptCount}</td>
                    <td className={styles.td}>{n.failureCode ?? '—'}</td>
                    <td className={styles.td}>
                      {n.status === 'FAILED' && <RetryNotificationButton notificationId={n.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
