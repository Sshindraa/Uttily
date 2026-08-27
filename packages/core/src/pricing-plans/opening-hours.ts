/**
 * @uttily/core — Module Pricing Plans (G7P-B1 / Chantier 15.1 / Chantier 15.2).
 *
 * Validation des horaires d'ouverture et des exceptions de calendrier.
 */

import type { LocationScheduleExceptionRecord } from '../identity/types';
import {
  isTimeWithinEffectiveSchedule,
  resolveEffectiveScheduleFromRules,
} from '../identity/schedule';
import type { DayRangeBoundaries, OpeningHour, ResolvedFlexiblePricingIntent } from './types';
import { FlexiblePricingError } from './errors';
import { civilDayNumber, getTimeInMinutes, minutesBetween, toLocalParts } from './time-utils';

/**
 * Valide les bornes effectives de retrait et de retour d'un plan DAILY (DAY_RANGE)
 * contre le planning effectif de l'établissement (horaires hebdomadaires + exceptions de calendrier).
 *
 * @throws FlexiblePricingError('LOCATION_CLOSED') si l'établissement est fermé le 1er ou dernier jour.
 * @throws FlexiblePricingError('OUTSIDE_OPENING_HOURS') si l'heure de retrait ou de retour tombe hors créneau effectif.
 */
export function validateDayRangeBoundariesAgainstSchedule(
  boundaries: DayRangeBoundaries,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[] = [],
  locationId: string = '',
): void {
  if (openingHours.length === 0 && scheduleExceptions.length === 0) {
    // Pas d'horaires configurés ni d'exceptions → fail-open
    return;
  }

  // 1. Premier jour (retrait)
  const firstSchedule = resolveEffectiveScheduleFromRules(
    boundaries.firstDay.localDate,
    openingHours,
    scheduleExceptions,
    locationId,
  );

  if (!firstSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le premier jour de la location (${boundaries.firstDay.localDate}).`,
    );
  }

  if (firstSchedule.slots.length > 0) {
    if (!isTimeWithinEffectiveSchedule(boundaries.firstDay.startTime, firstSchedule)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `L'heure de retrait (${boundaries.firstDay.startTime}) n'est pas dans les horaires d'ouverture effectifs du jour de début (${boundaries.firstDay.localDate})`,
      );
    }
  }

  // 2. Dernier jour inclus (retour)
  const lastSchedule = resolveEffectiveScheduleFromRules(
    boundaries.lastDay.localDate,
    openingHours,
    scheduleExceptions,
    locationId,
  );

  if (!lastSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le dernier jour de la location (${boundaries.lastDay.localDate}).`,
    );
  }

  if (lastSchedule.slots.length > 0) {
    if (!isTimeWithinEffectiveSchedule(boundaries.lastDay.endTime, lastSchedule)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `L'heure de retour (${boundaries.lastDay.endTime}) n'est pas dans les horaires d'ouverture effectifs du jour de fin (${boundaries.lastDay.localDate})`,
      );
    }
  }
}

/**
 * Vérifie que la période demandée tombe dans les horaires d'ouverture effectifs
 * (horaires hebdomadaires + exceptions de calendrier CLOSED / OPEN_INTERVAL).
 *
 * @throws FlexiblePricingError('LOCATION_CLOSED') si l'établissement est fermé.
 * @throws FlexiblePricingError('OUTSIDE_OPENING_HOURS') si la période est hors créneaux.
 */
