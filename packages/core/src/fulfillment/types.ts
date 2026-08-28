import {
  BOOKING_STATUSES,
  type BookingStatus,
  FULFILLMENT_EVENT_TYPES,
  type FulfillmentEventType,
} from '@uttily/contracts';

export { BOOKING_STATUSES, type BookingStatus, FULFILLMENT_EVENT_TYPES, type FulfillmentEventType };

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
