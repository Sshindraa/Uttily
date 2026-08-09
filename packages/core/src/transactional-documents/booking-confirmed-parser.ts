/**
 * @uttily/core — Validation runtime stricte fail-closed de BOOKING_CONFIRMED.v1 (G5C, ADR-013).
 *
 * Le contenu lu depuis outbox_events n'est jamais trusté. Toute anomalie lève
 * DocumentRenderError. Aucune donnée métier n'est extraite du payload : seuls
 * les quatre UUIDs de déclenchement sont validés et recoupés.
 */

import type { BookingConfirmedV1Payload } from '@uttily/contracts';
import { DocumentRenderError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RawOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly payload: unknown;
}

export interface ParsedBookingConfirmedEvent {
  readonly outboxEventId: string;
  readonly organizationId: string;
  readonly aggregateId: string;
  readonly payload: BookingConfirmedV1Payload;
}

/**
 * Valide strictement un événement BOOKING_CONFIRMED.v1 lu depuis outbox_events.
 * Fail-closed : toute anomalie lève DocumentRenderError.
 *
 * Vérifications :
 * - aggregate_type exactement 'BOOKING'
 * - event_type exactement 'BOOKING_CONFIRMED'
 * - event_version exactement 'v1'
 * - aggregate_id UUID valide
 * - organization_id UUID valide
 * - payload objet JSON strict
 * - exactement 4 clés : bookingId, paymentId, draftId, organizationId
 * - chaque valeur est une string UUID valide
 * - aucun champ supplémentaire
 * - payload.bookingId = aggregate_id
 * - payload.organizationId = outbox_events.organization_id
 */
export function parseBookingConfirmedV1(raw: RawOutboxEvent): ParsedBookingConfirmedEvent {
  if (raw.aggregateType !== 'BOOKING') {
    throw new DocumentRenderError(
      'EVENT_CONTRACT_MISMATCH',
      'aggregate_type n est pas conforme au contrat',
    );
  }
  if (raw.eventType !== 'BOOKING_CONFIRMED') {
    throw new DocumentRenderError(
      'EVENT_CONTRACT_MISMATCH',
      'event_type n est pas conforme au contrat',
    );
  }
  if (raw.eventVersion !== 'v1') {
    throw new DocumentRenderError(
      'EVENT_CONTRACT_MISMATCH',
      'event_version n est pas conforme au contrat',
    );
  }

  if (!UUID_RE.test(raw.aggregateId)) {
    throw new DocumentRenderError('VALIDATION', 'aggregate_id n est pas un UUID valide');
  }
  if (!UUID_RE.test(raw.organizationId)) {
    throw new DocumentRenderError('VALIDATION', 'organization_id n est pas un UUID valide');
  }

  if (raw.payload === null || typeof raw.payload !== 'object' || Array.isArray(raw.payload)) {
    throw new DocumentRenderError('VALIDATION', 'payload n est pas un objet JSON');
  }

  const payload = raw.payload as Record<string, unknown>;
  const expectedKeys = ['bookingId', 'paymentId', 'draftId', 'organizationId'] as const;
  const actualKeys = Object.keys(payload).sort();
  const expectedSorted = [...expectedKeys].sort();

  if (actualKeys.length !== 4 || !expectedSorted.every((k, i) => actualKeys[i] === k)) {
    throw new DocumentRenderError(
      'VALIDATION',
      'payload doit contenir exactement bookingId, paymentId, draftId, organizationId',
    );
  }

  for (const key of expectedKeys) {
    const val = payload[key];
    if (typeof val !== 'string' || !UUID_RE.test(val)) {
      throw new DocumentRenderError('VALIDATION', `payload.${key} n est pas un UUID valide`);
    }
  }

  const parsedPayload: BookingConfirmedV1Payload = {
    bookingId: payload['bookingId'] as string,
    paymentId: payload['paymentId'] as string,
    draftId: payload['draftId'] as string,
    organizationId: payload['organizationId'] as string,
  };

  if (parsedPayload.bookingId !== raw.aggregateId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'payload.bookingId differe de aggregate_id',
    );
  }

  if (parsedPayload.organizationId !== raw.organizationId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'payload.organizationId differe de outbox_events.organization_id',
    );
  }

  return {
    outboxEventId: raw.id,
    organizationId: raw.organizationId,
    aggregateId: raw.aggregateId,
    payload: parsedPayload,
  };
}
