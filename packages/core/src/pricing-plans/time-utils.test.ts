import { describe, it, expect } from 'vitest';
import {
  minutesBetween,
  countCivilDays,
  getWeekdayFromDate,
  getTimeInMinutes,
  toLocalParts,
  civilDayNumber,
} from './time-utils';
import { FlexiblePricingError } from './errors';

describe('time-utils', () => {
  describe('minutesBetween', () => {
    it('2 heures → 120 minutes', () => {
      const start = new Date('2026-03-15T09:00:00Z');
      const end = new Date('2026-03-15T11:00:00Z');
      expect(minutesBetween(start, end)).toBe(120);
    });

    it('90 minutes', () => {
      const start = new Date('2026-03-15T09:00:00Z');
      const end = new Date('2026-03-15T10:30:00Z');
      expect(minutesBetween(start, end)).toBe(90);
    });

    it('lance si endAt <= startAt', () => {
      const start = new Date('2026-03-15T09:00:00Z');
      const end = new Date('2026-03-15T09:00:00Z');
      expect(() => minutesBetween(start, end)).toThrow(FlexiblePricingError);
    });

    it('lance si endAt < startAt', () => {
      const start = new Date('2026-03-15T11:00:00Z');
      const end = new Date('2026-03-15T09:00:00Z');
      expect(() => minutesBetween(start, end)).toThrow(FlexiblePricingError);
    });
  });

  describe('countCivilDays', () => {
    it('1 jour (2026-03-15 → 2026-03-16)', () => {
      expect(countCivilDays('2026-03-15', '2026-03-16')).toBe(1);
    });

    it('3 jours (2026-03-15 → 2026-03-18)', () => {
      expect(countCivilDays('2026-03-15', '2026-03-18')).toBe(3);
    });

    it('7 jours (2026-03-15 → 2026-03-22)', () => {
      expect(countCivilDays('2026-03-15', '2026-03-22')).toBe(7);
    });

    it('lance si endDateExclusive <= startDate', () => {
      expect(() => countCivilDays('2026-03-15', '2026-03-15')).toThrow(FlexiblePricingError);
      expect(() => countCivilDays('2026-03-16', '2026-03-15')).toThrow(FlexiblePricingError);
    });
  });

  describe('getWeekdayFromDate', () => {
    it('lundi (2026-03-16 est un lundi en UTC)', () => {
      // 2026-03-16 is a Monday
      const date = new Date('2026-03-16T12:00:00Z');
      expect(getWeekdayFromDate(date, 'UTC')).toBe(0);
    });

    it('dimanche (2026-03-22 est un dimanche en UTC)', () => {
      const date = new Date('2026-03-22T12:00:00Z');
      expect(getWeekdayFromDate(date, 'UTC')).toBe(6);
    });

    it('mercredi (2026-03-18 est un mercredi en UTC)', () => {
      const date = new Date('2026-03-18T12:00:00Z');
      expect(getWeekdayFromDate(date, 'UTC')).toBe(2);
    });
  });

  describe('getTimeInMinutes', () => {
    it('09:00:00 → 540', () => {
      expect(getTimeInMinutes('09:00:00')).toBe(540);
    });

    it('17:00:00 → 1020', () => {
      expect(getTimeInMinutes('17:00:00')).toBe(1020);
    });

    it('00:00:00 → 0', () => {
      expect(getTimeInMinutes('00:00:00')).toBe(0);
    });

    it('format invalide → erreur', () => {
      expect(() => getTimeInMinutes('9:00')).toThrow(FlexiblePricingError);
    });
  });

  describe('DST — Europe/Paris', () => {
    it('spring forward : 30 mars 2025, 9h→17h Paris = 8h réelles (pas 9h)', () => {
      // Europe/Paris spring forward 2025-03-30 at 02:00 → 03:00
      // 09:00 Paris = 07:00 UTC (avant DST) ... wait, après DST: UTC+2
      // 09:00 Paris on 2025-03-30 = 07:00 UTC (CET→CEST transition at 02:00)
      // Actually: before transition (01:59) = UTC+1, after (03:00) = UTC+2
      // 09:00 Paris on 2025-03-30 = 07:00 UTC
      // 17:00 Paris on 2025-03-30 = 15:00 UTC
      // Duration = 15:00 - 07:00 = 8h = 480 min
      const start = new Date('2025-03-30T07:00:00Z'); // 09:00 Paris
      const end = new Date('2025-03-30T15:00:00Z'); // 17:00 Paris
      expect(minutesBetween(start, end)).toBe(480);
    });

    it('fall back : 26 octobre 2025, 9h→17h Paris = 8h réelles', () => {
      // Europe/Paris fall back 2025-10-26 at 03:00 → 02:00
      // Before: UTC+2 (CEST), after: UTC+1 (CET)
      // 09:00 Paris on 2025-10-26 = 08:00 UTC (after transition, UTC+1)
      // 17:00 Paris on 2025-10-26 = 16:00 UTC
      // Duration = 16:00 - 08:00 = 8h = 480 min
      const start = new Date('2025-10-26T08:00:00Z'); // 09:00 Paris
      const end = new Date('2025-10-26T16:00:00Z'); // 17:00 Paris
      expect(minutesBetween(start, end)).toBe(480);
    });

    it('toLocalParts : 2025-03-30 09:00 Paris = 09:00 local après DST', () => {
      const date = new Date('2025-03-30T07:00:00Z');
      const parts = toLocalParts(date, 'Europe/Paris');
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(0);
    });

    it('toLocalParts : 2025-10-26 09:00 Paris = 09:00 local après fall back', () => {
      const date = new Date('2025-10-26T08:00:00Z');
      const parts = toLocalParts(date, 'Europe/Paris');
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(0);
    });
  });

  describe('DST — America/New_York', () => {
    it('spring forward : 9 mars 2025, 9h→17h NY = 8h réelles', () => {
      // America/New_York spring forward 2025-03-09 at 02:00 → 03:00
      // Before: UTC-5 (EST), after: UTC-4 (EDT)
      // 09:00 NY on 2025-03-09 = 13:00 UTC (after transition, UTC-4)
      // 17:00 NY on 2025-03-09 = 21:00 UTC
      // Duration = 21:00 - 13:00 = 8h = 480 min
      const start = new Date('2025-03-09T13:00:00Z'); // 09:00 NY
      const end = new Date('2025-03-09T21:00:00Z'); // 17:00 NY
      expect(minutesBetween(start, end)).toBe(480);
    });
  });

  describe('civilDayNumber', () => {
    it('2000-01-03 (lundi) → JDN mod 7 = 0', () => {
      expect(civilDayNumber(2000, 1, 3) % 7).toBe(0);
    });

    it('2000-01-01 (samedi) → JDN mod 7 = 5', () => {
      expect(civilDayNumber(2000, 1, 1) % 7).toBe(5);
    });
  });
});
