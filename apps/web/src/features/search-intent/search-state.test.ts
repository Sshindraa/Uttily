import { describe, expect, it } from 'vitest';
import { parsePublicSearchParams } from '@/lib/public-search';
import {
  buildSearchQuery,
  civilDate,
  dateSummary,
  initialSelection,
  shiftDate,
  type SearchSelection,
} from './search-state';

const destinationId = '00000000-0000-0000-0000-000000000001';
const categoryId = '00000000-0000-0000-0000-000000000002';
const options = {
  destinations: [
    {
      publicId: destinationId,
      slug: 'annecy',
      label: 'Annecy',
      countryCode: 'FR',
      placeType: 'CITY',
      center: { latitude: 45.9, longitude: 6.1 },
      bbox: { south: 45, west: 6, north: 46, east: 7 },
    },
  ],
  categories: [{ id: categoryId, slug: 'bike', name: 'Vélos' }],
};
const selection: SearchSelection = {
  ...initialSelection(),
  destinationPublicId: destinationId,
  categoryId,
  startDate: '2026-09-12',
  endDate: '2026-09-13',
  people: 4,
};

describe('search intent to existing availability contract', () => {
  it('turns inclusive selected days into an exclusive end, without confusing people and quantity', () => {
    const result = buildSearchQuery(selection, options, 'fr');
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Expected a query');
    const params = new URLSearchParams(result.query);
    expect(params.get('endDateExclusive')).toBe('2026-09-14');
    expect(params.get('peopleCount')).toBe('4');
    expect(params.has('quantity')).toBe(false);
    const parsed = parsePublicSearchParams(params, 'fr');
    expect(parsed.kind).toBe('VALID');
    if (parsed.kind !== 'VALID') throw Error('Expected valid server input');
    expect(parsed.input.intent).toEqual({
      kind: 'DAY_RANGE',
      startDate: '2026-09-12',
      endDateExclusive: '2026-09-14',
    });
    expect(parsed.input).not.toHaveProperty('peopleCount');
    expect(parsed.input).not.toHaveProperty('quantity');
    expect(initialSelection(parsed.values)).toEqual(selection);
  });
  it('supports one day, year boundaries and leap days with calendar arithmetic', () => {
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(civilDate('2026-02-29')).toBeNull();
    const result = buildSearchQuery({ ...selection, endDate: '' }, options, 'fr');
    expect(result.ok && new URLSearchParams(result.query).get('endDateExclusive')).toBe(
      '2026-09-13',
    );
  });
  it('keeps local times untouched and never computes a tariff or timezone in the browser', () => {
    const result = buildSearchQuery(
      {
        ...selection,
        withTimes: true,
        endDate: '2026-09-12',
        startTime: '09:00',
        endTime: '13:00',
      },
      options,
      'en',
    );
    if (!result.ok) throw Error('Expected query');
    const params = new URLSearchParams(result.query);
    expect(params.get('startAt')).toBe('2026-09-12T09:00');
    expect(params.get('endAt')).toBe('2026-09-12T13:00');
    expect(params.has('startDate')).toBe(false);
    expect(params.has('price')).toBe(false);
  });
  it('targets the missing panel instead of launching a second questionnaire', () => {
    expect(
      buildSearchQuery({ ...selection, destinationPublicId: '' }, options, 'fr'),
    ).toMatchObject({ ok: false, field: 'destination' });
    expect(
      buildSearchQuery({ ...selection, categoryId: 'not-in-catalogue' }, options, 'fr'),
    ).toMatchObject({ ok: false, field: 'equipment' });
    expect(buildSearchQuery({ ...selection, startDate: '' }, options, 'fr')).toMatchObject({
      ok: false,
      field: 'dates',
    });
    expect(buildSearchQuery({ ...selection, people: 0 }, options, 'fr')).toMatchObject({
      ok: false,
      field: 'people',
    });
    expect(buildSearchQuery({ ...selection, people: 1.5 }, options, 'fr').ok).toBe(false);
    expect(buildSearchQuery({ ...selection, categoryId: '' }, options, 'fr').ok).toBe(true);
  });
  it('rejects reversed dates, incomplete times and nonpositive periods without crashing the summary', () => {
    expect(buildSearchQuery({ ...selection, endDate: '2026-09-01' }, options, 'fr').ok).toBe(false);
    expect(() => dateSummary({ ...selection, endDate: '2026-09-01' }, 'fr')).not.toThrow();
    expect(buildSearchQuery({ ...selection, withTimes: true }, options, 'fr').ok).toBe(false);
    expect(
      buildSearchQuery(
        {
          ...selection,
          withTimes: true,
          endDate: selection.startDate,
          startTime: '13:00',
          endTime: '13:00',
        },
        options,
        'fr',
      ).ok,
    ).toBe(false);
    expect(
      buildSearchQuery(
        { ...selection, withTimes: true, startTime: '25:00', endTime: '13:00' },
        options,
        'fr',
      ).ok,
    ).toBe(false);
  });
});
