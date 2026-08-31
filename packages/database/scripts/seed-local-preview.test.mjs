import { describe, expect, it } from 'vitest';

import { assertLocalPreviewSeedEnvironment } from './seed-local-preview.mjs';

describe('seed preview local environment guard', () => {
  it('requires local development and the explicit preview marker', () => {
    expect(() =>
      assertLocalPreviewSeedEnvironment({
        NODE_ENV: 'development',
        UTTILY_LOCAL_DEV: '1',
        UTTILY_LOCAL_PREVIEW: '1',
      }),
    ).not.toThrow();
  });

  it('refuses missing, staging, and production markers', () => {
    expect(() =>
      assertLocalPreviewSeedEnvironment({ NODE_ENV: 'development', UTTILY_LOCAL_DEV: '1' }),
    ).toThrow(/UTTILY_LOCAL_PREVIEW=1/i);
    expect(() =>
      assertLocalPreviewSeedEnvironment({
        NODE_ENV: 'staging',
        UTTILY_LOCAL_DEV: '1',
        UTTILY_LOCAL_PREVIEW: '1',
      }),
    ).toThrow(/environnement de développement local/i);
    expect(() =>
      assertLocalPreviewSeedEnvironment({
        NODE_ENV: 'production',
        UTTILY_LOCAL_DEV: '1',
        UTTILY_LOCAL_PREVIEW: '1',
      }),
    ).toThrow(/environnement de développement local/i);
  });
});
