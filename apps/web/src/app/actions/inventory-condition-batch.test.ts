import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@uttily/contracts';
import type { UpdateInventoryItemsConditionBatchResult } from '@uttily/core';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(() => {
    throw new Error('L’autorisation ne doit pas être appelée avant la validation.');
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { updateInventoryItemsConditionBatchAction } from './inventory';

const EMPTY_PREV: ActionResult<UpdateInventoryItemsConditionBatchResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

function formData(values: {
  itemIds?: string[];
  condition?: string;
  idempotencyKey?: string;
}): FormData {
  const data = new FormData();
  for (const itemId of values.itemIds ?? []) data.append('inventoryItemId', itemId);
  if (values.condition !== undefined) data.set('condition', values.condition);
  if (values.idempotencyKey !== undefined) data.set('idempotencyKey', values.idempotencyKey);
  return data;
}

describe('updateInventoryItemsConditionBatchAction — validation FormData', () => {
  it('refuse une sélection vide et les champs d’état manquants', async () => {
    const result = await updateInventoryItemsConditionBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({}),
    );

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) {
      expect(result.fieldErrors).toMatchObject({
        inventoryItemIds: expect.any(String),
        condition: expect.any(String),
        idempotencyKey: expect.any(String),
      });
    }
  });

  it('refuse un état inconnu avant toute autorisation', async () => {
    const result = await updateInventoryItemsConditionBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
        condition: 'BROKENNESS',
        idempotencyKey: 'invalid-condition',
      }),
    );

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) expect(result.fieldErrors?.condition).toBe('État invalide.');
  });

  it('refuse les doublons et une sélection dépassant la limite', async () => {
    const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const duplicate = await updateInventoryItemsConditionBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: [validId, validId],
        condition: 'POOR',
        idempotencyKey: 'duplicate-condition',
      }),
    );
    expect(duplicate).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!duplicate.ok) {
      expect(duplicate.fieldErrors?.inventoryItemIds).toContain('doublon');
    }

    const overLimit = await updateInventoryItemsConditionBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: Array.from(
          { length: 51 },
          (_, index) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`,
        ),
        condition: 'GOOD',
        idempotencyKey: 'over-limit-condition',
      }),
    );
    expect(overLimit).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!overLimit.ok) {
      expect(overLimit.fieldErrors?.inventoryItemIds).toContain('limitée à 50');
    }
  });
});
