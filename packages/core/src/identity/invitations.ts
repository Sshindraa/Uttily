import { createHash, createHmac, randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  notifications,
  organizationInvitations,
  organizationMemberships,
  organizations,
  users,
} from '@uttily/database';
import type { AuthenticatedUser, InvitationInput, MembershipRole } from './types';
import { AuthorizationError, can, canInviteRole } from './permissions';

export const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 jours

export class InvitationSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationSecretConfigurationError';
  }
}

/**
 * Récupère le secret de signature des tokens d'invitation (Chantier 15.2.1).
 *
 * - Strictement requis en production/LIVE (pas de réutilisation de Clerk/Cron, pas de secret statique faible).
 * - Vérifie une entropie minimale de 32 caractères.
 * - Fallback de test/dev explicite uniquement hors production.
 */
export function getInvitationSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INVITATION_SECRET;
  const isProductionLike = env.NODE_ENV === 'production' || env.STRIPE_ENVIRONMENT === 'LIVE';

  if (!raw || raw.trim().length === 0) {
    if (isProductionLike) {
      throw new InvitationSecretConfigurationError(
        'INVITATION_SECRET est requis et doit être configuré en production.',
      );
    }
    return 'uttily-invitation-signing-secret-dev-32chars-minimum!!';
  }

  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new InvitationSecretConfigurationError(
      'INVITATION_SECRET doit comporter au moins 32 caractères pour garantir une entropie suffisante.',
    );
  }

  return trimmed;
}

/**
 * Hash un token d'invitation (jamais stocké en clair dans la table invitations).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Génère un token d'invitation signé cryptographiquement (HMAC-SHA256).
 * Reconstructible côté serveur par le loader de notification sans nécessiter
 * d'écrire le secret en clair dans `notifications.metadata` (Chantier 15.2).
 */
export function createSignedInvitationToken(
  data: {
    invitationId: string;
    organizationId: string;
    email: string;
    expiresAt: Date | number;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expiresAtMs = data.expiresAt instanceof Date ? data.expiresAt.getTime() : data.expiresAt;
  const payload = `${data.invitationId}:${data.organizationId}:${data.email.trim().toLowerCase()}:${expiresAtMs}`;
  const hmac = createHmac('sha256', getInvitationSecret(env)).update(payload).digest('hex');
  return `${data.invitationId}.${expiresAtMs}.${hmac}`;
}

/**
 * Vérifie la signature cryptographique d'un token d'invitation.
 */
export function verifySignedInvitationToken(
  token: string,
  context: { organizationId: string; email: string },
  env: NodeJS.ProcessEnv = process.env,
): { valid: boolean; invitationId?: string; expiresAt?: Date } {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };
  const [invitationId, expiresAtStr, providedHmac] = parts;
  if (!invitationId || !expiresAtStr || !providedHmac) return { valid: false };

  const expiresAtMs = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAtMs)) return { valid: false };

  const expectedToken = createSignedInvitationToken(
    {
      invitationId,
      organizationId: context.organizationId,
      email: context.email,
      expiresAt: expiresAtMs,
    },
    env,
  );

  if (token !== expectedToken) return { valid: false };
  return { valid: true, invitationId, expiresAt: new Date(expiresAtMs) };
}

export interface CreatedInvitation {
  id: string;
  token: string; // renvoyé une seule fois à l'appelant
  email: string;
  role: MembershipRole;
  expiresAt: Date;
}

/**
 * Erreur levée lorsqu'une invitation PENDING existe déjà pour
 * la même organisation et le même email. La contrainte d'unicité
 * partielle PostgreSQL (migration 0009) est l'autorité finale.
 */
export class DuplicateInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateInvitationError';
  }
}

/**
 * Détecte si une erreur est une violation de l'index unique partiel
 * `invitations_pending_org_email_unique` (migration 0009).
 */
function isPendingInvitationDuplicate(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const constraint =
      (err as { constraint?: string }).constraint ??
      (err as { constraint_name?: string }).constraint_name;
    if (constraint === 'invitations_pending_org_email_unique') return true;
  }
  return false;
}

/**
 * Crée une invitation et sa notification de manière transactionnelle atomique (Chantier 15.2).
 * Aucun utilisateur n'est créé avant acceptation.
 * Aucun token brut n'est écrit dans `notifications.metadata`.
 */
