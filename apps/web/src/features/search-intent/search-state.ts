import type { PublicSearchFilterOptions } from '@uttily/core';
import type { PublicSearchFormValues } from '@/lib/public-search';
import { MAX_SEARCH_PEOPLE } from '@/lib/search-people';

export type SearchField = 'destination' | 'equipment' | 'dates' | 'people';
export type SearchLocale = 'fr' | 'en';
export interface SearchSelection {
  destinationPublicId: string;
  categoryId: string;
  startDate: string;
  endDate: string;
  withTimes: boolean;
  startTime: string;
  endTime: string;
  people: number;
}

export function civilDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function shiftDate(value: string, days: number): string {
  const date = civilDate(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  const shifted = date.toISOString().slice(0, 10);
  return civilDate(shifted) ? shifted : '';
}

export function initialSelection(values?: PublicSearchFormValues): SearchSelection {
  return {
    destinationPublicId: values?.destinationPublicId ?? '',
    categoryId: values?.categoryId ?? '',
    startDate:
      values?.intent === 'TIME_RANGE' ? values.startAt.slice(0, 10) : (values?.startDate ?? ''),
    endDate:
      values?.intent === 'TIME_RANGE'
        ? values.endAt.slice(0, 10)
        : shiftDate(values?.endDateExclusive ?? '', -1),
    withTimes: values?.intent === 'TIME_RANGE',
    startTime: values?.startAt.slice(11, 16) ?? '',
    endTime: values?.endAt.slice(11, 16) ?? '',
    people: values?.peopleCount ?? 1,
  };
}

export function dateSelectionError(
  selection: SearchSelection,
  locale: SearchLocale,
): string | null {
  const fr = locale === 'fr';
  const end = selection.endDate || selection.startDate;
  if (!civilDate(selection.startDate) || !civilDate(end))
    return fr ? 'Choisissez vos dates.' : 'Choose your dates.';
  if (end < selection.startDate)
    return fr ? 'La fin doit suivre le début.' : 'The end must follow the start.';
  if (selection.withTimes) {
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!time.test(selection.startTime) || !time.test(selection.endTime))
      return fr ? 'Précisez les deux horaires.' : 'Choose both times.';
    if (`${end}T${selection.endTime}` <= `${selection.startDate}T${selection.startTime}`)
      return fr
        ? 'L’heure de fin doit être après le début.'
        : 'The end time must be after the start.';
  } else if (!shiftDate(end, 1)) return fr ? 'Date de fin invalide.' : 'Invalid end date.';
  return null;
}

export function buildSearchQuery(
  selection: SearchSelection,
  options: PublicSearchFilterOptions,
  locale: SearchLocale,
): { ok: true; query: string } | { ok: false; field: SearchField; message: string } {
  const fr = locale === 'fr';
  if (!options.destinations.some((d) => d.publicId === selection.destinationPublicId)) {
    return {
      ok: false,
      field: 'destination',
      message: fr ? 'Choisissez une destination proposée.' : 'Choose an available destination.',
    };
  }
  if (selection.categoryId && !options.categories.some((c) => c.id === selection.categoryId)) {
    return {
      ok: false,
      field: 'equipment',
      message: fr ? 'Choisissez un équipement proposé.' : 'Choose an available equipment category.',
    };
  }
  const dateError = dateSelectionError(selection, locale);
  if (dateError) return { ok: false, field: 'dates', message: dateError };
  if (
    !Number.isInteger(selection.people) ||
    selection.people < 1 ||
    selection.people > MAX_SEARCH_PEOPLE
  ) {
    return {
      ok: false,
      field: 'people',
      message: fr ? 'Indiquez entre 1 et 99 personnes.' : 'Enter between 1 and 99 people.',
    };
  }
  const end = selection.endDate || selection.startDate;
  const params = new URLSearchParams({
    destinationPublicId: selection.destinationPublicId,
    intent: selection.withTimes ? 'TIME_RANGE' : 'DAY_RANGE',
  });
  if (selection.categoryId) params.set('categoryId', selection.categoryId);
  params.set('peopleCount', String(selection.people));
  if (selection.withTimes) {
    params.set('startAt', `${selection.startDate}T${selection.startTime}`);
    params.set('endAt', `${end}T${selection.endTime}`);
  } else {
    params.set('startDate', selection.startDate);
    params.set('endDateExclusive', shiftDate(end, 1));
  }
  return { ok: true, query: params.toString() };
}

export function dateSummary(selection: SearchSelection, locale: SearchLocale): string {
  const start = civilDate(selection.startDate);
  const end = civilDate(selection.endDate || selection.startDate);
  if (!start || !end) return locale === 'fr' ? 'Quand partez-vous ?' : 'When are you going?';
  const format = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const range =
    start.getTime() === end.getTime()
      ? format.format(start)
      : end < start
        ? `${format.format(start)} – ${format.format(end)}`
        : format.formatRange(start, end);
  return selection.withTimes && selection.startTime && selection.endTime
    ? `${range} · ${selection.startTime}–${selection.endTime}`
    : range;
}
