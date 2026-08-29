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
import { PageHeader, Card, Badge, LinkButton } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
import { DepartureFlow } from './departure-flow';
import { ReturnFlow } from './return-flow';
import { CancellationFlow } from './cancellation-flow';

function getBookingBadgeTone(status: BookingStatus): BadgeTone {
  switch (status) {
    case 'CONFIRMED':
    case 'READY_FOR_PICKUP':
      return 'info';
    case 'ACTIVE':
      return 'success';
    case 'RETURNED':
      return 'neutral';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

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

  // Timeline des événements opérationnels
  const timelineEvents: {
    id: string;
    date: Date;
    title: string;
    subtitle?: string | undefined;
    icon: string;
  }[] = [];

  details.fulfillmentEvents.forEach((ev) => {
    let title = 'Mise à jour opérationnelle';
    let icon = 'ℹ️';

    if (ev.eventType === 'PREPARED') {
      title = 'Vélo préparé au point de retrait';
      icon = '✓';
    } else if (ev.eventType === 'PICKED_UP') {
      title = 'Vélo remis au locataire';
      icon = '🟢';
    } else if (ev.eventType === 'RETURNED') {
      title = 'Vélo restitué et contrôlé';
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

  details.damageReports.forEach((dr) => {
    timelineEvents.push({
      id: dr.id,
      date: dr.createdAt,
      title: '⚠️ Anomalie ou dommage signalé',
      subtitle: `« ${dr.description} »`,
      icon: '⚠️',
    });
  });

  timelineEvents.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <Link
        href={`/dashboard/${organizationId}/bookings`}
        style={{
          color: 'var(--ut-color-primary)',
          fontWeight: 600,
          textDecoration: 'none',
          fontSize: '0.95rem',
        }}
      >
        ← Retour aux réservations
      </Link>

      <PageHeader
        eyebrow={`Établissement : ${details.locationName}`}
        title={
          details.customerEmail ? `Réservation : ${details.customerEmail}` : 'Réservation locataire'
        }
        description={`Du ${formatDateTimeInTimeZone(details.customerStartAt, details.locationTimeZone)} au ${formatDateTimeInTimeZone(details.customerEndAt, details.locationTimeZone)}`}
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={getBookingBadgeTone(status)}>{bookingStatusLabel(status)}</Badge>
            {isPickupPending && (
              <DepartureFlow orgId={organizationId} bookingId={bookingId} items={formItems} />
            )}
            {isReturnPending && (
              <ReturnFlow orgId={organizationId} bookingId={bookingId} items={formItems} />
            )}
            {status === 'CONFIRMED' && (
              <LinkButton
                href={`/dashboard/${organizationId}/bookings/${bookingId}/amend`}
                variant="secondary"
              >
                Modifier la réservation
              </LinkButton>
            )}
            {isPickupPending && <CancellationFlow orgId={organizationId} bookingId={bookingId} />}
          </div>
        }
      />

      {/* Grille des 4 Piliers */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
        }}
      >
        {/* Pilier 1 : Dates & Point de Retrait */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            📍 Dates &amp; Point de retrait
          </h2>
          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              border: 'var(--ut-border-thin)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.875rem' }}>
                Départ :
              </span>
              <strong>
                {formatDateTimeInTimeZone(details.customerStartAt, details.locationTimeZone)}
              </strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.875rem' }}>
                Retour prévu :
              </span>
              <strong>
                {formatDateTimeInTimeZone(details.customerEndAt, details.locationTimeZone)}
              </strong>
            </div>
            <div
              style={{
                borderTop: 'var(--ut-border-thin)',
                paddingTop: '0.5rem',
                marginTop: '0.25rem',
              }}
            >
              <span
                style={{ fontSize: '0.9rem', color: 'var(--ut-color-ink-strong)', fontWeight: 600 }}
              >
                📍 {details.locationName}
              </span>
              <span
                style={{
                  color: 'var(--ut-color-ink-muted)',
                  fontSize: '0.8rem',
                  marginLeft: '0.5rem',
                }}
              >
                ({details.locationTimeZone})
              </span>
            </div>
          </div>
        </Card>

        {/* Pilier 2 : Vélo réservé */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            🚲 Vélo réservé
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {details.items.map((item) => (
              <div
                key={item.bookingItemId}
                style={{
                  background: 'var(--ut-color-surface-soft)',
                  padding: '1rem',
                  borderRadius: 'var(--ut-radius-md)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                  border: 'var(--ut-border-thin)',
                }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                    Référence vélo :
                  </span>
                  <Link
                    href={`/dashboard/${organizationId}/fleet`}
                    style={{
                      color: 'var(--ut-color-primary)',
                      fontWeight: 700,
                      textDecoration: 'none',
                    }}
                  >
                    {item.internalSku}
                  </Link>
                </div>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                    N° de série :
                  </span>
                  <span style={{ color: 'var(--ut-color-ink)' }}>
                    {item.serialNumber ?? 'Non renseigné'}
                  </span>
                </div>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                    État actuel :
                  </span>
                  <Badge tone={item.currentCondition === 'POOR' ? 'danger' : 'success'}>
                    {conditionLabel(item.currentCondition)}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Pilier 3 : Locataire */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            👤 Locataire
          </h2>
          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              border: 'var(--ut-border-thin)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Contact locataire :
              </span>
              <strong>{details.customerEmail || 'Non communiqué'}</strong>
            </div>
            <p
              style={{
                fontSize: '0.8rem',
                color: 'var(--ut-color-ink-muted)',
                margin: '0.25rem 0 0',
              }}
            >
              Contact utilisé pour cette réservation.
            </p>
          </div>
        </Card>

        {/* Pilier 4 : Dossier Opérationnel */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            📋 Dossier opérationnel
          </h2>
          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              border: 'var(--ut-border-thin)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Nombre d’équipements :
              </span>
              <strong style={{ fontSize: '1rem', color: 'var(--ut-color-ink-strong)' }}>
                {details.items.length} vélo(s)
              </strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Statut opérationnel :
              </span>
              <Badge tone={getBookingBadgeTone(status)}>{bookingStatusLabel(status)}</Badge>
            </div>
          </div>
        </Card>
      </div>

      {/* Journal d'activité */}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
        <h2
          style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            margin: 0,
            color: 'var(--ut-color-ink-strong)',
          }}
        >
          Journal d’activité du dossier
        </h2>
        {timelineEvents.length === 0 ? (
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, fontSize: '0.9rem' }}>
            Aucun événement enregistré sur ce dossier.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {timelineEvents.map((ev) => (
              <div
                key={ev.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.75rem',
                  padding: '0.75rem 0',
                  borderBottom: 'var(--ut-border-thin)',
                }}
              >
                <span style={{ fontSize: '1.25rem' }}>{ev.icon}</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--ut-color-ink-strong)' }}>
                    {ev.title}
                  </strong>
                  {ev.subtitle && (
                    <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                      {ev.subtitle}
                    </span>
                  )}
                  <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-subtle)' }}>
                    {new Intl.DateTimeFormat('fr-FR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(new Date(ev.date))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