export async function createInvitation(
  db: DatabaseClient,
  actor: { id: string; role: MembershipRole },
  input: InvitationInput,
): Promise<CreatedInvitation> {
  if (!canInviteRole(actor.role, input.role)) {
    throw new AuthorizationError(`Rôle ${actor.role} ne peut pas inviter au rôle ${input.role}.`);
  }
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) {
    throw new Error('Email invalide.');
  }

  const ttlSeconds = input.ttlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const invitationId = randomUUID();

  const token = createSignedInvitationToken({
    invitationId,
    organizationId: input.organizationId,
    email,
    expiresAt,
  });
  const tokenHash = hashToken(token);

  try {
    return await db.transaction(async (tx) => {
      // 1. Vérification préalable
      const existing = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.organizationId, input.organizationId),
            eq(organizationInvitations.email, email),
            eq(organizationInvitations.status, 'PENDING'),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new DuplicateInvitationError('Une invitation est déjà en attente pour cet email.');
      }

      // 2. Insérer l'invitation
      const [row] = await tx
        .insert(organizationInvitations)
        .values({
          id: invitationId,
          organizationId: input.organizationId,
          email,
          role: input.role,
          tokenHash,
          status: 'PENDING',
          invitedBy: input.invitedBy,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error('Échec de création de l\u2019invitation.');

      // 3. Charger le nom de l'organisation
      const [org] = await tx
        .select({
          legalName: organizations.legalName,
          publicDisplayName: organizations.publicDisplayName,
        })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1);

      const roleLabels: Record<MembershipRole, string> = {
        OWNER: 'Propriétaire',
        ADMIN: 'Administrateur',
        MANAGER: 'Responsable',
        STAFF: "Membre d'équipe",
      };

      // 4. Insérer la notification dans la même transaction SANS bearer token en clair (Chantier 15.2)
      await tx
        .insert(notifications)
        .values({
          organizationId: input.organizationId,
          template: 'ORGANIZATION_INVITATION',
          recipient: email,
          status: 'PENDING',
          idempotencyKey: `invitation:${row.id}`,
          metadata: {
            organizationName: org?.publicDisplayName ?? org?.legalName ?? 'Uttily',
            roleName: roleLabels[input.role] ?? input.role,
            invitationId: row.id,
          },
        })
        .onConflictDoNothing();

      return {
        id: row.id,
        token,
        email,
        role: input.role,
        expiresAt,
      };
    });
  } catch (err) {
    if (isPendingInvitationDuplicate(err)) {
      throw new DuplicateInvitationError('Une invitation est déjà en attente pour cet email.');
    }
    throw err;
  }
}

/**
 * Liste les invitations en attente d'une organisation.
 */
export async function listPendingInvitations(db: DatabaseClient, organizationId: string) {
  return db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, 'PENDING'),
      ),
    );
}

/**
 * Révoque une invitation et annule de façon atomique toute notification PENDING associée (Chantier 15.2).
 */
export async function revokeInvitation(
  db: DatabaseClient,
  organizationId: string,
  invitationId: string,
  actor: { userId: string; role: MembershipRole },
): Promise<void> {
  if (!can(actor.role, 'team.invite')) {
    throw new AuthorizationError('Rôle insuffisant pour révoquer une invitation.');
  }

  await db.transaction(async (tx) => {
    const rows = await tx
      .update(organizationInvitations)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizationInvitations.id, invitationId),
          eq(organizationInvitations.organizationId, organizationId),
          eq(organizationInvitations.status, 'PENDING'),
        ),
      )
      .returning({ id: organizationInvitations.id });

    if (rows.length === 0) {
      throw new AuthorizationError('Invitation introuvable ou déjà traitée.');
    }

    // Annuler immédiatement les notifications PENDING associées dans la même transaction
    await tx
      .update(notifications)
      .set({
        status: 'CANCELLED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notifications.template, 'ORGANIZATION_INVITATION'),
          eq(notifications.organizationId, organizationId),
          eq(notifications.status, 'PENDING'),
          eq(notifications.idempotencyKey, `invitation:${invitationId}`),
        ),
      );
  });
}

/**
 * Marque les invitations expirées (PENDING dont expires_at < now).
 */
export async function expireDueInvitations(db: DatabaseClient): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(organizationInvitations)
    .set({ status: 'EXPIRED', updatedAt: now })
    .where(
      and(
        eq(organizationInvitations.status, 'PENDING'),
        lt(organizationInvitations.expiresAt, now),
      ),
    )
    .returning({ id: organizationInvitations.id });
  return rows.length;
}

/**
 * Accepte une invitation : crée la membership ACTIVE et marque l'invitation ACCEPTED.
 * Transaction atomique. L'utilisateur doit exister (créé via Clerk à l'auth).
 */
export async function acceptInvitation(
  db: DatabaseClient,
  user: AuthenticatedUser,
  token: string,
): Promise<{ organizationId: string; role: MembershipRole }> {
  const tokenHash = hashToken(token);

  return await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenHash, tokenHash))
      .limit(1);

    if (!invitation) {
      throw new AuthorizationError('Invitation introuvable.');
    }
    if (invitation.status !== 'PENDING') {
      throw new AuthorizationError(`Invitation ${invitation.status.toLowerCase()}.`);
    }
    if (invitation.expiresAt < new Date()) {
      await tx
        .update(organizationInvitations)
        .set({ status: 'EXPIRED', updatedAt: new Date() })
        .where(eq(organizationInvitations.id, invitation.id));
      throw new AuthorizationError('Invitation expirée.');
    }
    if (invitation.email !== user.email) {
      throw new AuthorizationError('Cette invitation est destinée à un autre email.');
    }

    // L'utilisateur doit exister dans la base Uttily.
    const [u] = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!u) {
      throw new AuthorizationError('Utilisateur inconnu.');
    }

    // Pas de membership déjà actif.
    const [existing] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, invitation.organizationId),
          eq(organizationMemberships.userId, user.id),
        ),
      )
      .limit(1);
    if (existing && existing.status === 'ACTIVE') {
      throw new AuthorizationError('Vous êtes déjà membre de cette organisation.');
    }

    if (existing) {
      await tx
        .update(organizationMemberships)
        .set({
          role: invitation.role,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(organizationMemberships.id, existing.id));
    } else {
      await tx.insert(organizationMemberships).values({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        status: 'ACTIVE',
        invitedBy: invitation.invitedBy,
        acceptedAt: new Date(),
      });
    }

    await tx
      .update(organizationInvitations)
      .set({
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        acceptedByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(eq(organizationInvitations.id, invitation.id));

    return { organizationId: invitation.organizationId, role: invitation.role };
  });
}
