/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Fonctions de validation pures (sans accès base de données).
 * Utilisées par record-event, aggregate, purge et summary.
 */

import { ProductAnalyticsError } from './errors';
import type { AnalyticsEnvironment, AnalyticsEventType } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ENVIRONMENTS: readonly AnalyticsEnvironment[] = ['DEVELOPMENT', 'TEST', 'PRODUCTION'];

const VALID_EVENT_TYPES: readonly AnalyticsEventType[] = [
  'PUBLIC_SEARCH_PERFORMED',
  'BOOKING_ATTEMPTED',
  'BOOKING_CONFIRMED',
];

/**
 * Valide qu'une chaîne est un UUID v4 canonique (lowercase ou uppercase).
 * @throws {ProductAnalyticsError} INVALID_UUID si invalide.
 */
export function validateUuid(value: string, field: string): void {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new ProductAnalyticsError('INVALID_UUID', `${field} invalide.`);
  }
}

/**
 * Valide qu'une chaîne est une date strictement au format YYYY-MM-DD.
 * Vérifie également la validité du calendrier (mois 1-12, jour valide selon
 * le mois et l'année bissextile).
 * @returns Les composants { year, month, day }.
 * @throws {ProductAnalyticsError} INVALID_DATE si invalide.
 */
export function validateDateString(
  value: string,
  field: string,
): { year: number; month: number; day: number } {
  if (typeof value !== 'string') {
    throw new ProductAnalyticsError('INVALID_DATE', `${field} invalide.`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new ProductAnalyticsError('INVALID_DATE', `${field} invalide.`);
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  if (month < 1 || month > 12) {
    throw new ProductAnalyticsError('INVALID_DATE', `${field} invalide.`);
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new ProductAnalyticsError('INVALID_DATE', `${field} invalide.`);
  }
  return { year, month, day };
}

/**
 * Calcule le nombre de jours dans un mois donné, en tenant compte des
 * années bissextiles.
 */
function daysInMonth(year: number, month: number): number {
  const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return daysPerMonth[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Convertit une date YYYY-MM-DD en un nombre de jours depuis l'époque
 * (pour comparaison arithmétique simple).
 */
function dateToDayNumber(year: number, month: number, day: number): number {
  // Algorithme de conversion : jours cumulés depuis l'an 1.
  // Utilise la formule proleptic Gregorian.
  const m = month;
  const y = year;
  const d = day;
  // Nombre de jours depuis 0000-03-01 (décalage pour simplifier février).
  const adjustedYear = m <= 2 ? y - 1 : y;
  const adjustedMonth = m <= 2 ? m + 9 : m - 3;
  const era = Math.floor(adjustedYear / 400);
  const yoe = adjustedYear - era * 400;
  const doy = Math.floor((153 * adjustedMonth + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Valide qu'une plage de jours [fromDay, toDayExclusive) est positive
 * (fromDay < toDayExclusive) et ne dépasse pas maxDays.
 * @returns { fromDayNum, toDayNum, dayCount }.
 * @throws {ProductAnalyticsError} INVALID_DAY_RANGE si la plage est nulle ou négative.
 * @throws {ProductAnalyticsError} RANGE_TOO_LARGE si la plage dépasse maxDays.
 */
export function validateDayRange(
  fromDay: string,
  toDayExclusive: string,
  maxDays: number,
): { fromDayNum: number; toDayNum: number; dayCount: number } {
  const from = validateDateString(fromDay, 'fromDay');
  const to = validateDateString(toDayExclusive, 'toDayExclusive');
  const fromDayNum = dateToDayNumber(from.year, from.month, from.day);
  const toDayNum = dateToDayNumber(to.year, to.month, to.day);
  const dayCount = toDayNum - fromDayNum;
  if (dayCount <= 0) {
    throw new ProductAnalyticsError(
      'INVALID_DAY_RANGE',
      'La plage de jours doit être positive (fromDay < toDayExclusive).',
    );
  }
  if (dayCount > maxDays) {
    throw new ProductAnalyticsError(
      'RANGE_TOO_LARGE',
      `La plage de jours ne doit pas dépasser ${maxDays} jours.`,
    );
  }
  return { fromDayNum, toDayNum, dayCount };
}

/**
 * Valide qu'une valeur Date est finie (pas NaN, pas Invalid Date).
 * @throws {ProductAnalyticsError} INVALID_INPUT si la date est invalide.
 */
export function validateOccurredAt(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'occurredAt invalide.');
  }
}

/**
 * Normalise un rawLimit optionnel : défaut 1000, min 1, max 5000.
 * Fail-closed : toute valeur invalide (null, NaN, Infinity, string, boolean,
 * décimal, zéro, négatif, non-safe integer) lève INVALID_INPUT.
 * Seul `undefined` retourne le défaut 1000.
 */
export function normalizeRawLimit(limit?: number): number {
  if (limit === undefined) {
    return 1000;
  }
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isSafeInteger(limit)) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'rawLimit invalide.');
  }
  if (limit < 1) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'rawLimit invalide.');
  }
  if (limit > 5000) {
    return 5000;
  }
  return limit;
}

/**
 * Calcule la borne de rétention raw : asOf - 90 jours.
 * Utilise l'arithmétique UTC pour éviter les décalages de fuseau horaire.
 */
