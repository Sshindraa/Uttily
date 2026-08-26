import { describe, expect, it } from 'vitest';

import { assertLocalSeedEnvironment, isLocalSeedEnvironment } from './seed-local.mjs';

describe('seed local environment guards', () => {
  it('refuse le seed sans marqueur local explicite', () => {
    const environment = { NODE_ENV: 'development' };

    expect(isLocalSeedEnvironment(environment)).toBe(false);
    expect(() => assertLocalSeedEnvironment(environment)).toThrow(
      /seed local exige un environnement de développement local explicite/i,
    );
  });

  it('refuse le seed si NODE_ENV est absent ou différent de development', () => {
    const invalidEnvironments = [
      { UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'test', UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'staging', UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'production', UTTILY_LOCAL_DEV: '1' },
    ];

    for (const environment of invalidEnvironments) {
      expect(isLocalSeedEnvironment(environment)).toBe(false);
      expect(() => assertLocalSeedEnvironment(environment)).toThrow(
        /seed local exige un environnement de développement local explicite/i,
      );
    }
  });

  it('autorise uniquement le couple local development explicite', () => {
    const environment = { NODE_ENV: 'development', UTTILY_LOCAL_DEV: '1' };

    expect(isLocalSeedEnvironment(environment)).toBe(true);
    expect(() => assertLocalSeedEnvironment(environment)).not.toThrow();
  });
});
