import type { PublicSearchFilterOptions } from '@uttily/core';
import type { CompiledPartyRequirement } from '@uttily/intelligence';
import type { PublicSearchFormValues } from '@/lib/public-search';
import { MAX_SEARCH_PEOPLE } from '@/lib/search-people';

export type SearchField = 'destination' | 'equipment' | 'dates' | 'people';
export type SearchLocale = 'fr' | 'en';
type DestinationOption = PublicSearchFilterOptions['destinations'][number];
export interface SearchSelection {
  destinationPublicId: string;
  categoryId: string;
  startDate: string;
  endDate: string;
  withTimes: boolean;
  startTime: string;
  endTime: string;
  people: number;
  requirements?: readonly CompiledPartyRequirement[] | undefined;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Resolves an AI destination against the public catalogue without trusting a
 * model-provided identifier that is not present in the current options.
 */
export function resolveDestinationPublicId(
  destinations: readonly DestinationOption[],
  requestedPublicId?: string | null,
  requestedLabel?: string | null,
): string {
  if (requestedPublicId) {
    const idIsKnown = destinations.some(
      (destination) => destination.publicId === requestedPublicId,
    );
    if (idIsKnown || destinations.length === 0) return requestedPublicId;
  }

  const target = normalizeSearchText(requestedLabel ?? '');
  if (!target) return '';

  const exactMatch = destinations.find((destination) => {
    const label = normalizeSearchText(destination.label);
    const slug = normalizeSearchText(destination.slug);
    return label === target || slug === target;
  });
  if (exactMatch) return exactMatch.publicId;

  const partialMatch = destinations.find((destination) => {
    const label = normalizeSearchText(destination.label);
    const slug = normalizeSearchText(destination.slug);
    return (
      (target.length >= 3 && label.includes(target)) ||
      (target.length >= 3 && slug.includes(target)) ||
      (label.length >= 3 && target.includes(label)) ||
      (slug.length >= 3 && target.includes(slug))
    );
  });
  return partialMatch?.publicId ?? '';
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
    requirements: values?.packRequirements
      ? safeParseRequirements(values.packRequirements)
      : undefined,
  };
}

function safeParseRequirements(raw: string): readonly CompiledPartyRequirement[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function dateSelectionError(
  selection: SearchSelection,
  locale: SearchLocale,
): string | null {
  const fr = locale === 'fr';
  const end = selection.endDate || selection.startDate;
  if (!civilDate(selection.startDate) || !civilDate(end))
    return fr ? 'Choisissez votre créneau.' : 'Choose your rental slot.';
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
  if (selection.requirements && selection.requirements.length > 0) {
    params.set('packRequirements', JSON.stringify(selection.requirements));
  }
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
  let end = civilDate(selection.endDate || selection.startDate);
  if (!start || !end) return locale === 'fr' ? 'Ajouter des dates' : 'Add dates';
  if (end < start) end = start;
  const format = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const range =
    start.getTime() === end.getTime() ? format.format(start) : format.formatRange(start, end);
  return selection.withTimes && selection.startTime && selection.endTime
    ? `${range} · ${selection.startTime}–${selection.endTime}`
    : range;
}
