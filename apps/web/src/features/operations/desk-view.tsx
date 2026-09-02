import Link from 'next/link';
import type {
  LocationRecord,
  OperationalDayDesk,
  OperationalDeskBooking,
  OperationalDeskBucket,
} from '@uttily/core';
import { Badge, Button, Card, LinkButton, PageHeader } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
import {
  bookingStatusLabel,
  conditionLabel,
  formatDateTimeInTimeZone,
} from '@/lib/operations-helpers';
import { DepartureFlow } from './departure-flow';
import { NoShowFlow } from './no-show-flow';
import { ReturnFlow } from './return-flow';
import { SubstitutionFlow } from './substitution-flow';

const BUCKET_META: Record<
  OperationalDeskBucket,
  { label: string; description: string; tone: BadgeTone }
> = {
  PICKUPS_TODAY: {
    label: 'Départs du jour',
    description: 'Réservations à remettre aujourd’hui, y compris les départs en retard.',
    tone: 'info',
  },
  OVERDUE: {
    label: 'Retours en retard',
    description: 'Le matériel est encore marqué comme actif après l’échéance.',
    tone: 'danger',
  },
  RETURNS_TODAY: {
    label: 'Retours du jour',
    description: 'Locations actives dont le retour est prévu aujourd’hui.',
    tone: 'warning',
  },
  ONGOING: {
    label: 'Locations en cours',
    description: 'Locations actives qui traversent la date sélectionnée.',
    tone: 'success',
  },
};

// L'urgence opérationnelle doit rester visible en premier au comptoir.
const DISPLAY_ORDER: readonly OperationalDeskBucket[] = [
  'OVERDUE',
  'RETURNS_TODAY',
  'PICKUPS_TODAY',
  'ONGOING',
];

type DeskLocation = Pick<LocationRecord, 'id' | 'name' | 'timeZone'>;

export interface DeskViewProps {
  organizationId: string;
  locations: DeskLocation[];
  desk: OperationalDayDesk | null;
  selectedLocationId: string | null;
  search: string;
  filterError: string | null;
  defaultDate: string;
}

function bookingReference(bookingId: string): string {
  return `#UT-${bookingId.slice(0, 6).toUpperCase()}`;
}

function flowItems(booking: OperationalDeskBooking) {
  return booking.items.map((item) => ({
    bookingItemId: item.bookingItemId,
    internalSku: item.internalSku,
    serialNumber: item.serialNumber,
    currentCondition: item.currentCondition,
  }));
}

