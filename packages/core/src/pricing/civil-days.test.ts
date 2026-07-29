import { describe, it, expect } from 'vitest';
import { calculateBillableCivilDays } from './civil-days';
import { PricingError } from './errors';

describe('calculateBillableCivilDays', () => {
  it('période sur une même date civile (10h→18h le 15 juin, Europe/Paris) → 1 jour', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T18:00:00+02:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(1);
  });

  it('franchissement de minuit (10h le 15 juin → 14h le 16 juin, Europe/Paris) → 2 jours', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-16T14:00:00+02:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(2);
  });

  it('fin exactement à minuit local (10h le 15 → 00h00 le 16, Europe/Paris) → 1 jour', () => {
    // 2026-06-16T00:00:00 Europe/Paris = 2026-06-15T22:00:00Z
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T22:00:00Z');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(1);
  });

  it('fin quelques ms après minuit (10h le 15 → 00h00:00.001 le 16, Europe/Paris) → 2 jours', () => {
    // 2026-06-16T00:00:00.001 Europe/Paris = 2026-06-15T22:00:00.001Z
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T22:00:00.001Z');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(2);
  });

  it('passage DST printemps (29 mars 2026, jour à 23h, Europe/Paris) → 1 jour civil', () => {
    // 29 mars 2026 : transition à 2h00 CET → 3h00 CEST (jour à 23h).
    // Start avant la transition (01:30 CET = +01:00), end après (03:30 CEST = +02:00).
    // Même jour civil (29 mars) → 1 jour.
    const start = new Date('2026-03-29T01:30:00+01:00');
    const end = new Date('2026-03-29T03:30:00+02:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(1);
  });

  it('passage DST automne (25 octobre 2026, jour à 25h, Europe/Paris) → 1 jour civil', () => {
    // 25 octobre 2026 : transition à 3h00 CEST → 2h00 CET (jour à 25h).
    // Période de 00:00 à 23:59:59 le même jour civil → 1 jour.
    const start = new Date('2026-10-25T00:00:00+02:00');
    const end = new Date('2026-10-25T23:59:59+01:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(1);
  });

  it("franchissement de fin d'année (31 déc 2026 10h → 2 jan 2027 14h, Europe/Paris) → 3 jours", () => {
    const start = new Date('2026-12-31T10:00:00+01:00');
    const end = new Date('2027-01-02T14:00:00+01:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(3);
  });

  it('période multi-mois (15 juin → 20 août 2026, Europe/Paris) → 67 jours', () => {
    // 15 juin au 20 août inclus = 67 jours (juin: 16 jours, juillet: 31, août: 20 = 67)
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-08-20T14:00:00+02:00');
    expect(calculateBillableCivilDays(start, end, 'Europe/Paris')).toBe(67);
  });

  it('période traversant plusieurs transitions DST (15 mars → 15 nov 2026, Europe/Paris)', () => {
    // Traversée du passage printemps (29 mars) ET automne (25 octobre).
    // 15 mars au 15 novembre inclus.
    const start = new Date('2026-03-15T10:00:00+01:00');
    const end = new Date('2026-11-15T14:00:00+01:00');
    const days = calculateBillableCivilDays(start, end, 'Europe/Paris');
    // Mars: 15→31 = 17 jours, Avril: 30, Mai: 31, Juin: 30, Juillet: 31,
    // Août: 31, Sept: 30, Oct: 31, Nov: 1→15 = 15 jours
    // Total = 17+30+31+30+31+31+30+31+15 = 246
    expect(days).toBe(246);
  });

  it('fuseau UTC (10h→18h le 15 juin) → 1 jour', () => {
    const start = new Date('2026-06-15T10:00:00Z');
    const end = new Date('2026-06-15T18:00:00Z');
    expect(calculateBillableCivilDays(start, end, 'UTC')).toBe(1);
  });

  it('fuseau America/New_York (10h le 15 → 14h le 16) → 2 jours', () => {
    const start = new Date('2026-06-15T10:00:00-04:00');
    const end = new Date('2026-06-16T14:00:00-04:00');
    expect(calculateBillableCivilDays(start, end, 'America/New_York')).toBe(2);
  });

  it('période inversée (end <= start) → PricingError', () => {
    const start = new Date('2026-06-15T18:00:00+02:00');
    const end = new Date('2026-06-15T10:00:00+02:00');
    expect(() => calculateBillableCivilDays(start, end, 'Europe/Paris')).toThrow(PricingError);
    expect(() => calculateBillableCivilDays(start, end, 'Europe/Paris')).toThrow(
      /strictement positive/,
    );
  });

  it('période égale (end == start) → PricingError', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    expect(() => calculateBillableCivilDays(start, start, 'Europe/Paris')).toThrow(PricingError);
  });

  it('fuseau invalide (Foo/Bar) → PricingError', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T18:00:00+02:00');
    expect(() => calculateBillableCivilDays(start, end, 'Foo/Bar')).toThrow(PricingError);
    expect(() => calculateBillableCivilDays(start, end, 'Foo/Bar')).toThrow(/Fuseau IANA invalide/);
  });

  it('fuseau vide (empty string) → PricingError', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T18:00:00+02:00');
    expect(() => calculateBillableCivilDays(start, end, '')).toThrow(PricingError);
  });

  it('dates Invalid Date → PricingError', () => {
    const invalid = new Date('invalid');
    const valid = new Date('2026-06-15T18:00:00+02:00');
    expect(() => calculateBillableCivilDays(invalid, valid, 'Europe/Paris')).toThrow(PricingError);
    expect(() => calculateBillableCivilDays(valid, invalid, 'Europe/Paris')).toThrow(PricingError);
  });

  it('le code d’erreur est VALIDATION pour les erreurs de validation', () => {
    const start = new Date('2026-06-15T10:00:00+02:00');
    const end = new Date('2026-06-15T18:00:00+02:00');
    try {
      calculateBillableCivilDays(start, end, 'Foo/Bar');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PricingError);
      expect((err as PricingError).code).toBe('VALIDATION');
    }
  });
});
