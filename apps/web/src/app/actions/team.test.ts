import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import { changeMemberRoleAction, removeMemberAction } from './team';

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
    changeMemberRole: vi.fn(),
    removeMember: vi.fn(),
  };
});

describe('Team Server Actions', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'owner@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_1',
  };
  const orgId = '11111111-1111-1111-1111-111111111111';
  const targetUserId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('changeMemberRoleAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(changeMemberRoleAction(orgId, targetUserId, 'MANAGER')).rejects.toThrow(
      'Non authentifié',
    );
  });

  it('changeMemberRoleAction : rejette si rôle insuffisant (ex : ADMIN)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    await expect(changeMemberRoleAction(orgId, targetUserId, 'MANAGER')).rejects.toThrow(
      'Permission refusée',
    );
  });

  it('removeMemberAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(removeMemberAction(orgId, targetUserId)).rejects.toThrow('Non authentifié');
  });

  it('removeMemberAction : rejette si rôle insuffisant (ex : STAFF)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'STAFF',
      status: 'ACTIVE',
    });

    await expect(removeMemberAction(orgId, targetUserId)).rejects.toThrow('Permission refusée');
  });
});
