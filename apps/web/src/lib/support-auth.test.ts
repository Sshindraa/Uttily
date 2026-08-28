import type { DatabaseClient } from '@uttily/database';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireSupportPlatformAdmin } from './support-auth';
import * as auth from './auth';
import * as dbMod from './db';
import { AuthorizationError } from '@uttily/core';

vi.mock('./auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('./db', () => ({
  getDb: vi.fn(),
}));

describe('requireSupportPlatformAdmin (Garde Support Back-Office)', () => {
  const userId = '11111111-2222-3333-4444-555555555555';
  const mockDb = {} as unknown as DatabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(dbMod, 'getDb').mockReturnValue(mockDb);
  });

  it('jette UNAUTHENTICATED si getAuthenticatedUser renvoie null', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    await expect(requireSupportPlatformAdmin()).rejects.toThrow('UNAUTHENTICATED');
  });

  it('jette AuthorizationError si l’utilisateur est un compte Pro (isPlatformAdmin = false)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce({
      id: userId,
      email: 'pro-owner@location-velos.fr',
      oidcSubject: 'sub_pro_owner',
      emailVerified: true,
      isPlatformAdmin: false,
    });

    await expect(requireSupportPlatformAdmin()).rejects.toThrow(AuthorizationError);
  });

  it('succède et retourne le contexte si l’utilisateur est isPlatformAdmin = true', async () => {
    const adminUser = {
      id: userId,
      email: 'support@uttily.com',
      oidcSubject: 'sub_support_admin',
      emailVerified: true,
      isPlatformAdmin: true,
    };
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(adminUser);

    const ctx = await requireSupportPlatformAdmin();
    expect(ctx.user).toEqual(adminUser);
    expect(ctx.db).toBe(mockDb);
  });
});
