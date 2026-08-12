import { describe, it, expect } from 'vitest';
import {
  BOOKING_AMENDED_AGGREGATE_TYPE,
  BOOKING_AMENDED_EVENT_TYPE,
  BOOKING_AMENDED_EVENT_VERSION,
  parseBookingAmendedV1Event,
  type BookingAmendedV1Event,
  type BookingAmendedV1Payload,
} from './booking-amended-event';

describe('BOOKING_AMENDED.v1 — contrat fermé', () => {
  it('aggregateType est exactement BOOKING', () => {
    expect(BOOKING_AMENDED_AGGREGATE_TYPE).toBe('BOOKING');
  });

  it('eventType est exactement BOOKING_AMENDED', () => {
    expect(BOOKING_AMENDED_EVENT_TYPE).toBe('BOOKING_AMENDED');
  });

  it('eventVersion est exactement v1', () => {
    expect(BOOKING_AMENDED_EVENT_VERSION).toBe('v1');
  });

  it('un événement conforme satisfait BookingAmendedV1Event', () => {
    const event: BookingAmendedV1Event = {
      aggregateType: BOOKING_AMENDED_AGGREGATE_TYPE,
      eventType: BOOKING_AMENDED_EVENT_TYPE,
      eventVersion: BOOKING_AMENDED_EVENT_VERSION,
      payload: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        bookingId: '00000000-0000-4000-8000-000000000002',
        amendmentId: '00000000-0000-4000-8000-000000000003',
      },
    };
    expect(event.aggregateType).toBe('BOOKING');
    expect(event.eventType).toBe('BOOKING_AMENDED');
    expect(event.eventVersion).toBe('v1');
    expect(event.payload.organizationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.payload.bookingId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.payload.amendmentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('le payload est contractuellement limité aux trois UUIDs attendus', () => {
    const payload: BookingAmendedV1Payload = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      bookingId: '00000000-0000-4000-8000-000000000002',
      amendmentId: '00000000-0000-4000-8000-000000000003',
    };
    const keys = Object.keys(payload);
    expect(keys).toEqual(['organizationId', 'bookingId', 'amendmentId']);
  });

  describe('parseBookingAmendedV1Event', () => {
    const validRaw = {
      aggregateType: 'BOOKING',
      eventType: 'BOOKING_AMENDED',
      eventVersion: 'v1',
      payload: {
        organizationId: '00000000-0000-4000-8000-000000000001',
        bookingId: '00000000-0000-4000-8000-000000000002',
        amendmentId: '00000000-0000-4000-8000-000000000003',
      },
    };

    it('parse avec succès un événement valide', () => {
      const parsed = parseBookingAmendedV1Event(validRaw);
      expect(parsed).toEqual(validRaw);
    });

    it('refuse une valeur non-objet', () => {
      expect(() => parseBookingAmendedV1Event(null)).toThrow('valeur non-objet');
      expect(() => parseBookingAmendedV1Event('str')).toThrow('valeur non-objet');
      expect(() => parseBookingAmendedV1Event(123)).toThrow('valeur non-objet');
      expect(() => parseBookingAmendedV1Event([])).toThrow('valeur non-objet');
    });

    it('refuse un champ racine supplémentaire', () => {
      expect(() => parseBookingAmendedV1Event({ ...validRaw, extra: true })).toThrow(
        'champ racine supplémentaire',
      );
    });

    it('refuse un aggregateType incorrect', () => {
      expect(() => parseBookingAmendedV1Event({ ...validRaw, aggregateType: 'DRAFT' })).toThrow(
        'aggregateType',
      );
    });

    it('refuse un eventType incorrect', () => {
      expect(() =>
        parseBookingAmendedV1Event({ ...validRaw, eventType: 'BOOKING_CREATED' }),
      ).toThrow('eventType');
    });

    it('refuse un eventVersion incorrect', () => {
      expect(() => parseBookingAmendedV1Event({ ...validRaw, eventVersion: 'v2' })).toThrow(
        'eventVersion',
      );
    });

    it('refuse un payload absent ou non-objet', () => {
      expect(() => parseBookingAmendedV1Event({ ...validRaw, payload: null })).toThrow(
        'payload absent',
      );
      expect(() => parseBookingAmendedV1Event({ ...validRaw, payload: 'invalid' })).toThrow(
        'payload absent',
      );
    });

    it('refuse un champ payload supplémentaire', () => {
      expect(() =>
        parseBookingAmendedV1Event({
          ...validRaw,
          payload: { ...validRaw.payload, extraField: 1 },
        }),
      ).toThrow('champ payload supplémentaire');
    });

    it('refuse un UUID invalide dans le payload', () => {
      expect(() =>
        parseBookingAmendedV1Event({
          ...validRaw,
          payload: { ...validRaw.payload, organizationId: 'not-a-uuid' },
        }),
      ).toThrow('organizationId invalide');
      expect(() =>
        parseBookingAmendedV1Event({
          ...validRaw,
          payload: { ...validRaw.payload, bookingId: '123' },
        }),
      ).toThrow('bookingId invalide');
      expect(() =>
        parseBookingAmendedV1Event({
          ...validRaw,
          payload: { ...validRaw.payload, amendmentId: 'bad-uuid' },
        }),
      ).toThrow('amendmentId invalide');
    });
  });
});
