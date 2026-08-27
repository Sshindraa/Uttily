/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Génération des candidats éligibles à partir des plans résolus et de l'intent.
 * Pour chaque ligne (variantId + quantity), génère tous les candidats possibles.
 */

import type {
  Candidate,
  DayRangeBoundaries,
  OpeningHour,
  PricingContext,
  ResolvedPlan,
  ResolvedWindow,
  SelectedWindow,
} from './types';
import {
  civilDayNumber,
  countCivilDays,
  getWeekdayFromDate,
  getTimeInMinutes,
  minutesBetween,
  toLocalParts,
} from './time-utils';
import { findMatchingWindow, findDayRangeWindow } from './windows';
import { resolveEffectiveScheduleFromRules } from '../identity/schedule';

/**
 * Génère tous les candidats éligibles pour une ligne donnée.
 *
 * Filtre les plans par :
 * - productVariantId === variantId
 * - currency === context.currency
 * - (lifecycleState === ACTIVE est déjà garanti par resolve_effective_pricing_plans)
 *
 * Pour TIME_RANGE :
 * - HOURLY : eligible si minDurationMinutes <= requestedDurationMinutes <= maxDurationMinutes
 *   (le billed duration après arrondi aux incréments doit aussi être <= maxDurationMinutes)
 * - FIXED_DURATION : eligible si includedDurationMinutes >= requestedDurationMinutes
 * - DAILY : eligible ONLY s'il y a une fenêtre commerciale couvrant toute la plage demandée.
 *   Pas de fallback 24h.
 *
 * Pour DAY_RANGE :
 * - Seuls les plans DAILY sont éligibles.
 * - HOURLY et FIXED_DURATION ne sont PAS éligibles.
 */
