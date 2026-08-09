import { describe, it, expect } from 'vitest';
import { parseBookingConfirmedV1 } from './booking-confirmed-parser';
import { DocumentRenderError } from './errors';

const VALID_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THIRD_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FOURTH_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeValidRaw(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: VALID_UUID,
    organizationId: OTHER_UUID,
    aggregateType: 'BOOKING',
    aggregateId: VALID_UUID,
    eventType: 'BOOKING_CONFIRMED',
    eventVersion: 'v1',
    payload: {
      bookingId: VALID_UUID,
      paymentId: THIRD_UUID,
      draftId: FOURTH_UUID,
      organizationId: OTHER_UUID,
    },
    ...overrides,
  };
}

describe('parseBookingConfirmedV1', () => {
  it('nominal — valide et retourne le parsed event', () => {
    const result = parseBookingConfirmedV1(makeValidRaw());
    expect(result.outboxEventId).toBe(VALID_UUID);
    expect(result.organizationId).toBe(OTHER_UUID);
    expect(result.aggregateId).toBe(VALID_UUID);
    expect(result.payload.bookingId).toBe(VALID_UUID);
    expect(result.payload.paymentId).toBe(THIRD_UUID);
    expect(result.payload.draftId).toBe(FOURTH_UUID);
    expect(result.payload.organizationId).toBe(OTHER_UUID);
  });

  it('mauvais aggregate_type — EVENT_CONTRACT_MISMATCH', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ aggregateType: 'PAYMENT' }))).toThrow(
      DocumentRenderError,
    );
    try {
      parseBookingConfirmedV1(makeValidRaw({ aggregateType: 'PAYMENT' }));
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('EVENT_CONTRACT_MISMATCH');
    }
  });

  it('mauvais event_type — EVENT_CONTRACT_MISMATCH', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ eventType: 'BOOKING_CANCELLED' }))).toThrow(
      DocumentRenderError,
    );
  });

  it('mauvais event_version — EVENT_CONTRACT_MISMATCH', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ eventVersion: 'v2' }))).toThrow(
      DocumentRenderError,
    );
  });

  it('aggregate_id non-UUID — VALIDATION', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          aggregateId: 'not-a-uuid',
          payload: {
            bookingId: 'not-a-uuid',
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: OTHER_UUID,
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
  });

  it('organization_id non-UUID — VALIDATION', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ organizationId: 'not-a-uuid' }))).toThrow(
      DocumentRenderError,
    );
  });

  it('payload null — VALIDATION', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ payload: null }))).toThrow(
      DocumentRenderError,
    );
  });

  it('payload array — VALIDATION', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ payload: [1, 2] }))).toThrow(
      DocumentRenderError,
    );
  });

  it('payload string — VALIDATION', () => {
    expect(() => parseBookingConfirmedV1(makeValidRaw({ payload: 'hello' }))).toThrow(
      DocumentRenderError,
    );
  });

  it('payload avec cle supplementaire — VALIDATION', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: OTHER_UUID,
            extra: 'bad',
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
  });

  it('payload avec cle manquante — VALIDATION', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
  });

  it('payload avec valeur non-UUID — VALIDATION', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          payload: {
            bookingId: VALID_UUID,
            paymentId: 'not-a-uuid',
            draftId: FOURTH_UUID,
            organizationId: OTHER_UUID,
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
  });

  it('payload.bookingId differe de aggregate_id — AUTHORITY_MISMATCH', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          aggregateId: OTHER_UUID,
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: OTHER_UUID,
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
    try {
      parseBookingConfirmedV1(
        makeValidRaw({
          aggregateId: OTHER_UUID,
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: OTHER_UUID,
          },
        }),
      );
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('AUTHORITY_MISMATCH');
    }
  });

  it('payload.organizationId differe de outbox_events.organization_id — AUTHORITY_MISMATCH', () => {
    expect(() =>
      parseBookingConfirmedV1(
        makeValidRaw({
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: FOURTH_UUID,
          },
        }),
      ),
    ).toThrow(DocumentRenderError);
    try {
      parseBookingConfirmedV1(
        makeValidRaw({
          payload: {
            bookingId: VALID_UUID,
            paymentId: THIRD_UUID,
            draftId: FOURTH_UUID,
            organizationId: FOURTH_UUID,
          },
        }),
      );
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('AUTHORITY_MISMATCH');
    }
  });
});
