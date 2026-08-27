import { describe, expect, it } from 'vitest';
import {
  parseBookingCancelledV1Event,
  BOOKING_CANCELLED_AGGREGATE_TYPE,
  BOOKING_CANCELLED_EVENT_TYPE,
  BOOKING_CANCELLED_EVENT_VERSION,
} from './booking-cancelled-event';

describe('parseBookingCancelledV1Event', () => {
  const validEvent = {
    aggregateType: BOOKING_CANCELLED_AGGREGATE_TYPE,
    eventType: BOOKING_CANCELLED_EVENT_TYPE,
    eventVersion: BOOKING_CANCELLED_EVENT_VERSION,
    aggregateId: '22222222-2222-2222-2222-222222222222',
    payload: {
      organizationId: '11111111-1111-1111-1111-111111111111',
      bookingId: '22222222-2222-2222-2222-222222222222',
      cancellationId: '33333333-3333-3333-3333-333333333333',
      refundId: '44444444-4444-4444-4444-444444444444',
      refundAmountMinor: 10000,
      retainedAmountMinor: 0,
      actorReason: 'MERCHANT_CANCELLATION',
    },
  };

  it('accepte un événement valide et retourne la représentation canonique', () => {
    const parsed = parseBookingCancelledV1Event(validEvent);
    expect(parsed).toEqual(validEvent);
  });

  it('accepte un refundId null si aucun remboursement requis', () => {
    const noRefundEvent = {
      ...validEvent,
      payload: {
        ...validEvent.payload,
        refundId: null,
        refundAmountMinor: 0,
        retainedAmountMinor: 10000,
      },
    };
    const parsed = parseBookingCancelledV1Event(noRefundEvent);
    expect(parsed.payload.refundId).toBeNull();
  });

  it('refuse les types ou formats invalides', () => {
    expect(() => parseBookingCancelledV1Event(null)).toThrow('valeur non-objet');
    expect(() => parseBookingCancelledV1Event({ ...validEvent, aggregateType: 'booking' })).toThrow(
      "aggregateType 'booking' incorrect",
    );
    expect(() => parseBookingCancelledV1Event({ ...validEvent, eventType: 'CANCELLED' })).toThrow(
      "eventType 'CANCELLED' incorrect",
    );
    expect(() => parseBookingCancelledV1Event({ ...validEvent, eventVersion: 'v2' })).toThrow(
      "eventVersion 'v2' incorrect",
    );
    expect(() =>
      parseBookingCancelledV1Event({
        ...validEvent,
        aggregateId: '55555555-5555-5555-5555-555555555555',
      }),
    ).toThrow('doit correspondre à payload.bookingId');
  });

  it('refuse les champs inconnus', () => {
    expect(() => parseBookingCancelledV1Event({ ...validEvent, extra: 123 })).toThrow(
      "champ racine supplémentaire 'extra'",
    );
    expect(() =>
      parseBookingCancelledV1Event({
        ...validEvent,
        payload: { ...validEvent.payload, extra: 123 },
      }),
    ).toThrow("champ payload supplémentaire 'extra'");
  });
});
