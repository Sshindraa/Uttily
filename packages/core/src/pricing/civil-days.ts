import { isValidTimeZone } from '../identity/time-zone';
import { PricingError } from './errors';

/**
 * Composants d'un instant décomposés en date civile locale d'un fuseau IANA.
 * Utilise Intl.DateTimeFormat (pas de nouvelle dépendance) pour la conversion.
 */
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Convertit un instant UTC en composants de date civile locale dans un fuseau IANA.
 * hour12: false peut retourner '24' au lieu de '00' sur certains runtimes ; on
 * normalise via modulo 24.
 */
function toLocalParts(date: Date, timeZone: string): LocalParts {
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
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    millisecond: parseInt(get('fractionalSecond'), 10),
  };
}

/**
 * Numéro de jour civil (Julian Day Number simplifié) pour une date (year, month, day).
 * Permet de comparer des dates civiles sans dépendre de divisions par 24h qui
 * seraient incorrectes lors des passages DST (jours à 23h ou 25h).
 */
function civilDayNumber(year: number, month: number, day: number): number {
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
 * Calcule le nombre de jours civils facturables entre deux instants, dans un
 * fuseau IANA donné (ADR-009 section 9).
 *
 * Règles :
 * - L'intervalle est strictement positif (endAt > startAt).
 * - Si début et fin tombent sur la même date civile locale : 1 jour.
 * - Si la fin correspond exactement à minuit local (00:00:00), la date de fin
 *   est exclue (intervalle semi-ouvert).
 * - Sinon, la date de fin est incluse.
 * - Minimum 1 jour.
 *
 * @throws PricingError(VALIDATION) si le fuseau est invalide, les dates sont
 *   invalides ou l'intervalle est vide/inversé.
 */
export function calculateBillableCivilDays(startAt: Date, endAt: Date, timeZone: string): number {
  if (!isValidTimeZone(timeZone)) {
    throw new PricingError('VALIDATION', `Fuseau IANA invalide : ${timeZone}`);
  }
  if (!Number.isFinite(startAt.getTime())) {
    throw new PricingError('VALIDATION', "startAt n'est pas une date valide");
  }
  if (!Number.isFinite(endAt.getTime())) {
    throw new PricingError('VALIDATION', "endAt n'est pas une date valide");
  }
  if (!(endAt.getTime() > startAt.getTime())) {
    throw new PricingError(
      'VALIDATION',
      'La période doit être strictement positive (endAt > startAt)',
    );
  }

  const startParts = toLocalParts(startAt, timeZone);
  const endParts = toLocalParts(endAt, timeZone);

  const startDayNum = civilDayNumber(startParts.year, startParts.month, startParts.day);
  const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);

  // Même jour civil : au moins 1 jour facturable.
  if (startDayNum === endDayNum) {
    return 1;
  }

  // Fin exactement à minuit local (00:00:00.000) : la date de fin est exclue (semi-ouvert).
  const endIsMidnight =
    endParts.hour === 0 &&
    endParts.minute === 0 &&
    endParts.second === 0 &&
    endParts.millisecond === 0;

  if (endIsMidnight) {
    const count = endDayNum - startDayNum;
    return Math.max(1, count);
  }

  // Fin dans la journée de end_date : end_date incluse.
  const count = endDayNum - startDayNum + 1;
  return Math.max(1, count);
}
