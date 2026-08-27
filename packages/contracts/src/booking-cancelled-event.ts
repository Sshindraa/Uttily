/**
 * @uttily/contracts — Contrat de l'événement BOOKING_CANCELLED.v1.
 *
 * Émis dans outbox_events par cancelConfirmedBooking lors de l'annulation
 * d'une réservation confirmée (Chantier 12/12.2).
 */

export const BOOKING_CANCELLED_AGGREGATE_TYPE = 'BOOKING' as const;
export const BOOKING_CANCELLED_EVENT_TYPE = 'BOOKING_CANCELLED' as const;
export const BOOKING_CANCELLED_EVENT_VERSION = 'v1' as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BookingCancelledV1Payload {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly cancellationId: string;
  readonly refundId: string | null;
  readonly refundAmountMinor: number;
  readonly retainedAmountMinor: number;
  readonly actorReason: string;
}

export interface BookingCancelledV1Event {
  readonly aggregateType: typeof BOOKING_CANCELLED_AGGREGATE_TYPE;
  readonly eventType: typeof BOOKING_CANCELLED_EVENT_TYPE;
  readonly eventVersion: typeof BOOKING_CANCELLED_EVENT_VERSION;
  readonly aggregateId: string;
  readonly payload: BookingCancelledV1Payload;
}

export function parseBookingCancelledV1Event(raw: unknown): BookingCancelledV1Event {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('parseBookingCancelledV1Event: valeur non-objet');
  }

  const obj = raw as Record<string, unknown>;

  const allowedKeys = new Set([
    'aggregateType',
    'eventType',
    'eventVersion',
    'aggregateId',
    'payload',
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`parseBookingCancelledV1Event: champ racine supplémentaire '${key}'`);
    }
  }

  if (obj.aggregateType !== BOOKING_CANCELLED_AGGREGATE_TYPE) {
    throw new Error(
      `parseBookingCancelledV1Event: aggregateType '${String(obj.aggregateType)}' incorrect, attendu '${BOOKING_CANCELLED_AGGREGATE_TYPE}'`,
    );
  }

  if (obj.eventType !== BOOKING_CANCELLED_EVENT_TYPE) {
    throw new Error(
      `parseBookingCancelledV1Event: eventType '${String(obj.eventType)}' incorrect, attendu '${BOOKING_CANCELLED_EVENT_TYPE}'`,
    );
  }

  if (obj.eventVersion !== BOOKING_CANCELLED_EVENT_VERSION) {
    throw new Error(
      `parseBookingCancelledV1Event: eventVersion '${String(obj.eventVersion)}' incorrect, attendu '${BOOKING_CANCELLED_EVENT_VERSION}'`,
    );
  }

  if (typeof obj.aggregateId !== 'string' || !UUID_REGEX.test(obj.aggregateId)) {
    throw new Error('parseBookingCancelledV1Event: aggregateId doit être un UUID valide');
  }

  if (typeof obj.payload !== 'object' || obj.payload === null || Array.isArray(obj.payload)) {
    throw new Error('parseBookingCancelledV1Event: payload non-objet');
  }

  const payload = obj.payload as Record<string, unknown>;
  const allowedPayloadKeys = new Set([
    'organizationId',
    'bookingId',
    'cancellationId',
    'refundId',
    'refundAmountMinor',
    'retainedAmountMinor',
    'actorReason',
  ]);

  for (const key of Object.keys(payload)) {
    if (!allowedPayloadKeys.has(key)) {
      throw new Error(`parseBookingCancelledV1Event: champ payload supplémentaire '${key}'`);
    }
  }

  if (typeof payload.organizationId !== 'string' || !UUID_REGEX.test(payload.organizationId)) {
    throw new Error('parseBookingCancelledV1Event: payload.organizationId invalide');
  }

  if (typeof payload.bookingId !== 'string' || !UUID_REGEX.test(payload.bookingId)) {
    throw new Error('parseBookingCancelledV1Event: payload.bookingId invalide');
  }

  if (obj.aggregateId !== payload.bookingId) {
    throw new Error(
      'parseBookingCancelledV1Event: aggregateId doit correspondre à payload.bookingId',
    );
  }

  if (typeof payload.cancellationId !== 'string' || !UUID_REGEX.test(payload.cancellationId)) {
    throw new Error('parseBookingCancelledV1Event: payload.cancellationId invalide');
  }

  if (
    payload.refundId !== null &&
    (typeof payload.refundId !== 'string' || !UUID_REGEX.test(payload.refundId))
  ) {
    throw new Error(
      'parseBookingCancelledV1Event: payload.refundId doit être null ou un UUID valide',
    );
  }

  if (
    typeof payload.refundAmountMinor !== 'number' ||
    !Number.isSafeInteger(payload.refundAmountMinor) ||
    payload.refundAmountMinor < 0
  ) {
    throw new Error('parseBookingCancelledV1Event: payload.refundAmountMinor invalide');
  }

  if (
    typeof payload.retainedAmountMinor !== 'number' ||
    !Number.isSafeInteger(payload.retainedAmountMinor) ||
    payload.retainedAmountMinor < 0
  ) {
    throw new Error('parseBookingCancelledV1Event: payload.retainedAmountMinor invalide');
  }

  if (typeof payload.actorReason !== 'string' || payload.actorReason.trim().length === 0) {
    throw new Error('parseBookingCancelledV1Event: payload.actorReason invalide');
  }

  return {
    aggregateType: BOOKING_CANCELLED_AGGREGATE_TYPE,
    eventType: BOOKING_CANCELLED_EVENT_TYPE,
    eventVersion: BOOKING_CANCELLED_EVENT_VERSION,
    aggregateId: obj.aggregateId,
    payload: {
      organizationId: payload.organizationId,
      bookingId: payload.bookingId,
      cancellationId: payload.cancellationId,
      refundId: payload.refundId,
      refundAmountMinor: payload.refundAmountMinor,
      retainedAmountMinor: payload.retainedAmountMinor,
      actorReason: payload.actorReason,
    },
  };
}
