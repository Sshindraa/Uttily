import { describe, it, expect } from 'vitest';
import { isWithinOpeningHours, validateDayRangeBoundariesAgainstSchedule } from './opening-hours';
import type { OpeningHour, ResolvedFlexiblePricingIntent } from './types';
import type { LocationScheduleExceptionRecord } from '../identity/types';

describe('opening-hours & schedule exceptions validation', () => {
  const weeklyHours: OpeningHour[] = [
    { weekday: 0, openTime: '09:00:00', closeTime: '18:00:00' }, // Lundi
    { weekday: 1, openTime: '09:00:00', closeTime: '18:00:00' }, // Mardi
    { weekday: 2, openTime: '09:00:00', closeTime: '18:00:00' }, // Mercredi
    { weekday: 3, openTime: '09:00:00', closeTime: '18:00:00' }, // Jeudi
    { weekday: 4, openTime: '09:00:00', closeTime: '18:00:00' }, // Vendredi
  ];

  describe('TIME_RANGE avec horaires hebdomadaires', () => {
    it('accepte une réservation dans les horaires (ex: Vendredi 10:00 - 16:00)', () => {
      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-28T08:00:00Z'), // 10:00 Paris (UTC+2)
        endAt: new Date('2026-08-28T14:00:00Z'), // 16:00 Paris (UTC+2)
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, []),
      ).not.toThrow();
    });

    it('rejette une réservation commençant avant l’ouverture (ex: 08:00 Paris)', () => {
      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-28T06:00:00Z'), // 08:00 Paris
        endAt: new Date('2026-08-28T10:00:00Z'), // 12:00 Paris
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, []),
      ).toThrow(expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }));
    });

    it('rejette une réservation un jour sans horaires hebdomadaires (ex: Samedi 29/08)', () => {
      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-29T08:00:00Z'), // Samedi 10:00 Paris
        endAt: new Date('2026-08-29T14:00:00Z'), // Samedi 16:00 Paris
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, []),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });
  });

  describe('TIME_RANGE avec exceptions de calendrier et multi-jours (Chantier 15.2)', () => {
    it('rejette avec LOCATION_CLOSED si une exception CLOSED est posée sur la date de retrait', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-1',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-28',
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Fermeture exceptionnelle pont',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-28T08:00:00Z'), // 10:00 Paris
        endAt: new Date('2026-08-28T14:00:00Z'), // 16:00 Paris
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });

    it('applique un OPEN_INTERVAL restreint qui remplace les horaires normaux (11h-15h : 10h refusé, 12h accepté)', () => {
      // Normalement 09:00 - 18:00 le vendredi, mais exception 11:00 - 15:00
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-2',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-28',
          kind: 'OPEN_INTERVAL',
          openTime: '11:00:00',
          closeTime: '15:00:00',
          reason: 'Horaires réduits',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // 09:30 - 11:30 Paris -> commence à 09:30 (avant 11:00) -> OUTSIDE_OPENING_HOURS
      const earlyIntent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-28T07:30:00Z'), // 09:30 Paris
        endAt: new Date('2026-08-28T09:30:00Z'), // 11:30 Paris
      };
      expect(() =>
        isWithinOpeningHours(earlyIntent, 'Europe/Paris', weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }));

      // 12:00 - 14:00 Paris -> dans l'intervalle 11:00 - 15:00 -> accepté
      const validIntent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-28T10:00:00Z'), // 12:00 Paris
        endAt: new Date('2026-08-28T12:00:00Z'), // 14:00 Paris
      };
      expect(() =>
        isWithinOpeningHours(validIntent, 'Europe/Paris', weeklyHours, exceptions),
      ).not.toThrow();
    });

    it('accepte une location multi-jours (Lundi 10h -> Mercredi 17h) même si le magasin est fermé le Mardi (Chantier 15.2)', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-3',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-25', // Mardi fermé
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Inventaire annuel',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // Du Lundi 24/08 10:00 Paris au Mercredi 26/08 17:00 Paris
      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-24T08:00:00Z'), // Lundi 10:00 Paris
        endAt: new Date('2026-08-26T15:00:00Z'), // Mercredi 17:00 Paris
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, exceptions),
      ).not.toThrow();
    });

    it('rejette une location multi-jours si le jour de retour est fermé par exception', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-3b',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-26', // Mercredi fermé
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Fermeture exceptionnelle',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: new Date('2026-08-24T08:00:00Z'), // Lundi 10:00 Paris
        endAt: new Date('2026-08-26T15:00:00Z'), // Mercredi 17:00 Paris
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });
  });

  describe('DAY_RANGE avec exceptions de calendrier', () => {
    it('rejette avec LOCATION_CLOSED si le premier jour est fermé par exception', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-4',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-24', // Lundi
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'DAY_RANGE',
        startDate: '2026-08-24',
        endDateExclusive: '2026-08-28',
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });

    it('rejette avec LOCATION_CLOSED si le dernier jour inclus est fermé par exception', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-5',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-27', // Jeudi (dernier jour inclus pour fin 2026-08-28 exclusive)
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'DAY_RANGE',
        startDate: '2026-08-24',
        endDateExclusive: '2026-08-28',
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });

    it('accepte une location DAY_RANGE si tous les jours sont ouverts', () => {
      const intent: ResolvedFlexiblePricingIntent = {
        kind: 'DAY_RANGE',
        startDate: '2026-08-24',
        endDateExclusive: '2026-08-28',
      };

      expect(() =>
        isWithinOpeningHours(intent, 'Europe/Paris', weeklyHours, []),
      ).not.toThrow();
    });
  });

  describe('validateDayRangeBoundariesAgainstSchedule (Chantier 15.2.1)', () => {
    const standardBoundaries = {
      kind: 'DAY_RANGE_BOUNDARIES' as const,
      firstDay: {
        localDate: '2026-08-24', // Lundi
        weekdayMask: 1,
        startTime: '09:00:00',
        endTime: '18:00:00',
      },
      lastDay: {
        localDate: '2026-08-27', // Jeudi (4 jours: lun, mar, mer, jeu)
        weekdayMask: 8,
        startTime: '09:00:00',
        endTime: '18:00:00',
      },
    };

    it('accepte des bornes régulières dans les horaires hebdomadaires', () => {
      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, []),
      ).not.toThrow();
    });

    it('rejette avec LOCATION_CLOSED si le premier jour a une exception CLOSED', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-close-1',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-24',
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Fermeture exceptionnelle',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });

    it('rejette avec LOCATION_CLOSED si le dernier jour a une exception CLOSED', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-close-last',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-27',
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Fermeture exceptionnelle',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'LOCATION_CLOSED' }));
    });

    it('rejette avec OUTSIDE_OPENING_HOURS si firstDay.startTime est hors de l’OPEN_INTERVAL effectif (ex: 09h quand ouvert 12h-15h)', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-interval-start',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-24',
          kind: 'OPEN_INTERVAL',
          openTime: '12:00:00',
          closeTime: '15:00:00',
          reason: 'Ouverture partielle',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // standardBoundaries.firstDay.startTime = '09:00:00' -> hors de 12h-15h -> rejet
      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }));
    });

    it('rejette avec OUTSIDE_OPENING_HOURS si lastDay.endTime est hors de l’OPEN_INTERVAL effectif (ex: 18h quand ouvert 09h-16h)', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-interval-end',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-27',
          kind: 'OPEN_INTERVAL',
          openTime: '09:00:00',
          closeTime: '16:00:00',
          reason: 'Fermeture anticipée',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // standardBoundaries.lastDay.endTime = '18:00:00' -> hors de 09h-16h -> rejet
      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).toThrow(expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }));
    });

    it('accepte si firstDay.startTime et lastDay.endTime sont compatibles avec les OPEN_INTERVAL effectifs', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-interval-wide-1',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-24',
          kind: 'OPEN_INTERVAL',
          openTime: '08:00:00',
          closeTime: '19:00:00',
          reason: 'Horaires étendus',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'ex-interval-wide-2',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-27',
          kind: 'OPEN_INTERVAL',
          openTime: '08:00:00',
          closeTime: '19:00:00',
          reason: 'Horaires étendus',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).not.toThrow();
    });

    it('accepte une location DAY_RANGE même si un jour intermédiaire (ex: Mardi 25/08) est CLOSED', () => {
      const exceptions: LocationScheduleExceptionRecord[] = [
        {
          id: 'ex-mid-closed',
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-08-25', // Mardi fermé
          kind: 'CLOSED',
          openTime: null,
          closeTime: null,
          reason: 'Maintenance boutique',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // Premier jour (24/08) et dernier jour (27/08) sont ouverts
      expect(() =>
        validateDayRangeBoundariesAgainstSchedule(standardBoundaries, weeklyHours, exceptions),
      ).not.toThrow();
    });
  });
});

