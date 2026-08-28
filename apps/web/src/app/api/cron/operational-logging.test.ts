import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cronRoutes = [
  'reconcile-payments',
  'process-refund-requests',
  'process-compensations',
  'expire-holds',
] as const;

describe('critical cron operational logging', () => {
  it('uses the safe structured logger without raw console logging', () => {
    for (const route of cronRoutes) {
      const source = readFileSync(new URL(`./${route}/route.ts`, import.meta.url), 'utf8');

      expect(source).toContain('emitOperationalLog');
      expect(source).not.toMatch(/console\.(log|warn|error)\s*\(/);
      expect(source).not.toMatch(/error:\s*error\b/);
      expect(source).not.toMatch(/environment,\s*error/);
    }
  });
});
