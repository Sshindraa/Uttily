import { createHash } from 'node:crypto';
import { FulfillmentError } from './fulfillment-errors';

/**
 * Payload canonique pour le calcul de l'empreinte fulfillment (G3A).
 * Version v1. Comprend au minimum : organizationId, bookingId, actorUserId, operation.
 */
export interface FulfillmentFingerprintPayload {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  operation: string;
}

/**
 * Calcule l'empreinte SHA-256 canonique d'un payload fulfillment (G3A).
 *
 * Le JSON canonique est construit avec :
 * - `v: "v1"` (version du schéma d'empreinte)
 * - les champs `actor_user_id`, `booking_id`, `operation`, `organization_id`
 * - ordre des champs trié alphabétiquement (ordre d'insertion préservé par JS)
 * - encodage UTF-8, JSON compact (pas d'espaces, pas de retours)
 *
 * @returns empreinte SHA-256 en hexadécimal (64 caractères)
 * @throws FulfillmentError('VALIDATION') si le payload est invalide
 */
export function computeFulfillmentFingerprint(payload: FulfillmentFingerprintPayload): string {
  if (!payload.organizationId || !payload.bookingId || !payload.actorUserId || !payload.operation) {
    throw new FulfillmentError('VALIDATION', 'Payload de fingerprint fulfillment invalide.');
  }
  const canonical = {
    actor_user_id: payload.actorUserId,
    booking_id: payload.bookingId,
    operation: payload.operation,
    organization_id: payload.organizationId,
    v: 'v1',
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
