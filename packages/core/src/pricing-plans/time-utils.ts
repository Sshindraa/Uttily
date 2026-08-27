/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Fonctions pures de gestion du temps, fuseaux IANA et jours civils.
 * Réutilise le pattern Intl.DateTimeFormat de civil-days.ts.
 * L'API Intl gère automatiquement les transitions DST.
 */

import { FlexiblePricingError } from './errors';

/**
 * Composants d'un instant décomposés en date civile locale d'un fuseau IANA.
 * weekday : 0=Monday..6=Sunday (cohérent avec weekdayMask et opening_hours).
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number; // 0=Monday..6=Sunday
}

/**
 * Convertit un instant UTC en composants de date civile locale dans un fuseau IANA.
 * hour12: false peut retourner '24' au lieu de '00' sur certains runtimes ; on
 * normalise via modulo 24.
 */
export function toLocalParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayStr = get('weekday');
  // Intl weekday short en en-US : Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const weekdayMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    millisecond: parseInt(get('fractionalSecond'), 10),
    weekday: weekdayMap[weekdayStr] ?? 0,
  };
}

/**
 * Numéro de jour civil (Julian Day Number simplifié) pour une date (year, month, day).
 * Permet de comparer des dates civiles sans dépendre de divisions par 24h qui
 * seraient incorrectes lors des passages DST (jours à 23h ou 25h).
 */
export function civilDayNumber(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/**
 * Compte le nombre de jours civils de startDate à endDateExclusive (exclusif).
 * Pour DAY_RANGE : l'intervalle est semi-ouvert [startDate, endDateExclusive[.
 * Retourne au minimum 1.
 *
 * @throws FlexiblePricingError(VALIDATION) si endDateExclusive <= startDate.
 */
export function countCivilDays(startDate: string, endDateExclusive: string): number {
  const start = parseDateString(startDate);
  const end = parseDateString(endDateExclusive);
  const startDayNum = civilDayNumber(start.year, start.month, start.day);
  const endDayNum = civilDayNumber(end.year, end.month, end.day);
  if (endDayNum <= startDayNum) {
    throw new FlexiblePricingError(
      'VALIDATION',
      `countCivilDays: endDateExclusive (${endDateExclusive}) doit être strictement postérieure à startDate (${startDate})`,
    );
  }
  const count = endDayNum - startDayNum;
  return Math.max(1, count);
}

/**
 * Minutes absolues entre deux instants.
 * @throws FlexiblePricingError(VALIDATION) si endAt <= startAt.
 */
export function minutesBetween(startAt: Date, endAt: Date): number {
  if (!Number.isFinite(startAt.getTime())) {
    throw new FlexiblePricingError(
      'VALIDATION',
      "minutesBetween: startAt n'est pas une date valide",
    );
  }
  if (!Number.isFinite(endAt.getTime())) {
    throw new FlexiblePricingError('VALIDATION', "minutesBetween: endAt n'est pas une date valide");
  }
  const diffMs = endAt.getTime() - startAt.getTime();
  if (diffMs <= 0) {
    throw new FlexiblePricingError(
      'VALIDATION',
      'minutesBetween: la période doit être strictement positive (endAt > startAt)',
    );
  }
  return Math.round(diffMs / 60000);
}

/**
 * Convertit une date locale (YYYY-MM-DD) en instant UTC minuit de cette date locale
 * dans le fuseau donné, en tenant compte du décalage DST à cette date.
 * Utilise Intl pour trouver l'offset du fuseau à la date donnée.
 */
export function localDateToUtcMidnight(dateStr: string, timeZone: string): Date {
  const { year, month, day } = parseDateString(dateStr);
  // Construire un instant à midi UTC de cette date (midi évite les ambigüités DST
  // aux frontières de minuit), puis calculer l'offset du fuseau à cet instant,
  // puis ajuster pour obtenir minuit local en UTC.
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  const parts = toLocalParts(noonUtc, timeZone);
  // L'offset = temps local affiché - temps UTC (en minutes).
  // noonUtc est 12:00 UTC ; parts.hour est l'heure locale.
  const localMinutes = parts.hour * 60 + parts.minute;
  const utcMinutes = 12 * 60;
  const offsetMinutes = localMinutes - utcMinutes;
  // minuit local = noonUtc - 12h - offset = Date.UTC(year, month-1, day, 0,0,0) - offset
  const midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60000;
  return new Date(midnightUtc);
}

/**
 * Retourne le jour de la semaine (0=Monday..6=Sunday) d'un instant dans un fuseau.
 */
export function getWeekdayFromDate(date: Date, timeZone: string): number {
  return toLocalParts(date, timeZone).weekday;
}

/**
 * Convertit une chaîne "HH:MM:SS" en minutes depuis minuit.
 * Ex: "09:00:00" → 540, "17:00:00" → 1020.
 */
export function getTimeInMinutes(timeStr: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeStr);
  if (!match) {
    throw new FlexiblePricingError(
      'VALIDATION',
      `getTimeInMinutes: format invalide (attendu HH:MM:SS, reçu ${timeStr})`,
    );
  }
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  const seconds = parseInt(match[3]!, 10);
  return hours * 60 + minutes + Math.floor(seconds / 60);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/** Parse une date YYYY-MM-DD et valide le format. */
export function parseDateString(dateStr: string): { year: number; month: number; day: number } {
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

/** Convertit un numéro de jour civil (Julian Day Number) en date YYYY-MM-DD. */
export function civilDayNumberToDate(dayNum: number): string {
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
