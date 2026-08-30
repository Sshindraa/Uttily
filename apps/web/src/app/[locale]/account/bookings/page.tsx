import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  listCustomerBookings,
  type CustomerBookingSummary,
  type CustomerBookingStatus,
} from '@uttily/core';
import { Card, Badge, LinkButton, Icon, PageHeader } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';

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

function formatDateRange(start: Date, end: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  return `${formatter.format(new Date(start))} → ${formatter.format(new Date(end))}`;
}

function getStatusBadgeProps(status: CustomerBookingStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'CONFIRMED':
      return { label: 'Confirmée', tone: 'success' };
    case 'READY_FOR_PICKUP':
      return { label: 'Votre équipement est prêt', tone: 'success' };
    case 'ACTIVE':
      return { label: 'En cours', tone: 'info' };
    case 'COMPLETED':
      return { label: 'Terminée', tone: 'neutral' };
    case 'CANCELLED_REFUND_PENDING':
      return { label: 'Annulée · Remboursement en cours', tone: 'warning' };
    case 'CANCELLED_REFUNDED':
      return { label: 'Annulée · Remboursée', tone: 'neutral' };
    case 'CANCELLED_NO_REFUND':
      return { label: 'Annulée', tone: 'neutral' };
    case 'CANCELLED_ACTION_REQUIRED':
      return { label: 'Annulée · Action requise', tone: 'danger' };
    default:
      return { label: 'Confirmée', tone: 'success' };
  }
}

export default async function CustomerBookingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect('/sign-in');
  }

  const db = getDb();
  const { upcoming, active, past } = await listCustomerBookings(db, user.id);

  const isEmpty = upcoming.length === 0 && active.length === 0 && past.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Espace personnel"
        title="Mes locations"
        description="Retrouvez l’ensemble de vos réservations et gérez vos trajets."
        actions={
          <LinkButton href={`/${locale}/search`} variant="secondary" size="md">
            Rechercher un équipement <Icon name="search" size={17} />
          </LinkButton>
        }
      />

      {isEmpty ? (
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
          <div style={{ fontSize: '3rem' }}>🚲</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Aucune location pour le moment
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '24rem' }}>
            Trouvez votre prochain équipement près de chez vous en quelques clics.
          </p>
          <LinkButton href={`/${locale}/search`} variant="primary">
            Rechercher un équipement
          </LinkButton>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
          {upcoming.length > 0 && (
            <section
              aria-labelledby="upcoming-heading"
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <h2
                id="upcoming-heading"
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                À venir ({upcoming.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {upcoming.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} />
                ))}
              </div>
            </section>
          )}

          {active.length > 0 && (
            <section
              aria-labelledby="active-heading"
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <h2
                id="active-heading"
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                En cours ({active.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {active.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section
              aria-labelledby="past-heading"
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <h2
                id="past-heading"
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                Historique ({past.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {past.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function BookingCard({
  booking,
  locale,
}: {
  booking: CustomerBookingSummary;
  locale: string;
}): React.ReactElement {
  const badgeProps = getStatusBadgeProps(booking.status);

  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '1.25rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '0.75rem',
        }}
      >
        <div>
          {booking.categoryName && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ut-color-primary)',
                display: 'block',
                marginBottom: '0.2rem',
              }}
            >
              {booking.categoryName}
            </span>
          )}
          <h3
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              margin: '0 0 0.15rem 0',
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            {booking.productName}
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)', margin: 0 }}>
            Loueur : <strong>{booking.organizationName}</strong>
          </p>
        </div>
        <Badge tone={badgeProps.tone}>{badgeProps.label}</Badge>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
          background: 'var(--ut-color-surface-soft)',
          padding: '0.75rem',
          borderRadius: 'var(--ut-radius-md)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.9rem',
            color: 'var(--ut-color-ink)',
          }}
        >
          <span>📅</span>
          <span>{formatDateRange(booking.startAt, booking.endAt, booking.timeZone)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.9rem',
            color: 'var(--ut-color-ink)',
          }}
        >
          <span>📍</span>
          <span>{booking.locationName}</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '0.5rem',
          borderTop: 'var(--ut-border-thin)',
        }}
      >
        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--ut-color-ink-strong)' }}>
          {formatAmount(booking.totalAmountMinor, booking.currency)}
        </span>
        <Link
          href={`/${locale}/account/bookings/${booking.id}`}
          style={{
            fontSize: '0.9rem',
            fontWeight: 600,
            color: 'var(--ut-color-primary-strong)',
            textDecoration: 'none',
          }}
        >
          Voir ma location →
        </Link>
      </div>
    </Card>
  );
}
