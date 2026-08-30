import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getCustomerBooking, type CustomerBookingStatus } from '@uttily/core';
import { Card, Badge, PageHeader } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
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
): { title: string; desc: string; tone: BadgeTone } {
  switch (status) {
    case 'CONFIRMED':
      return {
        title: 'Votre location est confirmée',
        desc: 'Le loueur a préparé votre dossier. Présentez-vous au point de retrait à l’heure convenue.',
        tone: 'success',
      };
    case 'READY_FOR_PICKUP':
      return {
        title: 'Votre équipement est prêt au magasin',
        desc: 'Votre équipement a été préparé par le loueur.',
        tone: 'success',
      };
    case 'ACTIVE':
      return {
        title: 'Location en cours',
        desc: 'Profitez de votre trajet ! Pensez à restituer l’équipement avant l’heure limite de retour.',
        tone: 'info',
      };
    case 'COMPLETED':
      return {
        title: 'Location terminée',
        desc: 'L’équipement a été restitué. Merci d’avoir loué avec Uttily !',
        tone: 'neutral',
      };
    case 'CANCELLED_REFUND_PENDING':
      return {
        title: 'Réservation annulée — Remboursement en cours de traitement',
        desc: refundAmountMinor
          ? `Une demande de remboursement de ${formatAmount(refundAmountMinor, currency)} a été transmise et est en cours de traitement.`
          : 'Votre réservation est annulée.',
        tone: 'warning',
      };
    case 'CANCELLED_REFUNDED':
      return {
        title: 'Réservation annulée et remboursée',
        desc: refundAmountMinor
          ? `Un remboursement de ${formatAmount(refundAmountMinor, currency)} a été émis sur votre moyen de paiement.`
          : 'Réservation annulée.',
        tone: 'neutral',
      };
    case 'CANCELLED_NO_REFUND':
      return {
        title: 'Réservation annulée',
        desc: 'Cette réservation a été annulée conformément aux conditions applicables.',
        tone: 'neutral',
      };
    case 'CANCELLED_ACTION_REQUIRED':
      return {
        title: 'Réservation annulée — Action requise',
        desc: 'Le traitement de votre dossier nécessite une intervention. Notre équipe vous contacte.',
        tone: 'danger',
      };
    default:
      return {
        title: 'Votre location est confirmée',
        desc: 'Présentez-vous à l’accueil du magasin.',
        tone: 'success',
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <Link
        href={`/${locale}/account/bookings`}
        style={{
          color: 'var(--ut-color-primary)',
          fontWeight: 600,
          textDecoration: 'none',
          fontSize: '0.95rem',
        }}
      >
        ← Mes locations
      </Link>

      <PageHeader
        eyebrow={booking.categoryName ?? 'Location'}
        title={booking.productName}
        description={`Loueur : ${booking.organizationName}`}
      />

      {/* Bannière de statut */}
      <Card
        style={{
          background:
            banner.tone === 'success'
              ? 'var(--ut-color-success-soft)'
              : banner.tone === 'info'
                ? 'var(--ut-color-primary-soft)'
                : banner.tone === 'warning'
                  ? 'var(--ut-color-warning-soft)'
                  : banner.tone === 'danger'
                    ? 'var(--ut-color-danger-soft)'
                    : 'var(--ut-color-surface-soft)',
          borderColor: 'transparent',
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}
        >
          <Badge tone={banner.tone}>{banner.title}</Badge>
        </div>
        <p style={{ margin: 0, color: 'var(--ut-color-ink)', fontSize: '0.95rem' }}>
          {banner.desc}
        </p>
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
          alignItems: 'start',
        }}
      >
        {/* Colonne principale */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Carte Retrait & Retour */}
          <Card style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <h2
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              📅 Dates et lieu de location
            </h2>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--ut-color-surface-soft)',
                borderRadius: 'var(--ut-radius-md)',
                padding: '1rem',
                border: 'var(--ut-border-thin)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Retrait
                </span>
                <strong style={{ fontSize: '0.95rem', color: 'var(--ut-color-ink-strong)' }}>
                  {formatFullDateTime(booking.startAt, booking.timeZone)}
                </strong>
              </div>
              <span style={{ color: 'var(--ut-color-ink-subtle)', fontSize: '1.25rem' }}>→</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Retour
                </span>
                <strong style={{ fontSize: '0.95rem', color: 'var(--ut-color-ink-strong)' }}>
                  {formatFullDateTime(booking.endAt, booking.timeZone)}
                </strong>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <strong style={{ color: 'var(--ut-color-ink-strong)', fontSize: '1rem' }}>
                  📍 {booking.locationName}
                </strong>
                <p
                  style={{
                    color: 'var(--ut-color-ink-muted)',
                    fontSize: '0.9rem',
                    margin: '0.2rem 0 0',
                  }}
                >
                  {booking.locationAddress}
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'var(--ut-color-primary)',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    textDecoration: 'none',
                  }}
                >
                  Ouvrir l’itinéraire Google Maps ↗
                </a>
                {booking.locationPhone && (
                  <span style={{ fontSize: '0.875rem', color: 'var(--ut-color-ink-muted)' }}>
                    📞 {booking.locationPhone}
                  </span>
                )}
              </div>
            </div>
          </Card>

          {/* Carte Consignes & Déroulement */}
          <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h2
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              ℹ️ Consignes &amp; Déroulement
            </h2>
            <ul
              style={{
                margin: 0,
                paddingLeft: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                color: 'var(--ut-color-ink)',
                fontSize: '0.9rem',
                lineHeight: 1.5,
              }}
            >
              <li>
                <strong>Pièce d’identité :</strong> Présentez une pièce d’identité valide au moment
                du retrait.
              </li>
              <li>
                <strong>Accueil magasin :</strong> Présentez-vous directement à l’accueil en
                indiquant votre nom.
              </li>
              {(booking.pickupInstructions ?? booking.locationInstructions) && (
                <li>
                  <strong>Consignes de retrait :</strong>{' '}
                  {booking.pickupInstructions ?? booking.locationInstructions}
                </li>
              )}
              {booking.returnInstructions && (
                <li>
                  <strong>Consignes de retour :</strong> {booking.returnInstructions}
                </li>
              )}
            </ul>
          </Card>

          {/* Carte Équipement réservé */}
          <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h2
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              🧰 Équipement réservé
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {booking.items.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: 'var(--ut-color-surface-soft)',
                    padding: '0.75rem 1rem',
                    borderRadius: 'var(--ut-radius-md)',
                  }}
                >
                  <div>
                    <strong style={{ color: 'var(--ut-color-ink-strong)', fontSize: '0.95rem' }}>
                      {item.productName}
                    </strong>
                    {item.variantName && (
                      <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                        {' '}
                        · {item.variantName}
                      </span>
                    )}
                    {item.size && (
                      <span
                        style={{
                          marginLeft: '0.5rem',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          background: 'var(--ut-color-border)',
                          padding: '0.15rem 0.4rem',
                          borderRadius: 'var(--ut-radius-sm)',
                        }}
                      >
                        Taille {item.size}
                      </span>
                    )}
                  </div>
                  <strong style={{ color: 'var(--ut-color-ink-strong)', fontSize: '0.9rem' }}>
                    × {item.quantity}
                  </strong>
                </div>
              ))}
            </div>
          </Card>

          {/* Vos documents */}
          {booking.documents.length > 0 && (
            <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h2
                style={{
                  fontSize: '1.1rem',
                  fontWeight: 700,
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                📄 Vos documents
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {booking.documents.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.5rem 0',
                      borderBottom: 'var(--ut-border-thin)',
                    }}
                  >
                    <div>
                      <strong
                        style={{
                          fontSize: '0.9rem',
                          color: 'var(--ut-color-ink-strong)',
                          display: 'block',
                        }}
                      >
                        {doc.title}
                      </strong>
                      <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                        Émis le {new Intl.DateTimeFormat('fr-FR').format(new Date(doc.createdAt))}
                      </span>
                    </div>
                    <a
                      href={`/api/account/bookings/${booking.id}/documents/${doc.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--ut-color-primary)',
                        textDecoration: 'none',
                      }}
                    >
                      Télécharger PDF ↗
                    </a>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Colonne latérale */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Votre paiement */}
          <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h2
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              💳 Votre paiement
            </h2>
            {booking.payment ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.95rem' }}>
                    Montant total
                  </span>
                  <strong style={{ fontSize: '1.35rem', color: 'var(--ut-color-ink-strong)' }}>
                    {formatAmount(booking.payment.amountPaidMinor, booking.payment.currency)}
                  </strong>
                </div>
                <div>
                  <Badge tone={booking.payment.status === 'PAID' ? 'success' : 'warning'}>
                    {booking.payment.status === 'PAID'
                      ? '✓ Payé en ligne'
                      : booking.payment.status === 'PENDING'
                        ? '⏳ Paiement en cours'
                        : '⚠️ Paiement à régulariser'}
                  </Badge>
                  {booking.payment.paidAt && booking.payment.status === 'PAID' && (
                    <span
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--ut-color-ink-muted)',
                        marginLeft: '0.5rem',
                      }}
                    >
                      le {new Intl.DateTimeFormat('fr-FR').format(new Date(booking.payment.paidAt))}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem', margin: 0 }}>
                Informations de paiement non disponibles.
              </p>
            )}
          </Card>

          {/* Gestion / Annulation */}
          <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h2
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              ⚙️ Gestion de la réservation
            </h2>
            {booking.cancellation.allowed ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <p style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem', margin: 0 }}>
                  Vous pouvez annuler votre réservation selon les conditions convenues.
                </p>
                <CustomerCancellationModal bookingId={booking.id} />
              </div>
            ) : booking.cancellationRecord ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <p style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem', margin: 0 }}>
                  Réservation annulée le{' '}
                  {new Intl.DateTimeFormat('fr-FR').format(
                    new Date(booking.cancellationRecord.cancelledAt),
                  )}
                  .
                </p>
                {booking.cancellationRecord.refundAmountMinor > 0 && (
                  <p style={{ color: 'var(--ut-color-ink-strong)', fontSize: '0.9rem', margin: 0 }}>
                    Remboursement demandé :{' '}
                    <strong>
                      {formatAmount(booking.cancellationRecord.refundAmountMinor, booking.currency)}
                    </strong>
                  </p>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem', margin: 0 }}>
                Cette réservation n’est plus modifiable ou annulable en ligne.
              </p>
            )}

            <div
              style={{
                borderTop: 'var(--ut-border-thin)',
                paddingTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                Besoin d’aide ?
              </span>
              <p style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem', margin: 0 }}>
                {booking.locationPhone
                  ? `Pour toute question relative à votre équipement, contactez directement l’établissement au ${booking.locationPhone}.`
                  : 'Pour toute question relative à votre équipement, contactez directement l’établissement.'}
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
