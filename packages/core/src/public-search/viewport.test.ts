import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { createPublicSearchCursorCodec } from './cursor';
import { PublicSearchError } from './errors';
import { searchPublicOffers } from './search-offers';
import type { PublicSearchViewport } from './types';

const SECRET = 'viewport-test-secret-that-is-at-least-32-bytes-long';
const destinationPublicId = '00000000-0000-0000-0000-000000000001';
const options = {
  publicationGate: {
    filterEligibleProductIds: async () => new Set<string>(),
  },
  cursorCodec: createPublicSearchCursorCodec(SECRET),
};
const fakeDb = {} as DatabaseClient;

describe('searchPublicOffers viewport validation', () => {
  it.each([
    {
      kind: 'VIEWPORT',
      south: Number.NaN,
      west: 2,
      north: 3,
      east: 4,
    },
    {
      kind: 'VIEWPORT',
      south: -91,
      west: 2,
      north: 3,
      east: 4,
    },
    {
      kind: 'VIEWPORT',
      south: 4,
      west: 2,
      north: 3,
      east: 4,
    },
    {
      kind: 'VIEWPORT',
      south: 1,
      west: 181,
      north: 3,
      east: 4,
    },
    {
      kind: 'VIEWPORT',
      south: 1,
      west: 2,
      north: 3,
      east: 4,
      extra: true,
    },
  ])('rejette fail-closed %o sans fallback vers la destination', async (viewport) => {
    await expect(
      searchPublicOffers(
        fakeDb,
        {
          destinationPublicId,
          locale: 'fr',
          intent: {
            kind: 'DAY_RANGE',
            startDate: '2026-08-10',
            endDateExclusive: '2026-08-12',
          },
          viewport: viewport as unknown as PublicSearchViewport,
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<PublicSearchError>);
  });

  it('accepte le sens west > east réservé à l’antiméridien', async () => {
    const emptyDestinationDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as unknown as DatabaseClient;
    await expect(
      searchPublicOffers(
        emptyDestinationDb,
        {
          destinationPublicId,
          locale: 'fr',
          intent: {
            kind: 'DAY_RANGE',
            startDate: '2026-08-10',
            endDateExclusive: '2026-08-12',
          },
          viewport: { kind: 'VIEWPORT', south: -10, west: 170, north: 10, east: -170 },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'DESTINATION_NOT_FOUND' });
  });
});
