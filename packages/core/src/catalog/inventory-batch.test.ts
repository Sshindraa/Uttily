import { describe, expect, it } from 'vitest';
import { buildInventoryBatchSku } from './inventory-batch';

describe('création en série — SKU déterministes', () => {
  it('reconstruit le même SKU pour la même clé et la même position', () => {
    const first = buildInventoryBatchSku('kayak', 1, 'batch-key-1');
    const replay = buildInventoryBatchSku('kayak', 1, 'batch-key-1');

    expect(replay).toBe(first);
  });

  it('distingue les positions et les lots sans dépendre du vélo', () => {
    const first = buildInventoryBatchSku(undefined, 1, 'batch-key-1');
    const second = buildInventoryBatchSku(undefined, 2, 'batch-key-1');
    const otherBatch = buildInventoryBatchSku(undefined, 1, 'batch-key-2');

    expect(first).toMatch(/^EQUIP-[A-F0-9]{12}-001$/);
    expect(second).toMatch(/^EQUIP-[A-F0-9]{12}-002$/);
    expect(otherBatch).not.toBe(first);
  });

  it('refuse une position invalide', () => {
    expect(() => buildInventoryBatchSku('EQP', 0, 'batch-key')).toThrow('positive');
  });
});
