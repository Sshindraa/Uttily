import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPrivacyRequest } from './create-privacy-request';
import type { DbExecutor } from '@uttily/database';

const { writeAuditEntryMock } = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn(),
}));

vi.mock('../identity/audit', () => ({
  writeAuditEntry: writeAuditEntryMock,
}));

describe('createPrivacyRequest', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const requestId = '00000000-0000-4000-8000-000000000002';

  beforeEach(() => {
    writeAuditEntryMock.mockReset();
  });

  it('crée une demande valide et génère un audit trail minimaliste sans PII', async () => {
    const mockCreated = {
      id: requestId,
      userId,
      requestType: 'ACCESS' as const,
      status: 'RECEIVED' as const,
      details: 'Demande détaillée avec informations personnelles',
      decisionReasonCode: null,
      resolutionNotes: null,
      receivedAt: new Date('2026-09-03T10:00:00.000Z'),
      responseDueAt: new Date('2026-10-03T10:00:00.000Z'),
      extendedUntil: null,
      resolvedAt: null,
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
      updatedAt: new Date('2026-09-03T10:00:00.000Z'),
    };

    const returningMock = vi.fn().mockResolvedValue([mockCreated]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

    const mockDb = {
      insert: insertMock,
    } as unknown as DbExecutor;

    const result = await createPrivacyRequest(mockDb, {
      userId,
      requestType: 'ACCESS',
      details: 'Demande détaillée avec informations personnelles',
    });

    expect(result.id).toBe(requestId);
    expect(result.requestType).toBe('ACCESS');
    expect(result.status).toBe('RECEIVED');
    expect(insertMock).toHaveBeenCalled();

    // Vérifier l'audit minimaliste : aucun message libre, aucun PII
    expect(writeAuditEntryMock).toHaveBeenCalledWith(mockDb, {
      actorUserId: userId,
      action: 'PRIVACY_REQUEST_CREATED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: { requestType: 'ACCESS' },
    });
  });

  it('rejette les types de demande invalides', async () => {
    const mockDb = {} as unknown as DbExecutor;
    await expect(
      createPrivacyRequest(mockDb, {
        userId,
        // @ts-expect-error test type check
        requestType: 'UNKNOWN_TYPE',
      }),
    ).rejects.toThrow('Type de demande invalide');
  });
});
