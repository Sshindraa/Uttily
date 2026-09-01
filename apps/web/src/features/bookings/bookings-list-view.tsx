import Link from 'next/link';
import {
  type GroupedCustomerBookings,
  type CustomerBookingSummary,
  type CustomerBookingStatus,
} from '@uttily/core';
import { Card, Badge, LinkButton, Icon, PageHeader } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
import { getAccountCopy, type AccountCopy } from '@/lib/account-copy';
import { getIntlLocale } from '@/lib/locale';

function formatAmount(minor: number, currency: string, locale: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat(getIntlLocale(locale), {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatDateRange(start: Date, end: Date, timeZone: string, locale: string): string {
  const formatter = new Intl.DateTimeFormat(getIntlLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  return `${formatter.format(new Date(start))} → ${formatter.format(new Date(end))}`;
}

function getStatusBadgeProps(
  status: CustomerBookingStatus,
  copy: AccountCopy,
): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'CONFIRMED':
      return { label: copy.statusLabels.CONFIRMED, tone: 'success' };
    case 'READY_FOR_PICKUP':
      return { label: copy.statusLabels.READY_FOR_PICKUP, tone: 'success' };
    case 'ACTIVE':
      return { label: copy.statusLabels.ACTIVE, tone: 'info' };
    case 'COMPLETED':
      return { label: copy.statusLabels.COMPLETED, tone: 'neutral' };
    case 'CANCELLED_REFUND_PENDING':
      return { label: copy.statusLabels.CANCELLED_REFUND_PENDING, tone: 'warning' };
    case 'CANCELLED_REFUNDED':
      return { label: copy.statusLabels.CANCELLED_REFUNDED, tone: 'neutral' };
    case 'CANCELLED_NO_REFUND':
      return { label: copy.statusLabels.CANCELLED_NO_REFUND, tone: 'neutral' };
    case 'CANCELLED_ACTION_REQUIRED':
      return { label: copy.statusLabels.CANCELLED_ACTION_REQUIRED, tone: 'danger' };
    default:
      return { label: copy.detail.statusBanner.unavailableTitle, tone: 'danger' };
  }
}

export function BookingsListView({
  locale,
  bookings,
}: {
  locale: string;
  bookings: GroupedCustomerBookings;
}): React.ReactElement {
  const { upcoming, active, past } = bookings;
  const copy = getAccountCopy(locale);

  const isEmpty = upcoming.length === 0 && active.length === 0 && past.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow={copy.bookings.eyebrow}
        title={copy.bookings.title}
        description={copy.bookings.description}
        actions={
          <LinkButton href={`/${locale}/search`} variant="secondary" size="md">
            {copy.bookings.search} <Icon name="search" size={17} />
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
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            {copy.bookings.emptyTitle}
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '24rem' }}>
            {copy.bookings.emptyDescription}
          </p>
          <LinkButton href={`/${locale}/search`} variant="primary">
            {copy.bookings.search}
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
                  fontWeight: 'var(--ut-weight-bold)',
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                {copy.bookings.upcoming} ({upcoming.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {upcoming.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} copy={copy} />
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
                  fontWeight: 'var(--ut-weight-bold)',
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                {copy.bookings.active} ({active.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {active.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} copy={copy} />
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
                  fontWeight: 'var(--ut-weight-bold)',
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                {copy.bookings.past} ({past.length})
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '1.25rem',
                }}
              >
                {past.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} copy={copy} />
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
  copy,
}: {
  booking: CustomerBookingSummary;
  locale: string;
  copy: AccountCopy;
}): React.ReactElement {
  const badgeProps = getStatusBadgeProps(booking.status, copy);

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
                fontWeight: 'var(--ut-weight-bold)',
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
              fontWeight: 'var(--ut-weight-bold)',
              margin: '0 0 0.15rem 0',
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            {booking.productName}
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)', margin: 0 }}>
            {copy.bookings.renter(booking.organizationName)}
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
          <span>{formatDateRange(booking.startAt, booking.endAt, booking.timeZone, locale)}</span>
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
        <span
          style={{
            fontSize: '1.1rem',
            fontWeight: 'var(--ut-weight-bold)',
            color: 'var(--ut-color-ink-strong)',
          }}
        >
          {formatAmount(booking.totalAmountMinor, booking.currency, locale)}
        </span>
        <Link
          href={`/${locale}/account/bookings/${booking.id}`}
          style={{
            fontSize: '0.9rem',
            fontWeight: 'var(--ut-weight-semibold)',
            color: 'var(--ut-color-primary-strong)',
            textDecoration: 'none',
          }}
        >
          {copy.bookings.view}
        </Link>
      </div>
    </Card>
  );
}
