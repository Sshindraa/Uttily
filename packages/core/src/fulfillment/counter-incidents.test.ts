import { describe, expect, it } from 'vitest';
import { computeCounterIncidentFingerprint } from './counter-incidents-fingerprint';
import {
  isBookingNoShowEligible,
  isNoShowEligibleStatus,
  isSubstitutionEligibleStatus,
  isUsableSubstitutionCondition,
} from './counter-incidents-types';

const START = new Date('2026-09-03T10:00:00.000Z');

describe('21-U2-AA — règles pures des incidents de comptoir', () => {
  it('autorise le no-show à l’instant du départ et après, uniquement pour CONFIRMED/READY', () => {
    expect(isBookingNoShowEligible('CONFIRMED', START, START)).toBe(true);
    expect(
      isBookingNoShowEligible('READY_FOR_PICKUP', START, new Date('2026-09-03T10:01:00Z')),
    ).toBe(true);
    expect(isBookingNoShowEligible('CONFIRMED', START, new Date('2026-09-03T09:59:59.999Z'))).toBe(
      false,
    );
    expect(isBookingNoShowEligible('ACTIVE', START, START)).toBe(false);
  });

  it('conserve des gardes fermées pour les statuts et les conditions utilisables', () => {
    expect(isNoShowEligibleStatus('CONFIRMED')).toBe(true);
    expect(isNoShowEligibleStatus('READY_FOR_PICKUP')).toBe(true);
    expect(isNoShowEligibleStatus('CANCELLED')).toBe(false);
    expect(isSubstitutionEligibleStatus('CONFIRMED')).toBe(true);
    expect(isSubstitutionEligibleStatus('ACTIVE')).toBe(false);
    expect(isUsableSubstitutionCondition('NEW')).toBe(true);
    expect(isUsableSubstitutionCondition('GOOD')).toBe(true);
    expect(isUsableSubstitutionCondition('FAIR')).toBe(true);
    expect(isUsableSubstitutionCondition('POOR')).toBe(false);
    expect(isUsableSubstitutionCondition('BROKEN')).toBe(false);
  });

  it('produit une empreinte idempotente sensible aux paramètres métier', () => {
    const base = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      bookingId: '00000000-0000-4000-8000-000000000002',
      actorUserId: '00000000-0000-4000-8000-000000000003',
      operation: 'record_booking_no_show',
      reason: 'Client absent',
    };
    expect(computeCounterIncidentFingerprint(base)).toBe(
      computeCounterIncidentFingerprint({ ...base }),
    );
    expect(
      computeCounterIncidentFingerprint({ ...base, reason: 'Client absent après appel' }),
    ).not.toBe(computeCounterIncidentFingerprint(base));
    expect(
      computeCounterIncidentFingerprint({
        ...base,
        operation: 'substitute_booking_item',
        bookingItemId: '00000000-0000-4000-8000-000000000004',
        replacementInventoryItemId: '00000000-0000-4000-8000-000000000005',
        reason: null,
      }),
    ).not.toBe(computeCounterIncidentFingerprint(base));
  });
});
