import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { updateInventoryItemsStatusBatch } from './inventory-status-batch';

describe('changement groupé de statut des exemplaires — validation', () => {
  it('refuse un statut absent de l’enum avant tout accès à la base', async () => {
    await expect(
      updateInventoryItemsStatusBatch({} as DatabaseClient, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        inventoryItemIds: ['00000000-0000-0000-0000-000000000002'],
        status: 'INVALID' as never,
        idempotencyKey: 'invalid-status',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
