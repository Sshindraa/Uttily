import { describe, expect, it, vi } from 'vitest';
import { retryNotificationSupport, NotificationActionError } from './retry-notification';
import { cancelNotificationSupport } from './cancel-notification';
import { resendInvitationNotificationSupport } from './resend-invitation-notification';

describe('Support Actions (Unit)', () => {
  describe('retryNotificationSupport', () => {
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
        }),
      ).rejects.toThrow(NotificationActionError);
    });

    it('refuse de relancer une notification déjà envoyée (SENT)', async () => {
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
        retryNotificationSupport(fakeDb, {
          notificationId: 'notif-1',
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow('Cette notification a déjà été envoyée avec succès.');
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
        }),
      ).rejects.toThrow('Cette invitation est expirée.');
    });
  });
});
