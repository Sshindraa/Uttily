import { describe, expect, it } from 'vitest';
import { parseLocationFormData, toTimeInputValue } from './location-form';

describe('location form parsing', () => {
  it('parse une fiche complète avec plusieurs créneaux', () => {
    const formData = new FormData();
    formData.set('name', 'Lyon République');
    formData.set('timeZone', 'Europe/Paris');
    formData.set('addressLine1', '10 rue de la République');
    formData.set('addressLine2', 'Bâtiment A');
    formData.set('city', 'Lyon');
    formData.set('postalCode', '69001');
    formData.set('countryCode', 'fr');
    formData.set('latitude', '45.764');
    formData.set('longitude', '4.8357');
    formData.set('pickupEnabled', 'on');
    formData.set('isPubliclyListed', 'on');
    formData.set('openDay-0', 'on');
    formData.set('openTime-0-0', '09:00');
    formData.set('closeTime-0-0', '12:00');
    formData.set('openTime-0-1', '14:00');
    formData.set('closeTime-0-1', '18:00');

    expect(parseLocationFormData(formData)).toEqual({
      name: 'Lyon République',
      timeZone: 'Europe/Paris',
      addressLine1: '10 rue de la République',
      addressLine2: 'Bâtiment A',
      city: 'Lyon',
      postalCode: '69001',
      countryCode: 'fr',
      coordinates: { latitude: 45.764, longitude: 4.8357 },
      pickupEnabled: true,
      isPubliclyListed: true,
      openingHours: [
        { weekday: 0, openTime: '09:00:00', closeTime: '12:00:00' },
        { weekday: 0, openTime: '14:00:00', closeTime: '18:00:00' },
      ],
    });
  });

  it('refuse une seule coordonnée ou un créneau incomplet', () => {
    const coordinates = new FormData();
    coordinates.set('latitude', '45.764');
    expect(() => parseLocationFormData(coordinates)).toThrow(/ensemble/);

    const hours = new FormData();
    hours.set('openDay-0', 'on');
    hours.set('openTime-0-0', '09:00');
    expect(() => parseLocationFormData(hours)).toThrow(/deux heures/);
  });

  it('convertit les horaires stockés en valeur HTML time', () => {
    expect(toTimeInputValue('09:00:00')).toBe('09:00');
    expect(toTimeInputValue(undefined)).toBe('');
  });
});
