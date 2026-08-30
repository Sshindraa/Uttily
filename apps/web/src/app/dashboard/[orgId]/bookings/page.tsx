import Link from 'next/link';
import { listOperationalBookings, type BookingStatus } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import {
  bookingStatusLabel,
  formatDateTimeInTimeZone,
  QUICK_FILTERS,
  parseStatusFilter,
} from '@/lib/operations-helpers';
import { PageHeader, Card, Badge, LinkButton } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Opérations"
        title="Réservations"
        description="Gestion des départs, retours et suivi des réservations locataires."
        actions={
          <LinkButton href={`/dashboard/${organizationId}/bookings/planning`} variant="secondary">
            📅 Vue planning
          </LinkButton>
        }
      />

      {/* Onglets de filtrage rapide */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Link
          href={`/dashboard/${organizationId}/bookings`}
          style={{
            padding: '0.45rem 0.9rem',
            borderRadius: 'var(--ut-radius-md)',
            fontSize: '0.875rem',
            fontWeight: 600,
            textDecoration: 'none',
            background: !sp.status ? 'var(--ut-color-ink-strong)' : 'var(--ut-color-surface-soft)',
            color: !sp.status ? '#ffffff' : 'var(--ut-color-ink)',
            border: 'var(--ut-border-thin)',
          }}
        >
          Toutes ({bookings.length})
        </Link>
        {QUICK_FILTERS.map((qf) => {
          const isMatch = sp.status === (Array.isArray(qf.statuses) ? qf.statuses[0] : qf.statuses);
          const href = `/dashboard/${organizationId}/bookings?status=${Array.isArray(qf.statuses) ? qf.statuses.join(',') : qf.statuses}`;

          return (
            <Link
              key={qf.key}
              href={href}
              style={{
                padding: '0.45rem 0.9rem',
                borderRadius: 'var(--ut-radius-md)',
                fontSize: '0.875rem',
                fontWeight: 600,
                textDecoration: 'none',
                background: isMatch ? 'var(--ut-color-ink-strong)' : 'var(--ut-color-surface-soft)',
                color: isMatch ? '#ffffff' : 'var(--ut-color-ink)',
                border: 'var(--ut-border-thin)',
              }}
            >
              {qf.label}
            </Link>
          );
        })}
      </div>

      {filterError && (
        <Card
          style={{
            background: 'var(--ut-color-danger-soft)',
            color: 'var(--ut-color-danger)',
            padding: '1rem',
          }}
        >
          {filterError}
        </Card>
      )}

      {bookings.length === 0 ? (
        <Card
          style={{
            textAlign: 'center',
            padding: '3.5rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <div style={{ fontSize: '3rem' }}>📅</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Aucune réservation trouvée
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '28rem' }}>
            Les nouvelles réservations clients apparaîtront automatiquement ici lors de leur
            confirmation.
          </p>
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '1.5rem',
          }}
        >
          {bookings.map((booking) => {
            const isPickupPending =
              booking.status === 'CONFIRMED' || booking.status === 'READY_FOR_PICKUP';
            const isReturnPending = booking.status === 'ACTIVE';
            const detailHref = `/dashboard/${organizationId}/bookings/${booking.id}`;
            const badgeTone = getBookingBadgeTone(booking.status);

            return (
              <Card
                key={booking.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '1.25rem',
                  padding: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                    }}
                  >
                    <div>
                      <h2
                        style={{
                          fontSize: '1.1rem',
                          fontWeight: 700,
                          margin: '0 0 0.25rem 0',
                          color: 'var(--ut-color-ink-strong)',
                        }}
                      >
                        Réservation · {booking.bookingItemCount} équipement
                        {booking.bookingItemCount > 1 ? 's' : ''}
                      </h2>
                      <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                        📍 {booking.locationName}
                      </span>
                    </div>
                    <Badge tone={badgeTone}>{bookingStatusLabel(booking.status)}</Badge>
                  </div>

                  <div
                    style={{
                      background: 'var(--ut-color-surface-soft)',
                      padding: '0.85rem',
                      borderRadius: 'var(--ut-radius-md)',
                      fontSize: '0.85rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.35rem',
                      border: 'var(--ut-border-thin)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--ut-color-ink-muted)' }}>Départ :</span>
                      <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                        {formatDateTimeInTimeZone(
                          booking.customerStartAt,
                          booking.locationTimeZone,
                        )}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--ut-color-ink-muted)' }}>Retour :</span>
                      <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                        {formatDateTimeInTimeZone(booking.customerEndAt, booking.locationTimeZone)}
                      </strong>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    paddingTop: '0.75rem',
                    borderTop: 'var(--ut-border-thin)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Link
                    href={detailHref}
                    style={{
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: 'var(--ut-color-primary)',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    {isPickupPending
                      ? 'Préparer le départ →'
                      : isReturnPending
                        ? 'Effectuer le retour →'
                        : 'Consulter le dossier →'}
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
