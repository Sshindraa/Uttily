import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserErasureError } from '@uttily/core';

const { getAuthenticatedUserMock, createPrivacyRequestMock, eraseUserAccountMock, deleteUserMock } =
  vi.hoisted(() => ({
    getAuthenticatedUserMock: vi.fn(),
    createPrivacyRequestMock: vi.fn(),
    eraseUserAccountMock: vi.fn(),
    deleteUserMock: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: getAuthenticatedUserMock,
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(() =>
    Promise.resolve({
      users: {
        deleteUser: deleteUserMock,
      },
    }),
  ),
}));

vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@uttily/core');
  return {
    ...actual,
    createPrivacyRequest: createPrivacyRequestMock,
    eraseUserAccount: eraseUserAccountMock,
  };
});

const { submitPrivacyRequestAction, eraseMyAccountAction } = await import('./privacy');

describe('Privacy Server Actions', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001' };

  beforeEach(() => {
    getAuthenticatedUserMock.mockReset();
    createPrivacyRequestMock.mockReset();
    eraseUserAccountMock.mockReset();
    deleteUserMock.mockReset();
  });

  describe('submitPrivacyRequestAction', () => {
    it('échoue si non authentifié', async () => {
      getAuthenticatedUserMock.mockResolvedValue(null);

      const result = await submitPrivacyRequestAction('ACCESS', 'Détails');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('UNAUTHENTICATED');
      }
    });

    it('échoue si le type de demande est invalide', async () => {
      getAuthenticatedUserMock.mockResolvedValue(user);

      const result = await submitPrivacyRequestAction('INVALID_TYPE');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID_REQUEST_TYPE');
      }
    });

    it('enregistre une demande valide et revalide le path', async () => {
      getAuthenticatedUserMock.mockResolvedValue(user);
      createPrivacyRequestMock.mockResolvedValue({
        id: 'req-123',
        requestType: 'ERASURE',
        status: 'RECEIVED',
        responseDueAt: new Date('2026-10-03T10:00:00.000Z'),
      });

      const result = await submitPrivacyRequestAction('ERASURE', 'Demande de suppression');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.requestId).toBe('req-123');
        expect(result.data.requestType).toBe('ERASURE');
        expect(result.data.responseDueAt).toBe('2026-10-03T10:00:00.000Z');
      }
      expect(createPrivacyRequestMock).toHaveBeenCalledWith(expect.anything(), {
        userId: user.id,
        requestType: 'ERASURE',
        details: 'Demande de suppression',
      });
    });
  });

  describe('eraseMyAccountAction (Lot 21-P2)', () => {
    it('échoue si non authentifié', async () => {
      getAuthenticatedUserMock.mockResolvedValue(null);

      const result = await eraseMyAccountAction();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('UNAUTHENTICATED');
      }
    });

    it('échoue si UserErasureError est levée (e.g. réservations en cours)', async () => {
      getAuthenticatedUserMock.mockResolvedValue(user);
      eraseUserAccountMock.mockRejectedValue(
        new UserErasureError(
          'ACTIVE_BOOKINGS_EXIST',
          'Suppression impossible : vous avez des réservations actives ou confirmées en cours.',
        ),
      );

      const result = await eraseMyAccountAction();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('ACTIVE_BOOKINGS_EXIST');
        expect(result.message).toContain('réservations actives ou confirmées');
      }
    });

    it('exécute l’effacement et retourne les dates de scellement probatoire', async () => {
      getAuthenticatedUserMock.mockResolvedValue(user);
      const civilDate = new Date('2031-09-04T12:00:00.000Z');
      const accountingDate = new Date('2036-09-04T12:00:00.000Z');

      eraseUserAccountMock.mockImplementation(async (_db, options) => {
        if (options.deleteExternalIdentity) {
          await options.deleteExternalIdentity('user_clerk_123');
        }
        return {
          ok: true,
          alreadyErased: false,
          userId: user.id,
          sealedAt: new Date('2026-09-04T12:00:00.000Z'),
          civilRetentionUntil: civilDate,
          accountingRetentionUntil: accountingDate,
          sealedBookingsCount: 3,
          sealedPaymentsCount: 3,
          sealedDocumentsCount: 1,
          externalIdentityDeleted: true,
        };
      });

      const result = await eraseMyAccountAction();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.userId).toBe(user.id);
        expect(result.data.civilRetentionUntil).toBe(civilDate.toISOString());
        expect(result.data.accountingRetentionUntil).toBe(accountingDate.toISOString());
      }

      expect(eraseUserAccountMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: user.id,
          actorUserId: user.id,
          triggerSource: 'SELF_SERVICE',
        }),
      );
      expect(deleteUserMock).toHaveBeenCalledWith('user_clerk_123');
    });
  });
});
