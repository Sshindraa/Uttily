import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@uttily/contracts';
import type {
  CreateManualBlockResult,
  RecurringManualBlockSeriesMutationResult,
} from '@uttily/core';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(() => {
    throw new Error('L’autorisation ne doit pas être appelée avant la validation.');
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { createManualBlockAction, createRecurringManualBlockSeriesAction } from './availability';

const EMPTY_PREV: ActionResult<CreateManualBlockResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

const EMPTY_RECURRING_PREV: ActionResult<RecurringManualBlockSeriesMutationResult> = {
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

describe('createRecurringManualBlockSeriesAction — validation FormData', () => {
  it('refuse une série incomplète avant toute autorisation', async () => {
    const result = await createRecurringManualBlockSeriesAction(
      'org-1',
      EMPTY_RECURRING_PREV,
      formData({}),
    );
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    if (!result.ok) {
      expect(result.fieldErrors).toMatchObject({
        inventoryItemId: expect.any(String),
        locationId: expect.any(String),
        startDate: expect.any(String),
        endDate: expect.any(String),
        startTime: expect.any(String),
        endTime: expect.any(String),
        timeZone: expect.any(String),
        idempotencyKey: expect.any(String),
      });
    }
  });

  it('refuse un exemplaire ou un établissement invalide avant la permission', async () => {
    const result = await createRecurringManualBlockSeriesAction(
      'org-1',
      EMPTY_RECURRING_PREV,
      formData({
        inventoryItemId: 'not-a-uuid',
        locationId: 'not-a-uuid',
        startDate: '2030-01-07',
        endDate: '2030-01-21',
        startTime: '10:00',
        endTime: '12:00',
        timeZone: 'Europe/Paris',
        idempotencyKey: 'recurring-action-validation',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
  });
});
