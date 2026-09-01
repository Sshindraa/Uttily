import { describe, expect, it } from 'vitest';
import { createFirstEquipmentDraftAction, publishFirstEquipmentFromSetupAction } from './products';

const EMPTY_PREV = { ok: false as const, code: 'UNKNOWN' as const, message: '' };

describe('Onboarding autonome — premier équipement', () => {
  it('rejette la création avant toute écriture si le produit ou la catégorie est invalide', async () => {
    const formData = new FormData();
    formData.set('name', 'A');
    formData.set('categoryId', 'not-a-uuid');

    const result = await createFirstEquipmentDraftAction(
      '00000000-0000-0000-0000-000000000001',
      EMPTY_PREV,
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.name).toBeDefined();
      expect(result.fieldErrors?.categoryId).toBeDefined();
    }
  });

  it('conserve la variante facultative et borne sa saisie', async () => {
    const formData = new FormData();
    formData.set('name', 'Kayak de randonnée');
    formData.set('categoryId', '00000000-0000-0000-0000-000000000001');
    formData.set('variantName', 'x'.repeat(81));

    const result = await createFirstEquipmentDraftAction(
      '00000000-0000-0000-0000-000000000001',
      EMPTY_PREV,
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.variantName).toContain('trop long');
    }
  });

  it('refuse une publication sans identifiant produit valide', async () => {
    const formData = new FormData();
    formData.set('productId', 'not-a-uuid');

    const result = await publishFirstEquipmentFromSetupAction(
      '00000000-0000-0000-0000-000000000001',
      EMPTY_PREV,
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.message).toContain('invalide');
    }
  });
});
