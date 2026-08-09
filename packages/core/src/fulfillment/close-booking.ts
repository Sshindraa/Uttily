import type { DatabaseClient } from '@uttily/database';
import { applyFulfillmentTransition } from './apply-fulfillment-transition';
import type {
  FulfillmentOperationSpec,
  FulfillmentTransitionInput,
  FulfillmentTransitionResult,
} from './apply-fulfillment-transition';

/**
 * Spécification de l'opération de clôture (RETURNED → CLOSED).
 */
const CLOSE_SPEC: FulfillmentOperationSpec = {
  operation: 'close_booking',
  eventType: 'CLOSED',
  requestedStatus: 'CLOSED',
  auditAction: 'BOOKING_CLOSED',
  outboxEventType: 'BOOKING_CLOSED',
};

/**
 * Use case : clôturer une réservation (RETURNED → CLOSED).
 *
 * Transactionnel, idempotent, autorisé et audité. Voir applyFulfillmentTransition.
 */
export async function closeBooking(
  db: DatabaseClient,
  input: FulfillmentTransitionInput,
): Promise<FulfillmentTransitionResult> {
  return applyFulfillmentTransition(db, CLOSE_SPEC, input);
}
