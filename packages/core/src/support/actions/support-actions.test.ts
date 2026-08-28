import { describe, expect, it, vi } from 'vitest';
import { retryNotificationSupport, NotificationActionError } from './retry-notification';
import { cancelNotificationSupport } from './cancel-notification';
import { resendInvitationNotificationSupport } from './resend-invitation-notification';
import { reconcilePaymentSupport, PaymentReconcileActionError } from './reconcile-payment';

describe('Support Actions (Unit)', () => {
  describe('retryNotificationSupport', () => {
    it('exige un motif d’action support explicite', async () => {
      const fakeDb = {} as any;
      await expect(
        retryNotificationSupport(fakeDb, {
          notificationId: 'notif-1',
          actorUserId: 'user-1',
          reason: '   ',
        }),
      ).rejects.toThrow('Un motif explicite est obligatoire');
    });

    it('lève NOT_FOUND si la notification n\u2019existe pas', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        retryNotificationSupport(fakeDb, {
          notificationId: '00000000-0000-0000-0000-000000000001',
          actorUserId: '00000000-0000-0000-0000-000000000002',
          reason: 'Revue client',
        }),
      ).rejects.toThrow(NotificationActionError);
    });

    it('refuse de relancer une notification avec statut non-FAILED (SENT, PENDING, SENDING, CANCELLED)', async () => {
      for (const status of ['SENT', 'PENDING', 'SENDING', 'CANCELLED']) {
        const txMock = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: 'notif-1',
                      status,
                      failureCode: null,
                      requiresManualReview: false,
                    },
                  ]),
                }),
              }),
            }),
          }),
        };
        const fakeDb = {
          transaction: vi.fn((cb) => cb(txMock)),
        } as any;

        await expect(
          retryNotificationSupport(fakeDb, {
            notificationId: 'notif-1',
            actorUserId: 'user-1',
            reason: 'Tentative de relance',
          }),
        ).rejects.toThrow(`Seules les notifications en statut FAILED peuvent être relancées`);
      }
    });

    it('refuse la relance pour PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED (anti-doublon)', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'notif-1',
                    status: 'FAILED',
                    failureCode: 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED',
                    requiresManualReview: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        retryNotificationSupport(fakeDb, {
          notificationId: 'notif-1',
          actorUserId: 'user-1',
          reason: 'Client inquiet',
        }),
      ).rejects.toThrow('Relance interdite : la fenêtre d’incertitude du provider est expirée');
    });
  });

  describe('cancelNotificationSupport', () => {
    it('refuse d\u2019annuler une notification déjà envoyée (SENT)', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'notif-1',
                    status: 'SENT',
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        cancelNotificationSupport(fakeDb, {
          notificationId: 'notif-1',
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow('Impossible d’annuler une notification déjà envoyée.');
    });
  });

  describe('resendInvitationNotificationSupport', () => {
    it('exige un motif d’action support explicite', async () => {
      const fakeDb = {} as any;
      await expect(
        resendInvitationNotificationSupport(fakeDb, {
          invitationId: 'inv-1',
          actorUserId: 'user-1',
          reason: '',
        }),
      ).rejects.toThrow('Un motif explicite est obligatoire');
    });

    it('refuse de renvoyer une invitation expirée', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'inv-1',
                    status: 'PENDING',
                    expiresAt: new Date(Date.now() - 10000), // passée
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        resendInvitationNotificationSupport(fakeDb, {
          invitationId: 'inv-1',
          actorUserId: 'user-1',
          reason: 'Demande renvoi',
        }),
      ).rejects.toThrow('Cette invitation est expirée.');
    });

    it('refuse de renvoyer si l’organisation n’est pas active', async () => {
      const txMock = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: 'inv-1',
                      organizationId: 'org-1',
                      status: 'PENDING',
                      expiresAt: new Date(Date.now() + 86400000),
                    },
                  ]),
                }),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'org-1',
                    status: 'SUSPENDED',
                  },
                ]),
              }),
            }),
          }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        resendInvitationNotificationSupport(fakeDb, {
          invitationId: 'inv-1',
          actorUserId: 'user-1',
          reason: 'Demande renvoi',
        }),
      ).rejects.toThrow('L’organisation associée à cette invitation n’est pas active.');
    });
  });

  describe('reconcilePaymentSupport', () => {
    it('exige un motif d’action support explicite', async () => {
      const fakeDb = {} as any;
      await expect(
        reconcilePaymentSupport(fakeDb, {
          paymentId: 'pay-1',
          actorUserId: 'user-1',
          reason: '   ',
        }),
      ).rejects.toThrow('Un motif explicite est obligatoire');
    });

    it('refuse si aucune tentative éligible n’est trouvée', async () => {
      const txMock = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'pay-1',
                    organizationId: 'org-1',
                    status: 'SUCCEEDED',
                  },
                ]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([]), // aucune tentative éligible
              }),
            }),
          }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as any;

      await expect(
        reconcilePaymentSupport(fakeDb, {
          paymentId: 'pay-1',
          actorUserId: 'user-1',
          reason: 'Vérification paiement',
        }),
      ).rejects.toThrow(PaymentReconcileActionError);
    });
  });
});
