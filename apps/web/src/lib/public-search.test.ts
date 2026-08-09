import { describe, expect, it } from 'vitest';
import {
  executePublicSearch,
  parsePublicSearchParams,
  publicSearchHttpStatus,
} from './public-search';

const DESTINATION_ID = '00000000-0000-0000-0000-000000000001';

describe('parsePublicSearchParams', () => {
  it('considère une URL sans critères comme un état initial', () => {
    expect(parsePublicSearchParams(new URLSearchParams(), 'fr').kind).toBe('EMPTY');
  });

  it('construit un DAY_RANGE strict avec catégorie optionnelle', () => {
    const params = new URLSearchParams({
      destinationPublicId: DESTINATION_ID,
      intent: 'DAY_RANGE',
      startDate: '2026-08-10',
      endDateExclusive: '2026-08-13',
      categoryId: '00000000-0000-0000-0000-000000000002',
    });
    const result = parsePublicSearchParams(params, 'fr');
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') throw new Error('VALID attendu');
    expect(result.input.intent).toEqual({
      kind: 'DAY_RANGE',
      startDate: '2026-08-10',
      endDateExclusive: '2026-08-13',
    });
    expect(result.input.categoryId).toBe('00000000-0000-0000-0000-000000000002');
  });

  it('normalise les datetime-local vers le contrat Core avec secondes', () => {
    const params = new URLSearchParams({
      destinationPublicId: DESTINATION_ID,
      intent: 'TIME_RANGE',
      startAt: '2026-08-10T09:30',
      endAt: '2026-08-10T13:30',
    });
    const result = parsePublicSearchParams(params, 'en');
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') throw new Error('VALID attendu');
    expect(result.input.intent).toEqual({
      kind: 'TIME_RANGE',
      startAt: '2026-08-10T09:30:00',
      endAt: '2026-08-10T13:30:00',
    });
  });

  it('rejette les dates civiles impossibles et les périodes inversées', () => {
    const result = parsePublicSearchParams(
      new URLSearchParams({
        destinationPublicId: DESTINATION_ID,
        intent: 'DAY_RANGE',
        startDate: '2026-02-30',
        endDateExclusive: '2026-02-01',
      }),
      'fr',
    );
    expect(result.kind).toBe('INVALID');
    if (result.kind !== 'INVALID') throw new Error('INVALID attendu');
    expect(result.fieldErrors.startDate).toBeDefined();
    expect(result.fieldErrors.endDateExclusive).toBeDefined();
  });

  it('conserve un curseur opaque uniquement sur une entrée valide', () => {
    const params = new URLSearchParams({
      destinationPublicId: DESTINATION_ID,
      intent: 'DAY_RANGE',
      startDate: '2026-08-10',
      endDateExclusive: '2026-08-13',
      cursor: 'opaque.signed',
    });
    const result = parsePublicSearchParams(params, 'fr');
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') throw new Error('VALID attendu');
    expect(result.input.cursor).toBe('opaque.signed');
  });

  it('refuse un intent inconnu et un curseur démesuré', () => {
    const result = parsePublicSearchParams(
      new URLSearchParams({
        destinationPublicId: DESTINATION_ID,
        intent: 'UNKNOWN',
        startDate: '2026-08-10',
        endDateExclusive: '2026-08-13',
        cursor: 'x'.repeat(4097),
      }),
      'en',
    );
    expect(result.kind).toBe('INVALID');
    if (result.kind !== 'INVALID') throw new Error('INVALID attendu');
    expect(result.fieldErrors.intent).toBeDefined();
    expect(result.fieldErrors.cursor).toBeDefined();
  });

  it('parse explicitement un viewport et conserve la pagination demandée', () => {
    const result = parsePublicSearchParams(
      new URLSearchParams({
        destinationPublicId: DESTINATION_ID,
        intent: 'DAY_RANGE',
        startDate: '2026-08-10',
        endDateExclusive: '2026-08-13',
        pageSize: '12',
        viewportSouth: '45.8',
        viewportWest: '6.0',
        viewportNorth: '46.0',
        viewportEast: '6.3',
      }),
      'en',
    );
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') throw new Error('VALID attendu');
    expect(result.input.pageSize).toBe(12);
    expect(result.input.viewport).toEqual({
      kind: 'VIEWPORT',
      south: 45.8,
      west: 6,
      north: 46,
      east: 6.3,
    });
  });

  it('rejette une zone partielle, un nombre non fini et une zone inversée', () => {
    const partial = parsePublicSearchParams(
      new URLSearchParams({
        destinationPublicId: DESTINATION_ID,
        intent: 'DAY_RANGE',
        startDate: '2026-08-10',
        endDateExclusive: '2026-08-13',
        viewportSouth: '45.8',
        viewportWest: '6.0',
        viewportNorth: 'Infinity',
      }),
      'fr',
    );
    expect(partial.kind).toBe('INVALID');
    if (partial.kind !== 'INVALID') throw new Error('INVALID attendu');
    expect(partial.fieldErrors.viewportEast).toBeDefined();
    expect(partial.fieldErrors.viewportNorth).toBeDefined();

    const inverted = parsePublicSearchParams(
      new URLSearchParams({
        destinationPublicId: DESTINATION_ID,
        intent: 'DAY_RANGE',
        startDate: '2026-08-10',
        endDateExclusive: '2026-08-13',
        viewportSouth: '46',
        viewportWest: '6',
        viewportNorth: '45',
        viewportEast: '6.3',
      }),
      'fr',
    );
    expect(inverted.kind).toBe('INVALID');
    if (inverted.kind !== 'INVALID') throw new Error('INVALID attendu');
    expect(inverted.fieldErrors.viewportSouth).toBeDefined();
  });
});

describe('publicSearchHttpStatus', () => {
  it('rend les pannes de dépendances indisponibles sans fuite interne', () => {
    expect(publicSearchHttpStatus('PUBLICATION_GATE_UNAVAILABLE')).toBe(503);
    expect(publicSearchHttpStatus('CURSOR_CODEC_UNAVAILABLE')).toBe(503);
    expect(publicSearchHttpStatus('INVALID_CURSOR')).toBe(400);
  });
});

describe('executePublicSearch', () => {
  const input = {
    destinationPublicId: DESTINATION_ID,
    locale: 'fr',
    intent: {
      kind: 'DAY_RANGE' as const,
      startDate: '2026-08-10',
      endDateExclusive: '2026-08-13',
    },
  };

  it('refuse fail-closed un secret absent ou trop court avant tout accès DB', async () => {
    const fakeDb = {} as Parameters<typeof executePublicSearch>[0];
    await expect(executePublicSearch(fakeDb, input, '')).rejects.toMatchObject({
      code: 'CURSOR_CODEC_UNAVAILABLE',
    });
    await expect(executePublicSearch(fakeDb, input, 'short')).rejects.toMatchObject({
      code: 'CURSOR_CODEC_UNAVAILABLE',
    });
  });
});
