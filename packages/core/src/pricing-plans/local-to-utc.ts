/**
 * @uttily/core — Module Pricing Plans (G7P-B2-B).
 *
 * Conversion de date+heure locale → UTC pour un fuseau IANA.
 *
 * Exigences :
 * - Aucune dépendance au fuseau système (TZ env).
 * - Pas de `new Date('YYYY-MM-DD HH:mm')` (dépend de la machine).
 * - DST correctement géré via Intl.DateTimeFormat.
 * - Heure locale inexistante (spring-forward) → erreur typée.
 * - Heure locale ambiguë (fall-back) → erreur typée (fail-closed).
 * - Round-trip : UTC → local parts → UTC = identité.
 * - Support des offsets UTC-12 à UTC+14, incluant les offsets à 30 et 45 minutes.
 */

import { civilDayNumber, toLocalParts } from './time-utils';

/**
 * Composants d'une date+heure locale (sans fuseau).
 */
export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

/**
 * Erreur typée pour la conversion local → UTC.
 */
export class LocalToUtcError extends Error {
  constructor(
    public readonly code:
      | 'NON_EXISTENT_LOCAL_TIME'
      | 'AMBIGUOUS_LOCAL_TIME'
      | 'INVALID_TIMEZONE'
      | 'INVALID_LOCAL_DATETIME_STRING',
    message: string,
  ) {
    super(message);
    this.name = 'LocalToUtcError';
  }
}

/**
 * Convertit une date+heure locale en instant UTC pour un fuseau IANA.
 *
 * Approche robuste (G7P-B2-B Round 2 — Defect 5) :
 *
 * 1. Valider le fuseau IANA via `Intl.DateTimeFormat` (lève si invalide).
 * 2. Collecter les offsets réels du fuseau en sondant plusieurs instants UTC
 *    autour de la date (date±1, plusieurs heures par jour) via `Intl.DateTimeFormat`.
 *    Cela capture les transitions DST et les offsets non standard (30/45 min).
 * 3. Pour chaque offset candidat, construire l'instant UTC correspondant à la
 *    date+heure locale et vérifier le round-trip (UTC → local parts → comparaison).
 * 4. 0 candidat valide → NON_EXISTENT_LOCAL_TIME (spring-forward).
 *    Plusieurs candidats valides → AMBIGUOUS_LOCAL_TIME (fall-back, fail-closed).
 *    1 candidat valide → succès.
 *
 * Aucune utilisation du fuseau système. Supporte UTC-12 à UTC+14, offsets à
 * 30 et 45 minutes, et transitions DST non standard (ex : Lord Howe 30 min).
 *
 * @throws LocalToUtcError(INVALID_TIMEZONE) si le fuseau IANA est invalide.
 * @throws LocalToUtcError(NON_EXISTENT_LOCAL_TIME) si l'heure locale n'existe pas.
 * @throws LocalToUtcError(AMBIGUOUS_LOCAL_TIME) si l'heure locale est ambiguë.
 */
export function localDateTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  // Étape 1 : Valider le fuseau IANA.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' });
  } catch {
    throw new LocalToUtcError(
      'INVALID_TIMEZONE',
      `localDateTimeToUtc: fuseau IANA invalide : ${timeZone}`,
    );
  }

  // Étape 2 : Collecter les offsets candidats en sondant la date et date±1.
  const offsets = collectCandidateOffsets(local, timeZone);

  // Étape 3 : Pour chaque offset, construire l'instant UTC et vérifier le round-trip.
  const candidates: Date[] = [];
  const seenTimestamps = new Set<number>();

  for (const offset of offsets) {
    const candidate = tryOffset(local, offset, timeZone);
    if (candidate !== null && !seenTimestamps.has(candidate.getTime())) {
      seenTimestamps.add(candidate.getTime());
      candidates.push(candidate);
    }
  }

  // Étape 4 : Analyser les résultats.
  if (candidates.length === 0) {
    throw new LocalToUtcError(
      'NON_EXISTENT_LOCAL_TIME',
      `localDateTimeToUtc: l'heure locale ${formatLocal(local)} n'existe pas dans le fuseau ${timeZone} (spring-forward)`,
    );
  }

  if (candidates.length > 1) {
    throw new LocalToUtcError(
      'AMBIGUOUS_LOCAL_TIME',
      `localDateTimeToUtc: l'heure locale ${formatLocal(local)} est ambiguë dans le fuseau ${timeZone} (fall-back)`,
    );
  }

  return candidates[0]!;
}

