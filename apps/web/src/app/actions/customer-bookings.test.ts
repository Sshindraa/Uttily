import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import { previewMyBookingCancellationAction, cancelMyBookingAction } from './customer-bookings';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@uttily/core', () => ({
  previewBookingCancellation: vi.fn(),
  cancelConfirmedBooking: vi.fn(),
}));

describe('Customer Bookings Server Actions', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'locataire@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_1',
  };
  const bookingId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('previewMyBookingCancellationAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    const res = await previewMyBookingCancellationAction(bookingId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('UNAUTHENTICATED');
    }
  });

  it('previewMyBookingCancellationAction : retourne NOT_FOUND si la réservation n’appartient pas à l’utilisateur', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]), // Pas de résultat car customerUserId mismatch
          }),
        }),
      }),
    };
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce(fakeDb as unknown as DatabaseClient);

    const res = await previewMyBookingCancellationAction(bookingId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('NOT_FOUND');
    }
  });

  it('cancelMyBookingAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    const res = await cancelMyBookingAction({
      bookingId,
      idempotencyKey: 'k',
      previewFingerprint: 'fp',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('UNAUTHENTICATED');
    }
  });

  it('cancelMyBookingAction : retourne NOT_FOUND si la réservation n’appartient pas à l’utilisateur', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    };
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce(fakeDb as unknown as DatabaseClient);

    const res = await cancelMyBookingAction({
      bookingId,
      idempotencyKey: 'k',
      previewFingerprint: 'fp',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('NOT_FOUND');
    }
  });
});
