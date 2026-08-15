import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { createBookingDraftAction } from './bookings';
import * as auth from '@/lib/auth';
import * as dbModule from '@/lib/db';
import * as core from '@uttily/core';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    createBookingDraftWithHold: vi.fn(),
  };
});

describe('createBookingDraftAction', () => {
  const mockUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.com',
    oidcSubject: 'sub_111',
    displayName: 'Client Test',
    emailVerified: true,
    isPlatformAdmin: false,
  };

  const validPublicProductId = '22222222-2222-4222-8222-222222222222';
  const validPublicLocationId = '33333333-3333-4333-8333-333333333333';
  const validVariantId = '44444444-4444-4444-8444-444444444444';
  const validIdempotencyKey = '55555555-5555-4555-8555-555555555555';

  const defaultResolvedProductLocation = [
    {
      productId: 'aaaa0000-0000-4000-8000-000000000000',
      productOrgId: 'bbbb0000-0000-4000-8000-000000000000',
      productPublicationStatus: 'PUBLISHED',
      productDeletedAt: null,
      locationId: 'cccc0000-0000-4000-8000-000000000000',
      locationOrgId: 'bbbb0000-0000-4000-8000-000000000000',
      locationDeletedAt: null,
      isPubliclyListed: true,
      pickupEnabled: true,
    },
  ];

  const defaultResolvedVariant = [
    {
      id: validVariantId,
      isActive: true,
      deletedAt: null,
    },
  ];

  function createMockDb(
    productLocationRows = defaultResolvedProductLocation,
    variantRows = defaultResolvedVariant,
  ): DatabaseClient {
    let callCount = 0;
    const mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) return Promise.resolve(productLocationRows);
                return Promise.resolve(variantRows);
              }),
            })),
          })),
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(() => {
              callCount++;
              return Promise.resolve(variantRows);
            }),
          })),
        })),
      })),
    };
    return mockDb as unknown as DatabaseClient;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Rejette UNAUTHENTICATED si l’utilisateur n’est pas connecté', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNAUTHENTICATED');
    }
  });

  it('2. Rejette VALIDATION pour un UUID de produit invalide', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);

    const res = await createBookingDraftAction({
      publicProductId: 'invalid-uuid',
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
    }
  });

  it('3. Rejette VALIDATION si les dates DAY_RANGE sont invalides ou inversées', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-10', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
    }
  });

  it('4. Rejette NOT_FOUND si le produit ou l’établissement n’est pas trouvé ou non publié', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(dbModule.getDb).mockReturnValue(createMockDb([]));

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
    }
  });

  it('5. Succès : crée le booking draft avec hold et retourne la redirection vers checkout', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(dbModule.getDb).mockReturnValue(createMockDb());

    const draftId = 'dddd0000-0000-4000-8000-000000000000';
    vi.mocked(core.createBookingDraftWithHold).mockResolvedValue({
      kind: 'SUCCESS',
      statusCode: 201,
      resourceId: draftId,
      body: {} as unknown as core.BookingDraftSuccessBody,
    });

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.draftId).toBe(draftId);
      expect(res.data.redirectUrl).toBe(`/checkout/${draftId}`);
    }
  });

  it('6. Mappe CONFLICT_BLOCK de Core vers un message d’indisponibilité clair', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(dbModule.getDb).mockReturnValue(createMockDb());

    vi.mocked(core.createBookingDraftWithHold).mockResolvedValue({
      kind: 'FAILURE',
      statusCode: 409,
      resourceId: null,
      body: {
        error: 'CONFLICT_BLOCK',
        message: 'No available items for this slot',
      },
    });

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      variantId: validVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('CONFLICT_BLOCK');
      expect(res.message).toContain('plus disponible');
    }
  });
});
