import { describe, it, expect } from 'vitest';
import {
  PUBLICATION_STATUSES,
  INVENTORY_CONDITIONS,
  INVENTORY_STATUSES,
  type PublicationStatus,
  type InventoryCondition,
  type InventoryStatus,
} from '../index';

describe('catalog types', () => {
  it('PUBLICATION_STATUSES contient DRAFT, PUBLISHED, ARCHIVED', () => {
    expect(PUBLICATION_STATUSES).toEqual(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
  });

  it('INVENTORY_CONDITIONS contient NEW, GOOD, FAIR, POOR, BROKEN', () => {
    expect(INVENTORY_CONDITIONS).toEqual(['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN']);
  });

  it('INVENTORY_STATUSES contient ACTIVE, RETIRED, LOST (pas AVAILABLE)', () => {
    expect(INVENTORY_STATUSES).toEqual(['ACTIVE', 'RETIRED', 'LOST']);
    expect(INVENTORY_STATUSES).not.toContain('AVAILABLE');
  });

  it('les types sont inférables', () => {
    const status: PublicationStatus = 'DRAFT';
    const condition: InventoryCondition = 'BROKEN';
    const itemStatus: InventoryStatus = 'ACTIVE';
    expect(status).toBe('DRAFT');
    expect(condition).toBe('BROKEN');
    expect(itemStatus).toBe('ACTIVE');
  });
});

describe('catalog product invariants (validation statique)', () => {
  it('un produit ACTIVE+BROKEN est légitime (pas de contrainte BROKEN→RETIRED)', () => {
    // La sémantique Lot 2A découple status (gestion du parc) et condition (état physique).
    // Un exemplaire ACTIVE et BROKEN est en attente de réparation.
    const item = {
      status: 'ACTIVE' as InventoryStatus,
      condition: 'BROKEN' as InventoryCondition,
    };
    expect(item.status).toBe('ACTIVE');
    expect(item.condition).toBe('BROKEN');
    // Aucune règle métier ne force RETIRED ici au Lot 2A.
  });
});
