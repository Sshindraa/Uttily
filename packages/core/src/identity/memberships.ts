import { and, count, eq } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { lockOrganization, organizationMemberships } from '@uttily/database';
import type { MembershipRecord, MembershipRole } from './types';
import { AuthorizationError, can } from './permissions';

/**
 * Récupère la membership d'un utilisateur pour une organisation.
 * Renvoie null si l'utilisateur n'en fait pas partie.
 */
export async function getMembership(
  db: DatabaseClient,
  organizationId: string,
  userId: string,
): Promise<MembershipRecord | null> {
  const [row] = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role,
    status: row.status,
  };
}

/**
 * Liste les membres actifs d'une organisation.
 */
export async function listMembers(
  db: DatabaseClient,
  organizationId: string,
): Promise<MembershipRecord[]> {
  const rows = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.status, 'ACTIVE'),
      ),
    );
  return rows.map((r) => ({
    organizationId: r.organizationId,
    userId: r.userId,
    role: r.role,
    status: r.status,
  }));
}

/**
 * Compte les OWNER actifs d'une organisation.
 * Utilisé par le garde-fou "dernier OWNER".
 *
 * IMPORTANT : cette fonction ne verrouille pas. Elle doit être appelée
 * À L'INTÉRIEUR d'une transaction protégée par lockOrganization pour
 * garantir un compte cohérent face aux appels concurrents.
 */
export async function countActiveOwners(db: DbExecutor, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.role, 'OWNER'),
        eq(organizationMemberships.status, 'ACTIVE'),
      ),
    );
  return Number(row?.value ?? 0);
}

/**
 * Change le rôle d'un membre. Réservé à l'OWNER (Chantier 15B).
 *
 * Garde-fou "au moins un OWNER actif" protégé face à la concurrence :
 * la vérification et la mutation sont effectuées dans une transaction
 * PostgreSQL tenant un verrou advisory transactionnel par organisation.
 * Deux appels concurrents sur la même organisation sont sérialisés.
 */
export async function changeMemberRole(
  db: DatabaseClient,
  organizationId: string,
  targetUserId: string,
  newRole: MembershipRole,
  actor?: { userId: string; role: MembershipRole },
): Promise<void> {
  if (actor && !can(actor.role, 'team.changeRole')) {
    throw new AuthorizationError('Seul un propriétaire (OWNER) peut modifier les rôles.');
  }

  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId);

    const [target] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, targetUserId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new AuthorizationError('Membre introuvable dans cette organisation.');
    }

    if (newRole !== 'OWNER' && target.role === 'OWNER' && target.status === 'ACTIVE') {
      const owners = await countActiveOwners(tx, organizationId);
      if (owners <= 1) {
        throw new AuthorizationError(
          'Impossible de rétrograder le dernier OWNER de l\u2019organisation.',
        );
      }
    }

    await tx
      .update(organizationMemberships)
      .set({ role: newRole, updatedAt: new Date() })
      .where(eq(organizationMemberships.id, target.id));
  });
}

/**
 * Retire un membre (status -> REMOVED, removed_at positionné) (Chantier 15B).
 *
 * Règles hiérarchiques Core :
 * - OWNER peut retirer n'importe qui (sauf le dernier OWNER).
 * - ADMIN peut retirer MANAGER ou STAFF, mais JAMAIS OWNER ou ADMIN.
 * - MANAGER et STAFF ne peuvent rien retirer.
 *
 * Garde-fou "au moins un OWNER actif" protégé face à la concurrence :
 * la vérification et la mutation sont effectuées dans une transaction
 * PostgreSQL tenant un verrou advisory transactionnel par organisation.
 */
export async function removeMember(
  db: DatabaseClient,
  organizationId: string,
  targetUserId: string,
  actor?: { userId: string; role: MembershipRole },
): Promise<void> {
  if (actor && !can(actor.role, 'team.remove')) {
    throw new AuthorizationError('Rôle insuffisant pour retirer un membre.');
  }

  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId);

    const [target] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, targetUserId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new AuthorizationError('Membre introuvable dans cette organisation.');
    }

    if (actor && actor.role === 'ADMIN') {
      if (target.role === 'OWNER' || target.role === 'ADMIN') {
        throw new AuthorizationError(
          'Un administrateur ne peut pas retirer un propriétaire ou un autre administrateur.',
        );
      }
    }

    if (target.role === 'OWNER' && target.status === 'ACTIVE') {
      const owners = await countActiveOwners(tx, organizationId);
      if (owners <= 1) {
        throw new AuthorizationError(
          'Impossible de retirer le dernier OWNER de l\u2019organisation.',
        );
      }
    }

    await tx
      .update(organizationMemberships)
      .set({ status: 'REMOVED', removedAt: new Date(), updatedAt: new Date() })
      .where(eq(organizationMemberships.id, target.id));
  });
}
