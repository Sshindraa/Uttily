import { describe, it, expect, vi } from 'vitest';
import { getUnifiedBike } from './unified-bike';
import type { DatabaseClient } from '@uttily/database';

describe('UnifiedBike Read Model (Core Unit Tests)', () => {
  it('agrège les 4 piliers et calcule la readiness correctement', async () => {
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
                  categorySlug: 'velo-urbain',
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
                    slotKey: 'hero-profile',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    mimeType: 'image/jpeg',
                    checksumSha256: 'sha-1',
                    createdAt: new Date(),
                  },
                  {
                    id: 'photo-2',
                    publicId: 'pub-2',
                    storageKey: 'storage-2',
                    sortOrder: 1,
                    slotKey: 'three-quarter',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    mimeType: 'image/jpeg',
                    checksumSha256: 'sha-2',
                    createdAt: new Date(),
                  },
                  {
                    id: 'photo-3',
                    publicId: 'pub-3',
                    storageKey: 'storage-3',
                    sortOrder: 2,
                    slotKey: 'secondary-view',
                    fileState: 'AVAILABLE',
                    byteSize: 1024,
                    mimeType: 'image/jpeg',
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
            return {
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  locationId: 'loc-1',
                  sku: 'CAN-001',
                  serialNumber: 'SN-001',
                  status: 'ACTIVE',
                  notes: null,
                  createdAt: new Date(),
                },
                {
                  id: 'inv-2',
                  locationId: 'loc-1',
                  sku: 'CAN-002',
                  serialNumber: 'SN-002',
                  status: 'ACTIVE',
                  notes: null,
                  createdAt: new Date(),
                },
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
    expect(bike.product.categoryName).toBe('Vélo Urbain');
    expect(bike.variant.name).toBe('Taille M');

    // 2. Photos
    expect(bike.photos.count).toBe(3);
    expect(bike.photos.isComplete).toBe(true);

    // 3. Pricing
    expect(bike.pricing.isPriced).toBe(true);
    expect(bike.pricing.activePlan?.priceAmountMinor).toBe(2500);

    // 4. Inventaire
    expect(bike.inventory.activeCount).toBe(2);
    expect(bike.inventory.totalCount).toBe(2);

    // 5. Readiness
    expect(bike.readiness.isPublishable).toBe(true);
    expect(bike.readiness.statusSummary).toBe('READY_TO_PUBLISH');
  });
});
