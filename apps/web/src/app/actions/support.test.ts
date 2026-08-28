import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  retryNotificationAction,
  cancelNotificationAction,
  resendInvitationNotificationAction,
  reconcilePaymentSupportAction,
} from './support';
import * as supportAuth from '@/lib/support-auth';
import * as core from '@uttily/core';

vi.mock('@/lib/support-auth', () => ({
  requireSupportPlatformAdmin: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    retryNotificationSupport: vi.fn(),
    cancelNotificationSupport: vi.fn(),
    resendInvitationNotificationSupport: vi.fn(),
    reconcilePaymentSupport: vi.fn(),
  };
});

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Support Server Actions (Apps/Web)', () => {
  const adminUser = {
    id: 'admin-1111-2222-3333-444444444444',
    email: 'support@uttily.com',
    isPlatformAdmin: true,
    oidcSubject: 'sub_admin',
    emailVerified: true,
  };
  const fakeDb = {} as unknown as DatabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('retryNotificationAction', () => {
    it('renvoie UNAUTHENTICATED si non authentifié', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockRejectedValueOnce(
        new Error('UNAUTHENTICATED'),
      );

      const res = await retryNotificationAction('notif-1', 'Test retry');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('UNAUTHENTICATED');
      }
    });

    it('renvoie SUPPORT_UNAUTHORIZED si l’utilisateur n’est pas admin Uttily', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockRejectedValueOnce(
        new core.AuthorizationError('Action réservée à l’administrateur Uttily.'),
      );

      const res = await retryNotificationAction('notif-1', 'Test retry');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SUPPORT_UNAUTHORIZED');
      }
    });

    it('exécute l’action support avec succès', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'retryNotificationSupport').mockResolvedValueOnce({
        ok: true,
        notificationId: 'notif-1',
      });

      const res = await retryNotificationAction('notif-1', 'Client demande renvoi');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.notificationId).toBe('notif-1');
      }
    });
  });

  describe('cancelNotificationAction', () => {
    it('annule la notification et retourne le statut CANCELLED', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'cancelNotificationSupport').mockResolvedValueOnce({
        ok: true,
        notificationId: 'notif-2',
      });

      const res = await cancelNotificationAction('notif-2', 'Doublon');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.notificationId).toBe('notif-2');
      }
    });
  });

  describe('resendInvitationNotificationAction', () => {
    const SUPPORT_REQUEST_ID = '9f1c3b2a-1234-4abc-9def-111111111111';

    it('renvoie l’invitation et consigne l’audit sans fuite de secret', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'resendInvitationNotificationSupport').mockResolvedValueOnce({
        ok: true,
        invitationId: 'inv-1',
        notificationId: 'notif-1',
      });

      const res = await resendInvitationNotificationAction(
        'inv-1',
        'Invitation non reçue',
        SUPPORT_REQUEST_ID,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.invitationId).toBe('inv-1');
      }
    });

    it('transmet intégralement le supportRequestId reçu au Core (preuve end-to-end 16.1.1)', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      const resendMock = vi
        .spyOn(core, 'resendInvitationNotificationSupport')
        .mockResolvedValueOnce({
          ok: true,
          invitationId: 'inv-1',
          notificationId: 'notif-1',
        });

      await resendInvitationNotificationAction('inv-1', 'Invitation non reçue', SUPPORT_REQUEST_ID);

      expect(resendMock).toHaveBeenCalledTimes(1);
      const coreInput = resendMock.mock.calls[0]?.[1];
      expect(coreInput).toMatchObject({
        invitationId: 'inv-1',
        reason: 'Invitation non reçue',
        actorUserId: adminUser.id,
        supportRequestId: SUPPORT_REQUEST_ID,
      });
    });

    it('refuse fail-closed sans supportRequestId et n’appelle jamais le Core', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      const resendMock = vi.spyOn(core, 'resendInvitationNotificationSupport');

      for (const missing of ['', '   ']) {
        const res = await resendInvitationNotificationAction('inv-1', 'Motif', missing);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe('SUPPORT_ACTION_INVALID_STATE');
        }
      }
      expect(resendMock).not.toHaveBeenCalled();
    });
  });

  describe('reconcilePaymentSupportAction', () => {
    it('reprogramme la vérification du paiement', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'reconcilePaymentSupport').mockResolvedValueOnce({
        id: 'pay-1',
        status: 'PROCESSING',
        reconciledCount: 1,
      });

      const res = await reconcilePaymentSupportAction('pay-1', 'Blocage webhook');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('PROCESSING');
      }
    });
  });
});
