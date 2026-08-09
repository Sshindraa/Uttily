import {
  createPublicSearchCursorCodec,
  isValidPublicSearchViewport,
  PostgresPhotoPublicationGate,
  PublicSearchError,
  searchPublicOffers,
  type PublicSearchErrorCode,
  type SearchPublicOffersInput,
  type SearchPublicOffersResult,
  type PublicSearchViewport,
} from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

export type PublicUiLocale = 'fr' | 'en';

export interface PublicSearchFormValues {
  destinationPublicId: string;
  categoryId: string;
  intent: 'DAY_RANGE' | 'TIME_RANGE';
  startDate: string;
  endDateExclusive: string;
  startAt: string;
  endAt: string;
  viewport?: PublicSearchViewport;
  pageSize?: number;
}

export type PublicSearchParseResult =
  | { kind: 'EMPTY'; values: PublicSearchFormValues }
  | { kind: 'INVALID'; values: PublicSearchFormValues; fieldErrors: Record<string, string> }
  | { kind: 'VALID'; values: PublicSearchFormValues; input: SearchPublicOffersInput };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DECIMAL_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DEFAULT_PAGE_SIZE = 24;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 48;
const VIEWPORT_QUERY_KEYS = [
  'viewportSouth',
  'viewportWest',
  'viewportNorth',
  'viewportEast',
] as const;

