import { describe, it, expect, vi } from 'vitest';
import { getUnifiedBike, listUnifiedBikes, resolveBikeStatusSummary } from './unified-bike';
import type { DatabaseClient } from '@uttily/database';

describe('UnifiedBike Read Model (Core Unit Tests)', () => {
  describe('resolveBikeStatusSummary', () => {
    it('retourne ARCHIVED si le produit est archivé', () => {
      expect(resolveBikeStatusSummary('ARCHIVED', true, true)).toBe('ARCHIVED');
    });

    it('retourne INCOMPLETE si DRAFT et publication incomplète', () => {
      expect(resolveBikeStatusSummary('DRAFT', false, false)).toBe('INCOMPLETE');
      expect(resolveBikeStatusSummary('DRAFT', false, true)).toBe('INCOMPLETE');
    });

    it('retourne READY_TO_PUBLISH si DRAFT et publication complète', () => {
      expect(resolveBikeStatusSummary('DRAFT', true, false)).toBe('READY_TO_PUBLISH');
      expect(resolveBikeStatusSummary('DRAFT', true, true)).toBe('READY_TO_PUBLISH');
    });

    it('retourne ONLINE_UNAVAILABLE si PUBLISHED sans offre disponible (0 stock ou sans prix)', () => {
      expect(resolveBikeStatusSummary('PUBLISHED', true, false)).toBe('ONLINE_UNAVAILABLE');
    });

    it('retourne ONLINE_AVAILABLE si PUBLISHED avec tarif et exemplaire actif', () => {
      expect(resolveBikeStatusSummary('PUBLISHED', true, true)).toBe('ONLINE_AVAILABLE');
    });
  });

  it('agrège les 4 piliers et calcule la publication readiness via collectPublicationFailures', async () => {
    let selectIndex = 0;

    const mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'prod-1',
                  organizationId: 'org-1',
                  categoryId: 'cat-1',
                  categoryName: 'Vélo Urbain',
                  categorySlug: 'bike',
                  name: 'Canyon Roadlite',
                  slug: 'canyon-roadlite',
                  description: 'Superbe vélo de ville léger et rapide.',
                  publicationStatus: 'DRAFT',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]),
            }),
          }),
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'prod-1',
                name: 'Canyon Roadlite',
                description: 'Superbe vélo de ville léger et rapide.',
                categoryId: 'cat-1',
                categoryIsActive: true,
                categorySlug: 'bike',
              },
            ]),
          }),
          where: vi.fn().mockImplementation(() => {
            selectIndex++;
            // 2. variantes
            if (selectIndex === 1) {
              return {
                orderBy: vi.fn().mockResolvedValue([
                  {
                    id: 'var-1',
                    name: 'Taille M',
                    skuSuffix: 'M',
                    isActive: true,
                    attributes: { color: 'noir' },
                    currency: 'EUR',
                  },
                ]),
              };
            }
            // 3. photos
            if (selectIndex === 2) {
              return {
                orderBy: vi.fn().mockResolvedValue([
                  {
                    id: 'photo-1',
                    publicId: 'pub-1',
                    storageKey: 'storage-1',
                    sortOrder: 0,
                    slotType: 'HERO_PROFILE',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    contentType: 'image/jpeg',
                    checksumSha256: 'sha-1',
                    createdAt: new Date(),
                  },
                  {
                    id: 'photo-2',
                    publicId: 'pub-2',
                    storageKey: 'storage-2',
                    sortOrder: 1,
                    slotType: 'THREE_QUARTER_FRONT',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    contentType: 'image/jpeg',
                    checksumSha256: 'sha-2',
                    createdAt: new Date(),
                  },
                  {
                    id: 'photo-3',
                    publicId: 'pub-3',
                    storageKey: 'storage-3',
                    sortOrder: 2,
                    slotType: 'SECONDARY_VIEW',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    contentType: 'image/jpeg',
                    checksumSha256: 'sha-3',
                    createdAt: new Date(),
                  },
                ]),
              };
            }
            // 4. pricing summary
            if (selectIndex === 3) {
              return {
                orderBy: vi.fn().mockResolvedValue([
                  {
                    id: 'plan-1',
                    organizationId: 'org-1',
                    productVariantId: 'var-1',
                    locationId: null,
                    planType: 'DAILY',
                    currency: 'EUR',
                    priceAmountMinor: 2500,
                    internalLabel: 'Tarif standard',
                    lifecycleState: 'ACTIVE',
                    version: 1,
                    priority: 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              };
            }
            // 4b. translations & tiers for pricing
            if (selectIndex === 4 || selectIndex === 5) {
              return [];
            }
            // 5. inventory items
            if (selectIndex === 6) {
              return {
                orderBy: vi.fn().mockResolvedValue([
                  {
                    id: 'inv-1',
                    currentLocationId: 'loc-1',
                    internalSku: 'CAN-001',
                    serialNumber: 'SN-001',
                    status: 'ACTIVE',
                    notes: null,
                    createdAt: new Date(),
                  },
                ]),
              };
            }
            // 6. collectPublicationFailuresBatch variant counts (groupBy)
            if (selectIndex === 7) {
              return {
                groupBy: vi.fn().mockResolvedValue([{ productId: 'prod-1', value: 1 }]),
              };
            }
            // 7. collectPublicationFailuresBatch photo counts (groupBy)
            if (selectIndex === 8) {
              return {
                groupBy: vi.fn().mockResolvedValue([{ productId: 'prod-1', value: 3 }]),
              };
            }
            // 8. collectPublicationFailuresBatch bike slots
            return {
              groupBy: vi.fn().mockResolvedValue([
                { productId: 'prod-1', slotType: 'HERO_PROFILE' },
                { productId: 'prod-1', slotType: 'THREE_QUARTER_FRONT' },
                { productId: 'prod-1', slotType: 'SECONDARY_VIEW' },
              ]),
            };
          }),
        })),
      })),
    } as unknown as DatabaseClient;

    const bike = await getUnifiedBike(mockDb, 'org-1', 'prod-1');

    expect(bike).not.toBeNull();
    if (!bike) return;

    // 1. Identité
    expect(bike.product.name).toBe('Canyon Roadlite');
    expect(bike.variant.name).toBe('Taille M');
    expect(bike.variant.currency).toBe('EUR');

    // 2. Photos
    expect(bike.photos.count).toBe(3);
    expect(bike.photos.isComplete).toBe(true);

    // 3. Pricing
    expect(bike.pricing.isPriced).toBe(true);
    expect(bike.pricing.activePlan?.priceAmountMinor).toBe(2500);

    // 4. Inventaire
    expect(bike.inventory.activeCount).toBe(1);

    // 5. Publication & Offer Readiness
    expect(bike.publication.ready).toBe(true);
    expect(bike.offerReadiness.isAvailable).toBe(true);
    expect(bike.statusSummary).toBe('READY_TO_PUBLISH');
  });

  it('listUnifiedBikes liste l’ensemble des vélos avec leur statut synthétique', async () => {
    let selectIndex = 0;

    const mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'p-1',
                  name: 'Vélo Ville',
                  slug: 'velo-ville',
                  description: 'Description vélo',
                  publicationStatus: 'PUBLISHED',
                  categoryName: 'Urbain',
                  categorySlug: 'bike',
                  createdAt: new Date(),
                },
              ]),
            }),
          }),
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'p-1',
                name: 'Vélo Ville',
                description: 'Description vélo',
                categoryId: 'cat-1',
                categoryIsActive: true,
              },
            ]),
          }),
          where: vi.fn().mockImplementation(() => {
            selectIndex++;
            // 2. variantes
            if (selectIndex === 1) {
              return {
                orderBy: vi
                  .fn()
                  .mockResolvedValue([
                    { id: 'v-1', productId: 'p-1', name: 'Taille Unique', isActive: true },
                  ]),
              };
            }
            // 3. photos
            if (selectIndex === 2) {
              return {
                orderBy: vi.fn().mockResolvedValue([
                  {
                    productId: 'p-1',
                    publicId: 'pub-1',
                    checksumSha256: 's1',
                    slotType: 'HERO_PROFILE',
                    sortOrder: 0,
                  },
                  {
                    productId: 'p-1',
                    publicId: 'pub-2',
                    checksumSha256: 's2',
                    slotType: 'THREE_QUARTER_FRONT',
                    sortOrder: 1,
                  },
                  {
                    productId: 'p-1',
                    publicId: 'pub-3',
                    checksumSha256: 's3',
                    slotType: 'SECONDARY_VIEW',
                    sortOrder: 2,
                  },
                ]),
              };
            }
            // 4. plans actifs
            if (selectIndex === 3) {
              return [{ productVariantId: 'v-1', priceAmountMinor: 2000 }];
            }
            // 5. inventaire
            if (selectIndex === 4) {
              return [{ productVariantId: 'v-1', status: 'ACTIVE' }];
            }
            // 6. collectPublicationFailuresBatch variant counts (groupBy)
            if (selectIndex === 5) {
              return {
                groupBy: vi.fn().mockResolvedValue([{ productId: 'p-1', value: 1 }]),
              };
            }
            // 7. collectPublicationFailuresBatch photo counts (groupBy)
            return {
              groupBy: vi.fn().mockResolvedValue([{ productId: 'p-1', value: 3 }]),
            };
          }),
        })),
      })),
    } as unknown as DatabaseClient;

    const bikes = await listUnifiedBikes(mockDb, 'org-1');
    expect(bikes).toHaveLength(1);
    expect(bikes[0]?.name).toBe('Vélo Ville');
    expect(bikes[0]?.statusSummary).toBe('ONLINE_AVAILABLE');
    expect(bikes[0]?.priceAmountMinor).toBe(2000);
    expect(bikes[0]?.activeInventoryCount).toBe(1);
    expect(bikes[0]?.photoCount).toBe(3);
    expect(bikes[0]?.hasRequiredPhotos).toBe(true);
  });
});
