import { createHash } from 'node:crypto';
import { FulfillmentError } from './fulfillment-errors';

export interface CounterIncidentFingerprintPayload {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  operation: string;
  bookingItemId?: string | null | undefined;
  replacementInventoryItemId?: string | null | undefined;
  reason?: string | null | undefined;
}

/** Empreinte stable des mutations opérationnelles du lot 21-U2-AA. */
export function computeCounterIncidentFingerprint(
  payload: CounterIncidentFingerprintPayload,
): string {
  if (!payload.organizationId || !payload.bookingId || !payload.actorUserId || !payload.operation) {
    throw new FulfillmentError('VALIDATION', 'Payload de fingerprint incident invalide.');
  }

  const canonical = {
    actor_user_id: payload.actorUserId,
    booking_id: payload.bookingId,
    booking_item_id: payload.bookingItemId ?? null,
    operation: payload.operation,
    organization_id: payload.organizationId,
    reason: payload.reason ?? null,
    replacement_inventory_item_id: payload.replacementInventoryItemId ?? null,
    v: 'v1',
  };

  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
