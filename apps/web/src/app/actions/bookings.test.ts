import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBookingDraftAction, mapBookingDraftError } from './bookings';
import * as auth from '@/lib/auth';
import * as core from '@uttily/core';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    resolvePublicBookingAuthority: vi.fn(),
    createBookingDraftWithHold: vi.fn(),
  };
});

describe('createBookingDraftAction — tests unitaires', () => {
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
  const validPublicVariantId = '44444444-4444-4444-8444-444444444444';
  const validIdempotencyKey = '55555555-5555-4555-8555-555555555555';

  const mockResolvedAuthority: core.ResolvedPublicBookingAuthority = {
    organizationId: 'aaaa0000-0000-4000-8000-000000000000',
    locationId: 'bbbb0000-0000-4000-8000-000000000000',
    productId: 'cccc0000-0000-4000-8000-000000000000',
    variantId: 'dddd0000-0000-4000-8000-000000000000',
    timeZone: 'Europe/Paris',
    operatingCurrency: 'EUR',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Rejette UNAUTHENTICATED si l’utilisateur n’est pas connecté (FR et EN)', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);

    const resFr = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: validPublicVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
      locale: 'fr',
    });
    expect(resFr.ok).toBe(false);
    if (!resFr.ok) {
      expect(resFr.code).toBe('UNAUTHENTICATED');
      expect(resFr.message).toBe('Vous devez être connecté pour effectuer une réservation.');
    }

    const resEn = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: validPublicVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
      locale: 'en',
    });
    expect(resEn.ok).toBe(false);
    if (!resEn.ok) {
      expect(resEn.code).toBe('UNAUTHENTICATED');
      expect(resEn.message).toBe('You must be signed in to make a booking.');
    }
  });

  it('2. Rejette VALIDATION pour un publicVariantId manquant ou non-UUID', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: 'not-a-uuid',
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
    }
  });

  it('3. Rejette NOT_FOUND si resolvePublicBookingAuthority retourne NOT_FOUND', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(core.resolvePublicBookingAuthority).mockResolvedValue({
      kind: 'NOT_FOUND',
    });

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: validPublicVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
    }
  });

  it('4. Succès : résout l’autorité et appelle createBookingDraftWithHold avec les IDs internes', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(core.resolvePublicBookingAuthority).mockResolvedValue({
      kind: 'SUCCESS',
      authority: mockResolvedAuthority,
    });

    const draftId = 'eeee0000-0000-4000-8000-000000000000';
    vi.mocked(core.createBookingDraftWithHold).mockResolvedValue({
      kind: 'SUCCESS',
      statusCode: 201,
      resourceId: draftId,
      body: {} as unknown as core.BookingDraftSuccessBody,
    });

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: validPublicVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.draftId).toBe(draftId);
      expect(res.data.redirectUrl).toBe(`/checkout/${draftId}`);
    }

    expect(core.createBookingDraftWithHold).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: mockResolvedAuthority.organizationId,
        locationId: mockResolvedAuthority.locationId,
        customerUserId: mockUser.id,
        lines: [{ variantId: mockResolvedAuthority.variantId, quantity: 1 }],
      }),
    );
  });

  it('5. Messages d’erreur fermés et assainis : prouve qu’aucun secret, SQL ou UUID interne ne fuite', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(mockUser);
    vi.mocked(core.resolvePublicBookingAuthority).mockResolvedValue({
      kind: 'SUCCESS',
      authority: mockResolvedAuthority,
    });

    const sentinelSecret = 'sk_live_secret_token_abcdef123456';
    const sentinelTable = 'internal_db_table_xyz';
    const sentinelInternalUuid = '99998888-7777-6666-5555-444433332222';

    vi.mocked(core.createBookingDraftWithHold).mockResolvedValue({
      kind: 'FAILURE',
      statusCode: 400,
      resourceId: null,
      body: {
        error: 'DATABASE_ERROR' as unknown as 'VALIDATION',
        message: `FATAL: table ${sentinelTable} with id ${sentinelInternalUuid} key=${sentinelSecret}`,
      },
    });

    const res = await createBookingDraftAction({
      publicProductId: validPublicProductId,
      publicLocationId: validPublicLocationId,
      publicVariantId: validPublicVariantId,
      quantity: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-05' },
      idempotencyKey: validIdempotencyKey,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNKNOWN');
      expect(res.message).not.toContain(sentinelSecret);
      expect(res.message).not.toContain(sentinelTable);
      expect(res.message).not.toContain(sentinelInternalUuid);
    }
  });

  it('6. mapBookingDraftError couvre tous les codes d’erreur avec traductions FR et EN', async () => {
    const conflictFr = await mapBookingDraftError('CONFLICT_BLOCK', 'fr');
    expect(conflictFr.code).toBe('CONFLICT_BLOCK');
    expect(conflictFr.message).toContain('plus disponible');

    const conflictEn = await mapBookingDraftError('CONFLICT_BLOCK', 'en');
    expect(conflictEn.code).toBe('CONFLICT_BLOCK');
    expect(conflictEn.message).toContain('no longer available');

    const idemFr = await mapBookingDraftError('CONFLICT_IDEMPOTENCY', 'fr');
    expect(idemFr.code).toBe('CONFLICT_IDEMPOTENCY');

    const hoursFr = await mapBookingDraftError('LOCATION_CLOSED', 'fr');
    expect(hoursFr.code).toBe('VALIDATION');
    expect(hoursFr.message).toContain('fermé');
  });
});
