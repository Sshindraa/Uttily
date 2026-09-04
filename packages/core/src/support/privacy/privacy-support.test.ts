import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  extendPrivacyRequestDeadline,
  flagPrivacyRequestIdentityCheck,
  resolvePrivacyRequest,
  startPrivacyRequestReview,
  executeErasurePrivacyRequest,
} from './manage-privacy-requests';
import { listPrivacyRequestsSupport } from './list-privacy-requests';
import { PrivacySupportActionError } from './types';
import * as auditModule from '../../identity/audit';

describe('Support Privacy Operations (Unit)', () => {
  const writeAuditEntrySpy = vi.spyOn(auditModule, 'writeAuditEntry').mockResolvedValue(undefined);

  describe('startPrivacyRequestReview', () => {
    it('lève NOT_FOUND si la demande n’existe pas', async () => {
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
        startPrivacyRequestReview(fakeDb, {
          requestId: 'req-1',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(PrivacySupportActionError);
    });

    it('refuse de prendre en charge une demande déjà terminée (FULFILLED, REFUSED, CANCELLED)', async () => {
      for (const status of ['FULFILLED', 'REFUSED', 'CANCELLED']) {
        const txMock = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ id: 'req-1', status }]),
                }),
              }),
            }),
          }),
        };
        const fakeDb = {
          transaction: vi.fn((cb) => cb(txMock)),
        } as unknown as DatabaseClient;

        await expect(
          startPrivacyRequestReview(fakeDb, {
            requestId: 'req-1',
            actorUserId: 'admin-1',
          }),
        ).rejects.toThrow(
          'La demande ne peut être prise en charge que depuis RECEIVED ou IDENTITY_CHECK_REQUIRED',
        );
      }
    });

    it('passe en IN_REVIEW depuis RECEIVED ou IDENTITY_CHECK_REQUIRED et consigne l’audit sans PII', async () => {
      const updateSetMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'req-1', status: 'RECEIVED' }]),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSetMock,
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const result = await startPrivacyRequestReview(fakeDb, {
        requestId: 'req-1',
        actorUserId: 'admin-1',
      });

      expect(result).toEqual({ ok: true, requestId: 'req-1', status: 'IN_REVIEW' });
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'IN_REVIEW',
        }),
      );
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(
        txMock,
        expect.objectContaining({
          action: 'PRIVACY_REQUEST_REVIEW_STARTED',
          actorUserId: 'admin-1',
          targetId: 'req-1',
          targetType: 'PRIVACY_REQUEST',
          metadata: {
            requestId: 'req-1',
            previousStatus: 'RECEIVED',
            newStatus: 'IN_REVIEW',
          },
        }),
      );
    });
  });

  describe('flagPrivacyRequestIdentityCheck', () => {
    it('passe en IDENTITY_CHECK_REQUIRED si statut est RECEIVED', async () => {
      const updateSetMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'req-2', status: 'RECEIVED' }]),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSetMock,
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const result = await flagPrivacyRequestIdentityCheck(fakeDb, {
        requestId: 'req-2',
        actorUserId: 'admin-1',
      });

      expect(result).toEqual({ ok: true, requestId: 'req-2', status: 'IDENTITY_CHECK_REQUIRED' });
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(
        txMock,
        expect.objectContaining({
          action: 'PRIVACY_REQUEST_IDENTITY_CHECK_REQUIRED',
          actorUserId: 'admin-1',
          targetId: 'req-2',
        }),
      );
    });

    it('refuse si la demande n’est pas en statut RECEIVED', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'req-2', status: 'IN_REVIEW' }]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      await expect(
        flagPrivacyRequestIdentityCheck(fakeDb, {
          requestId: 'req-2',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(
        'La vérification d’identité ne peut être demandée que pour une demande en statut RECEIVED',
      );
    });
  });

  describe('extendPrivacyRequestDeadline', () => {
    const baseDueAt = new Date('2026-10-01T12:00:00Z');

    it('exige un motif de prolongation obligatoire', async () => {
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        extendPrivacyRequestDeadline(fakeDb, {
          requestId: 'req-3',
          actorUserId: 'admin-1',
          extendedUntil: new Date('2026-11-01T12:00:00Z'),
          reason: '   ',
        }),
      ).rejects.toThrow('Un motif interne est obligatoire');
    });

    it('refuse si la demande n’est pas IN_REVIEW', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: 'req-3', status: 'RECEIVED', responseDueAt: baseDueAt },
                  ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      await expect(
        extendPrivacyRequestDeadline(fakeDb, {
          requestId: 'req-3',
          actorUserId: 'admin-1',
          extendedUntil: new Date('2026-11-01T12:00:00Z'),
          reason: 'Dossier complexe multi-systèmes',
        }),
      ).rejects.toThrow('Seule une demande en cours d’instruction (IN_REVIEW) peut être prolongée');
    });

    it('refuse si la date est antérieure ou égale à l’échéance initiale', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: 'req-3', status: 'IN_REVIEW', responseDueAt: baseDueAt },
                  ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      await expect(
        extendPrivacyRequestDeadline(fakeDb, {
          requestId: 'req-3',
          actorUserId: 'admin-1',
          extendedUntil: new Date('2026-09-15T12:00:00Z'),
          reason: 'Dossier complexe',
        }),
      ).rejects.toThrow('La date de prolongation doit être strictement postérieure');
    });

    it('refuse une prolongation excédant 2 mois supplémentaires (Art. 12.3 RGPD)', async () => {
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: 'req-3', status: 'IN_REVIEW', responseDueAt: baseDueAt },
                  ]),
              }),
            }),
          }),
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      // 4 mois plus tard
      const wayTooFar = new Date('2027-02-01T12:00:00Z');

      await expect(
        extendPrivacyRequestDeadline(fakeDb, {
          requestId: 'req-3',
          actorUserId: 'admin-1',
          extendedUntil: wayTooFar,
          reason: 'Dossier complexe',
        }),
      ).rejects.toThrow('La prolongation légale ne peut pas excéder deux mois calendaires');
    });

    it('prolonge l’échéance avec succès et audite sans PII', async () => {
      const updateSetMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const validExtension = new Date('2026-11-15T12:00:00Z');
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: 'req-3', status: 'IN_REVIEW', responseDueAt: baseDueAt },
                  ]),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSetMock,
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const result = await extendPrivacyRequestDeadline(fakeDb, {
        requestId: 'req-3',
        actorUserId: 'admin-1',
        extendedUntil: validExtension,
        reason: 'Recherche d’archives physiques',
      });

      expect(result).toEqual({ ok: true, requestId: 'req-3', extendedUntil: validExtension });
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          extendedUntil: validExtension,
        }),
      );
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(
        txMock,
        expect.objectContaining({
          action: 'PRIVACY_REQUEST_DEADLINE_EXTENDED',
          actorUserId: 'admin-1',
          targetId: 'req-3',
          metadata: {
            requestId: 'req-3',
            previousDueAt: baseDueAt.toISOString(),
            extendedUntil: validExtension.toISOString(),
            notified: false,
          },
        }),
      );
    });
  });

  describe('resolvePrivacyRequest', () => {
    it('exige une note interne de justification', async () => {
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        resolvePrivacyRequest(fakeDb, {
          requestId: 'req-4',
          actorUserId: 'admin-1',
          resolutionStatus: 'FULFILLED',
          resolutionNotes: '   ',
        }),
      ).rejects.toThrow('Une note interne de justification est obligatoire');
    });

    it('exige un motif légal obligatoire si statut REFUSED (Art. 12.4 RGPD)', async () => {
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        resolvePrivacyRequest(fakeDb, {
          requestId: 'req-4',
          actorUserId: 'admin-1',
          resolutionStatus: 'REFUSED',
          decisionReasonCode: null,
          resolutionNotes: 'Refus de suppression car factures sous délai de 10 ans',
        }),
      ).rejects.toThrow('Un motif légal de refus est obligatoire');
    });

    it('clôture avec succès en REFUSED avec motif légal et audit sans PII', async () => {
      const updateSetMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'req-4', status: 'IN_REVIEW' }]),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSetMock,
        }),
      };
      const fakeDb = {
        transaction: vi.fn((cb) => cb(txMock)),
      } as unknown as DatabaseClient;

      const result = await resolvePrivacyRequest(fakeDb, {
        requestId: 'req-4',
        actorUserId: 'admin-1',
        resolutionStatus: 'REFUSED',
        decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
        resolutionNotes: 'Conservation des factures 10 ans (Code de commerce)',
      });

      expect(result).toEqual({
        ok: true,
        requestId: 'req-4',
        status: 'DECISION_READY',
        resolution: 'REFUSED',
      });
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DECISION_READY',
          resolution: 'REFUSED',
          decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
          resolutionNotes: 'Conservation des factures 10 ans (Code de commerce)',
          decisionAt: expect.any(Date),
        }),
      );
      // Vérification que les notes textuelles (PII potentielles) NE SONT PAS dans l'audit metadata
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(
        txMock,
        expect.objectContaining({
          action: 'PRIVACY_REQUEST_DECISION_RECORDED',
          actorUserId: 'admin-1',
          targetId: 'req-4',
          metadata: {
            requestId: 'req-4',
            previousStatus: 'IN_REVIEW',
            newStatus: 'DECISION_READY',
            resolution: 'REFUSED',
            decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
          },
        }),
      );
    });
  });

  describe('listPrivacyRequestsSupport', () => {
    it('calcule correctement les urgences SLA et joint les utilisateurs', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const imminentDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const okDate = new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000);

      const fakeDb = {
        select: vi
          .fn()
          // 1er appel : fetch rows
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([
                        {
                          request: {
                            id: 'r1',
                            userId: 'u1',
                            requestType: 'ERASURE',
                            status: 'IN_REVIEW',
                            details: 'Supprimez mes données',
                            decisionReasonCode: null,
                            resolutionNotes: null,
                            receivedAt: new Date(),
                            responseDueAt: pastDate,
                            extendedUntil: null,
                            resolvedAt: null,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                          },
                          userEmail: 'client@example.com',
                          userDisplayName: 'Jean Dupont',
                        },
                        {
                          request: {
                            id: 'r2',
                            userId: 'u2',
                            requestType: 'ACCESS',
                            status: 'RECEIVED',
                            details: null,
                            decisionReasonCode: null,
                            resolutionNotes: null,
                            receivedAt: new Date(),
                            responseDueAt: imminentDate,
                            extendedUntil: null,
                            resolvedAt: null,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                          },
                          userEmail: 'marie@example.com',
                          userDisplayName: 'Marie Curie',
                        },
                        {
                          request: {
                            id: 'r3',
                            userId: 'u3',
                            requestType: 'PORTABILITY',
                            status: 'RECEIVED',
                            details: null,
                            decisionReasonCode: null,
                            resolutionNotes: null,
                            receivedAt: new Date(),
                            responseDueAt: okDate,
                            extendedUntil: null,
                            resolvedAt: null,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                          },
                          userEmail: 'paul@example.com',
                          userDisplayName: null,
                        },
                      ]),
                    }),
                  }),
                }),
              }),
            }),
          })
          // 2e appel : fetch counts
          .mockReturnValueOnce({
            from: vi.fn().mockResolvedValue([{ total: 3, active: 3, closed: 0, overdue: 1 }]),
          }),
      } as unknown as DatabaseClient;

      const result = await listPrivacyRequestsSupport(fakeDb, { tab: 'ACTIVE' });

      expect(result.totalCount).toBe(3);
      expect(result.items).toHaveLength(3);
      expect(result.items[0]!.urgency).toBe('DUE_OVERDUE');
      expect(result.items[1]!.urgency).toBe('DUE_IMMINENT');
      expect(result.items[2]!.urgency).toBe('DUE_OK');
      expect(result.items[0]!.userEmail).toBe('client@example.com');
      expect(result.items[0]!.userDisplayName).toBe('Jean Dupont');
    });
  });

  describe('executeErasurePrivacyRequest (Lot 21-P2)', () => {
    it('lève NOT_FOUND si la demande n’existe pas', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      await expect(
        executeErasurePrivacyRequest(fakeDb, {
          requestId: 'req-inexistant',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow('Demande RGPD introuvable');
    });

    it('lève INVALID_REQUEST_TYPE si la demande n’est pas de type ERASURE', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'req-access',
                  requestType: 'ACCESS',
                  status: 'IN_REVIEW',
                  userId: 'user-1',
                },
              ]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      await expect(
        executeErasurePrivacyRequest(fakeDb, {
          requestId: 'req-access',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow('Seule une demande d’effacement (ERASURE)');
    });

    it('lève INVALID_STATE_TRANSITION si la demande n’est pas IN_REVIEW', async () => {
      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'req-erasure',
                  requestType: 'ERASURE',
                  status: 'RECEIVED',
                  userId: 'user-1',
                },
              ]),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      await expect(
        executeErasurePrivacyRequest(fakeDb, {
          requestId: 'req-erasure',
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow('La demande doit être en cours d’instruction (IN_REVIEW)');
    });
  });
});
