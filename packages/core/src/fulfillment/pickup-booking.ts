import type { DatabaseClient } from '@uttily/database';
import { applyFulfillmentTransition } from './apply-fulfillment-transition';
import type {
  FulfillmentOperationSpec,
  FulfillmentTransitionInput,
  FulfillmentTransitionResult,
} from './apply-fulfillment-transition';

/**
 * Spécification de l'opération de remise (READY_FOR_PICKUP → ACTIVE).
 */
const PICKUP_SPEC: FulfillmentOperationSpec = {
  operation: 'pickup_booking',
  eventType: 'PICKED_UP',
  requestedStatus: 'ACTIVE',
  auditAction: 'BOOKING_PICKED_UP',
  outboxEventType: 'BOOKING_PICKED_UP',
};

/**
 * Use case : remettre une réservation au client (READY_FOR_PICKUP → ACTIVE).
 *
 * Transactionnel, idempotent, autorisé et audité. Voir applyFulfillmentTransition.
 */
export async function pickupBooking(
  db: DatabaseClient,
  input: FulfillmentTransitionInput,
): Promise<FulfillmentTransitionResult> {
  return applyFulfillmentTransition(db, PICKUP_SPEC, input);
}
