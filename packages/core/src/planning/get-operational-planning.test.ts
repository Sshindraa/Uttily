import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { getOperationalPlanning } from './get-operational-planning';

describe('Chantier 10 — getOperationalPlanning', () => {
  it('rejette un organizationId invalide', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(getOperationalPlanning(fakeDb, 'invalid-uuid')).rejects.toThrow('organizationId');
  });

  it('rejette une période inversée', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      getOperationalPlanning(fakeDb, orgId, {
        from: new Date('2026-08-30T10:00:00Z'),
        to: new Date('2026-08-20T10:00:00Z'),
      }),
    ).rejects.toThrow('date de fin');
  });
});
