import { describe, expect, it } from 'vitest';
import {
  normalizeReturnMaintenanceInput,
  RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES,
  RETURN_MAINTENANCE_MAX_DURATION_MINUTES,
  RETURN_MAINTENANCE_MIN_DURATION_MINUTES,
} from './return-maintenance';
import { FulfillmentError } from './fulfillment-errors';
import { computeReturnBookingFingerprint } from './return-booking';

const IDS = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  bookingId: '00000000-0000-4000-8000-000000000002',
  actorUserId: '00000000-0000-4000-8000-000000000003',
  bookingItemId: '00000000-0000-4000-8000-000000000004',
  sourceDamageReportId: '00000000-0000-4000-8000-000000000005',
};

describe('21-U2-AB — commande de maintenance au retour', () => {
  it('applique la durée par défaut et conserve la source optionnelle', () => {
    expect(
      normalizeReturnMaintenanceInput({
        bookingItemId: IDS.bookingItemId,
        sourceDamageReportId: IDS.sourceDamageReportId,
      }),
    ).toEqual({
      bookingItemId: IDS.bookingItemId,
      durationMinutes: RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES,
      sourceDamageReportId: IDS.sourceDamageReportId,
    });
  });

  it.each([
    ['UUID invalide', { bookingItemId: 'not-a-uuid' }],
    ['durée trop courte', { bookingItemId: IDS.bookingItemId, durationMinutes: 14 }],
    [
      'durée trop longue',
      {
        bookingItemId: IDS.bookingItemId,
        durationMinutes: RETURN_MAINTENANCE_MAX_DURATION_MINUTES + 1,
      },
    ],
    ['durée fractionnaire', { bookingItemId: IDS.bookingItemId, durationMinutes: 15.5 }],
  ])('refuse %s', (_label, input) => {
    expect(() => normalizeReturnMaintenanceInput(input)).toThrow(FulfillmentError);
  });

  it('inclut la durée et la source dans l’empreinte idempotente', () => {
    const base = {
      organizationId: IDS.organizationId,
      bookingId: IDS.bookingId,
      actorUserId: IDS.actorUserId,
      idempotencyKey: 'return-key',
    };
    const first = normalizeReturnMaintenanceInput({
      bookingItemId: IDS.bookingItemId,
      durationMinutes: RETURN_MAINTENANCE_MIN_DURATION_MINUTES,
      sourceDamageReportId: null,
    });
    const second = normalizeReturnMaintenanceInput({
      bookingItemId: IDS.bookingItemId,
      durationMinutes: RETURN_MAINTENANCE_MIN_DURATION_MINUTES + 1,
      sourceDamageReportId: null,
    });

    expect(computeReturnBookingFingerprint(base, first)).toBe(
      computeReturnBookingFingerprint(base, first),
    );
    expect(computeReturnBookingFingerprint(base, first)).not.toBe(
      computeReturnBookingFingerprint(base, second),
    );
  });
});
