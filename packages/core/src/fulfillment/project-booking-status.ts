import { BookingTransitionError } from './errors';
import type { BookingStatus, BookingTransitionResult } from './types';

/**
 * Transitions autorisées par la machine à états des bookings (ADR-011).
 * Alignée sur docs/architecture/booking-and-availability.md.
 */
const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  CONFIRMED: ['READY_FOR_PICKUP', 'CANCELLED', 'REFUNDED'],
  READY_FOR_PICKUP: ['ACTIVE'],
  ACTIVE: ['RETURNED'],
  RETURNED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  REFUNDED: [],
};

/**
 * États terminaux : aucune transition sortante n'est autorisée.
 */
const TERMINAL_STATES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
]);

/**
 * Fonction pure de projection d'une transition de booking (ADR-011).
 *
 * - Retourne `{ kind: 'NOOP'; currentStatus }` si `requestedStatus === currentStatus`.
 * - Retourne `{ kind: 'APPLIED'; previousStatus; nextStatus }` si la transition
 *   est autorisée.
 * - Lève `BookingTransitionError` avec le code `TERMINAL_STATE` si
 *   `currentStatus` est un état terminal.
 * - Lève `BookingTransitionError` avec le code `INVALID_TRANSITION` sinon.
 *
 * Ne dépend ni de PostgreSQL, ni de Stripe, ni de l'auth, ni de Next.js.
 * Ne modifie aucune donnée et ne gère aucun rôle.
 */
export function projectBookingStatus(
  currentStatus: BookingStatus,
  requestedStatus: BookingStatus,
): BookingTransitionResult {
  if (requestedStatus === currentStatus) {
    return { kind: 'NOOP', currentStatus };
  }

  if (TERMINAL_STATES.has(currentStatus)) {
    throw new BookingTransitionError(
      'TERMINAL_STATE',
      currentStatus,
      requestedStatus,
      `Aucune transition autorisée depuis l'état terminal ${currentStatus} vers ${requestedStatus}.`,
    );
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (allowed.includes(requestedStatus)) {
    return {
      kind: 'APPLIED',
      previousStatus: currentStatus,
      nextStatus: requestedStatus,
    };
  }

  throw new BookingTransitionError(
    'INVALID_TRANSITION',
    currentStatus,
    requestedStatus,
    `Transition ${currentStatus} → ${requestedStatus} non autorisée par la machine à états des bookings.`,
  );
}
