import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getCustomerBooking, type CustomerBookingStatus } from '@uttily/core';
import { CustomerCancellationModal } from './cancellation-modal';

export const dynamic = 'force-dynamic';

function formatAmount(minor: number, currency: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatFullDateTime(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  const str = formatter.format(new Date(date));
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getStatusBanner(
  status: CustomerBookingStatus,
  refundAmountMinor?: number,
  currency: string = 'EUR',
): { title: string; desc: string; bg: string; color: string; border: string } {
  switch (status) {
    case 'CONFIRMED':
      return {
        title: '✓ Votre location est confirmée',
        desc: 'Le loueur a réservé votre vélo. Présentez-vous à l’heure convenue pour le retrait.',
        bg: '#ecfdf5',
        color: '#065f46',
        border: '#a7f3d0',
      };
    case 'READY_FOR_PICKUP':
      return {
        title: '✓ Votre vélo est prêt à être retiré',
        desc: 'Votre équipement a été préparé et vérifié par l’atelier.',
        bg: '#ecfdf5',
        color: '#047857',
        border: '#6ee7b7',
      };
    case 'ACTIVE':
      return {
        title: '🚲 Location en cours',
        desc: 'Profitez de votre trajet ! Pensez à restituer l’équipement avant l’heure limite de retour.',
        bg: '#eff6ff',
        color: '#1d4ed8',
        border: '#bfdbfe',
      };
    case 'COMPLETED':
      return {
        title: '✓ Location terminée',
        desc: 'L’équipement a été restitué. Merci d’avoir loué avec Uttily !',
        bg: '#f8fafc',
        color: '#334155',
        border: '#cbd5e1',
      };
    case 'CANCELLED_REFUND_PENDING':
      return {
        title: '↩ Réservation annulée — Remboursement en cours',
        desc: refundAmountMinor
          ? `Un remboursement de ${formatAmount(refundAmountMinor, currency)} a été demandé et sera crédité sur votre moyen de paiement.`
          : 'Votre réservation est annulée.',
        bg: '#fffbeb',
        color: '#92400e',
        border: '#fde68a',
      };
    case 'CANCELLED_REFUNDED':
      return {
        title: '✓ Réservation annulée et remboursée',
        desc: refundAmountMinor
          ? `${formatAmount(refundAmountMinor, currency)} ont été remboursés sur votre compte.`
          : 'Réservation annulée.',
        bg: '#f8fafc',
        color: '#334155',
        border: '#e2e8f0',
      };
    case 'CANCELLED_NO_REFUND':
      return {
        title: '✕ Réservation annulée',
        desc: 'Cette réservation a été annulée conformément aux conditions acceptées.',
        bg: '#f8fafc',
        color: '#64748b',
        border: '#e2e8f0',
      };
    case 'CANCELLED_ACTION_REQUIRED':
      return {
        title: '⚠️ Réservation annulée — Action requise',
        desc: 'Le traitement du remboursement nécessite une action. Notre équipe prend contact avec vous.',
        bg: '#fef2f2',
        color: '#991b1b',
        border: '#fecaca',
      };
    default:
      return {
        title: '✓ Votre location est confirmée',
        desc: 'Présentez-vous à l’accueil du magasin.',
        bg: '#ecfdf5',
        color: '#065f46',
        border: '#a7f3d0',
      };
  }
}

export default async function CustomerBookingDetailPage({
  params,
}: {
  params: Promise<{ locale: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { locale, bookingId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect('/sign-in');
  }

  const db = getDb();
  const booking = await getCustomerBooking(db, user.id, bookingId);

  if (!booking) {
    notFound();
  }

  const banner = getStatusBanner(
    booking.status,
    booking.refund?.amountMinor ?? booking.cancellationRecord?.refundAmountMinor,
    booking.currency,
  );

  const mapsQuery = encodeURIComponent(`${booking.locationName}, ${booking.locationAddress}`);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

  return (
    <div style={containerStyle}>
      <Link href={`/${locale}/account/bookings`} style={backLinkStyle}>
        ← Mes locations
      </Link>

      <header style={headerStyle}>
        <div>
          {booking.categoryName && <span style={categoryBadgeStyle}>{booking.categoryName}</span>}
          <h1 style={titleStyle}>{booking.productName}</h1>
          <p style={orgSubtitleStyle}>Loueur : {booking.organizationName}</p>
        </div>
      </header>

      {/* Bannière de statut dynamique */}
      <div
        style={{
          ...bannerContainerStyle,
          backgroundColor: banner.bg,
          borderColor: banner.border,
          color: banner.color,
        }}
      >
        <h2 style={bannerTitleStyle}>{banner.title}</h2>
        <p style={bannerDescStyle}>{banner.desc}</p>
      </div>

      <div style={gridStyle}>
        {/* Colonne principale */}
        <div style={mainColumnStyle}>
          {/* Carte Retrait & Retour */}
          <section aria-labelledby="schedule-heading" style={cardStyle}>
            <h2 id="schedule-heading" style={cardTitleStyle}>
              📅 Dates et lieu de location
            </h2>

            <div style={scheduleGridStyle}>
              <div style={scheduleBlockStyle}>
                <span style={scheduleLabelStyle}>Retrait</span>
                <strong style={scheduleTimeStyle}>
                  {formatFullDateTime(booking.startAt, booking.timeZone)}
                </strong>
              </div>
              <div style={scheduleDividerStyle}>→</div>
              <div style={scheduleBlockStyle}>
                <span style={scheduleLabelStyle}>Retour</span>
                <strong style={scheduleTimeStyle}>
                  {formatFullDateTime(booking.endAt, booking.timeZone)}
                </strong>
              </div>
            </div>

            <div style={locationBoxStyle}>
              <div style={locationHeaderStyle}>
                <span style={locationIconStyle}>📍</span>
                <div>
                  <strong style={locationNameStyle}>{booking.locationName}</strong>
                  <p style={locationAddressStyle}>{booking.locationAddress}</p>
                </div>
              </div>

              <div style={locationActionsStyle}>
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={mapsButtonStyle}>
                  Ouvrir l’itinéraire Google Maps ↗
                </a>
                {booking.locationPhone && (
                  <span style={phoneStyle}>📞 {booking.locationPhone}</span>
                )}
              </div>
            </div>
          </section>

          {/* Carte Consignes de retrait */}
          <section aria-labelledby="instructions-heading" style={cardStyle}>
            <h2 id="instructions-heading" style={cardTitleStyle}>
              ℹ️ Pour votre retrait
            </h2>
            <ul style={instructionsListStyle}>
              <li style={instructionItemStyle}>
                <strong>Pièce d’identité :</strong> Présentez une carte d’identité ou un passeport
                valide au moment du retrait.
              </li>
              <li style={instructionItemStyle}>
                <strong>Accueil magasin :</strong> Présentez-vous directement à l’accueil de
                l’établissement en indiquant votre nom.
              </li>
              {booking.locationInstructions && (
                <li style={instructionItemStyle}>
                  <strong>Consigne spécifique :</strong> {booking.locationInstructions}
                </li>
              )}
            </ul>
          </section>

          {/* Carte Équipements */}
          <section aria-labelledby="items-heading" style={cardStyle}>
            <h2 id="items-heading" style={cardTitleStyle}>
              🚲 Équipement réservé
            </h2>
            <div style={itemsListStyle}>
              {booking.items.map((item, idx) => (
                <div key={idx} style={itemRowStyle}>
                  <div>
                    <strong style={itemNameStyle}>{item.productName}</strong>
                    {item.variantName && (
                      <span style={variantNameStyle}> · {item.variantName}</span>
                    )}
                    {item.size && <span style={sizeBadgeStyle}>Taille {item.size}</span>}
                  </div>
                  <span style={itemQtyStyle}>× {item.quantity}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Documents contractuels */}
          {booking.documents.length > 0 && (
            <section aria-labelledby="docs-heading" style={cardStyle}>
              <h2 id="docs-heading" style={cardTitleStyle}>
                📄 Vos documents
              </h2>
              <div style={docsListStyle}>
                {booking.documents.map((doc) => (
                  <div key={doc.id} style={docRowStyle}>
                    <div>
                      <strong style={docTitleStyle}>{doc.title}</strong>
                      <span style={docDateStyle}>
                        Émis le {new Intl.DateTimeFormat('fr-FR').format(new Date(doc.createdAt))}
                      </span>
                    </div>
                    <a
                      href={`/api/account/bookings/${booking.id}/documents/${doc.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={docDownloadLinkStyle}
                    >
                      Télécharger PDF ↗
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Colonne latérale */}
        <aside style={sideColumnStyle}>
          {/* Carte Paiement */}
          <section aria-labelledby="payment-heading" style={cardStyle}>
            <h2 id="payment-heading" style={cardTitleStyle}>
              💳 Votre paiement
            </h2>
            {booking.payment ? (
              <>
                <div style={paymentAmountRowStyle}>
                  <span style={paymentLabelStyle}>Montant total</span>
                  <strong style={paymentAmountStyle}>
                    {formatAmount(booking.payment.amountPaidMinor, booking.payment.currency)}
                  </strong>
                </div>
                <div style={paymentStatusRowStyle}>
                  {booking.payment.status === 'PAID' && (
                    <span style={paymentStatusPaidBadgeStyle}>✓ Payé en ligne</span>
                  )}
                  {booking.payment.status === 'PENDING' && (
                    <span style={paymentStatusPendingBadgeStyle}>⏳ Paiement en cours</span>
                  )}
                  {booking.payment.status === 'FAILED' && (
                    <span style={paymentStatusFailedBadgeStyle}>⚠️ Paiement à régulariser</span>
                  )}
                  {booking.payment.status === 'UNAVAILABLE' && (
                    <span style={paymentStatusMutedBadgeStyle}>Paiement non confirmé</span>
                  )}
                  {booking.payment.paidAt && booking.payment.status === 'PAID' && (
                    <span style={paymentDateStyle}>
                      le {new Intl.DateTimeFormat('fr-FR').format(new Date(booking.payment.paidAt))}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p style={noCancelNoticeStyle}>Informations de paiement non disponibles.</p>
            )}
          </section>

          {/* Carte Gestion / Annulation */}
          <section aria-labelledby="manage-heading" style={cardStyle}>
            <h2 id="manage-heading" style={cardTitleStyle}>
              ⚙️ Gestion de la réservation
            </h2>
            {booking.cancellation.allowed ? (
              <div style={cancellationActionBoxStyle}>
                <p style={cancellationNoticeStyle}>
                  Vous pouvez annuler votre réservation selon les conditions convenues.
                </p>
                <CustomerCancellationModal bookingId={booking.id} />
              </div>
            ) : booking.cancellationRecord ? (
              <div style={cancelledDetailsStyle}>
                <p style={cancelledTextStyle}>
                  Réservation annulée le{' '}
                  {new Intl.DateTimeFormat('fr-FR').format(
                    new Date(booking.cancellationRecord.cancelledAt),
                  )}
                  .
                </p>
                {booking.cancellationRecord.refundAmountMinor > 0 && (
                  <p style={refundTextStyle}>
                    Remboursement :{' '}
                    <strong>
                      {formatAmount(booking.cancellationRecord.refundAmountMinor, booking.currency)}
                    </strong>
                  </p>
                )}
              </div>
            ) : (
              <p style={noCancelNoticeStyle}>
                Cette réservation n’est plus modifiable ou annulable en ligne.
              </p>
            )}

            <div style={helpBoxStyle}>
              <span style={helpTitleStyle}>Besoin d’aide ?</span>
              <p style={helpTextStyle}>
                {booking.locationPhone
                  ? `Pour toute question relative à votre équipement, contactez directement l’établissement au ${booking.locationPhone}.`
                  : 'Pour toute question relative à votre équipement, contactez directement l’établissement.'}
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const backLinkStyle: React.CSSProperties = {
  textDecoration: 'none',
  color: '#0284c7',
  fontSize: '0.95rem',
  fontWeight: 600,
  alignSelf: 'flex-start',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
};

const categoryBadgeStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#0284c7',
  display: 'block',
  marginBottom: '0.25rem',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 800,
  letterSpacing: '-0.03em',
  color: '#0f172a',
  margin: '0 0 0.25rem 0',
};

const orgSubtitleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#64748b',
  margin: 0,
};

const bannerContainerStyle: React.CSSProperties = {
  borderRadius: '12px',
  borderWidth: '1px',
  borderStyle: 'solid',
  padding: '1.25rem 1.5rem',
};

const bannerTitleStyle: React.CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  margin: '0 0 0.25rem 0',
};

const bannerDescStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  margin: 0,
  opacity: 0.9,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: '1.5rem',
  alignItems: 'start',
};

const mainColumnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const sideColumnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '14px',
  border: '1px solid #e2e8f0',
  padding: '1.5rem',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.03)',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: '#0f172a',
  margin: 0,
};

const scheduleGridStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  backgroundColor: '#f8fafc',
  borderRadius: '10px',
  padding: '1rem',
  border: '1px solid #e2e8f0',
};

const scheduleBlockStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const scheduleLabelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  color: '#64748b',
  letterSpacing: '0.05em',
};

const scheduleTimeStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 700,
  color: '#0f172a',
};

const scheduleDividerStyle: React.CSSProperties = {
  fontSize: '1.25rem',
  color: '#94a3b8',
};

const locationBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  paddingTop: '0.5rem',
};

const locationHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
};

const locationIconStyle: React.CSSProperties = {
  fontSize: '1.2rem',
};

const locationNameStyle: React.CSSProperties = {
  fontSize: '1rem',
  color: '#0f172a',
  display: 'block',
};

const locationAddressStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  color: '#64748b',
  margin: '0.15rem 0 0 0',
};

const locationActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '0.75rem',
};

const mapsButtonStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#0284c7',
  textDecoration: 'none',
};

const phoneStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  color: '#475569',
  fontWeight: 500,
};

const instructionsListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const instructionItemStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  color: '#334155',
  lineHeight: 1.4,
};

const itemsListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const itemRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  backgroundColor: '#f8fafc',
  padding: '0.75rem 1rem',
  borderRadius: '8px',
};

const itemNameStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#0f172a',
};

const variantNameStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
};

const sizeBadgeStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  backgroundColor: '#e2e8f0',
  color: '#334155',
  padding: '0.15rem 0.4rem',
  borderRadius: '4px',
  marginLeft: '0.5rem',
};

const itemQtyStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  fontWeight: 700,
  color: '#0f172a',
};

const docsListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const docRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.75rem 0',
  borderBottom: '1px solid #f1f5f9',
};

const docTitleStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  color: '#0f172a',
  display: 'block',
};

const docDateStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#64748b',
};

const docDownloadLinkStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: '#0284c7',
  textDecoration: 'none',
};

const paymentAmountRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const paymentLabelStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#475569',
};

const paymentAmountStyle: React.CSSProperties = {
  fontSize: '1.35rem',
  fontWeight: 800,
  color: '#0f172a',
};

const paymentStatusRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.85rem',
};

const paymentStatusPaidBadgeStyle: React.CSSProperties = {
  color: '#059669',
  fontWeight: 600,
};

const paymentStatusPendingBadgeStyle: React.CSSProperties = {
  color: '#d97706',
  fontWeight: 600,
};

const paymentStatusFailedBadgeStyle: React.CSSProperties = {
  color: '#dc2626',
  fontWeight: 600,
};

const paymentStatusMutedBadgeStyle: React.CSSProperties = {
  color: '#64748b',
  fontWeight: 500,
};

const paymentDateStyle: React.CSSProperties = {
  color: '#64748b',
};

const cancellationActionBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  alignItems: 'flex-start',
};

const cancellationNoticeStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const cancelledDetailsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const cancelledTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const refundTextStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  color: '#0f172a',
  margin: 0,
};

const noCancelNoticeStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const helpBoxStyle: React.CSSProperties = {
  borderTop: '1px solid #f1f5f9',
  paddingTop: '0.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const helpTitleStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: '#334155',
};

const helpTextStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#64748b',
  margin: 0,
};
