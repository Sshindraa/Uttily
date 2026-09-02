import { describe, expect, it } from 'vitest';
import {
  calculateWeeklyRecurringManualBlockOccurrences,
  MAX_RECURRING_MANUAL_BLOCK_DAYS,
  normalizeRecurringManualBlockSchedule,
} from './recurring-manual-block';

const base = {
  frequency: 'WEEKLY',
  startDate: '2026-01-05',
  endDate: '2026-01-26',
  startTime: '10:00',
  endTime: '12:00',
  timeZone: 'Europe/Paris',
} as const;

describe('blocages manuels récurrents — calendrier hebdomadaire', () => {
  it('calcule les occurrences inclusives sur le même jour civil', () => {
    const occurrences = calculateWeeklyRecurringManualBlockOccurrences(base);

    expect(occurrences.map((occurrence) => occurrence.occurrenceDate)).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
      '2026-01-26',
    ]);
    expect(occurrences[0]!.startAt.toISOString()).toBe('2026-01-05T09:00:00.000Z');
    expect(occurrences[0]!.endAt.toISOString()).toBe('2026-01-05T11:00:00.000Z');
  });

  it('recalcule le décalage local à chaque occurrence autour du DST', () => {
    const occurrences = calculateWeeklyRecurringManualBlockOccurrences({
      ...base,
      startDate: '2026-03-02',
      endDate: '2026-03-30',
    });

    expect(occurrences[4]!.startAt.toISOString()).toBe('2026-03-30T08:00:00.000Z');
    expect(occurrences[4]!.endAt.toISOString()).toBe('2026-03-30T10:00:00.000Z');
  });

  it('accepte exactement la borne de douze semaines et rejette au-delà', () => {
    expect(() =>
      normalizeRecurringManualBlockSchedule({
        ...base,
        endDate: '2026-03-30',
      }),
    ).not.toThrow();
    expect(() =>
      normalizeRecurringManualBlockSchedule({
        ...base,
        endDate: '2026-03-31',
      }),
    ).toThrow(/12 semaines/);
    expect(MAX_RECURRING_MANUAL_BLOCK_DAYS).toBe(84);
  });

  it('refuse les bornes, la périodicité et les heures invalides', () => {
    expect(() => normalizeRecurringManualBlockSchedule({ ...base, frequency: 'MONTHLY' })).toThrow(
      /hebdomadaire/,
    );
    expect(() => normalizeRecurringManualBlockSchedule({ ...base, endDate: '2026-01-04' })).toThrow(
      /date de fin/,
    );
    expect(() => normalizeRecurringManualBlockSchedule({ ...base, endTime: '09:00' })).toThrow(
      /heure de fin/,
    );
    expect(() =>
      normalizeRecurringManualBlockSchedule({ ...base, startDate: '2026-02-30' }),
    ).toThrow(/invalide/);
  });

  it('rejette les horaires inexistants et ambigus lors des changements DST', () => {
    expect(() =>
      calculateWeeklyRecurringManualBlockOccurrences({
        ...base,
        startDate: '2026-03-29',
        endDate: '2026-03-29',
        startTime: '02:30',
        endTime: '04:00',
      }),
    ).toThrow(/n'existe pas/);

    expect(() =>
      calculateWeeklyRecurringManualBlockOccurrences({
        ...base,
        startDate: '2026-10-25',
        endDate: '2026-10-25',
        startTime: '02:30',
        endTime: '04:00',
      }),
    ).toThrow(/ambiguë/);
  });
});
