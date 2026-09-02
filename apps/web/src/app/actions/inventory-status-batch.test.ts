import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@uttily/contracts';
import type { UpdateInventoryItemsStatusBatchResult } from '@uttily/core';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(() => {
    throw new Error('L’autorisation ne doit pas être appelée avant la validation.');
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { updateInventoryItemsStatusBatchAction } from './inventory';

const EMPTY_PREV: ActionResult<UpdateInventoryItemsStatusBatchResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

function formData(values: {
  itemIds?: string[];
  status?: string;
  idempotencyKey?: string;
}): FormData {
  const data = new FormData();
  for (const itemId of values.itemIds ?? []) data.append('inventoryItemId', itemId);
  if (values.status !== undefined) data.set('status', values.status);
  if (values.idempotencyKey !== undefined) data.set('idempotencyKey', values.idempotencyKey);
  return data;
}

describe('updateInventoryItemsStatusBatchAction — validation FormData', () => {
  it('refuse une sélection vide et les champs de statut manquants', async () => {
    const result = await updateInventoryItemsStatusBatchAction('org-1', EMPTY_PREV, formData({}));

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) {
      expect(result.fieldErrors).toMatchObject({
        inventoryItemIds: expect.any(String),
        status: expect.any(String),
        idempotencyKey: expect.any(String),
      });
    }
  });

  it('refuse un statut inconnu avant toute autorisation', async () => {
    const result = await updateInventoryItemsStatusBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
        status: 'BROKEN',
        idempotencyKey: 'invalid-status',
      }),
    );

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) expect(result.fieldErrors?.status).toBe('Statut invalide.');
  });

  it('refuse les doublons et une sélection dépassant la limite', async () => {
    const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const duplicate = await updateInventoryItemsStatusBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: [validId, validId],
        status: 'LOST',
        idempotencyKey: 'duplicate-status',
      }),
    );
    expect(duplicate).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!duplicate.ok) {
      expect(duplicate.fieldErrors?.inventoryItemIds).toContain('doublon');
    }

    const overLimit = await updateInventoryItemsStatusBatchAction(
      'org-1',
      EMPTY_PREV,
      formData({
        itemIds: Array.from(
          { length: 51 },
          (_, index) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`,
        ),
        status: 'RETIRED',
        idempotencyKey: 'over-limit-status',
      }),
    );
    expect(overLimit).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!overLimit.ok) {
      expect(overLimit.fieldErrors?.inventoryItemIds).toContain('limitée à 50');
    }
  });
});
