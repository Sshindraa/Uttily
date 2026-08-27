/**
 * @uttily/contracts — Contrats des événements REFUND_REQUESTED (v1 et v2).
 *
 * Événement source pour la demande de remboursement asynchrone :
 * - v1 : amendements de réservation (ADR-023).
 * - v2 : union discriminée par origin ('BOOKING_AMENDMENT' | 'AMENDMENT_COMPENSATION' | 'BOOKING_CANCELLATION').
 *
 * Inséré dans outbox_events lors des transactions atomiques financières.
 */

export const REFUND_REQUESTED_AGGREGATE_TYPE = 'REFUND' as const;
export const REFUND_REQUESTED_EVENT_TYPE = 'REFUND_REQUESTED' as const;
export const REFUND_REQUESTED_EVENT_VERSION = 'v1' as const;
export const REFUND_REQUESTED_EVENT_VERSION_V1 = 'v1' as const;
export const REFUND_REQUESTED_EVENT_VERSION_V2 = 'v2' as const;

export type RefundRequestedOrigin =
  'BOOKING_AMENDMENT' | 'AMENDMENT_COMPENSATION' | 'BOOKING_CANCELLATION';

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
 * Payload discriminé de REFUND_REQUESTED.v2.
 */
export type RefundRequestedV2Payload =
  | {
      readonly organizationId: string;
      readonly bookingId: string;
      readonly refundId: string;
      readonly origin: 'BOOKING_AMENDMENT';
      readonly amendmentId: string;
    }
  | {
      readonly organizationId: string;
      readonly bookingId: string;
      readonly refundId: string;
      readonly origin: 'AMENDMENT_COMPENSATION';
      readonly amendmentId: string;
    }
  | {
      readonly organizationId: string;
      readonly bookingId: string;
      readonly refundId: string;
      readonly origin: 'BOOKING_CANCELLATION';
      readonly cancellationId: string;
    };

/**
 * Contrat fermé de l'événement REFUND_REQUESTED.v1.
 */
export interface RefundRequestedV1Event {
  readonly aggregateType: typeof REFUND_REQUESTED_AGGREGATE_TYPE;
  readonly eventType: typeof REFUND_REQUESTED_EVENT_TYPE;
  readonly eventVersion: typeof REFUND_REQUESTED_EVENT_VERSION_V1;
  readonly aggregateId: string;
  readonly payload: RefundRequestedV1Payload;
}

/**
 * Contrat fermé de l'événement REFUND_REQUESTED.v2.
 */
export interface RefundRequestedV2Event {
  readonly aggregateType: typeof REFUND_REQUESTED_AGGREGATE_TYPE;
  readonly eventType: typeof REFUND_REQUESTED_EVENT_TYPE;
  readonly eventVersion: typeof REFUND_REQUESTED_EVENT_VERSION_V2;
  readonly aggregateId: string;
  readonly payload: RefundRequestedV2Payload;
}

export type RefundRequestedEvent = RefundRequestedV1Event | RefundRequestedV2Event;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parseur runtime strict pour l'événement REFUND_REQUESTED.v1.
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
  if (obj['eventVersion'] !== REFUND_REQUESTED_EVENT_VERSION_V1) {
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
    eventVersion: REFUND_REQUESTED_EVENT_VERSION_V1,
    aggregateId,
    payload: {
      organizationId,
      bookingId,
      amendmentId,
      refundId,
    },
  };
}

/**
 * Parseur runtime strict pour l'événement REFUND_REQUESTED.v2.
 */
