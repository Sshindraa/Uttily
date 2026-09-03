import { describe, expect, it } from 'vitest';
import { isBookingUnreturnedLostEligible, normalizeUnreturnedLostReason } from './unreturned-lost';
import { FulfillmentError } from './fulfillment-errors';

describe('21-U2-AC — non-restitution et clôture de dossier', () => {
  it('exige ACTIVE et une échéance strictement dépassée', () => {
    const end = new Date('2026-08-12T10:00:00.000Z');

    expect(
      isBookingUnreturnedLostEligible('ACTIVE', end, new Date('2026-08-12T10:00:00.000Z')),
    ).toBe(false);
    expect(
      isBookingUnreturnedLostEligible('ACTIVE', end, new Date('2026-08-12T10:00:00.001Z')),
    ).toBe(true);
    expect(
      isBookingUnreturnedLostEligible('RETURNED', end, new Date('2026-08-12T10:00:00.001Z')),
    ).toBe(false);
  });

  it('normalise les circonstances et borne le texte libre', () => {
    expect(normalizeUnreturnedLostReason('  Client injoignable après plusieurs relances  ')).toBe(
      'Client injoignable après plusieurs relances',
    );
    expect(normalizeUnreturnedLostReason('   ')).toBeNull();
    expect(() => normalizeUnreturnedLostReason('x'.repeat(501))).toThrow(FulfillmentError);
  });
});
