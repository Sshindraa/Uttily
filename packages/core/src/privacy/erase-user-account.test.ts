import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  checkUserErasureEligibility,
  eraseUserAccount,
  UserErasureError,
} from './erase-user-account';
import { executeErasurePrivacyRequest } from '../support/privacy/manage-privacy-requests';
import { PrivacySupportActionError } from '../support/privacy/types';
import { provisionUserFromOidc } from '../identity/provisioning';
import { AccountDeletedError } from '../identity/types';
import * as auditModule from '../identity/audit';

describe('Lot 21-P2 — Privacy Erasure & Probatory Seal (Unit)', () => {
  const writeAuditEntrySpy = vi.spyOn(auditModule, 'writeAuditEntry').mockResolvedValue(undefined);

  beforeEach(() => {
    writeAuditEntrySpy.mockClear();
  });

  describe('checkUserErasureEligibility', () => {
    it('retourne inéligible si l’utilisateur est introuvable', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'unknown-user');
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('Utilisateur introuvable');
    });

    it('retourne éligible si l’utilisateur est déjà effacé (idempotence)', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: new Date() }]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'u-1');
      expect(result.eligible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('bloque l’effacement si des réservations actives existent', async () => {
      const fakeDb = {
        select: vi.fn()
          // 1. users
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: null }]),
              }),
            }),
          })
          // 2. active bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'b-1' }]),
            }),
          })
          // 3. held drafts
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 4. owner memberships
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'u-1');
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('réservations sont en cours'))).toBe(true);
    });

    it('bloque l’effacement si des brouillons en hold ou en paiement existent', async () => {
      const fakeDb = {
        select: vi.fn()
          // 1. users
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: null }]),
              }),
            }),
          })
          // 2. active bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 3. held drafts
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'draft-1' }]),
            }),
          })
          // 4. owner memberships
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'u-1');
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('retenue ou de paiement'))).toBe(true);
    });

    it('bloque l’effacement si le user est le seul owner d’une org avec du matériel actif', async () => {
      const fakeDb = {
        select: vi.fn()
          // 1. users
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: null }]),
              }),
            }),
          })
          // 2. active bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 3. held drafts
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 4. owner memberships
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ organizationId: 'org-1' }]),
            }),
          })
          // 5. other owners check
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]), // aucun autre owner
              }),
            }),
          })
          // 6. active items in org
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'item-1' }]), // équipement actif présent
              }),
            }),
          }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'u-1');
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('seul propriétaire'))).toBe(true);
    });

    it('autorise l’effacement pour un utilisateur propre sans conflit', async () => {
      const fakeDb = {
        select: vi.fn()
          // 1. users
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: null }]),
              }),
            }),
          })
          // 2. active bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 3. held drafts
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 4. owner memberships
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
      } as unknown as DatabaseClient;

      const result = await checkUserErasureEligibility(fakeDb, 'u-1');
      expect(result.eligible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe('eraseUserAccount', () => {
    it('lève USER_NOT_FOUND si l’utilisateur n’existe pas', async () => {
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
      } as unknown as DatabaseClient;

      await expect(
        eraseUserAccount(fakeDb, {
          userId: 'unknown',
          actorUserId: 'admin-1',
          triggerSource: 'SELF_SERVICE',
        }),
      ).rejects.toThrow(UserErasureError);
    });

    it('gère l’idempotence sans seconde écriture si déjà effacé', async () => {
      const pastDate = new Date('2026-08-01T10:00:00.000Z');
      const txMock = {
        select: vi.fn()
          // 1. users check
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ id: 'u-1', deletedAt: pastDate }]),
                }),
              }),
            }),
          })
          // 2. privacyProbatorySeals check
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    userId: 'u-1',
                    civilRetentionUntil: new Date('2031-08-01T10:00:00.000Z'),
                    accountingRetentionUntil: new Date('2036-08-01T10:00:00.000Z'),
                    sealedBookingsCount: 3,
                    sealedPaymentsCount: 3,
                    sealedDocumentsCount: 3,
                  },
                ]),
              }),
            }),
          }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const deleteClerkSpy = vi.fn();
      const res = await eraseUserAccount(fakeDb, {
        userId: 'u-1',
        actorUserId: 'u-1',
        triggerSource: 'SELF_SERVICE',
        deleteExternalIdentity: deleteClerkSpy,
      });

      expect(res.ok).toBe(true);
      expect(res.alreadyErased).toBe(true);
      expect(res.sealedBookingsCount).toBe(3);
      expect(deleteClerkSpy).not.toHaveBeenCalled(); // Déjà supprimé précédemment
      expect(writeAuditEntrySpy).not.toHaveBeenCalled();
    });

    it('exécute la pseudonymisation complète, le scellement probatoire et la purge Clerk', async () => {
      const updateMock = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({}),
        }),
      });
      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue({}),
      });

      const txMock = {
        select: vi.fn()
          // 1. users
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: 'u-100',
                      email: 'client@example.com',
                      displayName: 'Alice Dupont',
                      oidcSubject: 'user_clerk_123',
                      deletedAt: null,
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. active bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 3. held drafts
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 4. owner memberships
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          })
          // 5. count bookings
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 2 }]),
            }),
          })
          // 6. count payments
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ count: 2 }]),
              }),
            }),
          })
          // 7. count documents
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ count: 4 }]),
              }),
            }),
          }),
        update: updateMock,
        insert: insertMock,
      };

      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const deleteClerkSpy = vi.fn().mockResolvedValue(undefined);

      const res = await eraseUserAccount(fakeDb, {
        userId: 'u-100',
        actorUserId: 'u-100',
        triggerSource: 'SELF_SERVICE',
        deleteExternalIdentity: deleteClerkSpy,
      });

      expect(res.ok).toBe(true);
      expect(res.alreadyErased).toBe(false);
      expect(res.sealedBookingsCount).toBe(2);
      expect(res.sealedPaymentsCount).toBe(2);
      expect(res.sealedDocumentsCount).toBe(4);
      expect(res.externalIdentityDeleted).toBe(true);

      // Calcul des dates : 5 ans et 10 ans
      expect(res.civilRetentionUntil.getTime()).toBeGreaterThan(res.sealedAt.getTime());
      expect(res.accountingRetentionUntil.getTime()).toBeGreaterThan(res.civilRetentionUntil.getTime());

      // Vérifie l'appel Clerk
      expect(deleteClerkSpy).toHaveBeenCalledWith('user_clerk_123');

      // Vérifie l'audit trail sans PII
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(txMock, {
        actorUserId: 'u-100',
        action: 'PRIVACY_USER_ACCOUNT_ERASED',
        targetType: 'USER',
        targetId: 'u-100',
        metadata: expect.objectContaining({
          erasedUserId: 'u-100',
          triggerSource: 'SELF_SERVICE',
          sealedBookingsCount: 2,
        }),
      });
    });
  });

  describe('executeErasurePrivacyRequest (Support)', () => {
    it('refuse si la demande n’est pas de type ERASURE', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'req-1', requestType: 'ACCESS', status: 'IN_REVIEW', userId: 'u-1' },
              ]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      await expect(
        executeErasurePrivacyRequest(fakeDb, {
          requestId: 'req-1',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(PrivacySupportActionError);
    });

    it('refuse si la demande n’est pas IN_REVIEW', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'req-1', requestType: 'ERASURE', status: 'RECEIVED', userId: 'u-1' },
              ]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      await expect(
        executeErasurePrivacyRequest(fakeDb, {
          requestId: 'req-1',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(PrivacySupportActionError);
    });
  });

  describe('provisionUserFromOidc (Lockout)', () => {
    it('lève AccountDeletedError si l’utilisateur a été supprimé', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'u-deleted',
                  oidcSubject: 'erased-u-deleted',
                  email: 'erased-u-deleted@anonymized.uttily.local',
                  deletedAt: new Date(),
                },
              ]),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      await expect(
        provisionUserFromOidc(fakeDb, {
          oidcSubject: 'erased-u-deleted',
          oidcProvider: 'clerk',
          email: 'erased-u-deleted@anonymized.uttily.local',
          emailVerified: true,
        }),
      ).rejects.toThrow(AccountDeletedError);
    });
  });
});