export function generateCandidates(
  variantId: string,
  quantity: number,
  context: PricingContext,
): Candidate[] {
  const variantPlans = context.plans.filter(
    (p) => p.productVariantId === variantId && p.currency === context.currency,
  );

  const candidates: Candidate[] = [];

  if (context.intent.kind === 'TIME_RANGE') {
    const requestedDurationMinutes = minutesBetween(context.intent.startAt, context.intent.endAt);
    for (const plan of variantPlans) {
      const candidate = generateTimeRangeCandidate(
        plan,
        variantId,
        quantity,
        requestedDurationMinutes,
        context.intent.startAt,
        context.intent.endAt,
        context.timeZone,
        context.windows,
        context.openingHours,
        context.scheduleExceptions,
        context.locationId,
      );
      if (candidate) candidates.push(candidate);
    }
  } else {
    const dayCount = countCivilDays(context.intent.startDate, context.intent.endDateExclusive);
    for (const plan of variantPlans) {
      if (plan.planType !== 'DAILY') continue;
      const candidate = makeDailyDayRangeCandidate(
        plan,
        variantId,
        quantity,
        dayCount,
        context.intent.startDate,
        context.intent.endDateExclusive,
        context.timeZone,
        context.windows,
        context.openingHours,
        context.scheduleExceptions,
        context.locationId,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME_RANGE candidate generation
// ─────────────────────────────────────────────────────────────────────────────

function generateTimeRangeCandidate(
  plan: ResolvedPlan,
  variantId: string,
  quantity: number,
  requestedDurationMinutes: number,
  startAt: Date,
  endAt: Date,
  timeZone: string,
  windows: ResolvedWindow[],
  openingHours: OpeningHour[],
  scheduleExceptions?: import('../identity/types').LocationScheduleExceptionRecord[],
  locationId?: string,
): Candidate | null {
  switch (plan.planType) {
    case 'HOURLY':
      return generateHourlyCandidate(plan, variantId, quantity, requestedDurationMinutes);
    case 'FIXED_DURATION':
      return generateFixedDurationCandidate(plan, variantId, quantity, requestedDurationMinutes);
    case 'DAILY':
      return generateDailyTimeRangeCandidate(
        plan,
        variantId,
        quantity,
        requestedDurationMinutes,
        startAt,
        endAt,
        timeZone,
        windows,
        openingHours,
        scheduleExceptions,
        locationId,
      );
  }
}

function generateHourlyCandidate(
  plan: ResolvedPlan,
  variantId: string,
  quantity: number,
  requestedDurationMinutes: number,
): Candidate | null {
  if (
    plan.minDurationMinutes === null ||
    plan.maxDurationMinutes === null ||
    plan.billingIncrementMinutes === null
  ) {
    return null;
  }
  if (requestedDurationMinutes < plan.minDurationMinutes) return null;
  if (requestedDurationMinutes > plan.maxDurationMinutes) return null;

  const increments = Math.ceil(requestedDurationMinutes / plan.billingIncrementMinutes);
  const billedDurationMinutes = increments * plan.billingIncrementMinutes;

  if (billedDurationMinutes > plan.maxDurationMinutes) return null;

  return makeCandidate({
    plan,
    variantId,
    quantity,
    requestedDurationMinutes,
    billedDurationMinutes,
    coveredDurationMinutes: null,
    billedDays: null,
    selectedWindow: null,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 0,
    exactDurationMatch: billedDurationMinutes === requestedDurationMinutes,
    sufficientDuration: billedDurationMinutes,
    unusedTime: billedDurationMinutes - requestedDurationMinutes,
    dayRangeBoundaries: null,
    billableUnitCount: 0,
  });
}

function generateFixedDurationCandidate(
  plan: ResolvedPlan,
  variantId: string,
  quantity: number,
  requestedDurationMinutes: number,
): Candidate | null {
  if (plan.includedDurationMinutes === null) return null;
  if (plan.includedDurationMinutes < requestedDurationMinutes) return null;

  const coveredDurationMinutes = plan.includedDurationMinutes;

  return makeCandidate({
    plan,
    variantId,
    quantity,
    requestedDurationMinutes,
    billedDurationMinutes: null,
    coveredDurationMinutes,
    billedDays: null,
    selectedWindow: null,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 0,
    exactDurationMatch: coveredDurationMinutes === requestedDurationMinutes,
    sufficientDuration: coveredDurationMinutes,
    unusedTime: coveredDurationMinutes - requestedDurationMinutes,
    dayRangeBoundaries: null,
    billableUnitCount: 0,
  });
}

function generateDailyTimeRangeCandidate(
  plan: ResolvedPlan,
  variantId: string,
  quantity: number,
  requestedDurationMinutes: number,
  startAt: Date,
  endAt: Date,
  timeZone: string,
  windows: ResolvedWindow[],
  openingHours: OpeningHour[],
  scheduleExceptions: import('../identity/types').LocationScheduleExceptionRecord[] = [],
  locationId: string = '',
): Candidate | null {
  const startParts = toLocalParts(startAt, timeZone);
  const endParts = toLocalParts(endAt, timeZone);

  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);

  // DAILY TIME_RANGE ne supporte qu'un seul jour civil.
  if (startDayNum !== endDayNum) return null;

  const weekday = startParts.weekday;
  const startTimeMin = startParts.hour * 60 + startParts.minute;
  const endTimeMin = endParts.hour * 60 + endParts.minute;

  const startLocalDate = `${startParts.year}-${String(startParts.month).padStart(2, '0')}-${String(startParts.day).padStart(2, '0')}`;
  const effectiveSchedule =
    openingHours.length > 0 || scheduleExceptions.length > 0
      ? resolveEffectiveScheduleFromRules(
          startLocalDate,
          openingHours,
          scheduleExceptions,
          locationId,
        )
      : undefined;

  // G7P-B2-B Round 2 / Chantier 15.2.1 : findMatchingWindow filtre désormais par planning effectif.
  const window = findMatchingWindow(
    plan.id,
    windows,
    weekday,
    startTimeMin,
    endTimeMin,
    effectiveSchedule,
  );
  if (!window) return null;

  const selectedWindow: SelectedWindow = {
    weekdayMask: window.weekdayMask,
    startTime: window.startTime,
    endTime: window.endTime,
  };

  const windowDuration = getTimeInMinutes(window.endTime) - getTimeInMinutes(window.startTime);

  return makeCandidate({
    plan,
    variantId,
    quantity,
    requestedDurationMinutes,
    billedDurationMinutes: null,
    coveredDurationMinutes: null,
    billedDays: 1,
    selectedWindow,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 0,
    exactDurationMatch: requestedDurationMinutes === windowDuration,
    sufficientDuration: 1,
    unusedTime: 0,
    dayRangeBoundaries: null,
    billableUnitCount: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY_RANGE candidate generation
// ─────────────────────────────────────────────────────────────────────────────

function makeDailyDayRangeCandidate(
  plan: ResolvedPlan,
  variantId: string,
  quantity: number,
  dayCount: number,
  startDate: string,
  endDateExclusive: string,
  timeZone: string,
  windows: ResolvedWindow[],
  openingHours: OpeningHour[],
  scheduleExceptions: import('../identity/types').LocationScheduleExceptionRecord[] = [],
  locationId: string = '',
): Candidate | null {
  // G7P-B2-B : trouver les fenêtres pour le premier et le dernier jour.
  // Le dernier jour est le jour avant endDateExclusive.
  const firstDayWeekday = getWeekdayFromDate(new Date(startDate + 'T12:00:00.000Z'), timeZone);
  // endDateExclusive est exclusif, donc le dernier jour est la veille.
  // Utiliser la date civile directement.
  const endParts = parseDateString(endDateExclusive);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);
  const lastDayNum = endDayNum - 1;
  const lastDayDate = civilDayNumberToDate(lastDayNum);
  const lastDayWeekday = getWeekdayFromDate(new Date(lastDayDate + 'T12:00:00.000Z'), timeZone);

  // Chantier 15.2.1 : Résoudre le planning effectif (exceptions OPEN_INTERVAL/CLOSED incluses)
  const hasScheduleRules = openingHours.length > 0 || scheduleExceptions.length > 0;
  const effectiveFirst = hasScheduleRules
    ? resolveEffectiveScheduleFromRules(startDate, openingHours, scheduleExceptions, locationId)
    : undefined;
  const effectiveLast = hasScheduleRules
    ? resolveEffectiveScheduleFromRules(lastDayDate, openingHours, scheduleExceptions, locationId)
    : undefined;

  const firstWindow = findDayRangeWindow(plan.id, windows, firstDayWeekday, effectiveFirst);
  if (!firstWindow) return null; // No matching window → plan ineligible

  const lastWindow = findDayRangeWindow(plan.id, windows, lastDayWeekday, effectiveLast);
  if (!lastWindow) return null; // No matching window → plan ineligible

  const dayRangeBoundaries: DayRangeBoundaries = {
    kind: 'DAY_RANGE_BOUNDARIES',
    firstDay: {
      localDate: startDate,
      weekdayMask: firstWindow.weekdayMask,
      startTime: firstWindow.startTime,
      endTime: firstWindow.endTime,
    },
    lastDay: {
      localDate: lastDayDate,
      weekdayMask: lastWindow.weekdayMask,
      startTime: lastWindow.startTime,
      endTime: lastWindow.endTime,
    },
  };

  return makeCandidate({
    plan,
    variantId,
    quantity,
    requestedDurationMinutes: 0,
    billedDurationMinutes: null,
    coveredDurationMinutes: null,
    billedDays: dayCount,
    selectedWindow: null,
    discountThresholdDays: null,
    discountPercent: null,
    amountBeforeDiscountMinor: null,
    amountAfterDiscountMinor: null,
    lineTotalAmountMinor: 0,
    exactDurationMatch: false,
    sufficientDuration: dayCount,
    unusedTime: 0,
    dayRangeBoundaries,
    billableUnitCount: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function makeCandidate(c: Candidate): Candidate {
  return c;
}

/** Parse une date YYYY-MM-DD et valide le format. */
function parseDateString(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`parseDateString: format invalide (attendu YYYY-MM-DD, reçu ${dateStr})`);
  }
  return {
    year: parseInt(match[1]!, 10),
    month: parseInt(match[2]!, 10),
    day: parseInt(match[3]!, 10),
  };
}

/** Convertit un numéro de jour civil (Julian Day Number) en date YYYY-MM-DD. */
function civilDayNumberToDate(dayNum: number): string {
  // Inverse de civilDayNumber : algorithme de Julian Day → Gregorian.
  const a = dayNum + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Export pour les tests
export { getWeekdayFromDate };
