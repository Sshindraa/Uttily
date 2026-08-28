import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import {
  retryNotificationAction,
  cancelNotificationAction,
  resendInvitationNotificationAction,
  reconcilePaymentSupportAction,
} from '@/app/actions/support';
import * as auth from '@/lib/auth';
import * as dbMod from '@/lib/db';
import { AuthorizationError } from '@uttily/core';

import type { DatabaseClient } from '@uttily/database';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Chantier 16 — Sécurité & Guardrails Support Back-Office', () => {
  const fakeDb = {} as unknown as DatabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(dbMod, 'getDb').mockReturnValue(fakeDb);
  });

  describe('Garde d’accès fail-closed', () => {
    it('bloque un utilisateur non-authentifié (UNAUTHENTICATED)', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

      await expect(requireSupportPlatformAdmin()).rejects.toThrow('UNAUTHENTICATED');
    });

    it('bloque un utilisateur Pro avec rôle OWNER/ADMIN mais isPlatformAdmin = false', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
        id: 'user-pro-owner',
        email: 'boss@location-pro.fr',
        isPlatformAdmin: false,
        oidcSubject: 'sub_pro_owner',
        emailVerified: true,
      });

      await expect(requireSupportPlatformAdmin()).rejects.toThrow(AuthorizationError);
    });

    it('autorise uniquement un compte interne Uttily (isPlatformAdmin = true)', async () => {
      const admin = {
        id: 'user-support-admin',
        email: 'ops@uttily.com',
        isPlatformAdmin: true,
        oidcSubject: 'sub_support_admin',
        emailVerified: true,
      };
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(admin);

      const ctx = await requireSupportPlatformAdmin();
      expect(ctx.user.id).toBe(admin.id);
      expect(ctx.user.isPlatformAdmin).toBe(true);
    });
  });

  describe('Server Actions sécurisées contre les accès non-autorisés', () => {
    it('retryNotificationAction rejette les utilisateurs Pro non-admin', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
        id: 'user-pro-owner',
        email: 'boss@location-pro.fr',
        isPlatformAdmin: false,
        oidcSubject: 'sub_pro_owner',
        emailVerified: true,
      });

      const res = await retryNotificationAction('notif-1', 'Test tentative non autorisée');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SUPPORT_UNAUTHORIZED');
      }
    });

    it('cancelNotificationAction rejette les utilisateurs Pro non-admin', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
        id: 'user-pro-owner',
        email: 'boss@location-pro.fr',
        isPlatformAdmin: false,
        oidcSubject: 'sub_pro_owner',
        emailVerified: true,
      });

      const res = await cancelNotificationAction('notif-1', 'Test');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SUPPORT_UNAUTHORIZED');
      }
    });

    it('resendInvitationNotificationAction rejette les utilisateurs Pro non-admin', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
        id: 'user-pro-owner',
        email: 'boss@location-pro.fr',
        isPlatformAdmin: false,
        oidcSubject: 'sub_pro_owner',
        emailVerified: true,
      });

      const res = await resendInvitationNotificationAction(
        'inv-1',
        'Test',
        '9f1c3b2a-1234-4abc-9def-111111111111',
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SUPPORT_UNAUTHORIZED');
      }
    });

    it('reconcilePaymentSupportAction rejette les utilisateurs Pro non-admin', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
        id: 'user-pro-owner',
        email: 'boss@location-pro.fr',
        isPlatformAdmin: false,
        oidcSubject: 'sub_pro_owner',
        emailVerified: true,
      });

      const res = await reconcilePaymentSupportAction('pay-1', 'Test');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SUPPORT_UNAUTHORIZED');
      }
    });
  });
});
