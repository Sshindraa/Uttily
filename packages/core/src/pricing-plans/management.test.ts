import { describe, it, expect } from 'vitest';
import { saveDailyPricingPlanDraft } from './management';
import { FlexiblePricingError } from './errors';
import type { DatabaseClient } from '@uttily/database';

describe('Pricing Plans Management — Validation et règles métier', () => {
  it('rejette un montant négatif ou égal à zéro', async () => {
    const fakeDb = {} as unknown as DatabaseClient;

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 0,
      }),
    ).rejects.toThrowError(FlexiblePricingError);

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: -2500,
      }),
    ).rejects.toThrowError(FlexiblePricingError);
  });

  it('rejette une devise invalide', async () => {
    const fakeDb = {} as unknown as DatabaseClient;

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 2500,
        currency: 'EUROPE',
      }),
    ).rejects.toThrowError(FlexiblePricingError);
  });

  it('rejette un palier de réduction avec seuil < 2 jours ou pourcentage invalide', async () => {
    const fakeDb = {} as unknown as DatabaseClient;

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 2500,
        discountTiers: [{ thresholdDays: 1, discountPercent: 10 }],
      }),
    ).rejects.toThrowError('au moins 2 jours');

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 2500,
        discountTiers: [{ thresholdDays: 3, discountPercent: 0 }],
      }),
    ).rejects.toThrowError('entre 1 % et 99 %');

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 2500,
        discountTiers: [{ thresholdDays: 3, discountPercent: 100 }],
      }),
    ).rejects.toThrowError('entre 1 % et 99 %');

    await expect(
      saveDailyPricingPlanDraft(fakeDb, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        variantId: '00000000-0000-0000-0000-000000000002',
        priceAmountMinor: 2500,
        discountTiers: [
          { thresholdDays: 3, discountPercent: 10 },
          { thresholdDays: 3, discountPercent: 15 },
        ],
      }),
    ).rejects.toThrowError('Palier en double');
  });
});
