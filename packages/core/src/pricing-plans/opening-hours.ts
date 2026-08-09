/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Validation des horaires d'ouverture.
 */

import type { OpeningHour, ResolvedFlexiblePricingIntent } from './types';
import { FlexiblePricingError } from './errors';
import { civilDayNumber, getTimeInMinutes, minutesBetween, toLocalParts } from './time-utils';

/**
 * Vérifie que la période demandée tombe dans les horaires d'ouverture.
 *
 * Pour TIME_RANGE : vérifie que l'heure de début et l'heure de fin (en local)
 * tombent dans un créneau d'ouverture pour le jour de la semaine correspondant
 * au début. Si la plage traverse minuit (plusieurs jours civils), chaque jour
 * couvert doit avoir un créneau d'ouverture.
 *
 * Pour DAY_RANGE : vérifie que pour chaque jour civil de la plage, il existe
 * une entrée d'horaires d'ouverture pour ce jour de la semaine.
 *
 * @throws FlexiblePricingError(OUTSIDE_OPENING_HOURS) si la période n'est pas
 *   entièrement dans les horaires d'ouverture.
 */
export function isWithinOpeningHours(
  intent: ResolvedFlexiblePricingIntent,
  timeZone: string,
  openingHours: OpeningHour[],
): void {
  if (openingHours.length === 0) {
    // Pas d'horaires d'ouverture configurés → on ne bloque pas (fail-open pour
    // les locations sans horaires, cohérent avec le MVP où les horaires sont
    // optionnels). Le moteur de pricing ne rejette pas si aucun horaire n'existe.
    return;
  }

  if (intent.kind === 'TIME_RANGE') {
    assertTimeRangeOpeningHours(intent.startAt, intent.endAt, timeZone, openingHours);
  } else {
    assertDayRangeOpeningHours(intent.startDate, intent.endDateExclusive, openingHours);
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
): void {
  const durationMin = minutesBetween(startAt, endAt);
  const startParts = toLocalParts(startAt, timeZone);
  const endParts = toLocalParts(endAt, timeZone);

  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);

  const startTimeMin = startParts.hour * 60 + startParts.minute;
  const endTimeMin = endParts.hour * 60 + endParts.minute;

  // Cas 1 : même jour civil — vérifier que [startTime, endTime] est couvert
  // par un créneau d'ouverture ce jour-là.
  if (startDayNum === endDayNum) {
    const weekday = startParts.weekday;
    if (!isTimeRangeCoveredByOpeningHours(weekday, startTimeMin, endTimeMin, openingHours)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `La plage horaire (${startParts.hour}:${String(startParts.minute).padStart(2, '0')}-${endParts.hour}:${String(endParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour ${weekday}`,
      );
    }
    return;
  }

  // Cas 2 : la plage traverse minuit (plusieurs jours civils).
  // Vérifier le jour de début : startTime → fin de journée couverte par un créneau.
  if (!isTimeRangeCoveredByOpeningHours(startParts.weekday, startTimeMin, 24 * 60, openingHours)) {
    throw new FlexiblePricingError(
      'OUTSIDE_OPENING_HOURS',
      `L'heure de début (${startParts.hour}:${String(startParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour de départ`,
    );
  }

  // Vérifier le jour de fin : début de journée → endTime couverte par un créneau.
  if (!isTimeRangeCoveredByOpeningHours(endParts.weekday, 0, endTimeMin, openingHours)) {
    throw new FlexiblePricingError(
      'OUTSIDE_OPENING_HOURS',
      `L'heure de fin (${endParts.hour}:${String(endParts.minute).padStart(2, '0')}) n'est pas dans les horaires d'ouverture du jour d'arrivée`,
    );
  }

  // Vérifier les jours intermédiaires : chaque jour doit avoir au moins un créneau.
  for (let dayNum = startDayNum + 1; dayNum < endDayNum; dayNum++) {
    const weekday = weekdayFromDayNum(dayNum);
    if (!openingHours.some((oh) => oh.weekday === weekday)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `Aucun horaire d'ouverture pour le jour de la semaine ${weekday} dans la plage multi-jours`,
      );
    }
  }

  // Utiliser durationMin pour éviter l'avertissement de variable non utilisée
  // (la durée est déjà validée par minutesBetween qui lève si <= 0).
  void durationMin;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY_RANGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valide que le premier et le dernier jour inclus d'un DAY_RANGE ont des
 * horaires d'ouverture couvrant au moins un créneau. Les jours intermédiaires
 * peuvent être fermés (le client conserve l'équipement entre-temps).
 *
 * G7P-B2-B Round 2 — Defect 3 : safety-net — vérifie qu'au moins une entrée
 * d'horaires d'ouverture existe pour le weekday du premier et du dernier jour.
 * Le filtrage par couverture temporelle de la fenêtre sélectionnée est déjà
 * effectué par findDayRangeWindow ; cette fonction est un double-check.
 *
 * Le weekday d'une date YYYY-MM-DD est déterministe (indépendant du fuseau) :
 * on utilise civilDayNumber + weekdayFromDayNum directement, sans conversion
 * en instant UTC.
 *
 * @throws FlexiblePricingError(OUTSIDE_OPENING_HOURS) si le premier ou dernier
 *   jour n'a pas d'horaires d'ouverture.
 */
function assertDayRangeOpeningHours(
  startDate: string,
  endDateExclusive: string,
  openingHours: OpeningHour[],
): void {
  // Calculer les day numbers directement depuis les dates civiles (YYYY-MM-DD).
  // Le weekday d'une date civile est déterministe, indépendant du fuseau.
  const startParts = parseDateString(startDate);
  const endParts = parseDateString(endDateExclusive);
  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);

  // Le dernier jour inclus = endDayNum - 1 (endDateExclusive est exclusif).
  const lastIncludedDayNum = endDayNum - 1;

  // Vérifier le premier jour.
  const firstWeekday = weekdayFromDayNum(startDayNum);
  if (!openingHours.some((oh) => oh.weekday === firstWeekday)) {
    throw new FlexiblePricingError(
      'OUTSIDE_OPENING_HOURS',
      `Aucun horaire d'ouverture pour le premier jour (weekday ${firstWeekday}) dans la plage DAY_RANGE`,
    );
  }

  // Vérifier le dernier jour inclus (uniquement s'il est différent du premier).
  if (lastIncludedDayNum > startDayNum) {
    const lastWeekday = weekdayFromDayNum(lastIncludedDayNum);
    if (!openingHours.some((oh) => oh.weekday === lastWeekday)) {
      throw new FlexiblePricingError(
        'OUTSIDE_OPENING_HOURS',
        `Aucun horaire d'ouverture pour le dernier jour (weekday ${lastWeekday}) dans la plage DAY_RANGE`,
      );
    }
  }
}

/** Parse une date YYYY-MM-DD et valide le format. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Vérifie qu'un créneau d'ouverture couvre [startTimeMin, endTimeMin] pour un weekday. */
function isTimeRangeCoveredByOpeningHours(
  weekday: number,
  startTimeMin: number,
  endTimeMin: number,
  openingHours: OpeningHour[],
): boolean {
  for (const oh of openingHours) {
    if (oh.weekday !== weekday) continue;
    const openMin = getTimeInMinutes(oh.openTime);
    const closeMin = getTimeInMinutes(oh.closeTime);
    if (startTimeMin >= openMin && endTimeMin <= closeMin) {
      return true;
    }
  }
  return false;
}

/** Retourne le jour de la semaine (0=Monday..6=Sunday) pour un Julian day number. */
function weekdayFromDayNum(dayNum: number): number {
  // Julian Day Number mod 7 : 0=Monday..6=Sunday (JDN 0 = lundi 4713 BC).
  // Vérifié : civilDayNumber(2000,1,3) = 2451547, 2451547 % 7 = 0, et 2000-01-03 = lundi.
  return ((dayNum % 7) + 7) % 7;
}
