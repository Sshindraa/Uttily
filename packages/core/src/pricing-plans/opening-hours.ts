/**
 * @uttily/core — Module Pricing Plans (G7P-B1 / Chantier 15.1).
 *
 * Validation des horaires d'ouverture et des exceptions de calendrier.
 */

import type { LocationScheduleExceptionRecord } from '../identity/types';
import type { OpeningHour, ResolvedFlexiblePricingIntent } from './types';
import { FlexiblePricingError } from './errors';
import { civilDayNumber, getTimeInMinutes, minutesBetween, toLocalParts } from './time-utils';

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
  scheduleExceptions: LocationScheduleExceptionRecord[],
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

  const startSchedule = resolveScheduleForLocalDate(
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

  // Multi-jours : vérifier heure de départ
  if (startSchedule.slots.length > 0) {
    if (!isTimeCoveredBySlots(startTimeMin, startSchedule.slots)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `L'heure de début (${startParts.hour}:${String(startParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour de départ (${startDateStr})`,
      );
    }
  }

  // Vérifier heure de fin
  const endSchedule = resolveScheduleForLocalDate(endDateStr, openingHours, scheduleExceptions);
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

  // Vérifier les jours intermédiaires
  for (let dayNum = startDayNum + 1; dayNum < endDayNum; dayNum++) {
    const intermediateDateStr = dateStringFromDayNum(dayNum);
    const daySchedule = resolveScheduleForLocalDate(
      intermediateDateStr,
      openingHours,
      scheduleExceptions,
    );
    if (!daySchedule.isOpen) {
      throw new FlexiblePricingError(
        'LOCATION_CLOSED',
        `L’établissement est fermé le ${intermediateDateStr} durant la période de réservation.`,
      );
    }
  }

  void durationMin;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY_RANGE
// ─────────────────────────────────────────────────────────────────────────────

function assertDayRangeOpeningHours(
  startDate: string,
  endDateExclusive: string,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[],
): void {
  const startParts = parseDateString(startDate);
  const endParts = parseDateString(endDateExclusive);
  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);
  const lastIncludedDayNum = endDayNum - 1;

  // Vérifier le premier jour
  const startSchedule = resolveScheduleForLocalDate(startDate, openingHours, scheduleExceptions);
  if (!startSchedule.isOpen) {
    throw new FlexiblePricingError(
      'LOCATION_CLOSED',
      `L’établissement est fermé le premier jour de la location (${startDate}).`,
    );
  }

  // Vérifier le dernier jour inclus
  if (lastIncludedDayNum > startDayNum) {
    const lastDateStr = dateStringFromDayNum(lastIncludedDayNum);
    const lastSchedule = resolveScheduleForLocalDate(
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
// Helpers de résolution
// ─────────────────────────────────────────────────────────────────────────────

interface EffectiveDateSchedule {
  isOpen: boolean;
  slots: Array<{ openTime: string; closeTime: string }>;
}

function resolveScheduleForLocalDate(
  localDate: string,
  openingHours: OpeningHour[],
  scheduleExceptions: LocationScheduleExceptionRecord[],
): EffectiveDateSchedule {
  const exception = scheduleExceptions.find((ex) => ex.localDate === localDate);
  if (exception) {
    if (exception.kind === 'CLOSED') {
      return { isOpen: false, slots: [] };
    }
    if (exception.kind === 'OPEN_INTERVAL' && exception.openTime && exception.closeTime) {
      return {
        isOpen: true,
        slots: [{ openTime: exception.openTime, closeTime: exception.closeTime }],
      };
    }
  }

  const parts = parseDateString(localDate);
  const dayNum = civilDayNumber(parts.year, parts.month, parts.day);
  const weekday = weekdayFromDayNum(dayNum);

  const regular = openingHours.filter((oh) => oh.weekday === weekday);
  if (regular.length === 0 && openingHours.length > 0) {
    return { isOpen: false, slots: [] };
  }

  return {
    isOpen: true,
    slots: regular.map((r) => ({ openTime: r.openTime, closeTime: r.closeTime })),
  };
}

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

function weekdayFromDayNum(dayNum: number): number {
  return ((dayNum % 7) + 7) % 7;
}
