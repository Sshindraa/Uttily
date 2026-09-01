import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@uttily/contracts';
import type { TransferInventoryItemsBatchResult } from '@uttily/core';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(() => {
    throw new Error('L’autorisation ne doit pas être appelée avant la validation.');
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { transferInventoryItemsBatchAction } from './inventory';

const EMPTY_PREV: ActionResult<TransferInventoryItemsBatchResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

function formData(values: {
  itemIds?: string[];
  toLocationId?: string;
  idempotencyKey?: string;
}): FormData {
  const data = new FormData();
  for (const itemId of values.itemIds ?? []) data.append('inventoryItemId', itemId);
  if (values.toLocationId !== undefined) data.set('toLocationId', values.toLocationId);
  if (values.idempotencyKey !== undefined) data.set('idempotencyKey', values.idempotencyKey);
  return data;
}

describe('transferInventoryItemsBatchAction — validation FormData', () => {
  it('refuse une sélection vide et les champs de destination manquants', async () => {
    const result = await transferInventoryItemsBatchAction('org-1', EMPTY_PREV, formData({}));

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) {
      expect(result.fieldErrors).toMatchObject({
        inventoryItemIds: expect.any(String),
        toLocationId: expect.any(String),
        idempotencyKey: expect.any(String),
      });
    }
  });

  it('refuse les doublons et les sélections dépassant la limite', async () => {
    const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const validTarget = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const duplicate = await transferInventoryItemsBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: [validId, validId],
        toLocationId: validTarget,
        idempotencyKey: 'duplicate',
      }),
    );
    expect(duplicate).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!duplicate.ok) {
      expect(duplicate.fieldErrors?.inventoryItemIds).toContain('doublon');
    }

    const overLimit = await transferInventoryItemsBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: Array.from(
          { length: 51 },
          (_, index) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`,
        ),
        toLocationId: validTarget,
        idempotencyKey: 'over-limit',
      }),
    );
    expect(overLimit).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!overLimit.ok) {
      expect(overLimit.fieldErrors?.inventoryItemIds).toContain('limitée à 50');
    }
  });
});
