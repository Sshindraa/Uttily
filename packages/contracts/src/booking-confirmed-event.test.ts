import { describe, it, expect } from 'vitest';
import {
  BOOKING_CONFIRMED_AGGREGATE_TYPE,
  BOOKING_CONFIRMED_EVENT_TYPE,
  BOOKING_CONFIRMED_EVENT_VERSION,
  type BookingConfirmedV1Event,
  type BookingConfirmedV1Payload,
} from './booking-confirmed-event';

describe('BOOKING_CONFIRMED.v1 — contrat fermé', () => {
  it('aggregateType est exactement BOOKING', () => {
    expect(BOOKING_CONFIRMED_AGGREGATE_TYPE).toBe('BOOKING');
  });

  it('eventType est exactement BOOKING_CONFIRMED', () => {
    expect(BOOKING_CONFIRMED_EVENT_TYPE).toBe('BOOKING_CONFIRMED');
  });

  it('eventVersion est exactement v1', () => {
    expect(BOOKING_CONFIRMED_EVENT_VERSION).toBe('v1');
  });

  it('un événement conforme satisfait BookingConfirmedV1Event', () => {
    const event: BookingConfirmedV1Event = {
      aggregateType: BOOKING_CONFIRMED_AGGREGATE_TYPE,
      eventType: BOOKING_CONFIRMED_EVENT_TYPE,
      eventVersion: BOOKING_CONFIRMED_EVENT_VERSION,
      payload: {
        bookingId: '00000000-0000-4000-8000-000000000001',
        paymentId: '00000000-0000-4000-8000-000000000002',
        draftId: '00000000-0000-4000-8000-000000000003',
        organizationId: '00000000-0000-4000-8000-000000000004',
      },
    };
    expect(event.aggregateType).toBe('BOOKING');
    expect(event.eventType).toBe('BOOKING_CONFIRMED');
    expect(event.eventVersion).toBe('v1');
    expect(event.payload.bookingId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.payload.paymentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.payload.draftId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.payload.organizationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('le payload est contractuellement limité aux quatre UUIDs attendus', () => {
    // Vérification statique : BookingConfirmedV1Payload ne contient que
    // bookingId, paymentId, draftId, organizationId.
    // Si une nouvelle clé est ajoutée, ce test ne compile plus car
    // l'objet ne satisfait plus le type.
    const payload: BookingConfirmedV1Payload = {
      bookingId: '00000000-0000-4000-8000-000000000001',
      paymentId: '00000000-0000-4000-8000-000000000002',
      draftId: '00000000-0000-4000-8000-000000000003',
      organizationId: '00000000-0000-4000-8000-000000000004',
    };
    const keys = Object.keys(payload);
    expect(keys).toEqual(['bookingId', 'paymentId', 'draftId', 'organizationId']);
  });
});
