import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import { updateCompanySettingsAction, updateCancellationPolicyAction } from './settings';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getMembership: vi.fn(),
    updateOrganizationPublicSettings: vi.fn(),
    updateOrganizationCancellationPolicy: vi.fn(),
  };
});

describe('Settings Server Actions', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_1',
  };
  const orgId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updateCompanySettingsAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(
      updateCompanySettingsAction(orgId, { publicDisplayName: 'Vélo Express' }),
    ).rejects.toThrow('Non authentifié');
  });

  it('updateCompanySettingsAction : rejette si rôle insuffisant (ex : STAFF)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'STAFF',
      status: 'ACTIVE',
    });

    await expect(
      updateCompanySettingsAction(orgId, { publicDisplayName: 'Vélo Express' }),
    ).rejects.toThrow('Permission refusée');
  });

  it('updateCancellationPolicyAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(updateCancellationPolicyAction(orgId, 'MODERATE')).rejects.toThrow(
      'Non authentifié',
    );
  });

  it('updateCancellationPolicyAction : rejette si rôle insuffisant (ex : MANAGER)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'MANAGER',
      status: 'ACTIVE',
    });

    await expect(updateCancellationPolicyAction(orgId, 'MODERATE')).rejects.toThrow(
      'Permission refusée',
    );
  });
});
