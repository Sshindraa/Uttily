import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  startPrivacyReviewAction,
  flagPrivacyIdentityCheckAction,
  extendPrivacyDeadlineAction,
  recordExtensionNotificationAction,
  recordPrivacyResponseNotificationAction,
  resolvePrivacyRequestAction,
  executeSupportErasureAction,
} from './support-privacy';
import * as supportAuth from '@/lib/support-auth';
import * as core from '@uttily/core';

vi.mock('@/lib/support-auth', () => ({
  requireSupportPlatformAdmin: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(() =>
    Promise.resolve({
      users: {
        deleteUser: vi.fn(),
      },
    }),
  ),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    startPrivacyRequestReview: vi.fn(),
    flagPrivacyRequestIdentityCheck: vi.fn(),
    extendPrivacyRequestDeadline: vi.fn(),
    recordExtensionNotification: vi.fn(),
    recordPrivacyResponseNotification: vi.fn(),
    resolvePrivacyRequest: vi.fn(),
    executeErasurePrivacyRequest: vi.fn(),
  };
});

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Support Privacy Server Actions', () => {
  const adminUser = {
    id: 'admin-1111-2222-3333-444444444444',
    email: 'dpo@uttily.com',
    isPlatformAdmin: true,
    oidcSubject: 'sub_admin',
    emailVerified: true,
  };
  const fakeDb = {} as unknown as DatabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startPrivacyReviewAction', () => {
    it('renvoie UNAUTHENTICATED si non authentifié', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockRejectedValueOnce(
        new Error('UNAUTHENTICATED'),
      );

      const res = await startPrivacyReviewAction('req-1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('UNAUTHENTICATED');
      }
    });

    it('exécute startPrivacyRequestReview avec succès', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'startPrivacyRequestReview').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-1',
        status: 'IN_REVIEW',
      });

      const res = await startPrivacyReviewAction('req-1');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('IN_REVIEW');
      }
      expect(core.startPrivacyRequestReview).toHaveBeenCalledWith(fakeDb, {
        requestId: 'req-1',
        actorUserId: adminUser.id,
      });
    });
  });

  describe('flagPrivacyIdentityCheckAction', () => {
    it('exécute flagPrivacyRequestIdentityCheck avec succès', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'flagPrivacyRequestIdentityCheck').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-2',
        status: 'IDENTITY_CHECK_REQUIRED',
      });

      const res = await flagPrivacyIdentityCheckAction('req-2');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('IDENTITY_CHECK_REQUIRED');
      }
    });
  });

  describe('extendPrivacyDeadlineAction', () => {
    it('refuse une date invalide', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });

      const res = await extendPrivacyDeadlineAction('req-3', {
        extendedUntil: 'invalid-date',
        reason: 'Test',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('VALIDATION');
      }
    });

    it('prolonge l’échéance avec succès', async () => {
      const extDate = new Date('2026-11-20T12:00:00Z');
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'extendPrivacyRequestDeadline').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-3',
        extendedUntil: extDate,
      });

      const res = await extendPrivacyDeadlineAction('req-3', {
        extendedUntil: extDate.toISOString(),
        reason: 'Recherche archives',
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.extendedUntil).toEqual(extDate);
      }
    });
  });

  describe('recordExtensionNotificationAction', () => {
    it('consigne la notification avec succès', async () => {
      const notifDate = new Date('2026-10-05T10:00:00Z');
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'recordExtensionNotification').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-3b',
        notifiedAt: notifDate,
      });

      const res = await recordExtensionNotificationAction('req-3b');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.notifiedAt).toEqual(notifDate);
      }
    });
  });

  describe('resolvePrivacyRequestAction', () => {
    it('résout la demande avec succès', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'resolvePrivacyRequest').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-4',
        status: 'DECISION_READY',
        resolution: 'REFUSED',
      });

      const res = await resolvePrivacyRequestAction('req-4', {
        resolutionStatus: 'REFUSED',
        decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
        resolutionNotes: 'Factures conservées 10 ans',
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('DECISION_READY');
        expect(res.data.resolution).toBe('REFUSED');
      }
    });
  });

  describe('recordPrivacyResponseNotificationAction', () => {
    it('enregistre l’attestation de réponse et clôture la demande (COMPLETED)', async () => {
      const notifDate = new Date('2026-09-20T10:00:00Z');
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });
      vi.spyOn(core, 'recordPrivacyResponseNotification').mockResolvedValueOnce({
        ok: true,
        requestId: 'req-5',
        status: 'COMPLETED',
        responseNotifiedAt: notifDate,
      });

      const res = await recordPrivacyResponseNotificationAction('req-5');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('COMPLETED');
        expect(res.data.responseNotifiedAt).toEqual(notifDate);
      }
    });
  });

  describe('executeSupportErasureAction (Lot 21-P2)', () => {
    it('échoue si l’utilisateur n’est pas administrateur', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockRejectedValueOnce(
        new Error('UNAUTHENTICATED'),
      );

      const res = await executeSupportErasureAction('req-erasure-1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('UNAUTHENTICATED');
      }
    });

    it('exécute l’effacement et retourne le résultat de scellement probatoire', async () => {
      vi.spyOn(supportAuth, 'requireSupportPlatformAdmin').mockResolvedValueOnce({
        user: adminUser,
        db: fakeDb,
      });

      const civilDate = new Date('2031-09-04T12:00:00.000Z');
      const accountingDate = new Date('2036-09-04T12:00:00.000Z');

      vi.spyOn(core, 'executeErasurePrivacyRequest').mockResolvedValueOnce({
        ok: true,
        alreadyErased: false,
        userId: 'pseudonymized-user-id',
        sealedAt: new Date('2026-09-04T12:00:00.000Z'),
        civilRetentionUntil: civilDate,
        accountingRetentionUntil: accountingDate,
        sealedBookingsCount: 5,
        sealedPaymentsCount: 5,
        sealedDocumentsCount: 2,
        externalIdentityDeleted: true,
      });

      const res = await executeSupportErasureAction('req-erasure-2');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.userId).toBe('pseudonymized-user-id');
        expect(res.data.civilRetentionUntil).toEqual(civilDate);
        expect(res.data.accountingRetentionUntil).toEqual(accountingDate);
        expect(res.data.sealedBookingsCount).toBe(5);
      }

      expect(core.executeErasurePrivacyRequest).toHaveBeenCalledWith(fakeDb, {
        requestId: 'req-erasure-2',
        actorUserId: adminUser.id,
        deleteExternalIdentity: expect.any(Function),
      });
    });
  });
});