/**
 * Convertit une chaîne de date+heure locale ISO 8601 sans offset (ex :
 * "2026-08-08T22:08:00") en un instant UTC pour un fuseau IANA donné.
 *
 * Cette fonction est un raccourci qui combine {@link parseLocalDateTimeString}
 * et {@link localDateTimeToUtc}. Elle est utilisée par le chemin de création
 * de brouillon flexible (TIME_RANGE) pour convertir l'entrée locale du client
 * en UTC pour le stockage dans `customer_start_at` / `customer_end_at`.
 *
 * @throws LocalToUtcError(INVALID_LOCAL_DATETIME_STRING) si le format est invalide.
 * @throws LocalToUtcError(INVALID_TIMEZONE) si le fuseau IANA est invalide.
 * @throws LocalToUtcError(NON_EXISTENT_LOCAL_TIME) si l'heure locale n'existe pas.
 * @throws LocalToUtcError(AMBIGUOUS_LOCAL_TIME) si l'heure locale est ambiguë.
 */
export function localDateTimeStringToUtc(localStr: string, timeZone: string): Date {
  return localDateTimeToUtc(parseLocalDateTimeString(localStr), timeZone);
}

/**
 * Collecte les offsets réels du fuseau en sondant plusieurs instants UTC autour
 * de la date locale donnée (date et date±1, plusieurs heures par jour).
 *
 * Pour chaque instant UTC sondé, on récupère les composants locaux via
 * `Intl.DateTimeFormat`, puis on calcule l'offset = (temps local en minutes) -
 * (temps UTC en minutes), ajusté pour les différences de jour civil.
 *
 * Cela capture tous les offsets possibles du fuseau autour de la date, y compris
 * les transitions DST et les offsets non standard (30/45 min).
 */
function collectCandidateOffsets(local: LocalDateTime, timeZone: string): Set<number> {
  const offsets = new Set<number>();
  const baseDayNum = civilDayNumber(local.year, local.month, local.day);

  // Sonder date-1, date, date+1 à plusieurs heures pour capturer les transitions DST.
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    for (let hour = 0; hour < 24; hour += 3) {
      const probeUtc = new Date(
        Date.UTC(local.year, local.month - 1, local.day + dayOffset, hour, 0, 0, 0),
      );
      const parts = toLocalParts(probeUtc, timeZone);

      // Calculer l'offset = (minutes locales depuis minuit) - (minutes UTC depuis minuit)
      // + (différence de jour civil en minutes).
      const probeLocalMinutes = parts.hour * 60 + parts.minute;
      const probeUtcMinutes = hour;
      const probeDayNum = civilDayNumber(parts.year, parts.month, parts.day);
      const baseProbeDayNum = baseDayNum + dayOffset;
      const dayDiffMinutes = (probeDayNum - baseProbeDayNum) * 24 * 60;
      const offset = probeLocalMinutes - probeUtcMinutes + dayDiffMinutes;
      offsets.add(offset);
    }
  }

  return offsets;
}

/**
 * Tente de construire un instant UTC avec un offset donné et vérifie le round-trip.
 * Retourne null si le round-trip ne correspond pas (heure inexistante pour cet offset).
 * Retourne l'instant UTC si le round-trip correspond.
 */
function tryOffset(local: LocalDateTime, offsetMinutes: number, timeZone: string): Date | null {
  const localMinutes = local.hour * 60 + local.minute + local.second / 60;
  const utcMinutes = localMinutes - offsetMinutes;
  const baseDayNum = civilDayNumber(local.year, local.month, local.day);
  const utcDayNum = baseDayNum + Math.floor(utcMinutes / (24 * 60));
  const utcHourMinute = ((utcMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const { year, month, day } = civilDayNumberToDate(utcDayNum);
  const utcHour = Math.floor(utcHourMinute / 60);
  const utcMinute = Math.floor(utcHourMinute % 60);
  const utcSecond = local.second;
  const candidateUtc = new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond, 0));

  const parts = toLocalParts(candidateUtc, timeZone);

  if (
    parts.year === local.year &&
    parts.month === local.month &&
    parts.day === local.day &&
    parts.hour === local.hour &&
    parts.minute === local.minute &&
    parts.second === local.second
  ) {
    return candidateUtc;
  }
  return null;
}

