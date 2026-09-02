import Link from 'next/link';
import type { OperationalItemCalendar, OperationalItemCalendarEvent } from '@uttily/core';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import { getInventoryStatusPresentation } from '@/lib/status-presentation';
import { getCategoryPresentation } from '@/features/equipment/category-presentation';
import styles from './planning.module.css';

export interface ItemCalendarPanelProps {
  orgId: string;
  calendar: OperationalItemCalendar;
}

const EVENT_PRESENTATION: Record<
  OperationalItemCalendarEvent['type'],
  { label: string; icon: string; className: string | undefined }
> = {
  HOLD: { label: 'Hold temporaire · Temporary hold', icon: '⏳', className: styles.eventHold },
  RENTAL: { label: 'Réservation · Reservation', icon: '🔵', className: styles.eventRental },
  MAINTENANCE: { label: 'Maintenance', icon: '🔧', className: styles.eventMaintenance },
  MANUAL_BLOCK: {
    label: 'Blocage manuel · Manual block',
    icon: '⛔',
    className: styles.eventManualBlock,
  },
};

function eventHref(orgId: string, event: OperationalItemCalendarEvent): string | null {
  if (event.bookingId) return `/dashboard/${orgId}/bookings/${event.bookingId}`;
  if (event.maintenanceCaseId) {
    return `/dashboard/${orgId}/fleet/maintenance/${event.maintenanceCaseId}`;
  }
  if (event.type === 'MANUAL_BLOCK') return `/dashboard/${orgId}/fleet`;
  return null;
}

function formatInterval(event: OperationalItemCalendarEvent): string {
  const start = formatDateTimeInTimeZone(event.startAt, event.locationTimeZone, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const end = formatDateTimeInTimeZone(event.endAt, event.locationTimeZone, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${start} → ${end}`;
}

function formatStatus(event: OperationalItemCalendarEvent): string {
  switch (event.type) {
    case 'HOLD':
      return event.status === 'PAYMENT_PROCESSING' ? 'Paiement en cours' : 'Actif';
    case 'RENTAL':
      switch (event.status) {
        case 'CONFIRMED':
          return 'Confirmée';
        case 'READY_FOR_PICKUP':
          return 'Prête au retrait';
        case 'ACTIVE':
          return 'En cours';
        case 'RETURNED':
          return 'Retournée';
        default:
          return event.status;
      }
    case 'MAINTENANCE':
      return event.status === 'IN_PROGRESS'
        ? 'En cours'
        : event.status === 'RESOLVED'
          ? 'Résolue'
          : 'Ouverte';
    case 'MANUAL_BLOCK':
      return event.recurringSeriesId ? 'Récurrent · Recurring' : 'Ponctuel · One-off';
    default: {
      const _exhaustive: never = event.type;
      return _exhaustive;
    }
  }
}

function CalendarEventCard({
  orgId,
  event,
}: {
  orgId: string;
  event: OperationalItemCalendarEvent;
}): React.ReactElement {
  const presentation = EVENT_PRESENTATION[event.type];
  const href = eventHref(orgId, event);
  const content = (
    <>
      <div className={styles.itemCalendarEventHeader}>
        <span className={styles.itemCalendarEventType}>
          {presentation.icon} {presentation.label}
        </span>
        <span className={styles.itemCalendarEventStatus}>{formatStatus(event)}</span>
      </div>
      <strong className={styles.itemCalendarEventTitle}>
        {event.reason ?? presentation.label}
      </strong>
      <span className={styles.itemCalendarEventInterval}>{formatInterval(event)}</span>
      {event.customerName && (
        <span className={styles.itemCalendarEventMeta}>Locataire · {event.customerName}</span>
      )}
      {event.holdExpiresAt && (
        <span className={styles.itemCalendarEventMeta}>
          Expire le ·{' '}
          {formatDateTimeInTimeZone(event.holdExpiresAt, event.locationTimeZone, {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </span>
      )}
      {event.recurringSeriesId && (
        <span className={styles.itemCalendarEventMeta}>Série récurrente liée</span>
      )}
      {href && <span className={styles.itemCalendarEventLink}>Ouvrir le détail →</span>}
    </>
  );

  return href ? (
    <Link
      href={href}
      className={`${styles.itemCalendarEvent} ${presentation.className}`}
      aria-label={`${presentation.label} — ${formatInterval(event)}`}
      role="listitem"
    >
      {content}
    </Link>
  ) : (
    <article
      className={`${styles.itemCalendarEvent} ${presentation.className}`}
      aria-label={`${presentation.label} — ${formatInterval(event)}`}
      role="listitem"
    >
      {content}
    </article>
  );
}

export function ItemCalendarPanel({ orgId, calendar }: ItemCalendarPanelProps): React.ReactElement {
  const category = getCategoryPresentation(calendar.item.categorySlug);
  const status = getInventoryStatusPresentation(
    calendar.item.status as Parameters<typeof getInventoryStatusPresentation>[0],
    calendar.item.condition === 'BROKEN',
  );
  const sortedEvents = [...calendar.events].sort(
    (left, right) => left.startAt.getTime() - right.startAt.getTime(),
  );

  return (
    <section className={styles.itemCalendarPanel} aria-labelledby="item-calendar-title">
      <div className={styles.itemCalendarHeader}>
        <div>
          <p className={styles.itemCalendarEyebrow}>Exemplaire sélectionné · Selected item</p>
          <h2 id="item-calendar-title" className={styles.itemCalendarTitle}>
            Calendrier détaillé · {calendar.item.internalSku}
          </h2>
          <p className={styles.itemCalendarSubtitle}>
            {category.icon} {calendar.item.productName} · {calendar.item.variantName} ·{' '}
            <span aria-label="Établissement">📍 {calendar.locationName}</span>
          </p>
        </div>
        <div className={styles.itemCalendarTimeZone}>
          <span>Fuseau d’affichage · Display timezone</span>
          <strong>{calendar.locationTimeZone}</strong>
        </div>
      </div>

      <dl className={styles.itemCalendarFacts}>
        <div>
          <dt>Statut · Status</dt>
          <dd>
            {status.icon} {status.label}
          </dd>
        </div>
        <div>
          <dt>Événements · Events</dt>
          <dd>{sortedEvents.length}</dd>
        </div>
        <div>
          <dt>Fenêtre · Window</dt>
          <dd>
            {formatDateTimeInTimeZone(calendar.from, calendar.locationTimeZone, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}{' '}
            →{' '}
            {formatDateTimeInTimeZone(calendar.to, calendar.locationTimeZone, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </dd>
        </div>
      </dl>

      {sortedEvents.length === 0 ? (
        <p className={styles.itemCalendarEmpty} role="status">
          Aucun événement sur cette fenêtre · No events in this window.
        </p>
      ) : (
        <div
          className={styles.itemCalendarEvents}
          role="list"
          aria-label="Événements de l’exemplaire"
        >
          {sortedEvents.map((event) => (
            <CalendarEventCard key={event.id} orgId={orgId} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}
