import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { updateInventoryItemsConditionBatch } from './inventory-condition-batch';

describe('mise à jour groupée de l’état physique — validation', () => {
  it('refuse un état absent de l’enum avant tout accès à la base', async () => {
    await expect(
      updateInventoryItemsConditionBatch({} as DatabaseClient, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        inventoryItemIds: ['00000000-0000-0000-0000-000000000002'],
        condition: 'INVALID' as never,
        idempotencyKey: 'invalid-condition',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
