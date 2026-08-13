/**
 * @uttily/contracts — Contrat de l'événement REFUND_REQUESTED.v1.
 *
 * Événement source pour la demande de remboursement d'amendement (ADR-023).
 * Inséré dans outbox_events lors de la transaction atomique d'amendement REFUND.
 *
 * Le payload ne contient aucun PII ni données financières redondantes :
 * le consumer worker rechargera le refund autoritatif depuis PostgreSQL.
 */

export const REFUND_REQUESTED_AGGREGATE_TYPE = 'REFUND' as const;
export const REFUND_REQUESTED_EVENT_TYPE = 'REFUND_REQUESTED' as const;
export const REFUND_REQUESTED_EVENT_VERSION = 'v1' as const;

/**
 * Payload minimal de REFUND_REQUESTED.v1 : 4 UUIDs uniquement.
 */
export interface RefundRequestedV1Payload {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
  readonly refundId: string;
}

/**
 * Contrat fermé de l'événement REFUND_REQUESTED.v1.
 */
export interface RefundRequestedV1Event {
  readonly aggregateType: typeof REFUND_REQUESTED_AGGREGATE_TYPE;
  readonly eventType: typeof REFUND_REQUESTED_EVENT_TYPE;
  readonly eventVersion: typeof REFUND_REQUESTED_EVENT_VERSION;
  readonly aggregateId: string;
  readonly payload: RefundRequestedV1Payload;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parseur runtime strict pour l'événement REFUND_REQUESTED.v1.
 *
 * Refuse :
 * - valeur non objet ;
 * - aggregateType, eventType, eventVersion, aggregateId incorrects ;
 * - payload absent/non objet ;
 * - UUIDs invalides ;
 * - incohérence entre aggregateId et payload.refundId ;
 * - champs supplémentaires dans le payload ou à la racine.
 */
export function parseRefundRequestedV1Event(input: unknown): RefundRequestedV1Event {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Événement REFUND_REQUESTED.v1 invalide: valeur non-objet.');
  }

  const obj = input as Record<string, unknown>;
  const allowedRootKeys = ['aggregateType', 'eventType', 'eventVersion', 'aggregateId', 'payload'];
  const rootKeys = Object.keys(obj);
  for (const k of rootKeys) {
    if (!allowedRootKeys.includes(k)) {
      throw new Error(
        `Événement REFUND_REQUESTED.v1 invalide: champ racine supplémentaire '${k}'.`,
      );
    }
  }

  if (obj['aggregateType'] !== REFUND_REQUESTED_AGGREGATE_TYPE) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: aggregateType '${String(obj['aggregateType'])}' incorrect.`,
    );
  }
  if (obj['eventType'] !== REFUND_REQUESTED_EVENT_TYPE) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: eventType '${String(obj['eventType'])}' incorrect.`,
    );
  }
  if (obj['eventVersion'] !== REFUND_REQUESTED_EVENT_VERSION) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: eventVersion '${String(obj['eventVersion'])}' incorrect.`,
    );
  }

  const aggregateId = obj['aggregateId'];
  if (typeof aggregateId !== 'string' || !UUID_REGEX.test(aggregateId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: aggregateId invalide (${String(aggregateId)}).`,
    );
  }

  const payload = obj['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Événement REFUND_REQUESTED.v1 invalide: payload absent ou non-objet.');
  }

  const payloadObj = payload as Record<string, unknown>;
  const allowedPayloadKeys = ['organizationId', 'bookingId', 'amendmentId', 'refundId'];
  const payloadKeys = Object.keys(payloadObj);
  for (const k of payloadKeys) {
    if (!allowedPayloadKeys.includes(k)) {
      throw new Error(
        `Événement REFUND_REQUESTED.v1 invalide: champ payload supplémentaire '${k}'.`,
      );
    }
  }

  const organizationId = payloadObj['organizationId'];
  if (typeof organizationId !== 'string' || !UUID_REGEX.test(organizationId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: payload.organizationId invalide (${String(organizationId)}).`,
    );
  }
  const bookingId = payloadObj['bookingId'];
  if (typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: payload.bookingId invalide (${String(bookingId)}).`,
    );
  }
  const amendmentId = payloadObj['amendmentId'];
  if (typeof amendmentId !== 'string' || !UUID_REGEX.test(amendmentId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: payload.amendmentId invalide (${String(amendmentId)}).`,
    );
  }
  const refundId = payloadObj['refundId'];
  if (typeof refundId !== 'string' || !UUID_REGEX.test(refundId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: payload.refundId invalide (${String(refundId)}).`,
    );
  }

  if (aggregateId !== refundId) {
    throw new Error(
      `Événement REFUND_REQUESTED.v1 invalide: aggregateId (${aggregateId}) doit correspondre à payload.refundId (${refundId}).`,
    );
  }

  return {
    aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
    eventType: REFUND_REQUESTED_EVENT_TYPE,
    eventVersion: REFUND_REQUESTED_EVENT_VERSION,
    aggregateId,
    payload: {
      organizationId,
      bookingId,
      amendmentId,
      refundId,
    },
  };
}
