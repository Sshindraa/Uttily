import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  getWeekdayFromLocalDate,
  isTimeWithinEffectiveSchedule,
  resolveEffectiveLocationSchedule,
  type EffectiveLocationSchedule,
} from './schedule';

describe('schedule authority — getWeekdayFromLocalDate', () => {
  it('calcule correctement les jours de la semaine (0 = Lundi, 6 = Dimanche)', () => {
    expect(getWeekdayFromLocalDate('2026-08-24')).toBe(0); // Lundi
    expect(getWeekdayFromLocalDate('2026-08-25')).toBe(1); // Mardi
    expect(getWeekdayFromLocalDate('2026-08-26')).toBe(2); // Mercredi
    expect(getWeekdayFromLocalDate('2026-08-27')).toBe(3); // Jeudi
    expect(getWeekdayFromLocalDate('2026-08-28')).toBe(4); // Vendredi
    expect(getWeekdayFromLocalDate('2026-08-29')).toBe(5); // Samedi
    expect(getWeekdayFromLocalDate('2026-08-30')).toBe(6); // Dimanche
  });

  it('rejette un format de date invalide', () => {
    expect(() => getWeekdayFromLocalDate('invalid-date')).toThrow();
  });
});

describe('schedule authority — isTimeWithinEffectiveSchedule', () => {
  const openSchedule: EffectiveLocationSchedule = {
    locationId: 'loc-1',
    localDate: '2026-08-28',
    isOpen: true,
    isException: false,
    slots: [
      { openTime: '09:00:00', closeTime: '12:00:00' },
      { openTime: '14:00:00', closeTime: '18:00:00' },
    ],
  };

  const closedSchedule: EffectiveLocationSchedule = {
    locationId: 'loc-1',
    localDate: '2026-08-28',
    isOpen: false,
    isException: true,
    exceptionKind: 'CLOSED',
    slots: [],
  };

  it('retourne false si l’établissement est fermé', () => {
    expect(isTimeWithinEffectiveSchedule('10:00:00', closedSchedule)).toBe(false);
  });

  it('accepte les horaires dans les créneaux et sur les bornes exactes', () => {
    expect(isTimeWithinEffectiveSchedule('09:00:00', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('10:30:00', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('12:00:00', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('14:00:00', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('18:00:00', openSchedule)).toBe(true);
  });

  it('gère le format HH:MM sans secondes', () => {
    expect(isTimeWithinEffectiveSchedule('09:00', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('10:30', openSchedule)).toBe(true);
    expect(isTimeWithinEffectiveSchedule('13:00', openSchedule)).toBe(false);
  });

  it('refuse les horaires en dehors des créneaux', () => {
    expect(isTimeWithinEffectiveSchedule('08:59:59', openSchedule)).toBe(false);
    expect(isTimeWithinEffectiveSchedule('12:30:00', openSchedule)).toBe(false);
    expect(isTimeWithinEffectiveSchedule('18:00:01', openSchedule)).toBe(false);
    expect(isTimeWithinEffectiveSchedule('20:00:00', openSchedule)).toBe(false);
  });
});

describe('schedule authority — resolveEffectiveLocationSchedule with DB', () => {
  it('rejette les formats de date invalides', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      resolveEffectiveLocationSchedule(fakeDb, 'org-1', 'loc-1', '28/08/2026'),
    ).rejects.toThrow('Format de date invalide');
  });
});
