import { describe, expect, it } from 'vitest';

import {
  isLocalDatabaseUrl,
  MAX_LOCAL_WORKER_INTERVAL_MS,
  resolveDatabaseUrl,
  resolveLocalWorkerIntervalMs,
} from './local-dev.js';

describe('validation de la base locale', () => {
  it('refuse une URL PostgreSQL distante', () => {
    const remoteUrl = 'postgresql://uttily:uttily@database.example.invalid:5432/uttily';

    expect(isLocalDatabaseUrl(remoteUrl)).toBe(false);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: remoteUrl })).toThrow(
      /DATABASE_URL doit pointer vers PostgreSQL local/,
    );
  });

  it('accepte une URL PostgreSQL locale', () => {
    const localUrl = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';

    expect(isLocalDatabaseUrl(localUrl)).toBe(true);
    expect(resolveDatabaseUrl({ DATABASE_URL: localUrl })).toBe(localUrl);
  });
});

describe('resolveLocalWorkerIntervalMs', () => {
  it('utilise la valeur par défaut si WORKER_INTERVAL_MS est absente', () => {
    expect(resolveLocalWorkerIntervalMs({})).toBe(5_000);
  });

  it('accepte une valeur entière positive valide', () => {
    expect(resolveLocalWorkerIntervalMs({ WORKER_INTERVAL_MS: '1250' })).toBe(1_250);
  });

  it.each([
    ['zéro', '0'],
    ['négative', '-1'],
    ['non entière', '1.5'],
    ['au-dessus de la borne', String(MAX_LOCAL_WORKER_INTERVAL_MS + 1)],
  ])('refuse une valeur %s', (_description, value) => {
    expect(() => resolveLocalWorkerIntervalMs({ WORKER_INTERVAL_MS: value })).toThrow(
      /WORKER_INTERVAL_MS/,
    );
  });
});
