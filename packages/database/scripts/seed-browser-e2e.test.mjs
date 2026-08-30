import { describe, expect, it } from 'vitest';
import { assertBrowserE2ESeedEnvironment } from './seed-browser-e2e.mjs';

describe('browser E2E seed guard', () => {
  it('requires the explicit CI browser marker', () => {
    expect(() =>
      assertBrowserE2ESeedEnvironment({
        NODE_ENV: 'development',
        UTTILY_LOCAL_DEV: '1',
        UTTILY_BROWSER_E2E: '1',
        CI: 'true',
      }),
    ).not.toThrow();
  });

  it('refuses local or production execution', () => {
    const baseEnvironment = {
      NODE_ENV: 'development',
      UTTILY_LOCAL_DEV: '1',
      UTTILY_BROWSER_E2E: '1',
      CI: 'true',
    };

    expect(() => assertBrowserE2ESeedEnvironment({ ...baseEnvironment, CI: 'false' })).toThrow(
      /CI.*UTTILY_BROWSER_E2E/i,
    );
    expect(() =>
      assertBrowserE2ESeedEnvironment({ ...baseEnvironment, NODE_ENV: 'production' }),
    ).toThrow(/environnement de développement local/i);
    expect(() =>
      assertBrowserE2ESeedEnvironment({ ...baseEnvironment, UTTILY_BROWSER_E2E: '0' }),
    ).toThrow(/CI.*UTTILY_BROWSER_E2E/i);
  });
});
