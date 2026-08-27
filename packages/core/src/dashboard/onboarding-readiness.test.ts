import { describe, it, expect, vi } from 'vitest';
import { getOrganizationOnboardingReadiness } from './onboarding-readiness';
import type { DatabaseClient } from '@uttily/database';

describe('Organization Onboarding Readiness (Pure Unit & Schema Contract)', () => {
  it('structure la réponse avec exactement 7 jalons et les clés attendues', async () => {
    // Mock minimal de DatabaseClient simulant une organisation neuve (aucun élément)
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { id: 'org-1', legalName: 'Mon Entreprise', slug: 'mon-entreprise' },
              ]),
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as DatabaseClient;

    // Pour les requêtes multiples de getOrganizationOnboardingReadiness
    let callCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          // 1. org
          if (callCount === 1)
            return {
              limit: vi
                .fn()
                .mockResolvedValue([
                  { id: 'org-1', legalName: 'Mon Entreprise', slug: 'mon-entreprise' },
                ]),
            };
          // 2. locations
          if (callCount === 2) return [];
          // 3. products
          if (callCount === 3) return [];
          // 4. pricing
          if (callCount === 4) return { limit: vi.fn().mockResolvedValue([]) };
          // 5. payments
          return { limit: vi.fn().mockResolvedValue([]) };
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ val: 0 }]),
        }),
      })),
    })) as unknown as typeof mockDb.select;

    const readiness = await getOrganizationOnboardingReadiness(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
    );

    expect(readiness.totalCount).toBe(7);
    expect(readiness.milestones).toHaveLength(7);
    expect(readiness.milestones.map((m) => m.key)).toEqual([
      'ORGANIZATION',
      'LOCATION',
      'PRIMARY_PRODUCT',
      'PHOTOS',
      'PRICING',
      'INVENTORY',
      'PAYMENTS',
    ]);
    expect(readiness.completedCount).toBe(1); // Seulement ORGANIZATION
    expect(readiness.percentage).toBe(14); // 1/7 = 14%
    expect(readiness.isConfigurationComplete).toBe(false);
    expect(readiness.isReadyForReservations).toBe(false);
  });
});
