import { describe, expect, it } from 'vitest';
import { inventoryCondition } from '@uttily/database';
import { INVENTORY_CONDITIONS } from './types';

describe('INVENTORY_CONDITIONS — garde de dérive', () => {
  it('est strictement égal à inventoryCondition.enumValues', () => {
    expect(INVENTORY_CONDITIONS).toEqual(inventoryCondition.enumValues);
  });

  it('contient exactement les 5 conditions attendues', () => {
    expect([...INVENTORY_CONDITIONS]).toEqual(['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN']);
  });
});
