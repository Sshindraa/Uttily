import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthenticatedUserMock, createPrivacyRequestMock } = vi.hoisted(() => ({
  getAuthenticatedUserMock: vi.fn(),
  createPrivacyRequestMock: vi.fn(),
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

vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@uttily/core');
  return {
    ...actual,
    createPrivacyRequest: createPrivacyRequestMock,
  };
});

const { submitPrivacyRequestAction } = await import('./privacy');

describe('submitPrivacyRequestAction', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001' };

  beforeEach(() => {
    getAuthenticatedUserMock.mockReset();
    createPrivacyRequestMock.mockReset();
  });

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
