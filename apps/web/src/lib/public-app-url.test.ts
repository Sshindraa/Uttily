import { describe, expect, it } from 'vitest';
import { getPublicAppUrl } from './public-app-url';

describe('getPublicAppUrl', () => {
  it('accepte une URL HTTP locale en développement', () => {
    expect(
      getPublicAppUrl({ NODE_ENV: 'development', PUBLIC_APP_URL: 'http://localhost:3000/' }),
    ).toBe('http://localhost:3000');
  });

  it('exige HTTPS et un hostname public en production', () => {
    expect(
      getPublicAppUrl({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://staging.uttily.example' }),
    ).toBe('https://staging.uttily.example');

    expect(() =>
      getPublicAppUrl({ NODE_ENV: 'production', PUBLIC_APP_URL: 'http://staging.uttily.example' }),
    ).toThrow(/HTTPS/);
    expect(() =>
      getPublicAppUrl({ NODE_ENV: 'production', PUBLIC_APP_URL: 'http://localhost:3000' }),
    ).toThrow(/hostname public/);
  });

  it('exige HTTPS pour un environnement Stripe LIVE même hors production', () => {
    expect(() =>
      getPublicAppUrl({
        NODE_ENV: 'test',
        STRIPE_ENVIRONMENT: 'LIVE',
        PUBLIC_APP_URL: 'http://localhost:3000',
      }),
    ).toThrow(/HTTPS/);
  });

  it('refuse une valeur absente ou une URL avec chemin, query ou credentials', () => {
    expect(() => getPublicAppUrl({ NODE_ENV: 'development' })).toThrow(/PUBLIC_APP_URL/);
    for (const value of [
      'https://uttily.example/checkout',
      'https://uttily.example/?next=payment',
      'https://user:password@uttily.example',
    ]) {
      expect(() => getPublicAppUrl({ NODE_ENV: 'development', PUBLIC_APP_URL: value })).toThrow(
        /PUBLIC_APP_URL/,
      );
    }
  });
});
