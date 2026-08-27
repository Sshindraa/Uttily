/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Matching des fenêtres commerciales (pricing_plan_windows).
 */

import type { OpeningHour, ResolvedWindow } from './types';
import { getTimeInMinutes } from './time-utils';

/**
 * Vérifie qu'une fenêtre commerciale [wStart, wEnd] pour un weekday donné est
 * entièrement couverte par au moins une entrée d'horaires d'ouverture pour le
 * même weekday.
 *
 * Couverture : wStart >= oh.openTime AND wEnd <= oh.closeTime AND oh.weekday === weekday.
 *
 * Si openingHours est vide → fail-open (retourne true, pas de filtrage).
 */
function isWindowCoveredByOpeningHours(
  weekday: number,
  wStart: number,
  wEnd: number,
  openingHours: OpeningHour[],
): boolean {
  if (openingHours.length === 0) return true; // fail-open
  for (const oh of openingHours) {
    if (oh.weekday !== weekday) continue;
    const openMin = getTimeInMinutes(oh.openTime);
    const closeMin = getTimeInMinutes(oh.closeTime);
    if (wStart >= openMin && wEnd <= closeMin) {
      return true;
    }
  }
  return false;
}

export interface EffectiveScheduleCoverage {
  isOpen: boolean;
  slots: Array<{ openTime: string; closeTime: string }>;
}

export type ScheduleCoverageInput = OpeningHour[] | EffectiveScheduleCoverage;

function isWindowCoveredByEffectiveSlots(
  wStart: number,
  wEnd: number,
  slots: Array<{ openTime: string; closeTime: string }>,
): boolean {
  if (slots.length === 0) return true; // fail-open si aucun créneau spécifié mais isOpen
  for (const slot of slots) {
    const openMin = getTimeInMinutes(slot.openTime);
    const closeMin = getTimeInMinutes(slot.closeTime);
    if (wStart >= openMin && wEnd <= closeMin) {
      return true;
    }
  }
  return false;
}

function isWindowCovered(
  weekday: number,
  wStart: number,
  wEnd: number,
  coverage: ScheduleCoverageInput = [],
): boolean {
  if (Array.isArray(coverage)) {
    return isWindowCoveredByOpeningHours(weekday, wStart, wEnd, coverage);
  }
  if (!coverage.isOpen) {
    return false;
  }
  return isWindowCoveredByEffectiveSlots(wStart, wEnd, coverage.slots);
}

/**
 * Trouve la fenêtre commerciale couvrante la plus petite pour un weekday et
 * une plage horaire donnés.
 *
 * Une fenêtre correspond si :
 * - (weekdayMask & (1 << weekday)) != 0  (le jour est inclus dans le masque)
 * - startTime >= window.startTime  (la demande commence après ou au début de la fenêtre)
 * - endTime <= window.endTime      (la demande finit avant ou à la fin de la fenêtre)
 *
 * G7P-B2-B Round 2 — Defect 3 : la fenêtre doit également être entièrement couverte
 * par les horaires d'ouverture ou le planning effectif (exceptions incluses) pour le même weekday.
 * Si openingHours est vide, fail-open (pas de filtrage).
 *
 * Parmi les fenêtres correspondantes, on préfère celle avec la plus petite durée
 * (endTime - startTime). En cas d'égalité, on prend la plus tôt (startTime le plus petit).
 * Tie-break final : weekdayMask ascendant (déterministe, sans dépendre de l'ordre DB).
 *
 * @returns la fenêtre correspondante ou null si aucune ne correspond.
 */
export function findMatchingWindow(
  planId: string,
  windows: ResolvedWindow[],
  weekday: number,
  startTimeMinutes: number,
  endTimeMinutes: number,
  scheduleCoverage: ScheduleCoverageInput = [],
): ResolvedWindow | null {
  let best: ResolvedWindow | null = null;
  let bestDuration = Infinity;
  let bestStart = Infinity;
  let bestMask = Infinity;

  for (const w of windows) {
    if (w.pricingPlanId !== planId) continue;
    if ((w.weekdayMask & (1 << weekday)) === 0) continue;
    const wStart = getTimeInMinutes(w.startTime);
    const wEnd = getTimeInMinutes(w.endTime);
    if (startTimeMinutes < wStart || endTimeMinutes > wEnd) continue;
    // Filtrage par horaires d'ouverture / planning effectif
    if (!isWindowCovered(weekday, wStart, wEnd, scheduleCoverage)) continue;
    const duration = wEnd - wStart;
    if (
      duration < bestDuration ||
      (duration === bestDuration && wStart < bestStart) ||
      (duration === bestDuration && wStart === bestStart && w.weekdayMask < bestMask)
    ) {
      best = w;
      bestDuration = duration;
      bestStart = wStart;
      bestMask = w.weekdayMask;
    }
  }

  return best;
}

/**
 * Vérifie qu'au moins une fenêtre existe pour un plan donné.
 */
export function hasAnyWindowForPlan(planId: string, windows: ResolvedWindow[]): boolean {
  return windows.some((w) => w.pricingPlanId === planId);
}

/**
 * Trouve la fenêtre commerciale avec la PLUS GRANDE durée pour un weekday donné.
 *
 * Utilisé pour DAY_RANGE : on veut la fenêtre représentative du jour commercial
 * complet, pas la plus petite fenêtre couvrante (contraire de findMatchingWindow).
 *
 * Une fenêtre correspond si :
 * - (weekdayMask & (1 << weekday)) != 0
 *
 * G7P-B2-B Round 2 / Chantier 15.2.1 : la fenêtre doit également être entièrement couverte
 * par les horaires d'ouverture effectifs (exceptions OPEN_INTERVAL/CLOSED incluses).
 * Si aucune fenêtre n'est couverte par les horaires effectifs → retourne null.
 *
 * Parmi les fenêtres correspondantes couvertes, on préfère celle avec la plus
 * grande durée (endTime - startTime). Tie-breaks déterministes (sans dépendre de
 * l'ordre DB) :
 * 1. Durée descendante (la plus grande d'abord).
 * 2. Heure de début ascendante.
 * 3. Heure de fin ascendante.
 * 4. WeekdayMask ascendant.
 *
 * @returns la fenêtre correspondante ou null si aucune ne correspond.
 */
export function findDayRangeWindow(
  planId: string,
  windows: ResolvedWindow[],
  weekday: number,
  scheduleCoverage: ScheduleCoverageInput = [],
): ResolvedWindow | null {
  let best: ResolvedWindow | null = null;
  let bestDuration = -1;
  let bestStart = Infinity;
  let bestEnd = Infinity;
  let bestMask = Infinity;

  for (const w of windows) {
    if (w.pricingPlanId !== planId) continue;
    if ((w.weekdayMask & (1 << weekday)) === 0) continue;
    const wStart = getTimeInMinutes(w.startTime);
    const wEnd = getTimeInMinutes(w.endTime);
    // Filtrage par horaires effectifs (incluant OPEN_INTERVAL)
    if (!isWindowCovered(weekday, wStart, wEnd, scheduleCoverage)) continue;
    const duration = wEnd - wStart;
    if (
      duration > bestDuration ||
      (duration === bestDuration && wStart < bestStart) ||
      (duration === bestDuration && wStart === bestStart && wEnd < bestEnd) ||
      (duration === bestDuration &&
        wStart === bestStart &&
        wEnd === bestEnd &&
        w.weekdayMask < bestMask)
    ) {
      best = w;
      bestDuration = duration;
      bestStart = wStart;
      bestEnd = wEnd;
      bestMask = w.weekdayMask;
    }
  }

  return best;
}
