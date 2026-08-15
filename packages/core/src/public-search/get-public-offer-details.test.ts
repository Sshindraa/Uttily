import { describe, it, expect } from 'vitest';
import { getPublicOfferDetails } from './get-public-offer-details';
import type { DatabaseClient } from '@uttily/database';

describe('getPublicOfferDetails — unit tests', () => {
  const fakeDb = {} as DatabaseClient;

  it('returns INVALID_INPUT for null or non-object input', async () => {
    // @ts-expect-error testing invalid input
    const res1 = await getPublicOfferDetails(fakeDb, null);
    expect(res1).toEqual({ kind: 'INVALID_INPUT' });

    // @ts-expect-error testing invalid input
    const res2 = await getPublicOfferDetails(fakeDb, undefined);
    expect(res2).toEqual({ kind: 'INVALID_INPUT' });
  });

  it('returns INVALID_INPUT for non-UUID publicProductId', async () => {
    const res = await getPublicOfferDetails(fakeDb, {
      publicProductId: 'not-a-uuid',
      publicLocationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(res).toEqual({ kind: 'INVALID_INPUT' });
  });

  it('returns INVALID_INPUT for non-UUID publicLocationId', async () => {
    const res = await getPublicOfferDetails(fakeDb, {
      publicProductId: '11111111-1111-4111-8111-111111111111',
      publicLocationId: 'not-a-uuid',
    });
    expect(res).toEqual({ kind: 'INVALID_INPUT' });
  });

  it('returns INVALID_INPUT for empty string IDs', async () => {
    const res = await getPublicOfferDetails(fakeDb, {
      publicProductId: '',
      publicLocationId: '',
    });
    expect(res).toEqual({ kind: 'INVALID_INPUT' });
  });
});
