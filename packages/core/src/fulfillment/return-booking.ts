import type { DatabaseClient } from '@uttily/database';
import { applyFulfillmentTransition } from './apply-fulfillment-transition';
import type {
  FulfillmentOperationSpec,
  FulfillmentTransitionInput,
  FulfillmentTransitionResult,
} from './apply-fulfillment-transition';

/**
 * Spécification de l'opération de réception (ACTIVE → RETURNED).
 */
const RETURN_SPEC: FulfillmentOperationSpec = {
  operation: 'return_booking',
  eventType: 'RETURNED',
  requestedStatus: 'RETURNED',
  auditAction: 'BOOKING_RETURNED',
  outboxEventType: 'BOOKING_RETURNED',
};

/**
 * Use case : réceptionner une réservation rendue par le client (ACTIVE → RETURNED).
 *
 * Transactionnel, idempotent, autorisé et audité. Voir applyFulfillmentTransition.
 */
export async function returnBooking(
  db: DatabaseClient,
  input: FulfillmentTransitionInput,
): Promise<FulfillmentTransitionResult> {
  return applyFulfillmentTransition(db, RETURN_SPEC, input);
}
