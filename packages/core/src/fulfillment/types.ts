/**
 * @uttily/core — Types du module fulfillment (Lot 6, ADR-011).
 *
 * Machine à états pure des bookings. La source de vérité des statuts est
 * l'enum Drizzle `bookingStatus` (packages/database/src/schema.ts), importée
 * via `bookingStatus.enumValues`. Cet import est une description de schéma
 * versionnée : il n'ouvre aucune connexion PostgreSQL, ne lit aucune variable
 * d'environnement et ne provoque aucun effet de bord.
 */

import { bookingStatus, fulfillmentEventType } from '@uttily/database';

/**
 * Statuts de booking dérivés de l'enum `booking_status` PostgreSQL via
 * `bookingStatus.enumValues`. Toute dérive du schéma DB est automatiquement
 * propagée : si un statut est ajouté dans l'enum Drizzle, `BookingStatus`
 * change et `ALLOWED_TRANSITIONS` (dans project-booking-status.ts) doit être
 * mise à jour sous peine d'échec de typecheck.
 */
export const BOOKING_STATUSES = bookingStatus.enumValues;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Types d'événements de fulfillment dérivés de l'enum `fulfillment_event_type`
 * PostgreSQL via `fulfillmentEventType.enumValues`.
 */
export const FULFILLMENT_EVENT_TYPES = fulfillmentEventType.enumValues;

export type FulfillmentEventType = (typeof FULFILLMENT_EVENT_TYPES)[number];

/**
 * Codes d'erreur fermés pour la machine à états de booking.
 */
export type BookingTransitionErrorCode = 'INVALID_TRANSITION' | 'TERMINAL_STATE';

/**
 * Résultat discriminé d'une transition.
 */
export type BookingTransitionResult =
  | { kind: 'APPLIED'; previousStatus: BookingStatus; nextStatus: BookingStatus }
  | { kind: 'NOOP'; currentStatus: BookingStatus };
