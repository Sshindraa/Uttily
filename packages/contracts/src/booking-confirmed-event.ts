/**
 * @uttily/contracts — Contrat de l'événement BOOKING_CONFIRMED.v1.
 *
 * Événement source du flux documentaire (ADR-013). Inséré dans outbox_events
 * par apply-booking-confirmation.ts lors de la transaction atomique de
 * confirmation de réservation.
 *
 * Le payload ne contient que des UUIDs : l'outbox est un canal de déclenchement,
 * pas un canal de données. Le worker recharge toutes les données autoritatives
 * depuis PostgreSQL et crée un document_render_snapshot au premier traitement.
 *
 * G5B : contrat fermé uniquement. Le parseur runtime et la modification du
 * producteur (apply-booking-confirmation) viendront avec le consommateur (G5D).
 */

export const BOOKING_CONFIRMED_AGGREGATE_TYPE = 'BOOKING' as const;
export const BOOKING_CONFIRMED_EVENT_TYPE = 'BOOKING_CONFIRMED' as const;
export const BOOKING_CONFIRMED_EVENT_VERSION = 'v1' as const;

/**
 * Payload de BOOKING_CONFIRMED.v1 : 4 UUIDs uniquement.
 */
export interface BookingConfirmedV1Payload {
  readonly bookingId: string;
  readonly paymentId: string;
  readonly draftId: string;
  readonly organizationId: string;
}

/**
 * Contrat fermé de l'événement BOOKING_CONFIRMED.v1.
 */
export interface BookingConfirmedV1Event {
  readonly aggregateType: typeof BOOKING_CONFIRMED_AGGREGATE_TYPE;
  readonly eventType: typeof BOOKING_CONFIRMED_EVENT_TYPE;
  readonly eventVersion: typeof BOOKING_CONFIRMED_EVENT_VERSION;
  readonly payload: BookingConfirmedV1Payload;
}
