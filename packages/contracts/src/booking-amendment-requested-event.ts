/**
 * @uttily/contracts — Contrat de l'événement BOOKING_AMENDMENT_REQUESTED.v1.
 *
 * Signal durable créé avant tout appel Stripe lors de l'initialisation locale
 * d'un supplément. Le payload reste minimal : le consommateur recharge les
 * snapshots et allocations depuis PostgreSQL.
 */

export const BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE = 'BOOKING' as const;
export const BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE = 'BOOKING_AMENDMENT_REQUESTED' as const;
export const BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION = 'v1' as const;

/** Payload strict : trois UUIDs uniquement. */
export interface BookingAmendmentRequestedV1Payload {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
}

export interface BookingAmendmentRequestedV1Event {
  readonly aggregateType: typeof BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE;
  readonly eventType: typeof BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE;
  readonly eventVersion: typeof BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION;
  readonly payload: BookingAmendmentRequestedV1Payload;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parseur runtime fermé de BOOKING_AMENDMENT_REQUESTED.v1. */
export function parseBookingAmendmentRequestedV1Event(
  input: unknown,
): BookingAmendmentRequestedV1Event {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: valeur non-objet.');
  }

  const obj = input as Record<string, unknown>;
  const allowedRootKeys = ['aggregateType', 'eventType', 'eventVersion', 'payload'];
  for (const key of Object.keys(obj)) {
    if (!allowedRootKeys.includes(key)) {
      throw new Error(
        `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: champ racine supplémentaire '${key}'.`,
      );
    }
  }

  if (obj['aggregateType'] !== BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: aggregateType '${String(obj['aggregateType'])}' incorrect.`,
    );
  }
  if (obj['eventType'] !== BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: eventType '${String(obj['eventType'])}' incorrect.`,
    );
  }
  if (obj['eventVersion'] !== BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: eventVersion '${String(obj['eventVersion'])}' incorrect.`,
    );
  }

  const payload = obj['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(
      'Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: payload absent ou non-objet.',
    );
  }

  const payloadObj = payload as Record<string, unknown>;
  const allowedPayloadKeys = ['organizationId', 'bookingId', 'amendmentId'];
  for (const key of Object.keys(payloadObj)) {
    if (!allowedPayloadKeys.includes(key)) {
      throw new Error(
        `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: champ payload supplémentaire '${key}'.`,
      );
    }
  }

  const organizationId = payloadObj['organizationId'];
  if (typeof organizationId !== 'string' || !UUID_REGEX.test(organizationId)) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: payload.organizationId invalide (${String(organizationId)}).`,
    );
  }
  const bookingId = payloadObj['bookingId'];
  if (typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: payload.bookingId invalide (${String(bookingId)}).`,
    );
  }
  const amendmentId = payloadObj['amendmentId'];
  if (typeof amendmentId !== 'string' || !UUID_REGEX.test(amendmentId)) {
    throw new Error(
      `Événement BOOKING_AMENDMENT_REQUESTED.v1 invalide: payload.amendmentId invalide (${String(amendmentId)}).`,
    );
  }

  return {
    aggregateType: BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE,
    eventType: BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE,
    eventVersion: BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION,
    payload: { organizationId, bookingId, amendmentId },
  };
}
