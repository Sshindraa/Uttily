import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { openMaintenanceCase } from './open-maintenance';
import { resolveMaintenanceCase } from './resolve-maintenance';

describe('Chantier 8.1 & 9 — Domain Maintenance & Invariant de Disponibilité', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const itemId = '00000000-0000-0000-0000-000000000002';
  const userId = '00000000-0000-0000-0000-000000000003';

  it('valide les UUIDs lors de openMaintenanceCase', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      openMaintenanceCase(fakeDb, {
        organizationId: 'invalid',
        inventoryItemId: itemId,
        actorUserId: userId,
        reason: 'Pneu crevé',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow('organizationId');
  });

  it('valide les UUIDs lors de resolveMaintenanceCase', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      resolveMaintenanceCase(fakeDb, {
        organizationId: orgId,
        maintenanceBlockId: 'invalid',
        actorUserId: userId,
        targetCondition: 'GOOD',
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow('maintenanceBlockId');
  });
});