export function calculateRawRetentionBoundary(asOf: Date): Date {
  const result = new Date(
    Date.UTC(
      asOf.getUTCFullYear(),
      asOf.getUTCMonth(),
      asOf.getUTCDate() - 90,
      asOf.getUTCHours(),
      asOf.getUTCMinutes(),
      asOf.getUTCSeconds(),
      asOf.getUTCMilliseconds(),
    ),
  );
  return result;
}

/**
 * Calcule la borne de rétention des agrégats : asOf - 24 mois.
 *
 * Règle exacte :
 * - Prend les composants date UTC de asOf.
 * - Soustrait 24 mois : year = asOf.year + floor((asOf.month - 1 - 24) / 12),
 *   month = ((asOf.month - 1 - 24) % 12 + 12) % 12 + 1.
 * - Le jour est le même que asOf, sauf s'il n'existe pas dans le mois cible
 *   (ex : 31 mars → février → 28 ou 29).
 * - La borne est exclusive pour la suppression : les agrégats avec
 *   day < boundary sont supprimés, day == boundary est conservé.
 */
export function calculateAggregateRetentionBoundary(asOf: Date): Date {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth(); // 0-indexed
  const day = asOf.getUTCDate();

  // Soustrait 24 mois.
  const totalMonths = year * 12 + month - 24;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12; // 0-indexed

  // Ajuste le jour si nécessaire (ex : 31 → février → 28/29).
  const maxDay = daysInMonth(targetYear, targetMonth + 1);
  const targetDay = Math.min(day, maxDay);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay));
}

/**
 * Convertit un bigint en number de manière sûre.
 * @throws {ProductAnalyticsError} OVERFLOW si la valeur dépasse Number.MAX_SAFE_INTEGER.
 */
export function safeBigIntToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ProductAnalyticsError('OVERFLOW', 'Dépassement de capacité détecté.');
  }
  return Number(value);
}

/**
 * Valide qu'une valeur est un AnalyticsEnvironment autorisé.
 * @throws {ProductAnalyticsError} INVALID_ENVIRONMENT si invalide.
 */
export function validateEnvironment(value: string): AnalyticsEnvironment {
  if (!VALID_ENVIRONMENTS.includes(value as AnalyticsEnvironment)) {
    throw new ProductAnalyticsError('INVALID_ENVIRONMENT', 'Environnement invalide.');
  }
  return value as AnalyticsEnvironment;
}

/**
 * Valide qu'une valeur est un AnalyticsEventType autorisé.
 * @throws {ProductAnalyticsError} INVALID_EVENT_TYPE si invalide.
 */
export function validateEventType(value: string): AnalyticsEventType {
  if (!VALID_EVENT_TYPES.includes(value as AnalyticsEventType)) {
    throw new ProductAnalyticsError('INVALID_EVENT_TYPE', "Type d'événement invalide.");
  }
  return value as AnalyticsEventType;
}

/**
 * Valide qu'une date asOf est représentable : les bornes de rétention raw (90 jours)
 * et agrégats (24 mois) doivent produire des Dates finies. Les dates extrêmes
 * (année 100000+) peuvent déborder l'arithmétique Date et produire NaN/Infinity.
 * @throws {ProductAnalyticsError} INVALID_INPUT si une borne n'est pas finie.
 */
export function validateAsOfRepresentable(asOf: Date): void {
  const rawBoundary = calculateRawRetentionBoundary(asOf);
  if (!(rawBoundary instanceof Date) || !Number.isFinite(rawBoundary.getTime())) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'asOf non représentable.');
  }
  const aggregateBoundary = calculateAggregateRetentionBoundary(asOf);
  if (!(aggregateBoundary instanceof Date) || !Number.isFinite(aggregateBoundary.getTime())) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'asOf non représentable.');
  }
}

/**
 * Décode une valeur inconnue en bigint de manière sûre (runtime).
 * Accepte : bigint → retourne tel quel ; string canonique décimale (/^\d+$/)
 * → parse en BigInt. Rejette : number, NaN, null, undefined, boolean, object,
 * chaîne vide, valeur négative, décimale, non-numérique.
 * @throws {ProductAnalyticsError} ANALYTICS_UNAVAILABLE si la valeur est rejetée
 *   (erreur d'infrastructure, pas d'entrée utilisateur).
 */
export function decodeBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new ProductAnalyticsError(
        'ANALYTICS_UNAVAILABLE',
        `Valeur bigint invalide pour ${field}.`,
      );
    }
    return BigInt(value);
  }
  throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', `Valeur bigint invalide pour ${field}.`);
}

/**
 * Décode une valeur inconnue en bigint non négatif de manière sûre (runtime).
 * Appelle decodeBigInt puis vérifie result >= 0n.
 * @throws {ProductAnalyticsError} ANALYTICS_UNAVAILABLE si la valeur est rejetée
 *   ou négative.
 */
export function decodeNonNegativeBigInt(value: unknown, field: string): bigint {
  const result = decodeBigInt(value, field);
  if (result < 0n) {
    throw new ProductAnalyticsError(
      'ANALYTICS_UNAVAILABLE',
      `Valeur bigint négative pour ${field}.`,
    );
  }
  return result;
}
