import type { LocationCoordinates, OpeningHourInput } from '@uttily/core';

export const LOCATION_WEEKDAYS = [
  { value: 0, label: 'Lundi' },
  { value: 1, label: 'Mardi' },
  { value: 2, label: 'Mercredi' },
  { value: 3, label: 'Jeudi' },
  { value: 4, label: 'Vendredi' },
  { value: 5, label: 'Samedi' },
  { value: 6, label: 'Dimanche' },
] as const;

export const LOCATION_HOUR_SLOTS = 2;

export interface LocationFormValues {
  name: string;
  timeZone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  countryCode: string;
  coordinates: LocationCoordinates | null;
  pickupEnabled: boolean;
  isPubliclyListed: boolean;
  openingHours: OpeningHourInput[];
}

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInputTime(value: string, fieldName: string): string {
  if (/^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  throw new Error(`Horaire invalide : ${fieldName}.`);
}

function parseCoordinates(formData: FormData): LocationCoordinates | null {
  const latitudeText = readText(formData, 'latitude');
  const longitudeText = readText(formData, 'longitude');
  if (latitudeText === '' && longitudeText === '') return null;
  if (latitudeText === '' || longitudeText === '') {
    throw new Error('La latitude et la longitude doivent être renseignées ensemble.');
  }
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Les coordonnées géographiques doivent être numériques.');
  }
  return { latitude, longitude };
}

function parseOpeningHours(formData: FormData): OpeningHourInput[] {
  const openingHours: OpeningHourInput[] = [];
  for (const { value: weekday } of LOCATION_WEEKDAYS) {
    if (formData.get(`openDay-${weekday}`) !== 'on') continue;
    for (let slot = 0; slot < LOCATION_HOUR_SLOTS; slot += 1) {
      const openName = `openTime-${weekday}-${slot}`;
      const closeName = `closeTime-${weekday}-${slot}`;
      const openTime = readText(formData, openName);
      const closeTime = readText(formData, closeName);
      if (openTime === '' && closeTime === '') continue;
      if (openTime === '' || closeTime === '') {
        throw new Error(`Les deux heures sont requises pour ${weekday}, créneau ${slot + 1}.`);
      }
      openingHours.push({
        weekday,
        openTime: normalizeInputTime(openTime, openName),
        closeTime: normalizeInputTime(closeTime, closeName),
      });
    }
  }
  return openingHours;
}

export function parseLocationFormData(formData: FormData): LocationFormValues {
  return {
    name: readText(formData, 'name'),
    timeZone: readText(formData, 'timeZone'),
    addressLine1: readText(formData, 'addressLine1'),
    addressLine2: readText(formData, 'addressLine2'),
    city: readText(formData, 'city'),
    postalCode: readText(formData, 'postalCode'),
    countryCode: readText(formData, 'countryCode'),
    coordinates: parseCoordinates(formData),
    pickupEnabled: formData.get('pickupEnabled') === 'on',
    isPubliclyListed: formData.get('isPubliclyListed') === 'on',
    openingHours: parseOpeningHours(formData),
  };
}

export function toTimeInputValue(value: string | undefined): string {
  return value?.slice(0, 5) ?? '';
}
