import type { DatabaseClient } from '@uttily/database';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAmendmentManagerOf } from './amendment-auth';
import * as auth from './auth';
import * as dbMod from './db';
import * as core from '@uttily/core';

vi.mock('./auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('./db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getMembership: vi.fn(),
  };
});

describe('requireAmendmentManagerOf', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const mockDb = {} as unknown as DatabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(dbMod, 'getDb').mockReturnValue(mockDb);
  });

  it('jette UNAUTHENTICATED si getAuthenticatedUser renvoie null', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    await expect(requireAmendmentManagerOf(orgId)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('jette AuthorizationError si aucun membership trouvé', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
      id: userId,
      email: 'user@example.com',
      oidcSubject: 'sub_user',
      emailVerified: true,
      isPlatformAdmin: false,
    });
    vi.spyOn(core, 'getMembership').mockResolvedValueOnce(null);

    await expect(requireAmendmentManagerOf(orgId)).rejects.toThrow();
  });

  it('jette AuthorizationError si le rôle est STAFF', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
      id: userId,
      email: 'staff@example.com',
      oidcSubject: 'sub_staff',
      emailVerified: true,
      isPlatformAdmin: false,
    });
    vi.spyOn(core, 'getMembership').mockResolvedValueOnce({
      organizationId: orgId,
      userId,
      role: 'STAFF',
      status: 'ACTIVE',
    });

    await expect(requireAmendmentManagerOf(orgId)).rejects.toThrow();
  });

  it('succède pour un rôle MANAGER actif', async () => {
    const user = {
      id: userId,
      email: 'mgr@example.com',
      oidcSubject: 'sub_mgr',
      emailVerified: true,
      isPlatformAdmin: false,
    };
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(core, 'getMembership').mockResolvedValueOnce({
      organizationId: orgId,
      userId,
      role: 'MANAGER',
      status: 'ACTIVE',
    });

    const ctx = await requireAmendmentManagerOf(orgId);
    expect(ctx.user).toEqual(user);
    expect(ctx.organizationId).toBe(orgId);
    expect(ctx.db).toBe(mockDb);
  });

  it('succède pour un rôle ADMIN actif', async () => {
    const user = {
      id: userId,
      email: 'admin@example.com',
      oidcSubject: 'sub_admin',
      emailVerified: true,
      isPlatformAdmin: false,
    };
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(core, 'getMembership').mockResolvedValueOnce({
      organizationId: orgId,
      userId,
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    const ctx = await requireAmendmentManagerOf(orgId);
    expect(ctx.user).toEqual(user);
  });

  it('succède pour un rôle OWNER actif', async () => {
    const user = {
      id: userId,
      email: 'owner@example.com',
      oidcSubject: 'sub_owner',
      emailVerified: true,
      isPlatformAdmin: false,
    };
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(core, 'getMembership').mockResolvedValueOnce({
      organizationId: orgId,
      userId,
      role: 'OWNER',
      status: 'ACTIVE',
    });

    const ctx = await requireAmendmentManagerOf(orgId);
    expect(ctx.user).toEqual(user);
  });
});