/** Convertit un numéro de jour civil (Julian Day Number) en date YYYY-MM-DD. */
function civilDayNumberToDate(dayNum: number): { year: number; month: number; day: number } {
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
  return { year, month, day };
}

function formatLocal(local: LocalDateTime): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

/**
 * Regex pour valider une chaîne de date+heure locale ISO 8601 sans offset.
 * Format attendu : "YYYY-MM-DDTHH:MM:SS" (ex : "2026-08-08T22:08:00").
 * Aucun offset de fuseau horaire n'est autorisé (pas de 'Z', pas de '+HH:MM').
 */
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Message générique pour une chaîne de date+heure locale invalide.
 * G7P-B2-B Round 3 : la valeur hostile brute n'est JAMAIS incluse dans le
 * message exposé (évite la fuite d'information vers le client).
 */
const INVALID_LOCAL_DATETIME_MESSAGE =
  'parseLocalDateTimeString: chaîne de date+heure locale invalide ' +
  '(attendu YYYY-MM-DDTHH:MM:SS sans offset, avec composants civils valides).';

/**
 * Parse une chaîne de date+heure locale ISO 8601 sans offset (ex :
 * "2026-08-08T22:08:00") en un objet {@link LocalDateTime}.
 *
 * La chaîne représente une heure locale dans le fuseau IANA du lieu de
 * location. Aucun offset n'est inclus — la conversion en UTC est effectuée
 * séparément via {@link localDateTimeToUtc} avec le fuseau du lieu.
 *
 * G7P-B2-B Round 3 : validation sémantique stricte (pas seulement regex).
 * Après le parsing regex, on vérifie :
 * - mois entre 1 et 12 ;
 * - heure entre 0 et 23 ;
 * - minute entre 0 et 59 ;
 * - seconde entre 0 et 59 ;
 * - jour réellement valide pour le mois et l'année (années bissextiles incluses) ;
 * - round-trip civil exact via construction UTC pure (sans dépendre du fuseau système).
 *
 * On n'utilise jamais `new Date(stringWithoutOffset)` (dépend de la machine).
 * On construit via `Date.UTC` puis on vérifie que tous les composants UTC
 * récupérés correspondent exactement aux valeurs d'entrée. Toute incohérence
 * (ex : 30 février, 31 avril, mois 13, heure 24) produit une erreur.
 *
 * @throws LocalToUtcError(INVALID_LOCAL_DATETIME_STRING) si le format ou les
 *   composants civils sont invalides. Le message est générique (sans valeur
 *   hostile).
 */
export function parseLocalDateTimeString(value: string): LocalDateTime {
  const match = LOCAL_DATETIME_RE.exec(value);
  if (!match) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  const second = parseInt(match[6]!, 10);

  // Plages de composants civils (vérification explicite avant la construction UTC).
  if (month < 1 || month > 12) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }
  if (hour < 0 || hour > 23) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }
  if (minute < 0 || minute > 59) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }
  if (second < 0 || second > 59) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }
  if (day < 1 || day > 31) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }

  // Construction UTC pure + vérification du round-trip civil (sans dépendre du
  // fuseau système). Date.UTC normalise les débordements (ex : jour 32 → mois
  // suivant, 30 février → 2 mars), donc si les composants UTC récupérés ne
  // correspondent pas exactement aux valeurs d'entrée, la date est impossible
  // (ex : 2026-02-30, 2026-04-31, 2026-02-29 année non bissextile).
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new LocalToUtcError('INVALID_LOCAL_DATETIME_STRING', INVALID_LOCAL_DATETIME_MESSAGE);
  }

  return { year, month, day, hour, minute, second };
}
