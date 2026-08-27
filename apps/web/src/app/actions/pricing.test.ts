import { describe, it, expect } from 'vitest';
import { saveDailyPricingPlanDraftAction, activateDailyPricingPlanAction } from './pricing';

describe('Pricing Actions — validation des formulaires', () => {
  it('rejette un formulaire avec prix manquant ou égal à 0', async () => {
    const formData = new FormData();
    formData.append('productId', '11111111-1111-1111-1111-111111111111');
    formData.append('variantId', '22222222-2222-2222-2222-222222222222');
    formData.append('dailyPriceEuros', '0');

    const result = await saveDailyPricingPlanDraftAction(
      '00000000-0000-0000-0000-000000000001',
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.dailyPriceEuros).toContain('supérieur à 0 €');
    }
  });

  it('rejette un planId invalide lors de l’activation', async () => {
    const formData = new FormData();
    formData.append('pricingPlanId', 'invalid-uuid');

    const result = await activateDailyPricingPlanAction(
      '00000000-0000-0000-0000-000000000001',
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.message).toContain('invalide');
    }
  });
});
