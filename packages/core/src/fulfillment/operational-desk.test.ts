import { describe, expect, it } from 'vitest';
import { classifyOperationalDeskBooking, getOperationalLocalCivilDate } from './operational-desk';

const TIME_ZONE = 'Europe/Paris';

function booking(
  status: 'CONFIRMED' | 'READY_FOR_PICKUP' | 'ACTIVE',
  startAt: string,
  endAt: string,
) {
  return {
    status,
    customerStartAt: new Date(startAt),
    customerEndAt: new Date(endAt),
    locationTimeZone: TIME_ZONE,
  } as const;
}

describe('cockpit opérationnel quotidien', () => {
  const now = new Date('2026-08-12T10:00:00.000Z');
  const targetDate = '2026-08-12';

  it('classe chaque réservation dans un seul bucket selon la priorité métier', () => {
    expect(
      classifyOperationalDeskBooking(
        booking('READY_FOR_PICKUP', '2026-08-12T08:00:00Z', '2026-08-12T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBe('PICKUPS_TODAY');

    expect(
      classifyOperationalDeskBooking(
        booking('ACTIVE', '2026-08-01T08:00:00Z', '2026-08-11T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBe('OVERDUE');

    expect(
      classifyOperationalDeskBooking(
        booking('ACTIVE', '2026-08-11T08:00:00Z', '2026-08-12T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBe('RETURNS_TODAY');

    expect(
      classifyOperationalDeskBooking(
        booking('ACTIVE', '2026-08-11T08:00:00Z', '2026-08-13T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBe('ONGOING');

    expect(
      classifyOperationalDeskBooking(
        booking('ACTIVE', '2026-08-14T08:00:00Z', '2026-08-15T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBeNull();
  });

  it('évalue OVERDUE sur now absolu, indépendamment de la date sélectionnée', () => {
    const result = classifyOperationalDeskBooking(
      booking('ACTIVE', '2026-08-01T08:00:00Z', '2026-08-12T08:30:00Z'),
      '2026-08-20',
      new Date('2026-08-12T08:30:00.001Z'),
    );
    expect(result).toBe('OVERDUE');

    const exactlyAtEnd = classifyOperationalDeskBooking(
      booking('ACTIVE', '2026-08-11T08:00:00Z', '2026-08-12T10:00:00Z'),
      targetDate,
      new Date('2026-08-12T10:00:00.000Z'),
    );
    expect(exactlyAtEnd).toBe('RETURNS_TODAY');
  });

  it('remonte aussi un départ non traité dont la date est déjà dépassée', () => {
    expect(
      classifyOperationalDeskBooking(
        booking('CONFIRMED', '2026-08-11T08:00:00Z', '2026-08-12T16:00:00Z'),
        targetDate,
        now,
      ),
    ).toBe('PICKUPS_TODAY');
  });

  it('ne déplace pas un ancien départ vers une date future sélectionnée', () => {
    expect(
      classifyOperationalDeskBooking(
        booking('CONFIRMED', '2026-08-11T08:00:00Z', '2026-08-12T16:00:00Z'),
        '2026-08-13',
        now,
      ),
    ).toBeNull();
  });

  it('calcule la date civile sans division par 24 heures lors des DST', () => {
    expect(getOperationalLocalCivilDate(new Date('2026-03-29T23:30:00Z'), TIME_ZONE)).toBe(
      '2026-03-30',
    );
    expect(getOperationalLocalCivilDate(new Date('2026-10-25T23:30:00Z'), TIME_ZONE)).toBe(
      '2026-10-26',
    );
  });
});