export function isWithinOpeningHours(
  intent: ResolvedFlexiblePricingIntent,
  timeZone: string,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[] = [],
): void {
  if (openingHours.length === 0 && scheduleExceptions.length === 0) {
    // Pas d'horaires configurés ni d'exceptions → fail-open
    return;
  }

  if (intent.kind === 'TIME_RANGE') {
    assertTimeRangeOpeningHours(
      intent.startAt,
      intent.endAt,
      timeZone,
      openingHours,
      scheduleExceptions,
    );
  } else {
    assertDayRangeOpeningHours(
      intent.startDate,
      intent.endDateExclusive,
      openingHours,
      scheduleExceptions,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME_RANGE
// ─────────────────────────────────────────────────────────────────────────────

function assertTimeRangeOpeningHours(
  startAt: Date,
  endAt: Date,
  timeZone: string,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[] = [],
): void {
  const durationMin = minutesBetween(startAt, endAt);
  const startParts = toLocalParts(startAt, timeZone);
  const endParts = toLocalParts(endAt, timeZone);

  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);

  const startDateStr = formatDateParts(startParts.year, startParts.month, startParts.day);
  const endDateStr = formatDateParts(endParts.year, endParts.month, endParts.day);

  const startTimeMin = startParts.hour * 60 + startParts.minute;
  const endTimeMin = endParts.hour * 60 + endParts.minute;

  // 1. Résoudre le planning effectif du jour de début
  const startSchedule = resolveEffectiveScheduleFromRules(
    startDateStr,
    openingHours,
    scheduleExceptions,
  );
  if (!startSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le ${startDateStr} (début de réservation).`,
    );
  }

  // Même jour civil
  if (startDayNum === endDayNum) {
    if (startSchedule.slots.length > 0) {
      if (!isTimeRangeCoveredBySlots(startTimeMin, endTimeMin, startSchedule.slots)) {
        throw new FlexiblePricingError(
          'OUTSIDE_OPENING_HOURS',
          `La plage horaire (${startParts.hour}:${String(startParts.minute).padStart(2, '0')}-${endParts.hour}:${String(endParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du ${startDateStr}`,
        );
      }
    }
    return;
  }

  // Multi-jours : vérifier heure de départ dans les horaires d'ouverture du premier jour
  if (startSchedule.slots.length > 0) {
    if (!isTimeCoveredBySlots(startTimeMin, startSchedule.slots)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `L'heure de début (${startParts.hour}:${String(startParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour de départ (${startDateStr})`,
      );
    }
  }

  // Vérifier heure de fin dans les horaires d'ouverture du jour d'arrivée
  const endSchedule = resolveEffectiveScheduleFromRules(
    endDateStr,
    openingHours,
    scheduleExceptions,
  );
  if (!endSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le ${endDateStr} (fin de réservation).`,
    );
  }

  if (endSchedule.slots.length > 0) {
    if (!isTimeCoveredBySlots(endTimeMin, endSchedule.slots)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `L'heure de fin (${endParts.hour}:${String(endParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour d'arrivée (${endDateStr})`,
      );
    }
  }

  // Note (Chantier 15.2) : Les jours intermédiaires ne contraignent pas la location (fermeture magasin intermédiaire autorisée pendant la possession du vélo).
  void durationMin;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY_RANGE
// ─────────────────────────────────────────────────────────────────────────────

function assertDayRangeOpeningHours(
  startDate: string,
  endDateExclusive: string,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[] = [],
): void {
  const startParts = parseDateString(startDate);
  const endParts = parseDateString(endDateExclusive);
  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);
  const lastIncludedDayNum = endDayNum - 1;

  // Vérifier le premier jour
  const startSchedule = resolveEffectiveScheduleFromRules(
    startDate,
    openingHours,
    scheduleExceptions,
  );
  if (!startSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le premier jour de la location (${startDate}).`,
    );
  }

  // Vérifier le dernier jour inclus
  if (lastIncludedDayNum > startDayNum) {
    const lastDateStr = dateStringFromDayNum(lastIncludedDayNum);
    const lastSchedule = resolveEffectiveScheduleFromRules(
      lastDateStr,
      openingHours,
      scheduleExceptions,
    );
    if (!lastSchedule.isOpen) {
      throw new FlexiblePricingError(
        'LOCATION_CLOSED',
        `L’établissement est fermé le dernier jour de la location (${lastDateStr}).`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de vérification de créneaux
// ─────────────────────────────────────────────────────────────────────────────

function isTimeCoveredBySlots(
  timeMin: number,
  slots: Array<{ openTime: string; closeTime: string }>,
): boolean {
  for (const slot of slots) {
    const openMin = getTimeInMinutes(slot.openTime);
    const closeMin = getTimeInMinutes(slot.closeTime);
    if (timeMin >= openMin && timeMin <= closeMin) {
      return true;
    }
  }
  return false;
}

function isTimeRangeCoveredBySlots(
  startTimeMin: number,
  endTimeMin: number,
  slots: Array<{ openTime: string; closeTime: string }>,
): boolean {
  for (const slot of slots) {
    const openMin = getTimeInMinutes(slot.openTime);
    const closeMin = getTimeInMinutes(slot.closeTime);
    if (startTimeMin >= openMin && endTimeMin <= closeMin) {
      return true;
    }
  }
  return false;
}

function parseDateString(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new FlexiblePricingError(
      'VALIDATION',
      `parseDateString: format invalide (attendu YYYY-MM-DD, reçu ${dateStr})`,
    );
  }
  return {
    year: parseInt(match[1]!, 10),
    month: parseInt(match[2]!, 10),
    day: parseInt(match[3]!, 10),
  };
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateStringFromDayNum(dayNum: number): string {
  // Conversion inverse civilDayNumber vers YYYY-MM-DD
  const a = dayNum + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return formatDateParts(year, month, day);
}