export function parsePublicSearchParams(
  params: URLSearchParams,
  locale: PublicUiLocale,
): PublicSearchParseResult {
  const rawIntent = params.get('intent');
  const intent = rawIntent === 'TIME_RANGE' ? 'TIME_RANGE' : 'DAY_RANGE';
  const values: PublicSearchFormValues = {
    destinationPublicId: params.get('destinationPublicId')?.trim() ?? '',
    categoryId: params.get('categoryId')?.trim() ?? '',
    intent,
    startDate: params.get('startDate')?.trim() ?? '',
    endDateExclusive: params.get('endDateExclusive')?.trim() ?? '',
    startAt: params.get('startAt')?.trim() ?? '',
    endAt: params.get('endAt')?.trim() ?? '',
  };

  const searchRequested =
    params.has('destinationPublicId') ||
    params.has('intent') ||
    params.has('pageSize') ||
    VIEWPORT_QUERY_KEYS.some((key) => params.has(key));
  if (!searchRequested) return { kind: 'EMPTY', values };

  const viewportResult = parseViewportQuery(params, locale);
  const fieldErrors: Record<string, string> = { ...viewportResult.fieldErrors };
  if (rawIntent !== 'DAY_RANGE' && rawIntent !== 'TIME_RANGE') {
    fieldErrors.intent = locale === 'fr' ? 'Type de durée invalide.' : 'Invalid rental period.';
  }
  if (!UUID_RE.test(values.destinationPublicId)) {
    fieldErrors.destinationPublicId =
      locale === 'fr' ? 'Choisissez une destination.' : 'Choose a destination.';
  }
  if (values.categoryId && !UUID_RE.test(values.categoryId)) {
    fieldErrors.categoryId = locale === 'fr' ? 'Catégorie invalide.' : 'Invalid category.';
  }
  const cursor = params.get('cursor');
  if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) {
    fieldErrors.cursor = locale === 'fr' ? 'Pagination invalide.' : 'Invalid pagination.';
  }

  const pageSizeResult = readSingleParam(params, 'pageSize');
  let pageSize = DEFAULT_PAGE_SIZE;
  if (pageSizeResult.duplicate || pageSizeResult.value === '') {
    fieldErrors.pageSize = locale === 'fr' ? 'Taille de page invalide.' : 'Invalid page size.';
  } else if (pageSizeResult.value !== null) {
    const parsedPageSize = Number(pageSizeResult.value);
    if (
      !/^\d+$/.test(pageSizeResult.value) ||
      !Number.isSafeInteger(parsedPageSize) ||
      parsedPageSize < MIN_PAGE_SIZE ||
      parsedPageSize > MAX_PAGE_SIZE
    ) {
      fieldErrors.pageSize = locale === 'fr' ? 'Taille de page invalide.' : 'Invalid page size.';
    } else {
      pageSize = parsedPageSize;
    }
  }

  if (intent === 'DAY_RANGE') {
    if (!isValidDate(values.startDate)) {
      fieldErrors.startDate = locale === 'fr' ? 'Date de début invalide.' : 'Invalid start date.';
    }
    if (!isValidDate(values.endDateExclusive)) {
      fieldErrors.endDateExclusive =
        locale === 'fr' ? 'Date de fin invalide.' : 'Invalid end date.';
    } else if (values.startDate && values.endDateExclusive <= values.startDate) {
      fieldErrors.endDateExclusive =
        locale === 'fr'
          ? 'La date de fin doit être postérieure au début.'
          : 'The end date must be after the start date.';
    }
  } else {
    if (!isValidLocalDateTime(values.startAt)) {
      fieldErrors.startAt =
        locale === 'fr' ? 'Date et heure de début invalides.' : 'Invalid start date and time.';
    }
    if (!isValidLocalDateTime(values.endAt)) {
      fieldErrors.endAt =
        locale === 'fr' ? 'Date et heure de fin invalides.' : 'Invalid end date and time.';
    } else if (values.startAt && values.endAt <= values.startAt) {
      fieldErrors.endAt =
        locale === 'fr'
          ? 'La fin doit être postérieure au début.'
          : 'The end must be after the start.';
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { kind: 'INVALID', values, fieldErrors };
  }

  const input: SearchPublicOffersInput = {
    destinationPublicId: values.destinationPublicId,
    locale,
    intent:
      intent === 'DAY_RANGE'
        ? {
            kind: 'DAY_RANGE',
            startDate: values.startDate,
            endDateExclusive: values.endDateExclusive,
          }
        : {
            kind: 'TIME_RANGE',
            startAt: `${values.startAt}:00`,
            endAt: `${values.endAt}:00`,
          },
    pageSize,
    ...(values.categoryId ? { categoryId: values.categoryId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(viewportResult.viewport ? { viewport: viewportResult.viewport } : {}),
  };
  values.pageSize = pageSize;
  if (viewportResult.viewport) values.viewport = viewportResult.viewport;
  return { kind: 'VALID', values, input };
}

function readSingleParam(
  params: URLSearchParams,
  name: string,
): {
  value: string | null;
  duplicate: boolean;
} {
  const values = params.getAll(name);
  return {
    value: values[0] ?? null,
    duplicate: values.length > 1,
  };
}

function parseViewportQuery(
  params: URLSearchParams,
  locale: PublicUiLocale,
): { viewport?: PublicSearchViewport; fieldErrors: Record<string, string> } {
  const present = VIEWPORT_QUERY_KEYS.some((key) => params.has(key));
  if (!present) return { fieldErrors: {} };

  const fieldErrors: Record<string, string> = {};
  const raw: Record<(typeof VIEWPORT_QUERY_KEYS)[number], string | null> = {
    viewportSouth: null,
    viewportWest: null,
    viewportNorth: null,
    viewportEast: null,
  };
  for (const key of VIEWPORT_QUERY_KEYS) {
    const result = readSingleParam(params, key);
    raw[key] = result.value;
    if (result.duplicate) {
      fieldErrors[key] = locale === 'fr' ? 'Zone de carte invalide.' : 'Invalid map area.';
    }
  }

  const parsed = {} as Record<(typeof VIEWPORT_QUERY_KEYS)[number], number>;
  for (const key of VIEWPORT_QUERY_KEYS) {
    const value = raw[key];
    if (value === null || value === '' || !DECIMAL_RE.test(value)) {
      fieldErrors[key] = locale === 'fr' ? 'Zone de carte invalide.' : 'Invalid map area.';
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      fieldErrors[key] = locale === 'fr' ? 'Zone de carte invalide.' : 'Invalid map area.';
      continue;
    }
    parsed[key] = number;
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const viewport: PublicSearchViewport = {
    kind: 'VIEWPORT',
    south: parsed.viewportSouth,
    west: parsed.viewportWest,
    north: parsed.viewportNorth,
    east: parsed.viewportEast,
  };
  if (!isValidPublicSearchViewport(viewport)) {
    for (const key of VIEWPORT_QUERY_KEYS) {
      fieldErrors[key] = locale === 'fr' ? 'Zone de carte invalide.' : 'Invalid map area.';
    }
    return { fieldErrors };
  }
  return { viewport, fieldErrors };
}

export async function executePublicSearch(
  db: DatabaseClient,
  input: SearchPublicOffersInput,
  secret: string | undefined = process.env.PUBLIC_SEARCH_CURSOR_SECRET,
): Promise<SearchPublicOffersResult> {
  if (!secret) {
    throw new PublicSearchError(
      'CURSOR_CODEC_UNAVAILABLE',
      'Le secret de pagination publique est absent.',
    );
  }
  let cursorCodec: ReturnType<typeof createPublicSearchCursorCodec>;
  try {
    cursorCodec = createPublicSearchCursorCodec(secret);
  } catch (error) {
    throw new PublicSearchError(
      'CURSOR_CODEC_UNAVAILABLE',
      'La configuration de pagination publique est invalide.',
      { cause: error },
    );
  }
  return searchPublicOffers(db, input, {
    publicationGate: new PostgresPhotoPublicationGate(),
    cursorCodec,
  });
}

export function publicSearchHttpStatus(code: PublicSearchErrorCode): number {
  switch (code) {
    case 'DESTINATION_NOT_FOUND':
    case 'CATEGORY_NOT_FOUND':
      return 404;
    case 'DESTINATION_INACTIVE':
    case 'COUNTRY_INACTIVE':
    case 'CATEGORY_INACTIVE':
      return 422;
    case 'PRICING_UNAVAILABLE':
    case 'PUBLICATION_GATE_UNAVAILABLE':
    case 'CURSOR_CODEC_UNAVAILABLE':
      return 503;
    case 'INVALID_INPUT':
    case 'INVALID_CURSOR':
    case 'INVALID_LOCAL_TIME':
      return 400;
  }
}

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
}

function isValidLocalDateTime(value: string): boolean {
  if (!LOCAL_DATE_TIME_RE.test(value)) return false;
  const [date, time] = value.split('T');
  const [hour, minute] = time!.split(':').map(Number);
  return isValidDate(date!) && hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59;
}
