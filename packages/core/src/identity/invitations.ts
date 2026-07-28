import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { organizationInvitations, organizationMemberships, users } from '@uttily/database';
import type { AuthenticatedUser, InvitationInput, MembershipRole } from './types';
import { AuthorizationError, canInviteRole } from './permissions';

export const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 jours

/**
 * Hash un token d'invitation (jamais stocké en clair).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Génère un token d'invitation aléatoire (32 octets, hex).
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
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
 *
 * On cible explicitement le nom de la contrainte plutôt que le seul
 * SQLSTATE 23505 (unique_violation) afin de ne pas masquer d'autres
 * violations d'unicité (ex : token_hash unique) qui doivent remonter
 * comme erreurs non gérées.
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
 * Crée une invitation. Aucun utilisateur n'est créé avant acceptation.
 * Vérifie que l'acteur a le droit d'inviter pour ce rôle.
 *
 * L'unicité des invitations PENDING par (organization_id, email) est
 * garantie par un index unique partiel PostgreSQL (migration 0009).
 * Une vérification préalable est effectuée pour un message d'erreur clair,
 * mais la contrainte SQL reste l'autorité finale face à la concurrence.
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

  // Vérification préalable (message clair, évite la plupart des doublons).
  const existing = await db
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

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  try {
    const [row] = await db
      .insert(organizationInvitations)
      .values({
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        status: 'PENDING',
        invitedBy: input.invitedBy,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error('Échec de création de l\u2019invitation.');

    return {
      id: row.id,
      token,
      email,
      role: input.role,
      expiresAt,
    };
  } catch (err) {
    // Autorité finale : contrainte SQL. Gère la concurrence.
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
 * Révoque une invitation.
 */
export async function revokeInvitation(
  db: DatabaseClient,
  invitationId: string,
  revokedBy: string,
): Promise<void> {
  await db
    .update(organizationInvitations)
    .set({ status: 'REVOKED', revokedAt: new Date(), revokedBy, updatedAt: new Date() })
    .where(
      and(
        eq(organizationInvitations.id, invitationId),
        eq(organizationInvitations.status, 'PENDING'),
      ),
    );
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
