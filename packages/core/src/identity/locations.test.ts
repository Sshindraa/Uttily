import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  validateLocationCoordinates,
  validateLocationForPublication,
  validateOpeningHours,
} from './locations';

describe('openingHours validation', () => {
  it('accepte des créneaux valides', () => {
    expect(() =>
      validateOpeningHours([
        { weekday: 0, openTime: '09:00:00', closeTime: '12:00:00' },
        { weekday: 0, openTime: '14:00:00', closeTime: '18:00:00' },
      ]),
    ).not.toThrow();
  });

  it('rejette open_time >= close_time', () => {
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '12:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '18:00:00', closeTime: '09:00:00' }]),
    ).toThrow();
  });

  it('rejette un format horaire qui ne serait pas accepté par PostgreSQL', () => {
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '25:00:00', closeTime: '26:00:00' }]),
    ).toThrow(/format/);
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '09:00', closeTime: '18:00' }]),
    ).toThrow(/format/);
  });

  it('rejette un weekday hors 0-6', () => {
    expect(() =>
      validateOpeningHours([{ weekday: 7, openTime: '09:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
    expect(() =>
      validateOpeningHours([{ weekday: -1, openTime: '09:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
  });
});

describe('location publication validation', () => {
  const completeLocation = {
    addressLine1: '10 rue de la République',
    city: 'Lyon',
    countryCode: 'FR',
    coordinates: { latitude: 45.764, longitude: 4.8357 },
    pickupEnabled: true,
    isPubliclyListed: true,
    openingHours: [{ weekday: 0, openTime: '09:00:00', closeTime: '18:00:00' }],
  };

  it('accepte un établissement complet', () => {
    expect(() => validateLocationForPublication(completeLocation)).not.toThrow();
  });

  it('refuse la publication sans coordonnées, retrait ou horaires', () => {
    expect(() =>
      validateLocationForPublication({ ...completeLocation, coordinates: null }),
    ).toThrow(/coordonnées/);
    expect(() =>
      validateLocationForPublication({ ...completeLocation, pickupEnabled: false }),
    ).toThrow(/retrait/);
    expect(() => validateLocationForPublication({ ...completeLocation, openingHours: [] })).toThrow(
      /horaire/,
    );
  });

  it('refuse les coordonnées hors limites', () => {
    expect(() => validateLocationCoordinates({ latitude: 91, longitude: 4 })).toThrow();
    expect(() => validateLocationCoordinates({ latitude: 45, longitude: 181 })).toThrow();
    expect(() => validateLocationCoordinates({ latitude: Number.NaN, longitude: 4 })).toThrow();
  });

  describe('schedule exceptions validation', () => {
    it('upsertLocationScheduleException rejette un format de date invalide', async () => {
      const { upsertLocationScheduleException } = await import('./locations');
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        upsertLocationScheduleException(fakeDb, {
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '25/12/2026', // format invalide
          kind: 'CLOSED',
        }),
      ).rejects.toThrow('Format de date invalide');
    });

    it('upsertLocationScheduleException OPEN_INTERVAL requiert openTime et closeTime valides', async () => {
      const { upsertLocationScheduleException } = await import('./locations');
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        upsertLocationScheduleException(fakeDb, {
          organizationId: 'org-1',
          locationId: 'loc-1',
          localDate: '2026-12-25',
          kind: 'OPEN_INTERVAL',
          openTime: '18:00:00',
          closeTime: '09:00:00', // open >= close
        }),
      ).rejects.toThrow('L’horaire d’ouverture doit être antérieur');
    });
  });
});
