import { describe, expect, it } from 'vitest';
import {
  BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE,
  BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE,
  BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION,
  parseBookingAmendmentRequestedV1Event,
  type BookingAmendmentRequestedV1Event,
} from './booking-amendment-requested-event';

describe('BOOKING_AMENDMENT_REQUESTED.v1 — contrat fermé', () => {
  const validEvent: BookingAmendmentRequestedV1Event = {
    aggregateType: BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE,
    eventType: BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE,
    eventVersion: BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION,
    payload: {
      organizationId: '00000000-0000-4000-8000-000000000001',
      bookingId: '00000000-0000-4000-8000-000000000002',
      amendmentId: '00000000-0000-4000-8000-000000000003',
    },
  };

  it('expose les constantes v1 attendues', () => {
    expect(BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE).toBe('BOOKING');
    expect(BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE).toBe('BOOKING_AMENDMENT_REQUESTED');
    expect(BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION).toBe('v1');
  });

  it('parse un événement valide et conserve les trois UUIDs', () => {
    expect(parseBookingAmendmentRequestedV1Event(validEvent)).toEqual(validEvent);
    expect(Object.keys(validEvent.payload)).toEqual(['organizationId', 'bookingId', 'amendmentId']);
  });

  it('refuse une valeur non objet et un champ racine supplémentaire', () => {
    expect(() => parseBookingAmendmentRequestedV1Event(null)).toThrow('valeur non-objet');
    expect(() => parseBookingAmendmentRequestedV1Event([])).toThrow('valeur non-objet');
    expect(() => parseBookingAmendmentRequestedV1Event({ ...validEvent, extra: true })).toThrow(
      'champ racine supplémentaire',
    );
  });

  it('refuse les constantes ou versions incorrectes', () => {
    expect(() =>
      parseBookingAmendmentRequestedV1Event({ ...validEvent, aggregateType: 'DRAFT' }),
    ).toThrow('aggregateType');
    expect(() =>
      parseBookingAmendmentRequestedV1Event({ ...validEvent, eventType: 'BOOKING_AMENDED' }),
    ).toThrow('eventType');
    expect(() =>
      parseBookingAmendmentRequestedV1Event({ ...validEvent, eventVersion: 'v2' }),
    ).toThrow('eventVersion');
  });

  it('refuse un champ payload supplémentaire et un UUID invalide', () => {
    expect(() =>
      parseBookingAmendmentRequestedV1Event({
        ...validEvent,
        payload: { ...validEvent.payload, amountMinor: 100 },
      }),
    ).toThrow('champ payload supplémentaire');
    expect(() =>
      parseBookingAmendmentRequestedV1Event({
        ...validEvent,
        payload: { ...validEvent.payload, amendmentId: 'bad' },
      }),
    ).toThrow('amendmentId invalide');
  });
});
