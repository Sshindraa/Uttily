import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  listCustomerBookings,
  type CustomerBookingSummary,
  type CustomerBookingStatus,
} from '@uttily/core';

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

function getStatusBadge(status: CustomerBookingStatus): {
  label: string;
  bg: string;
  color: string;
  border: string;
} {
  switch (status) {
    case 'CONFIRMED':
      return { label: '✓ Confirmée', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' };
    case 'READY_FOR_PICKUP':
      return { label: '✓ Votre vélo est prêt', bg: '#ecfdf5', color: '#065f46', border: '#6ee7b7' };
    case 'ACTIVE':
      return { label: '🚲 En cours', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' };
    case 'COMPLETED':
      return { label: '✓ Terminée', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
    case 'CANCELLED_REFUND_PENDING':
      return {
        label: '↩ Annulée · Remboursement en cours',
        bg: '#fffbeb',
        color: '#b45309',
        border: '#fde68a',
      };
    case 'CANCELLED_REFUNDED':
      return {
        label: '✓ Annulée · Remboursée',
        bg: '#f8fafc',
        color: '#475569',
        border: '#e2e8f0',
      };
    case 'CANCELLED_NO_REFUND':
      return { label: '✕ Annulée', bg: '#f8fafc', color: '#64748b', border: '#e2e8f0' };
    case 'CANCELLED_ACTION_REQUIRED':
      return {
        label: '⚠️ Annulée · Action requise',
        bg: '#fef2f2',
        color: '#b91c1c',
        border: '#fecaca',
      };
    default:
      return { label: '✓ Confirmée', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' };
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
    <div style={pageContainerStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Mes locations</h1>
        <p style={subtitleStyle}>Retrouvez l’ensemble de vos réservations et gérez vos trajets.</p>
      </header>

      {isEmpty ? (
        <div style={emptyStateStyle}>
          <div style={emptyIconStyle}>🚲</div>
          <h2 style={emptyTitleStyle}>Aucune location pour le moment</h2>
          <p style={emptyTextStyle}>
            Trouvez votre prochain vélo près de chez vous en quelques clics.
          </p>
          <Link href={`/${locale}/search`} style={primaryCtaStyle}>
            Rechercher un vélo
          </Link>
        </div>
      ) : (
        <div style={sectionsContainerStyle}>
          {upcoming.length > 0 && (
            <section aria-labelledby="upcoming-heading" style={sectionStyle}>
              <h2 id="upcoming-heading" style={sectionHeadingStyle}>
                À venir
              </h2>
              <div style={cardsGridStyle}>
                {upcoming.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} />
                ))}
              </div>
            </section>
          )}

          {active.length > 0 && (
            <section aria-labelledby="active-heading" style={sectionStyle}>
              <h2 id="active-heading" style={sectionHeadingStyle}>
                En cours
              </h2>
              <div style={cardsGridStyle}>
                {active.map((b) => (
                  <BookingCard key={b.id} booking={b} locale={locale} />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section aria-labelledby="past-heading" style={sectionStyle}>
              <h2 id="past-heading" style={sectionHeadingStyle}>
                Historique
              </h2>
              <div style={cardsGridStyle}>
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
  const badge = getStatusBadge(booking.status);

  return (
    <article style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          {booking.categoryName && <span style={categoryBadgeStyle}>{booking.categoryName}</span>}
          <h3 style={productTitleStyle}>{booking.productName}</h3>
          <p style={orgNameStyle}>Loueur : {booking.organizationName}</p>
        </div>
        <span
          style={{
            ...badgeStyle,
            backgroundColor: badge.bg,
            color: badge.color,
            borderColor: badge.border,
          }}
        >
          {badge.label}
        </span>
      </div>

      <div style={cardContentStyle}>
        <div style={infoRowStyle}>
          <span style={iconSpanStyle}>📅</span>
          <span style={infoTextStyle}>
            {formatDateRange(booking.startAt, booking.endAt, booking.timeZone)}
          </span>
        </div>
        <div style={infoRowStyle}>
          <span style={iconSpanStyle}>📍</span>
          <span style={infoTextStyle}>{booking.locationName}</span>
        </div>
      </div>

      <div style={cardFooterStyle}>
        <span style={priceStyle}>{formatAmount(booking.totalAmountMinor, booking.currency)}</span>
        <Link href={`/${locale}/account/bookings/${booking.id}`} style={viewBookingButtonStyle}>
          Voir ma location →
        </Link>
      </div>
    </article>
  );
}

const pageContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2rem',
};

const headerStyle: React.CSSProperties = {
  marginBottom: '0.5rem',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.875rem',
  fontWeight: 800,
  letterSpacing: '-0.03em',
  margin: '0 0 0.25rem 0',
  color: '#0f172a',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '1rem',
  color: '#64748b',
  margin: 0,
};

const emptyStateStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '16px',
  padding: '3.5rem 1.5rem',
  textAlign: 'center',
  border: '1px dashed #cbd5e1',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.75rem',
};

const emptyIconStyle: React.CSSProperties = {
  fontSize: '3rem',
  marginBottom: '0.5rem',
};

const emptyTitleStyle: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  margin: 0,
  color: '#0f172a',
};

const emptyTextStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#64748b',
  margin: '0 0 1rem 0',
  maxWidth: '380px',
};

const primaryCtaStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: '#0284c7',
  color: '#ffffff',
  fontWeight: 600,
  padding: '0.75rem 1.5rem',
  borderRadius: '10px',
  textDecoration: 'none',
  fontSize: '0.95rem',
  transition: 'background-color 0.15s ease',
};

const sectionsContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2.5rem',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  letterSpacing: '-0.02em',
  margin: 0,
  color: '#1e293b',
};

const cardsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: '1.25rem',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  border: '1px solid #e2e8f0',
  padding: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: '1rem',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '0.75rem',
};

const categoryBadgeStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#0284c7',
  display: 'block',
  marginBottom: '0.25rem',
};

const productTitleStyle: React.CSSProperties = {
  fontSize: '1.15rem',
  fontWeight: 700,
  margin: '0 0 0.15rem 0',
  color: '#0f172a',
};

const orgNameStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const badgeStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  padding: '0.35rem 0.65rem',
  borderRadius: '9999px',
  borderWidth: '1px',
  borderStyle: 'solid',
  whiteSpace: 'nowrap',
};

const cardContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  backgroundColor: '#f8fafc',
  padding: '0.75rem',
  borderRadius: '8px',
};

const infoRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const iconSpanStyle: React.CSSProperties = {
  fontSize: '0.95rem',
};

const infoTextStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  color: '#334155',
  fontWeight: 500,
};

const cardFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingTop: '0.5rem',
  borderTop: '1px solid #f1f5f9',
};

const priceStyle: React.CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: '#0f172a',
};

const viewBookingButtonStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#0284c7',
  textDecoration: 'none',
};
