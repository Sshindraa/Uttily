import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@uttily/contracts';
import type { CreateManualBlockResult } from '@uttily/core';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(() => {
    throw new Error('L’autorisation ne doit pas être appelée avant la validation.');
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { createManualBlockAction } from './availability';

const EMPTY_PREV: ActionResult<CreateManualBlockResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

function formData(values: Partial<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

describe('createManualBlockAction — validation FormData', () => {
  it('refuse les champs manquants avant toute autorisation', async () => {
    const result = await createManualBlockAction('org-1', EMPTY_PREV, formData({}));
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) {
      expect(result.fieldErrors).toMatchObject({
        inventoryItemId: expect.any(String),
        locationId: expect.any(String),
        startAt: expect.any(String),
        endAt: expect.any(String),
        idempotencyKey: expect.any(String),
      });
    }
  });

  it('refuse un identifiant invalide avant la permission', async () => {
    const result = await createManualBlockAction(
      'org-1',
      EMPTY_PREV,
      formData({
        inventoryItemId: 'not-a-uuid',
        locationId: 'not-a-uuid',
        startAt: '2026-01-15T10:00',
        endAt: '2026-01-15T12:00',
        idempotencyKey: 'manual-action-validation',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
  });
});
