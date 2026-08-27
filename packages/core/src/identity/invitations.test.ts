import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { hashToken, generateInvitationToken, DuplicateInvitationError } from './invitations';

describe('invitations tokens', () => {
  it('hashToken est déterministe', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abcd'));
  });

  it('hashToken produit une chaîne hex de 64 caractères', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateInvitationToken produit un token hex de 64 caractères', () => {
    const t = generateInvitationToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(t).not.toBe(generateInvitationToken());
  });

  it('DuplicateInvitationError est une classe d\u2019erreur nommée', () => {
    const err = new DuplicateInvitationError('dup');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DuplicateInvitationError');
    expect(err.message).toBe('dup');
  });

  describe('revokeInvitation', () => {
    it('rejette si l’acteur n’a pas la capacité team.invite', async () => {
      const { revokeInvitation } = await import('./invitations');
      const fakeDb = {} as unknown as DatabaseClient;
      await expect(
        revokeInvitation(fakeDb, 'org-1', 'inv-1', { userId: 'u-1', role: 'STAFF' }),
      ).rejects.toThrow('Rôle insuffisant');
    });
  });
});
