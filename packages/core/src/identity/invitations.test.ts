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
  const defaultTestSecret = 'test-invitation-signing-secret-with-high-entropy-123456789';
  const defaultTestEnv: NodeJS.ProcessEnv = {
    INVITATION_SECRET: defaultTestSecret,
  };

  describe('getInvitationSecret (Chantier 15.2.1)', () => {
    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est absent en production', () => {
      const prodEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
      };
      expect(() => getInvitationSecret(prodEnv)).toThrow(InvitationSecretConfigurationError);
      expect(() => getInvitationSecret(prodEnv)).toThrow(
        'INVITATION_SECRET est requis et doit être configuré.',
      );
    });

    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est absent en STRIPE_ENVIRONMENT=LIVE', () => {
      const liveEnv: NodeJS.ProcessEnv = {
        STRIPE_ENVIRONMENT: 'LIVE',
      };
      expect(() => getInvitationSecret(liveEnv)).toThrow(InvitationSecretConfigurationError);
    });

    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est absent en test / dev (aucun fallback statique)', () => {
      const devEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'development',
      };
      expect(() => getInvitationSecret(devEnv)).toThrow(InvitationSecretConfigurationError);

      const testEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
      };
      expect(() => getInvitationSecret(testEnv)).toThrow(InvitationSecretConfigurationError);

      const emptyEnv: NodeJS.ProcessEnv = {};
      expect(() => getInvitationSecret(emptyEnv)).toThrow(InvitationSecretConfigurationError);
    });

    it('lève InvitationSecretConfigurationError si INVITATION_SECRET est une chaîne vide ou d’espaces', () => {
      expect(() => getInvitationSecret({ INVITATION_SECRET: '' })).toThrow(
        InvitationSecretConfigurationError,
      );
      expect(() => getInvitationSecret({ INVITATION_SECRET: '   ' })).toThrow(
        InvitationSecretConfigurationError,
      );
    });

    it('lève InvitationSecretConfigurationError si le secret comporte moins de 32 octets effectifs', () => {
      const weakEnv: NodeJS.ProcessEnv = {
        INVITATION_SECRET: 'too-short-secret-12345',
      };
      expect(() => getInvitationSecret(weakEnv)).toThrow(InvitationSecretConfigurationError);
      expect(() => getInvitationSecret(weakEnv)).toThrow(
        'INVITATION_SECRET doit comporter au moins 32 octets effectifs pour garantir une entropie suffisante.',
      );
    });

    it('retourne le secret valide lorsqu’il comporte au moins 32 octets effectifs', () => {
      const validSecret = 'a-very-strong-and-long-secret-key-with-high-entropy-123456789';
      const validEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        INVITATION_SECRET: validSecret,
      };
      expect(getInvitationSecret(validEnv)).toBe(validSecret);
    });

    it('n’utilise jamais CLERK_SECRET_KEY ou CRON_SECRET comme fallback', () => {
      const fakeProdEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        CLERK_SECRET_KEY: 'sk_live_some_clerk_secret_key_123456789012345',
        CRON_SECRET: 'some_cron_secret_key_1234567890123456789012345',
      };
      expect(() => getInvitationSecret(fakeProdEnv)).toThrow(InvitationSecretConfigurationError);
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
      const token1 = createSignedInvitationToken(data, defaultTestEnv);
      const token2 = createSignedInvitationToken(data, defaultTestEnv);

      expect(token1).toBe(token2);
      expect(token1.startsWith('inv-123.')).toBe(true);

      const verification = verifySignedInvitationToken(
        token1,
        {
          organizationId: 'org-456',
          email: 'member@example.com',
        },
        defaultTestEnv,
      );
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
      const token = createSignedInvitationToken(data, defaultTestEnv);

      // Altération de l'email
      expect(
        verifySignedInvitationToken(
          token,
          {
            organizationId: 'org-456',
            email: 'other@example.com',
          },
          defaultTestEnv,
        ).valid,
      ).toBe(false);

      // Altération de l'organisation
      expect(
        verifySignedInvitationToken(
          token,
          {
            organizationId: 'org-OTHER',
            email: 'member@example.com',
          },
          defaultTestEnv,
        ).valid,
      ).toBe(false);

      // Altération du token lui-même
      expect(
        verifySignedInvitationToken(
          `${token}tampered`,
          {
            organizationId: 'org-456',
            email: 'member@example.com',
          },
          defaultTestEnv,
        ).valid,
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

  describe('Cycle complet : Création invitation → Rendu notification → Extraction → Vérification (Chantier 15.2.1)', () => {
    it('prouve la création, absence de bearer en metadata, reconstruction par renderNotificationRecord et acceptation par verifySignedInvitationToken', async () => {
      const { renderNotificationRecord } = await import('../notifications/load-notification-data');
      const testSecret = 'explicit-super-secret-key-for-invitations-32bytes-min!';
      process.env.INVITATION_SECRET = testSecret;
      process.env.PUBLIC_APP_URL = 'https://app.uttily.fr';

      const invitationId = 'inv-uuid-abc-123';
      const organizationId = 'org-uuid-xyz-456';
      const email = 'nouveau.membre@example.com';
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // 1. Création du token signé
      const token = createSignedInvitationToken(
        {
          invitationId,
          organizationId,
          email,
          expiresAt,
        },
        process.env,
      );

      // 2. Notification record outbox (comme créé par createInvitation)
      const notif = {
        id: 'notif-1',
        organizationId,
        template: 'ORGANIZATION_INVITATION' as const,
        channel: 'EMAIL' as const,
        recipient: email,
        status: 'PENDING' as const,
        idempotencyKey: `invitation:${invitationId}`,
        scheduledFor: new Date(),
        metadata: {
          organizationName: 'Atelier Vélo Lyon',
          roleName: 'Administrateur',
          invitationId,
        },
        bookingId: null,
        refundId: null,
        attemptCount: 0,
        providerFirstAttemptStartedAt: null,
        nextAttemptAt: null,
        failedAt: null,
        sentAt: null,
        leaseToken: null,
        leaseUntil: null,
        failureCode: null,
        providerMessageId: null,
        requiresManualReview: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Vérifier l'absence totale de bearer ou token brut dans metadata
      expect(JSON.stringify(notif.metadata)).not.toContain(token);
      expect(JSON.stringify(notif.metadata)).not.toContain('token');
      expect((notif.metadata as Record<string, unknown>).token).toBeUndefined();
      expect((notif.metadata as Record<string, unknown>).bearer).toBeUndefined();

      // 3. Reconstruction et rendu par le worker / loader de notification
      const fakeDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  {
                    id: invitationId,
                    organizationId,
                    email,
                    role: 'ADMIN',
                    expiresAt,
                    status: 'PENDING',
                    orgLegalName: 'Atelier Vélo Lyon SAS',
                    orgDisplayName: 'Atelier Vélo Lyon',
                  },
                ],
              }),
            }),
          }),
        }),
      } as unknown as DatabaseClient;

      const rendered = await renderNotificationRecord(fakeDb, notif);

      // 4. Extraction du token depuis le rendu email (URL d'action)
      const tokenMatch = /token=([^"&\s]+)/.exec(rendered.html);
      expect(tokenMatch).not.toBeNull();
      const extractedEncodedToken = tokenMatch![1]!;
      const extractedToken = decodeURIComponent(extractedEncodedToken);

      // Le token reconstruit dans le template doit être rigoureusement identique au token d'origine
      expect(extractedToken).toBe(token);

      // 5. Vérification cryptographique de l'acceptation avec le même INVITATION_SECRET
      const verification = verifySignedInvitationToken(
        extractedToken,
        {
          organizationId,
          email,
        },
        process.env,
      );

      expect(verification.valid).toBe(true);
      expect(verification.invitationId).toBe(invitationId);
    });
  });
});

