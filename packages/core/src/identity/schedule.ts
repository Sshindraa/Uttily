import { and, eq } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { locationOpeningHours, locationScheduleExceptions } from '@uttily/database';

export interface EffectiveScheduleSlot {
  openTime: string; // HH:MM:SS
  closeTime: string; // HH:MM:SS
}

export interface EffectiveLocationSchedule {
  locationId: string;
  localDate: string; // YYYY-MM-DD
  isOpen: boolean;
  isException: boolean;
  exceptionKind?: 'CLOSED' | 'OPEN_INTERVAL';
  reason?: string | null;
  slots: EffectiveScheduleSlot[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeTime(t: string | null | undefined): string {
  if (!t) return '00:00:00';
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`;
  return t;
}

/**
 * Calcule le jour de la semaine (0 = Lundi, 6 = Dimanche) pour une date 'YYYY-MM-DD'.
 */
export function getWeekdayFromLocalDate(localDate: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Date invalide: ${localDate}`);
  const dateObj = new Date(Date.UTC(year, month - 1, day));
  // getUTCDay() retourne 0 pour Dimanche, 1 pour Lundi ... 6 pour Samedi
  // On convertit vers 0=Lundi, ..., 6=Dimanche
  return (dateObj.getUTCDay() + 6) % 7;
}

/**
 * Résout le planning effectif pour une date locale de façon PURE à partir des règles
 * d'horaires d'ouverture et de la liste des exceptions.
 *
 * Utilisé à la fois par les requêtes DB de résolution de planning, le moteur de pricing
 * et la recherche publique, garantissant zéro divergence.
 */
export function resolveEffectiveScheduleFromRules(
  localDate: string,
  openingHours: Array<{ weekday: number; openTime: string; closeTime: string }>,
  scheduleExceptions: Array<{
    localDate: string;
    kind: 'CLOSED' | 'OPEN_INTERVAL';
    openTime?: string | null;
    closeTime?: string | null;
    reason?: string | null;
  }> = [],
  locationId: string = '',
): EffectiveLocationSchedule {
  if (!DATE_RE.test(localDate)) {
    throw new Error(`Format de date invalide: "${localDate}" (attendu YYYY-MM-DD).`);
  }

  // 1. Chercher s'il existe une exception pour cette date
  const exception = scheduleExceptions.find((ex) => ex.localDate === localDate);
  if (exception) {
    if (exception.kind === 'CLOSED') {
      return {
        locationId,
        localDate,
        isOpen: false,
        isException: true,
        exceptionKind: 'CLOSED',
        reason: exception.reason ?? null,
        slots: [],
      };
    }

    if (exception.kind === 'OPEN_INTERVAL' && exception.openTime && exception.closeTime) {
      return {
        locationId,
        localDate,
        isOpen: true,
        isException: true,
        exceptionKind: 'OPEN_INTERVAL',
        reason: exception.reason ?? null,
        slots: [
          {
            openTime: normalizeTime(exception.openTime),
            closeTime: normalizeTime(exception.closeTime),
          },
        ],
      };
    }
  }

  // 2. Pas d'exception : trouver les horaires hebdomadaires normaux
  const weekday = getWeekdayFromLocalDate(localDate);
  const regularHours = openingHours
    .filter((h) => h.weekday === weekday)
    .sort((a, b) => (a.openTime < b.openTime ? -1 : a.openTime > b.openTime ? 1 : 0));

  if (regularHours.length === 0) {
    return {
      locationId,
      localDate,
      isOpen: false,
      isException: false,
      slots: [],
    };
  }

  return {
    locationId,
    localDate,
    isOpen: true,
    isException: false,
    slots: regularHours.map((h) => ({
      openTime: normalizeTime(h.openTime),
      closeTime: normalizeTime(h.closeTime),
    })),
  };
}

/**
 * Autorité unique de résolution des horaires effectifs d'un établissement pour une date locale (Chantier 15.1 / 15.2).
 *
 * Règle :
 * 1. Exception CLOSED -> fermé
 * 2. Exception OPEN_INTERVAL -> cet intervalle remplace les horaires hebdomadaires
 * 3. Aucune exception -> horaires hebdomadaires normaux
 */
export async function resolveEffectiveLocationSchedule(
  db: DatabaseClient | DbExecutor,
  organizationId: string,
  locationId: string,
  localDate: string,
): Promise<EffectiveLocationSchedule> {
  if (!DATE_RE.test(localDate)) {
    throw new Error(`Format de date invalide: "${localDate}" (attendu YYYY-MM-DD).`);
  }

  // 1. Chercher s'il existe une exception pour cette date et cette organisation
  const exceptions = await db
    .select({
      localDate: locationScheduleExceptions.localDate,
      kind: locationScheduleExceptions.kind,
      openTime: locationScheduleExceptions.openTime,
      closeTime: locationScheduleExceptions.closeTime,
      reason: locationScheduleExceptions.reason,
    })
    .from(locationScheduleExceptions)
    .where(
      and(
        eq(locationScheduleExceptions.organizationId, organizationId),
        eq(locationScheduleExceptions.locationId, locationId),
        eq(locationScheduleExceptions.localDate, localDate),
      ),
    );

  // 2. Charger les horaires hebdomadaires
  const weekday = getWeekdayFromLocalDate(localDate);
  const regularHours = await db
    .select({
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(
      and(
        eq(locationOpeningHours.locationId, locationId),
        eq(locationOpeningHours.weekday, weekday),
      ),
    );

  return resolveEffectiveScheduleFromRules(
    localDate,
    regularHours.map((h) => ({
      weekday: h.weekday,
      openTime: typeof h.openTime === 'string' ? h.openTime : String(h.openTime),
      closeTime: typeof h.closeTime === 'string' ? h.closeTime : String(h.closeTime),
    })),
    exceptions,
    locationId,
  );
}

/**
 * Vérifie si un horaire 'HH:MM:SS' ou 'HH:MM' est compris dans les créneaux d'un planning effectif.
 */
export function isTimeWithinEffectiveSchedule(
  time: string,
  schedule: EffectiveLocationSchedule,
): boolean {
  if (!schedule.isOpen || schedule.slots.length === 0) return false;
  const normalizedTime = normalizeTime(time);
  return schedule.slots.some(
    (slot) => normalizedTime >= slot.openTime && normalizedTime <= slot.closeTime,
  );
}
