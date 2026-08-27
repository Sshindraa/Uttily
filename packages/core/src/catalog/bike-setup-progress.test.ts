import { describe, it, expect } from 'vitest';
import { resolveBikeSetupProgress } from './bike-setup-progress';
import type { UnifiedBike, UnifiedBikePhotoItem } from './unified-bike';

function makePhoto(id: string, sortOrder: number): UnifiedBikePhotoItem {
  return {
    id,
    publicId: `pub-${id}`,
    storageKey: `key-${id}`,
    slotKey: null,
    fileState: 'READY',
    sortOrder,
    byteSize: 1024,
    mimeType: 'image/jpeg',
    checksumSha256: `sha-${id}`,
    createdAt: new Date(),
  };
}

describe('BikeSetupProgress Read Model (Core Unit Tests)', () => {
  const baseBike: UnifiedBike = {
    product: {
      id: 'prod-1',
      organizationId: 'org-1',
      categoryId: 'cat-1',
      categoryName: 'Urbain',
      categorySlug: 'urbain',
      name: 'Canyon Roadlite',
      slug: 'canyon-roadlite',
      description: 'Super vélo de ville léger.',
      publicationStatus: 'DRAFT',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    variant: {
      id: 'var-1',
      name: 'M',
      skuSuffix: 'M',
      isActive: true,
      attributes: { size: 'M' },
    },
    photos: {
      count: 0,
      minRequired: 3,
      isComplete: false,
      items: [],
    },
    pricing: {
      activePlan: null,
      draftPlan: null,
      isPriced: false,
    },
    inventory: {
      totalCount: 0,
      activeCount: 0,
      maintenanceCount: 0,
      retiredCount: 0,
      items: [],
    },
    publication: {
      status: 'DRAFT',
      ready: false,
      failures: ['Au moins 3 photos valides sont requises pour la publication.'],
    },
    offerReadiness: {
      hasPricing: false,
      hasInventory: false,
      isAvailable: false,
    },
    statusSummary: 'INCOMPLETE',
  };

  it('indique PHOTOS comme prochaine étape si l’identité est complète mais 0 photos', () => {
    const progress = resolveBikeSetupProgress(baseBike);

    expect(progress.completedSteps).toContain('IDENTITY');
    expect(progress.completedSteps).not.toContain('PHOTOS');
    expect(progress.nextStep).toBe('PHOTOS');
    expect(progress.isPublicationReady).toBe(false);
  });

  it('indique PRICING comme prochaine étape si photos complètes mais aucun tarif', () => {
    const bikeWithPhotos: UnifiedBike = {
      ...baseBike,
      photos: {
        count: 3,
        minRequired: 3,
        isComplete: true,
        items: [makePhoto('1', 0), makePhoto('2', 1), makePhoto('3', 2)],
      },
    };

    const progress = resolveBikeSetupProgress(bikeWithPhotos);

    expect(progress.completedSteps).toContain('IDENTITY');
    expect(progress.completedSteps).toContain('PHOTOS');
    expect(progress.completedSteps).not.toContain('PRICING');
    expect(progress.nextStep).toBe('PRICING');
  });

  it('indique INVENTORY si tarif configuré mais 0 vélo en stock', () => {
    const bikeWithPricing: UnifiedBike = {
      ...baseBike,
      photos: {
        count: 3,
        minRequired: 3,
        isComplete: true,
        items: [makePhoto('1', 0), makePhoto('2', 1), makePhoto('3', 2)],
      },
      pricing: {
        activePlan: null,
        draftPlan: {
          id: 'plan-1',
          organizationId: 'org-1',
          productVariantId: 'var-1',
          locationId: null,
          planType: 'DAILY',
          currency: 'EUR',
          priceAmountMinor: 2500,
          internalLabel: 'Tarif 25€',
          lifecycleState: 'DRAFT',
          version: 1,
          discountTiers: [],
          translations: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isPriced: false,
      },
    };

    const progress = resolveBikeSetupProgress(bikeWithPricing);

    expect(progress.completedSteps).toContain('IDENTITY');
    expect(progress.completedSteps).toContain('PHOTOS');
    expect(progress.completedSteps).toContain('PRICING');
    expect(progress.completedSteps).not.toContain('INVENTORY');
    expect(progress.nextStep).toBe('INVENTORY');
  });

  it('indique REVIEW si toutes les étapes sont complétées', () => {
    const fullyCompleteBike: UnifiedBike = {
      ...baseBike,
      photos: {
        count: 3,
        minRequired: 3,
        isComplete: true,
        items: [makePhoto('1', 0), makePhoto('2', 1), makePhoto('3', 2)],
      },
      pricing: {
        activePlan: {
          id: 'plan-1',
          organizationId: 'org-1',
          productVariantId: 'var-1',
          locationId: null,
          planType: 'DAILY',
          currency: 'EUR',
          priceAmountMinor: 2500,
          internalLabel: 'Tarif 25€',
          lifecycleState: 'ACTIVE',
          version: 1,
          discountTiers: [],
          translations: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        draftPlan: null,
        isPriced: true,
      },
      inventory: {
        totalCount: 3,
        activeCount: 3,
        maintenanceCount: 0,
        retiredCount: 0,
        items: [
          {
            id: 'inv-1',
            locationId: 'loc-1',
            sku: 'CAN-001',
            serialNumber: null,
            status: 'ACTIVE',
            notes: null,
            createdAt: new Date(),
          },
        ],
      },
      publication: {
        status: 'DRAFT',
        ready: true,
        failures: [],
      },
      offerReadiness: {
        hasPricing: true,
        hasInventory: true,
        isAvailable: true,
      },
      statusSummary: 'READY_TO_PUBLISH',
    };

    const progress = resolveBikeSetupProgress(fullyCompleteBike);

    expect(progress.completedSteps).toEqual(['IDENTITY', 'PHOTOS', 'PRICING', 'INVENTORY']);
    expect(progress.nextStep).toBe('REVIEW');
    expect(progress.isPublicationReady).toBe(true);
    expect(progress.isOfferReady).toBe(true);
  });
});
