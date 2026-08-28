import { describe, expect, it } from 'vitest';
import {
  assertRecoveryDrillEnvironment,
  buildDatabaseNames,
  databaseUrlForName,
  DEFAULT_LOCAL_DATABASE_URL,
  resolveRecoveryDrillDatabaseUrl,
} from './restore-drill.mjs';

describe('restore drill guardrails', () => {
  it('requires an explicit drill confirmation and rejects production', () => {
    expect(() => assertRecoveryDrillEnvironment({})).toThrow('UTTILY_RECOVERY_DRILL=1');
    expect(() =>
      assertRecoveryDrillEnvironment({
        UTTILY_RECOVERY_DRILL: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow('NODE_ENV=production');
    expect(() =>
      assertRecoveryDrillEnvironment({
        UTTILY_RECOVERY_DRILL: '1',
        NODE_ENV: 'test',
      }),
    ).not.toThrow();
  });

  it('defaults to the documented local PostgreSQL endpoint', () => {
    expect(resolveRecoveryDrillDatabaseUrl({})).toBe(DEFAULT_LOCAL_DATABASE_URL);
    expect(
      resolveRecoveryDrillDatabaseUrl({
        RECOVERY_DRILL_DATABASE_URL: 'postgresql://localhost:5432/custom',
        DATABASE_URL: 'postgresql://remote.example/custom',
      }),
    ).toBe('postgresql://localhost:5432/custom');
  });

  it('accepts only generated local source/restored database names', () => {
    const names = buildDatabaseNames(1_725_000_000_000, 42);
    expect(names.source).toMatch(/^uttily_recovery_source_/);
    expect(names.restored).toMatch(/^uttily_recovery_restored_/);
    expect(databaseUrlForName(DEFAULT_LOCAL_DATABASE_URL, names.source)).toContain(names.source);
    expect(() => databaseUrlForName(DEFAULT_LOCAL_DATABASE_URL, 'uttily')).toThrow(
      'Nom de base de drill invalide',
    );
    expect(() => databaseUrlForName('postgresql://neon.example/uttily', names.source)).toThrow(
      'localhost',
    );
  });
});