function DeskBookingCard({
  organizationId,
  desk,
  booking,
  search,
}: {
  organizationId: string;
  desk: OperationalDayDesk;
  booking: OperationalDeskBooking;
  search: string;
}): React.ReactElement {
  const isPickup = booking.bucket === 'PICKUPS_TODAY';
  const isReturn =
    booking.bucket === 'OVERDUE' ||
    booking.bucket === 'RETURNS_TODAY' ||
    booking.bucket === 'ONGOING';
  const canReportNoShow = booking.customerStartAt.getTime() <= desk.now.getTime();
  const departureStatus: 'CONFIRMED' | 'READY_FOR_PICKUP' =
    booking.status === 'CONFIRMED' ? 'CONFIRMED' : 'READY_FOR_PICKUP';
  const query = new URLSearchParams({
    locationId: desk.locationId,
    date: desk.targetDate,
  });
  if (search) query.set('search', search);
  const detailHref = `/dashboard/${organizationId}/bookings/${booking.id}?${query.toString()}`;
  const items = flowItems(booking);

  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        padding: '1.25rem',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div
          style={{
            alignItems: 'flex-start',
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                color: 'var(--ut-color-ink-strong)',
                fontSize: '1.05rem',
                fontWeight: 'var(--ut-weight-bold)',
              }}
            >
              Réservation {bookingReference(booking.id)}
            </div>
            <div style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem' }}>
              {booking.bookingItemCount} équipement{booking.bookingItemCount > 1 ? 's' : ''} ·{' '}
              {bookingStatusLabel(booking.status)}
            </div>
          </div>
          <Badge tone={BUCKET_META[booking.bucket].tone}>{BUCKET_META[booking.bucket].label}</Badge>
        </div>

        <div
          style={{
            background: 'var(--ut-color-surface-soft)',
            border: 'var(--ut-border-thin)',
            borderRadius: 'var(--ut-radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            padding: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
            <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.82rem' }}>Départ</span>
            <strong style={{ color: 'var(--ut-color-ink-strong)', fontSize: '0.85rem' }}>
              {formatDateTimeInTimeZone(booking.customerStartAt, desk.locationTimeZone)}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
            <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.82rem' }}>
              Retour prévu
            </span>
            <strong style={{ color: 'var(--ut-color-ink-strong)', fontSize: '0.85rem' }}>
              {formatDateTimeInTimeZone(booking.customerEndAt, desk.locationTimeZone)}
            </strong>
          </div>
        </div>

        <div style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.82rem' }}>
          <strong style={{ color: 'var(--ut-color-ink)' }}>Exemplaires :</strong>{' '}
          {booking.items.length > 0
            ? booking.items
                .map(
                  (item) =>
                    `${item.internalSku}${item.serialNumber ? ` · N° ${item.serialNumber}` : ''} (${conditionLabel(item.currentCondition)})`,
                )
                .join(' · ')
            : 'Non renseignés'}
        </div>
      </div>

      <div
        style={{
          alignItems: 'center',
          borderTop: 'var(--ut-border-thin)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.65rem',
          paddingTop: '0.85rem',
        }}
      >
        {isPickup && (
          <>
            <DepartureFlow
              orgId={organizationId}
              bookingId={booking.id}
              status={departureStatus}
              items={items}
            />
            {canReportNoShow && <NoShowFlow orgId={organizationId} bookingId={booking.id} />}
            {items.map((item) => (
              <SubstitutionFlow
                key={item.bookingItemId}
                orgId={organizationId}
                bookingId={booking.id}
                bookingItemId={item.bookingItemId}
                currentSku={item.internalSku}
              />
            ))}
          </>
        )}
        {isReturn && <ReturnFlow orgId={organizationId} bookingId={booking.id} items={items} />}
        <Link
          href={detailHref}
          style={{
            color: 'var(--ut-color-primary)',
            fontSize: '0.875rem',
            fontWeight: 'var(--ut-weight-semibold)',
            textDecoration: 'none',
          }}
        >
          Ouvrir le dossier →
        </Link>
      </div>
    </Card>
  );
}

function EmptyBucket({ label }: { label: string }): React.ReactElement {
  return (
    <Card
      style={{
        color: 'var(--ut-color-ink-muted)',
        padding: '1.25rem',
      }}
    >
      Aucun élément dans « {label.toLowerCase()} ».
    </Card>
  );
}

export function DeskView({
  organizationId,
  locations,
  desk,
  selectedLocationId,
  search,
  filterError,
  defaultDate,
}: DeskViewProps): React.ReactElement {
  const selectedId = selectedLocationId ?? locations[0]?.id ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <PageHeader
        eyebrow="Opérations · Comptoir"
        title="Réservations · Cockpit opérationnel"
        description="Les départs, retours et alertes du jour sur un seul écran."
        actions={
          <LinkButton
            href={`/dashboard/${organizationId}/bookings/planning${selectedId ? `?locationId=${encodeURIComponent(selectedId)}` : ''}`}
            variant="secondary"
          >
            📅 Vue planning
          </LinkButton>
        }
      />

      <Card style={{ padding: '1rem' }}>
        <form
          method="get"
          action={`/dashboard/${organizationId}/bookings`}
          style={{
            alignItems: 'end',
            display: 'grid',
            gap: '0.85rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem' }}>
              Point de retrait
            </span>
            <select
              name="locationId"
              defaultValue={selectedId}
              required
              style={{
                background: 'var(--ut-color-surface)',
                border: 'var(--ut-border-thin)',
                borderRadius: 'var(--ut-radius-md)',
                color: 'var(--ut-color-ink)',
                minHeight: '44px',
                padding: '0.6rem 0.75rem',
              }}
            >
              {locations.length === 0 && <option value="">Aucun établissement</option>}
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} · {location.timeZone}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem' }}>
              Date locale
            </span>
            <input
              type="date"
              name="date"
              defaultValue={defaultDate}
              required
              style={{
                background: 'var(--ut-color-surface)',
                border: 'var(--ut-border-thin)',
                borderRadius: 'var(--ut-radius-md)',
                color: 'var(--ut-color-ink)',
                minHeight: '44px',
                padding: '0.6rem 0.75rem',
              }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem' }}>
              Réservation ou SKU
            </span>
            <input
              type="search"
              name="search"
              defaultValue={search}
              placeholder="#UT-12ABCD ou SKU-001"
              style={{
                background: 'var(--ut-color-surface)',
                border: 'var(--ut-border-thin)',
                borderRadius: 'var(--ut-radius-md)',
                color: 'var(--ut-color-ink)',
                minHeight: '44px',
                padding: '0.6rem 0.75rem',
              }}
            />
          </label>

          <Button type="submit" variant="primary" style={{ minHeight: '44px' }}>
            Actualiser le cockpit
          </Button>
        </form>
      </Card>

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

      {locations.length === 0 ? (
        <Card style={{ padding: '2rem', textAlign: 'center' }}>
          Aucun établissement actif n’est disponible pour les opérations.
        </Card>
      ) : desk === null ? (
        <Card style={{ padding: '2rem', textAlign: 'center' }}>
          Le point de retrait sélectionné n’est pas accessible.
        </Card>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gap: '0.75rem',
              gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
            }}
          >
            {DISPLAY_ORDER.map((bucket) => (
              <Card key={bucket} style={{ padding: '1rem' }}>
                <div style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.8rem' }}>
                  {BUCKET_META[bucket].label}
                </div>
                <div
                  style={{
                    color: 'var(--ut-color-ink-strong)',
                    fontSize: '1.8rem',
                    fontWeight: 'var(--ut-weight-bold)',
                    lineHeight: 1.1,
                    marginTop: '0.25rem',
                  }}
                >
                  {desk.counts[bucket]}
                </div>
              </Card>
            ))}
          </div>

          {desk.counts.OVERDUE > 0 && (
            <Card
              role="alert"
              style={{
                alignItems: 'center',
                background: 'var(--ut-color-danger-soft)',
                color: 'var(--ut-color-danger)',
                display: 'flex',
                gap: '0.75rem',
                padding: '1rem',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: '1.35rem' }}>
                ⚠️
              </span>
              <strong>
                {desk.counts.OVERDUE} retour{desk.counts.OVERDUE > 1 ? 's' : ''} en retard à traiter
                en priorité.
              </strong>
            </Card>
          )}

          <div style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.875rem' }}>
            {desk.locationName} · {desk.locationTimeZone} · date civile {desk.targetDate}
          </div>

          {DISPLAY_ORDER.map((bucket) => {
            const definition = BUCKET_META[bucket];
            const bookings = desk.buckets[bucket];
            return (
              <section key={bucket} aria-labelledby={`desk-${bucket.toLowerCase()}`}>
                <div
                  style={{
                    alignItems: 'baseline',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                    justifyContent: 'space-between',
                    marginBottom: '0.75rem',
                  }}
                >
                  <div>
                    <h2
                      id={`desk-${bucket.toLowerCase()}`}
                      style={{
                        color: 'var(--ut-color-ink-strong)',
                        fontSize: '1.15rem',
                        margin: 0,
                      }}
                    >
                      {definition.label} ({bookings.length})
                    </h2>
                    <p style={{ color: 'var(--ut-color-ink-muted)', margin: '0.25rem 0 0' }}>
                      {definition.description}
                    </p>
                  </div>
                </div>
                {bookings.length === 0 ? (
                  <EmptyBucket label={definition.label} />
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gap: '1rem',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))',
                    }}
                  >
                    {bookings.map((booking) => (
                      <DeskBookingCard
                        key={booking.id}
                        organizationId={organizationId}
                        desk={desk}
                        booking={booking}
                        search={search}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
