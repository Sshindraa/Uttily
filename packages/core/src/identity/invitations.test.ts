import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  hashToken,
  createSignedInvitationToken,
  verifySignedInvitationToken,
  DuplicateInvitationError,
} from './invitations';

describe('invitations tokens & security (Chantier 15.2)', () => {
  it('hashToken est déterministe', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abcd'));
  });

  it('hashToken produit une chaîne hex de 64 caractères', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('createSignedInvitationToken génère un token signé reconstructible', () => {
    const data = {
      invitationId: 'inv-123',
      organizationId: 'org-456',
      email: 'member@example.com',
      expiresAt: new Date('2026-09-01T12:00:00Z'),
    };
    const token1 = createSignedInvitationToken(data);
    const token2 = createSignedInvitationToken(data);

    expect(token1).toBe(token2);
    expect(token1.startsWith('inv-123.')).toBe(true);

    const verification = verifySignedInvitationToken(token1, {
      organizationId: 'org-456',
      email: 'member@example.com',
    });
    expect(verification.valid).toBe(true);
    expect(verification.invitationId).toBe('inv-123');
  });

  it('verifySignedInvitationToken rejette un token altéré ou pour une autre organisation', () => {
    const data = {
      invitationId: 'inv-123',
      organizationId: 'org-456',
      email: 'member@example.com',
      expiresAt: new Date('2026-09-01T12:00:00Z'),
    };
    const token = createSignedInvitationToken(data);

    // Altération de l'email
    expect(
      verifySignedInvitationToken(token, {
        organizationId: 'org-456',
        email: 'other@example.com',
      }).valid,
    ).toBe(false);

    // Altération de l'organisation
    expect(
      verifySignedInvitationToken(token, {
        organizationId: 'org-OTHER',
        email: 'member@example.com',
      }).valid,
    ).toBe(false);

    // Altération du token lui-même
    expect(
      verifySignedInvitationToken(`${token}tampered`, {
        organizationId: 'org-456',
        email: 'member@example.com',
      }).valid,
    ).toBe(false);
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
