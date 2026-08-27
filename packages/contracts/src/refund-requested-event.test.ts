import { describe, expect, it } from 'vitest';
import {
  parseRefundRequestedV1Event,
  parseRefundRequestedV2Event,
  parseRefundRequestedEvent,
  REFUND_REQUESTED_AGGREGATE_TYPE,
  REFUND_REQUESTED_EVENT_TYPE,
  REFUND_REQUESTED_EVENT_VERSION_V1,
  REFUND_REQUESTED_EVENT_VERSION_V2,
} from './refund-requested-event';

describe('parseRefundRequestedV1Event', () => {
  const validEvent = {
    aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
    eventType: REFUND_REQUESTED_EVENT_TYPE,
    eventVersion: REFUND_REQUESTED_EVENT_VERSION_V1,
    aggregateId: '44444444-4444-4444-4444-444444444444',
    payload: {
      organizationId: '11111111-1111-1111-1111-111111111111',
      bookingId: '22222222-2222-2222-2222-222222222222',
      amendmentId: '33333333-3333-3333-3333-333333333333',
      refundId: '44444444-4444-4444-4444-444444444444',
    },
  };

  it('accepte un événement valide et retourne la représentation canonique', () => {
    const parsed = parseRefundRequestedV1Event(validEvent);
    expect(parsed).toEqual(validEvent);
    expect(parsed.eventVersion).toBe('v1');
  });

  it('refuse les valeurs non-objets ou null', () => {
    expect(() => parseRefundRequestedV1Event(null)).toThrow('valeur non-objet');
    expect(() => parseRefundRequestedV1Event('string')).toThrow('valeur non-objet');
    expect(() => parseRefundRequestedV1Event([])).toThrow('valeur non-objet');
  });

  it('refuse un aggregateType incorrect', () => {
    expect(() => parseRefundRequestedV1Event({ ...validEvent, aggregateType: 'BOOKING' })).toThrow(
      "aggregateType 'BOOKING' incorrect",
    );
  });

  it('refuse un eventType incorrect', () => {
    expect(() =>
      parseRefundRequestedV1Event({ ...validEvent, eventType: 'BOOKING_AMENDED' }),
    ).toThrow("eventType 'BOOKING_AMENDED' incorrect");
  });

  it('refuse un eventVersion incorrect (rejette 1, "1", "v2")', () => {
    expect(() => parseRefundRequestedV1Event({ ...validEvent, eventVersion: '1' })).toThrow(
      "eventVersion '1' incorrect",
    );
    expect(() => parseRefundRequestedV1Event({ ...validEvent, eventVersion: 1 })).toThrow(
      "eventVersion '1' incorrect",
    );
    expect(() => parseRefundRequestedV1Event({ ...validEvent, eventVersion: 'v2' })).toThrow(
      "eventVersion 'v2' incorrect",
    );
  });

  it('refuse les champs racine supplémentaires', () => {
    expect(() => parseRefundRequestedV1Event({ ...validEvent, extra: 'bad' })).toThrow(
      "champ racine supplémentaire 'extra'",
    );
  });

  it('refuse les champs payload supplémentaires', () => {
    expect(() =>
      parseRefundRequestedV1Event({
        ...validEvent,
        payload: { ...validEvent.payload, extra: 'bad' },
      }),
    ).toThrow("champ payload supplémentaire 'extra'");
  });

  it('refuse un UUID organizationId invalide', () => {
    expect(() =>
      parseRefundRequestedV1Event({
        ...validEvent,
        payload: { ...validEvent.payload, organizationId: 'not-a-uuid' },
      }),
    ).toThrow('payload.organizationId invalide');
  });

  it('refuse un aggregateId ne correspondant pas au refundId', () => {
    expect(() =>
      parseRefundRequestedV1Event({
        ...validEvent,
        aggregateId: '55555555-5555-5555-5555-555555555555',
      }),
    ).toThrow('doit correspondre à payload.refundId');
  });
});

describe('parseRefundRequestedV2Event', () => {
  const validCancellationEvent = {
    aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
    eventType: REFUND_REQUESTED_EVENT_TYPE,
    eventVersion: REFUND_REQUESTED_EVENT_VERSION_V2,
    aggregateId: '44444444-4444-4444-4444-444444444444',
    payload: {
      organizationId: '11111111-1111-1111-1111-111111111111',
      bookingId: '22222222-2222-2222-2222-222222222222',
      refundId: '44444444-4444-4444-4444-444444444444',
      origin: 'BOOKING_CANCELLATION' as const,
      cancellationId: '55555555-5555-5555-5555-555555555555',
    },
  };

  it('accepte un événement v2 de type BOOKING_CANCELLATION', () => {
    const parsed = parseRefundRequestedV2Event(validCancellationEvent);
    expect(parsed).toEqual(validCancellationEvent);
    expect(parsed.eventVersion).toBe('v2');
  });

  it('accepte un événement v2 de type BOOKING_AMENDMENT', () => {
    const amendmentEvent = {
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: REFUND_REQUESTED_EVENT_VERSION_V2,
      aggregateId: '44444444-4444-4444-4444-444444444444',
      payload: {
        organizationId: '11111111-1111-1111-1111-111111111111',
        bookingId: '22222222-2222-2222-2222-222222222222',
        refundId: '44444444-4444-4444-4444-444444444444',
        origin: 'BOOKING_AMENDMENT' as const,
        amendmentId: '33333333-3333-3333-3333-333333333333',
      },
    };
    const parsed = parseRefundRequestedV2Event(amendmentEvent);
    expect(parsed).toEqual(amendmentEvent);
  });

  it('refuse une origin invalide', () => {
    expect(() =>
      parseRefundRequestedV2Event({
        ...validCancellationEvent,
        payload: { ...validCancellationEvent.payload, origin: 'UNKNOWN_ORIGIN' },
      }),
    ).toThrow('payload.origin');
  });
});

describe('parseRefundRequestedEvent (universel)', () => {
  it('route vers v1 pour eventVersion v1', () => {
    const v1 = {
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: 'v1' as const,
      aggregateId: '44444444-4444-4444-4444-444444444444',
      payload: {
        organizationId: '11111111-1111-1111-1111-111111111111',
        bookingId: '22222222-2222-2222-2222-222222222222',
        amendmentId: '33333333-3333-3333-3333-333333333333',
        refundId: '44444444-4444-4444-4444-444444444444',
      },
    };
    expect(parseRefundRequestedEvent(v1).eventVersion).toBe('v1');
  });

  it('route vers v2 pour eventVersion v2', () => {
    const v2 = {
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: 'v2' as const,
      aggregateId: '44444444-4444-4444-4444-444444444444',
      payload: {
        organizationId: '11111111-1111-1111-1111-111111111111',
        bookingId: '22222222-2222-2222-2222-222222222222',
        refundId: '44444444-4444-4444-4444-444444444444',
        origin: 'BOOKING_CANCELLATION' as const,
        cancellationId: '55555555-5555-5555-5555-555555555555',
      },
    };
    expect(parseRefundRequestedEvent(v2).eventVersion).toBe('v2');
  });
});
