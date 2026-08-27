import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  hashToken,
  createSignedInvitationToken,
  verifySignedInvitationToken,
  DuplicateInvitationError,
  getInvitationSecret,
  InvitationSecretConfigurationError,
} from './invitations';

describe('invitations tokens & security (Chantier 15.2 / 15.2.1)', () => {
  describe('getInvitationSecret (Chantier 15.2.1)', () => {
    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est absent en production', () => {
      const prodEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
      };
      expect(() => getInvitationSecret(prodEnv)).toThrow(InvitationSecretConfigurationError);
      expect(() => getInvitationSecret(prodEnv)).toThrow(
        'INVITATION_SECRET est requis et doit être configuré en production.',
      );
    });

    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est absent en STRIPE_ENVIRONMENT=LIVE', () => {
      const liveEnv: NodeJS.ProcessEnv = {
        STRIPE_ENVIRONMENT: 'LIVE',
      };
      expect(() => getInvitationSecret(liveEnv)).toThrow(InvitationSecretConfigurationError);
    });

    it('lève InvitationSecretConfigurationError si le secret comporte moins de 32 caractères', () => {
      const weakEnv: NodeJS.ProcessEnv = {
        INVITATION_SECRET: 'too-short-secret-12345',
      };
      expect(() => getInvitationSecret(weakEnv)).toThrow(InvitationSecretConfigurationError);
      expect(() => getInvitationSecret(weakEnv)).toThrow(
        'INVITATION_SECRET doit comporter au moins 32 caractères pour garantir une entropie suffisante.',
      );
    });

    it('retourne le secret valide lorsqu’il comporte au moins 32 caractères', () => {
      const validSecret = 'a-very-strong-and-long-secret-key-with-high-entropy-123456789';
      const validEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        INVITATION_SECRET: validSecret,
      };
      expect(getInvitationSecret(validEnv)).toBe(validSecret);
    });

    it('n’utilise jamais CLERK_SECRET_KEY ou CRON_SECRET comme fallback en production', () => {
      const fakeProdEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        CLERK_SECRET_KEY: 'sk_live_some_clerk_secret_key_123456789012345',
        CRON_SECRET: 'some_cron_secret_key_1234567890123456789012345',
      };
      expect(() => getInvitationSecret(fakeProdEnv)).toThrow(InvitationSecretConfigurationError);
    });

    it('utilise le fallback dev de 32 caractères minimum en environnement de test/développement', () => {
      const devEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
      };
      const secret = getInvitationSecret(devEnv);
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(secret).toContain('uttily-invitation-signing-secret');
    });
  });

  describe('Tokens signing & verification', () => {
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

    it('verifySignedInvitationToken accepte un token créé et vérifié avec le même secret explicite', () => {
      const envA: NodeJS.ProcessEnv = {
        INVITATION_SECRET: 'secret-key-aaaa-123456789012345678901234567890',
      };
      const data = {
        invitationId: 'inv-123',
        organizationId: 'org-456',
        email: 'member@example.com',
        expiresAt: new Date('2026-09-01T12:00:00Z'),
      };
      const token = createSignedInvitationToken(data, envA);

      const verification = verifySignedInvitationToken(
        token,
        {
          organizationId: 'org-456',
          email: 'member@example.com',
        },
        envA,
      );
      expect(verification.valid).toBe(true);
      expect(verification.invitationId).toBe('inv-123');
    });

    it('verifySignedInvitationToken rejette un token signé avec secret A si vérifié avec secret B', () => {
      const envA: NodeJS.ProcessEnv = {
        INVITATION_SECRET: 'secret-key-aaaa-123456789012345678901234567890',
      };
      const envB: NodeJS.ProcessEnv = {
        INVITATION_SECRET: 'secret-key-bbbb-123456789012345678901234567890',
      };
      const data = {
        invitationId: 'inv-123',
        organizationId: 'org-456',
        email: 'member@example.com',
        expiresAt: new Date('2026-09-01T12:00:00Z'),
      };
      const token = createSignedInvitationToken(data, envA);

      const verification = verifySignedInvitationToken(
        token,
        {
          organizationId: 'org-456',
          email: 'member@example.com',
        },
        envB,
      );
      expect(verification.valid).toBe(false);
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
  });

  describe('DuplicateInvitationError & Permissions', () => {
    it('DuplicateInvitationError est une classe d’erreur nommée', () => {
      const err = new DuplicateInvitationError('dup');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('DuplicateInvitationError');
      expect(err.message).toBe('dup');
    });

    it('InvitationSecretConfigurationError est une classe d’erreur nommée', () => {
      const err = new InvitationSecretConfigurationError('bad secret');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('InvitationSecretConfigurationError');
      expect(err.message).toBe('bad secret');
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
});

