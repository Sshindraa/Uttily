import type { DatabaseClient } from '@uttily/database';
import { applyFulfillmentTransition } from './apply-fulfillment-transition';
import type {
  FulfillmentOperationSpec,
  FulfillmentTransitionInput,
  FulfillmentTransitionResult,
} from './apply-fulfillment-transition';

/**
 * Spécification de l'opération de préparation (CONFIRMED → READY_FOR_PICKUP).
 */
const PREPARE_SPEC: FulfillmentOperationSpec = {
  operation: 'prepare_booking',
  eventType: 'PREPARED',
  requestedStatus: 'READY_FOR_PICKUP',
  auditAction: 'BOOKING_PREPARED',
  outboxEventType: 'BOOKING_PREPARED',
};

/**
 * Use case : préparer une réservation (CONFIRMED → READY_FOR_PICKUP).
 *
 * Transactionnel, idempotent, autorisé et audité. Voir applyFulfillmentTransition.
 */
export async function prepareBooking(
  db: DatabaseClient,
  input: FulfillmentTransitionInput,
): Promise<FulfillmentTransitionResult> {
  return applyFulfillmentTransition(db, PREPARE_SPEC, input);
}
