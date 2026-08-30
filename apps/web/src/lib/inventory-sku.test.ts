import { describe, expect, it } from 'vitest';
import { buildInventorySku } from './inventory-sku';

describe('buildInventorySku', () => {
  it('normalise le préfixe et distingue les exemplaires du même batch', () => {
    const batchId = '123e4567-e89b-12d3-a456-426614174000';

    expect(buildInventorySku(' vélo ', 1, batchId)).toBe('VÉLO-123E4567E89B-001');
    expect(buildInventorySku(' vélo ', 2, batchId)).toBe('VÉLO-123E4567E89B-002');
  });

  it('utilise un token différent pour deux batchs concurrents', () => {
    const first = buildInventorySku('VELO', 1, '123e4567-e89b-12d3-a456-426614174000');
    const second = buildInventorySku('VELO', 1, '987e6543-e21b-65d4-b654-624614174999');

    expect(first).not.toBe(second);
  });

  it('rejette un ordinal invalide', () => {
    expect(() => buildInventorySku('VELO', 0, '123e4567-e89b-12d3-a456-426614174000')).toThrow(
      /ordinal/,
    );
  });
});
