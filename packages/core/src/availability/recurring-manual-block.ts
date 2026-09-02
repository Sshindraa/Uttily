import { civilDayNumber, civilDayNumberToDate } from '../pricing-plans/time-utils';
import { LocalToUtcError, localDateTimeStringToUtc } from '../pricing-plans/local-to-utc';
import { isValidTimeZone } from '../identity/time-zone';
import { CatalogError } from '../catalog/errors';

export const RECURRING_MANUAL_BLOCK_FREQUENCY = 'WEEKLY' as const;
export const MAX_RECURRING_MANUAL_BLOCK_DAYS = 84;
export const MAX_RECURRING_MANUAL_BLOCK_WEEKS = 12;

export type RecurringManualBlockFrequency = typeof RECURRING_MANUAL_BLOCK_FREQUENCY;

export interface RecurringManualBlockScheduleInput {
  frequency?: unknown;
  startDate: unknown;
  endDate: unknown;
  startTime: unknown;
  endTime: unknown;
  timeZone: unknown;
}

export interface NormalizedRecurringManualBlockSchedule {
  frequency: RecurringManualBlockFrequency;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  timeZone: string;
}

export interface RecurringManualBlockOccurrencePeriod {
  occurrenceDate: string;
  startAt: Date;
  endAt: Date;
}

/**
 * Valide une règle V1 et la normalise sans jamais utiliser le fuseau du
 * processus. Les dates sont civiles et les horaires sont des heures murales.
 */
export function normalizeRecurringManualBlockSchedule(
  input: RecurringManualBlockScheduleInput,
): NormalizedRecurringManualBlockSchedule {
  const frequency = input.frequency ?? RECURRING_MANUAL_BLOCK_FREQUENCY;
  if (frequency !== RECURRING_MANUAL_BLOCK_FREQUENCY) {
    throw new CatalogError('VALIDATION', 'Seule la périodicité hebdomadaire est disponible.');
  }

  const startDate = normalizeLocalDate(input.startDate, 'startDate');
  const endDate = normalizeLocalDate(input.endDate, 'endDate');
  const startDay = civilDayNumberFor(startDate);
  const endDay = civilDayNumberFor(endDate);
  const durationDays = endDay - startDay;
  if (durationDays < 0) {
    throw new CatalogError('VALIDATION', 'La date de fin doit être après la date de début.', {
      endDate: 'La date de fin doit être après la date de début.',
    });
  }
  if (durationDays > MAX_RECURRING_MANUAL_BLOCK_DAYS) {
    throw new CatalogError(
      'VALIDATION',
      `Une série ne peut pas dépasser ${MAX_RECURRING_MANUAL_BLOCK_WEEKS} semaines.`,
      { endDate: `La série est limitée à ${MAX_RECURRING_MANUAL_BLOCK_WEEKS} semaines.` },
    );
  }

  const startTime = normalizeLocalTime(input.startTime, 'startTime');
  const endTime = normalizeLocalTime(input.endTime, 'endTime');
  if (endTime <= startTime) {
    throw new CatalogError(
      'VALIDATION',
      "L'heure de fin doit être après l'heure de début le même jour.",
      { endTime: "L'heure de fin doit être après l'heure de début." },
    );
  }

  if (typeof input.timeZone !== 'string' || !isValidTimeZone(input.timeZone)) {
    throw new CatalogError('VALIDATION', 'Un fuseau horaire IANA valide est requis.', {
      timeZone: 'Fuseau horaire IANA invalide.',
    });
  }

  return { frequency, startDate, endDate, startTime, endTime, timeZone: input.timeZone };
}

/**
 * Calcule les occurrences inclusives du même jour de semaine, en reconvertissant
 * chaque date séparément afin de respecter les changements de décalage DST.
 */
export function calculateWeeklyRecurringManualBlockOccurrences(
  input: RecurringManualBlockScheduleInput | NormalizedRecurringManualBlockSchedule,
): RecurringManualBlockOccurrencePeriod[] {
  const schedule = isNormalizedSchedule(input)
    ? input
    : normalizeRecurringManualBlockSchedule(input);
  const occurrences: RecurringManualBlockOccurrencePeriod[] = [];
  const startDay = civilDayNumberFor(schedule.startDate);
  const endDay = civilDayNumberFor(schedule.endDate);

  for (let day = startDay; day <= endDay; day += 7) {
    const occurrenceDate = civilDayNumberToDate(day);
    try {
      const startAt = localDateTimeStringToUtc(
        `${occurrenceDate}T${schedule.startTime}`,
        schedule.timeZone,
      );
      const endAt = localDateTimeStringToUtc(
        `${occurrenceDate}T${schedule.endTime}`,
        schedule.timeZone,
      );
      if (endAt <= startAt) {
        throw new CatalogError(
          'VALIDATION',
          "L'heure de fin doit être après l'heure de début le même jour.",
        );
      }
      occurrences.push({ occurrenceDate, startAt, endAt });
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw toLocalTimeValidationError(error);
    }
  }

  return occurrences;
}

function normalizeLocalDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CatalogError('VALIDATION', 'Une date civile au format AAAA-MM-JJ est requise.', {
      [field]: 'Format attendu : AAAA-MM-JJ.',
    });
  }
  const dayNumber = civilDayNumberFor(value, field);
  const normalized = civilDayNumberToDate(dayNumber);
  if (normalized !== value) {
    throw new CatalogError('VALIDATION', 'La date civile est invalide.', {
      [field]: 'Date invalide.',
    });
  }
  return value;
}

function civilDayNumberFor(value: string, field = 'date'): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new CatalogError('VALIDATION', 'La date civile est invalide.', {
      [field]: 'Date invalide.',
    });
  }
  return civilDayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
}

function normalizeLocalTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CatalogError('VALIDATION', 'Une heure locale au format HH:MM est requise.', {
      [field]: 'Format attendu : HH:MM.',
    });
  }
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) {
    throw new CatalogError('VALIDATION', 'Une heure locale au format HH:MM est requise.', {
      [field]: 'Format attendu : HH:MM.',
    });
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CatalogError('VALIDATION', "L'heure locale est invalide.", {
      [field]: 'Heure invalide.',
    });
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function isNormalizedSchedule(
  input: RecurringManualBlockScheduleInput | NormalizedRecurringManualBlockSchedule,
): input is NormalizedRecurringManualBlockSchedule {
  return (
    input.frequency === RECURRING_MANUAL_BLOCK_FREQUENCY &&
    typeof input.startDate === 'string' &&
    typeof input.endDate === 'string' &&
    typeof input.startTime === 'string' &&
    /^\d{2}:\d{2}:\d{2}$/.test(input.startTime) &&
    typeof input.endTime === 'string' &&
    /^\d{2}:\d{2}:\d{2}$/.test(input.endTime) &&
    typeof input.timeZone === 'string'
  );
}

function toLocalTimeValidationError(error: unknown): CatalogError {
  if (error instanceof LocalToUtcError) {
    const message =
      error.code === 'AMBIGUOUS_LOCAL_TIME'
        ? "Une heure locale est ambiguë dans le fuseau de l'établissement. Choisissez un autre horaire."
        : error.code === 'NON_EXISTENT_LOCAL_TIME'
          ? "Une heure locale n'existe pas dans le fuseau de l'établissement. Choisissez un autre horaire."
          : 'Le calendrier local est invalide.';
    return new CatalogError('VALIDATION', message);
  }
  throw error;
}