export function parseRefundRequestedV2Event(input: unknown): RefundRequestedV2Event {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Événement REFUND_REQUESTED.v2 invalide: valeur non-objet.');
  }

  const obj = input as Record<string, unknown>;
  const allowedRootKeys = ['aggregateType', 'eventType', 'eventVersion', 'aggregateId', 'payload'];
  const rootKeys = Object.keys(obj);
  for (const k of rootKeys) {
    if (!allowedRootKeys.includes(k)) {
      throw new Error(
        `Événement REFUND_REQUESTED.v2 invalide: champ racine supplémentaire '${k}'.`,
      );
    }
  }

  if (obj['aggregateType'] !== REFUND_REQUESTED_AGGREGATE_TYPE) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: aggregateType '${String(obj['aggregateType'])}' incorrect.`,
    );
  }
  if (obj['eventType'] !== REFUND_REQUESTED_EVENT_TYPE) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: eventType '${String(obj['eventType'])}' incorrect.`,
    );
  }
  if (obj['eventVersion'] !== REFUND_REQUESTED_EVENT_VERSION_V2) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: eventVersion '${String(obj['eventVersion'])}' incorrect.`,
    );
  }

  const aggregateId = obj['aggregateId'];
  if (typeof aggregateId !== 'string' || !UUID_REGEX.test(aggregateId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: aggregateId invalide (${String(aggregateId)}).`,
    );
  }

  const payload = obj['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Événement REFUND_REQUESTED.v2 invalide: payload absent ou non-objet.');
  }

  const payloadObj = payload as Record<string, unknown>;
  const origin = payloadObj['origin'];
  if (
    origin !== 'BOOKING_AMENDMENT' &&
    origin !== 'AMENDMENT_COMPENSATION' &&
    origin !== 'BOOKING_CANCELLATION'
  ) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: payload.origin '${String(origin)}' invalide.`,
    );
  }

  const organizationId = payloadObj['organizationId'];
  if (typeof organizationId !== 'string' || !UUID_REGEX.test(organizationId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: payload.organizationId invalide (${String(organizationId)}).`,
    );
  }
  const bookingId = payloadObj['bookingId'];
  if (typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: payload.bookingId invalide (${String(bookingId)}).`,
    );
  }
  const refundId = payloadObj['refundId'];
  if (typeof refundId !== 'string' || !UUID_REGEX.test(refundId)) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: payload.refundId invalide (${String(refundId)}).`,
    );
  }

  if (aggregateId !== refundId) {
    throw new Error(
      `Événement REFUND_REQUESTED.v2 invalide: aggregateId (${aggregateId}) doit correspondre à payload.refundId (${refundId}).`,
    );
  }

  if (origin === 'BOOKING_AMENDMENT' || origin === 'AMENDMENT_COMPENSATION') {
    const allowedPayloadKeys = ['organizationId', 'bookingId', 'refundId', 'origin', 'amendmentId'];
    for (const k of Object.keys(payloadObj)) {
      if (!allowedPayloadKeys.includes(k)) {
        throw new Error(
          `Événement REFUND_REQUESTED.v2 invalide: champ payload supplémentaire '${k}'.`,
        );
      }
    }
    const amendmentId = payloadObj['amendmentId'];
    if (typeof amendmentId !== 'string' || !UUID_REGEX.test(amendmentId)) {
      throw new Error(
        `Événement REFUND_REQUESTED.v2 invalide: payload.amendmentId invalide (${String(amendmentId)}).`,
      );
    }
    return {
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: REFUND_REQUESTED_EVENT_VERSION_V2,
      aggregateId,
      payload: {
        organizationId,
        bookingId,
        refundId,
        origin,
        amendmentId,
      },
    };
  } else {
    // BOOKING_CANCELLATION
    const allowedPayloadKeys = [
      'organizationId',
      'bookingId',
      'refundId',
      'origin',
      'cancellationId',
    ];
    for (const k of Object.keys(payloadObj)) {
      if (!allowedPayloadKeys.includes(k)) {
        throw new Error(
          `Événement REFUND_REQUESTED.v2 invalide: champ payload supplémentaire '${k}'.`,
        );
      }
    }
    const cancellationId = payloadObj['cancellationId'];
    if (typeof cancellationId !== 'string' || !UUID_REGEX.test(cancellationId)) {
      throw new Error(
        `Événement REFUND_REQUESTED.v2 invalide: payload.cancellationId invalide (${String(cancellationId)}).`,
      );
    }
    return {
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: REFUND_REQUESTED_EVENT_VERSION_V2,
      aggregateId,
      payload: {
        organizationId,
        bookingId,
        refundId,
        origin,
        cancellationId,
      },
    };
  }
}

/**
 * Parseur universel acceptant REFUND_REQUESTED.v1 ou REFUND_REQUESTED.v2.
 */
export function parseRefundRequestedEvent(input: unknown): RefundRequestedEvent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Événement REFUND_REQUESTED invalide: valeur non-objet.');
  }
  const obj = input as Record<string, unknown>;
  const version = obj['eventVersion'];
  if (version === 'v1') {
    return parseRefundRequestedV1Event(input);
  }
  if (version === 'v2') {
    return parseRefundRequestedV2Event(input);
  }
  throw new Error(
    `Événement REFUND_REQUESTED invalide: eventVersion '${String(version)}' non supportée.`,
  );
}
