import { describe, expect, it } from 'vitest';
import { PublicSearchError, type PublicSearchErrorCode } from './errors';

describe('PublicSearchError', () => {
  it.each<[PublicSearchErrorCode]>([
    ['INVALID_INPUT'],
    ['DESTINATION_NOT_FOUND'],
    ['DESTINATION_INACTIVE'],
    ['COUNTRY_INACTIVE'],
    ['CATEGORY_NOT_FOUND'],
    ['CATEGORY_INACTIVE'],
    ['INVALID_CURSOR'],
    ['INVALID_LOCAL_TIME'],
    ['PRICING_UNAVAILABLE'],
  ])('accepte le code %s', (code) => {
    const err = new PublicSearchError(code, 'msg');
    expect(err.code).toBe(code);
    expect(err.message).toBe('msg');
    expect(err.name).toBe('PublicSearchError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PublicSearchError);
  });

  it('conserve la cause en option', () => {
    const cause = new Error('underlying');
    const err = new PublicSearchError('PRICING_UNAVAILABLE', 'pricing failed', { cause });
    expect(err.cause).toBe(cause);
  });

  it('utilise le message fourni', () => {
    const err = new PublicSearchError('INVALID_CURSOR', 'Curseur corrompu.');
    expect(err.message).toBe('Curseur corrompu.');
  });

  it('est identifiable par instanceof PublicSearchError', () => {
    const err = new PublicSearchError('INVALID_INPUT', 'bad');
    expect(err instanceof PublicSearchError).toBe(true);
  });
});
