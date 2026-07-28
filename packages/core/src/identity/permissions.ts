import type { MembershipRecord, MembershipRole, AuthenticatedUser } from './types';

/**
 * Permissions serveur — invariants §1 et §2.
 *
 * Aucune action professionnelle ne peut être autorisée côté interface.
 * Toute vérification passe par ces fonctions.
 */

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * Rôles ordonnés du plus privilégié au moins privilégié.
 * Utilisé pour vérifier qu'un rôle est suffisant.
 */
const ROLE_RANK: Record<MembershipRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  STAFF: 1,
};

/**
 * Vérifie qu'une membership est active et que le rôle est suffisant.
 * Lance AuthorizationError si refusé.
 */
export function requireMembership(
  membership: MembershipRecord | null | undefined,
  allowedRoles: readonly MembershipRole[],
): MembershipRecord {
  if (!membership) {
    throw new AuthorizationError('Aucune appartenance à cette organisation.');
  }
  if (membership.status !== 'ACTIVE') {
    throw new AuthorizationError(`Appartenance non active (statut: ${membership.status}).`);
  }
  if (!allowedRoles.includes(membership.role)) {
    throw new AuthorizationError(
      `Rôle insuffisant: ${membership.role} (requis: ${allowedRoles.join(', ')}).`,
    );
  }
  return membership;
}

/**
 * Vérifie qu'un rôle est suffisant par rapport à un minimum.
 */
export function hasMinimumRole(role: MembershipRole, minimum: MembershipRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Rôles autorisés à gérer les établissements (création, édition).
 */
export const LOCATION_MANAGERS: readonly MembershipRole[] = ['OWNER', 'ADMIN', 'MANAGER'] as const;

/**
 * Rôles autorisés à inviter des membres.
 */
export const MEMBER_INVITERS: readonly MembershipRole[] = ['OWNER', 'ADMIN'] as const;

/**
 * Rôles autorisés à gérer les rôles des membres (changeMemberRole).
 */
export const ROLE_MANAGERS: readonly MembershipRole[] = ['OWNER'] as const;

/**
 * Vérifie qu'un utilisateur est admin Uttily (is_platform_admin).
 * Les actions admin sont distinctes des rôles d'organisation (invariant §3).
 */
export function requirePlatformAdmin(user: AuthenticatedUser): void {
  if (!user.isPlatformAdmin) {
    throw new AuthorizationError('Action réservée à l\u2019administrateur Uttily.');
  }
}

/**
 * Rôles qu'un acteur peut attribuer lors d'une invitation.
 * - OWNER peut inviter ADMIN, MANAGER, STAFF.
 * - ADMIN peut inviter MANAGER, STAFF (pas OWNER ni ADMIN).
 */
export function canInviteRole(actorRole: MembershipRole, targetRole: MembershipRole): boolean {
  if (actorRole === 'OWNER') {
    return targetRole !== 'OWNER';
  }
  if (actorRole === 'ADMIN') {
    return targetRole === 'MANAGER' || targetRole === 'STAFF';
  }
  return false;
}
