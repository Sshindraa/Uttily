import { describe, expect, it } from 'vitest';
import { bulkCreateInventoryItemsAction } from './inventory';

const EMPTY_PREV = { ok: false as const, code: 'UNKNOWN' as const, message: '' };

describe('création en série — Server Action', () => {
  it('exige une clé d’idempotence avant toute autorisation ou écriture', async () => {
    const formData = new FormData();
    formData.set('productVariantId', '00000000-0000-0000-0000-000000000001');
    formData.set('currentLocationId', '00000000-0000-0000-0000-000000000002');
    formData.set('count', '2');

    const result = await bulkCreateInventoryItemsAction(
      '00000000-0000-0000-0000-000000000003',
      EMPTY_PREV,
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.idempotencyKey).toBeDefined();
    }
  });

  it('borne strictement la quantité avant de déléguer au Core', async () => {
    const formData = new FormData();
    formData.set('productVariantId', '00000000-0000-0000-0000-000000000001');
    formData.set('currentLocationId', '00000000-0000-0000-0000-000000000002');
    formData.set('count', '51');
    formData.set('idempotencyKey', 'batch-limit');

    const result = await bulkCreateInventoryItemsAction(
      '00000000-0000-0000-0000-000000000003',
      EMPTY_PREV,
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.count).toContain('1 et 50');
    }
  });
});
