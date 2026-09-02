import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import { applyFulfillmentTransition } from './apply-fulfillment-transition';
import type {
  FulfillmentOperationSpec,
  FulfillmentTransitionInput,
  FulfillmentTransitionResult,
} from './apply-fulfillment-transition';
import { computeFulfillmentFingerprint } from './fingerprint';
import {
  applyReturnMaintenance,
  normalizeReturnMaintenanceInput,
  type NormalizedReturnMaintenanceInput,
  type ReturnMaintenanceInput,
} from './return-maintenance';

export interface ReturnBookingInput extends FulfillmentTransitionInput {
  /** Protection maintenance à poser dans la transaction de restitution. */
  maintenance?: ReturnMaintenanceInput | undefined;
}

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
  input: ReturnBookingInput,
): Promise<FulfillmentTransitionResult> {
  const maintenance = input.maintenance ? normalizeReturnMaintenanceInput(input.maintenance) : null;

  return applyFulfillmentTransition(
    db,
    {
      ...RETURN_SPEC,
      computeRequestFingerprint: (baseInput) =>
        computeReturnBookingFingerprint(baseInput, maintenance),
      afterApplied: ({ tx, booking, fulfillmentEventId }) =>
        applyReturnMaintenance({
          tx,
          booking,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          fulfillmentEventId,
          request: maintenance,
        }),
    },
    input,
  );
}

/**
 * Conserve l'empreinte historique pour les retours sans payload additionnel,
 * tout en rendant la durée et la source de maintenance idempotentes lorsqu'elles
 * sont présentes.
 */
export function computeReturnBookingFingerprint(
  input: FulfillmentTransitionInput,
  maintenance: NormalizedReturnMaintenanceInput | null,
): string {
  if (maintenance === null) {
    return computeFulfillmentFingerprint({
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      actorUserId: input.actorUserId,
      operation: RETURN_SPEC.operation,
    });
  }

  const canonical = {
    actor_user_id: input.actorUserId,
    booking_id: input.bookingId,
    booking_item_id: maintenance.bookingItemId,
    duration_minutes: maintenance.durationMinutes,
    operation: RETURN_SPEC.operation,
    organization_id: input.organizationId,
    source_damage_report_id: maintenance.sourceDamageReportId,
    v: 'v1',
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
