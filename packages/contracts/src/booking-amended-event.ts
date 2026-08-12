/**
 * @uttily/contracts — Contrat de l'événement BOOKING_AMENDED.v1.
 *
 * Événement source du flux documentaire d'amendement (ADR-023). Inséré dans
 * outbox_events lors de la transaction atomique d'amendement de réservation.
 *
 * Le payload ne contient que des UUIDs : l'outbox est un canal de déclenchement,
 * pas un canal de données. Le worker recharge toutes les données autoritatives
 * depuis PostgreSQL et crée un document_render_snapshot au premier traitement.
 *
 * G7M-B2-A : contrat fermé et parseur runtime parseBookingAmendedV1Event.
 */

export const BOOKING_AMENDED_AGGREGATE_TYPE = 'BOOKING' as const;
export const BOOKING_AMENDED_EVENT_TYPE = 'BOOKING_AMENDED' as const;
export const BOOKING_AMENDED_EVENT_VERSION = 'v1' as const;

/**
 * Payload de BOOKING_AMENDED.v1 : 3 UUIDs uniquement.
 */
export interface BookingAmendedV1Payload {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
}

/**
 * Contrat fermé de l'événement BOOKING_AMENDED.v1.
 */
export interface BookingAmendedV1Event {
  readonly aggregateType: typeof BOOKING_AMENDED_AGGREGATE_TYPE;
  readonly eventType: typeof BOOKING_AMENDED_EVENT_TYPE;
  readonly eventVersion: typeof BOOKING_AMENDED_EVENT_VERSION;
  readonly payload: BookingAmendedV1Payload;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parseur runtime strict pour l'événement BOOKING_AMENDED.v1.
 *
 * Refuse :
 * - valeur non objet ;
 * - aggregateType, eventType, eventVersion incorrects ;
 * - payload absent/non objet ;
 * - UUIDs invalides ;
 * - champs supplémentaires dans le payload ou à la racine.
 */
export function parseBookingAmendedV1Event(input: unknown): BookingAmendedV1Event {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Événement BOOKING_AMENDED.v1 invalide: valeur non-objet.');
  }

  const obj = input as Record<string, unknown>;
  const allowedRootKeys = ['aggregateType', 'eventType', 'eventVersion', 'payload'];
  const rootKeys = Object.keys(obj);
  for (const k of rootKeys) {
    if (!allowedRootKeys.includes(k)) {
      throw new Error(`Événement BOOKING_AMENDED.v1 invalide: champ racine supplémentaire '${k}'.`);
    }
  }

  if (obj['aggregateType'] !== BOOKING_AMENDED_AGGREGATE_TYPE) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: aggregateType '${String(obj['aggregateType'])}' incorrect.`,
    );
  }
  if (obj['eventType'] !== BOOKING_AMENDED_EVENT_TYPE) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: eventType '${String(obj['eventType'])}' incorrect.`,
    );
  }
  if (obj['eventVersion'] !== BOOKING_AMENDED_EVENT_VERSION) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: eventVersion '${String(obj['eventVersion'])}' incorrect.`,
    );
  }

  const payload = obj['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Événement BOOKING_AMENDED.v1 invalide: payload absent ou non-objet.');
  }

  const payloadObj = payload as Record<string, unknown>;
  const allowedPayloadKeys = ['organizationId', 'bookingId', 'amendmentId'];
  const payloadKeys = Object.keys(payloadObj);
  for (const k of payloadKeys) {
    if (!allowedPayloadKeys.includes(k)) {
      throw new Error(
        `Événement BOOKING_AMENDED.v1 invalide: champ payload supplémentaire '${k}'.`,
      );
    }
  }

  const organizationId = payloadObj['organizationId'];
  if (typeof organizationId !== 'string' || !UUID_REGEX.test(organizationId)) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: payload.organizationId invalide (${String(organizationId)}).`,
    );
  }
  const bookingId = payloadObj['bookingId'];
  if (typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: payload.bookingId invalide (${String(bookingId)}).`,
    );
  }
  const amendmentId = payloadObj['amendmentId'];
  if (typeof amendmentId !== 'string' || !UUID_REGEX.test(amendmentId)) {
    throw new Error(
      `Événement BOOKING_AMENDED.v1 invalide: payload.amendmentId invalide (${String(amendmentId)}).`,
    );
  }

  return {
    aggregateType: BOOKING_AMENDED_AGGREGATE_TYPE,
    eventType: BOOKING_AMENDED_EVENT_TYPE,
    eventVersion: BOOKING_AMENDED_EVENT_VERSION,
    payload: {
      organizationId,
      bookingId,
      amendmentId,
    },
  };
}
