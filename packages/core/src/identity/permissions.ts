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
 * Matrice de capacités unifiée (Chantier 15E).
 * Une seule source de vérité pour toutes les permissions d'organisation.
 */
export type Capability =
  | 'bookings.manage'
  | 'fulfillment.manage'
  | 'fleet.manage'
  | 'locations.manage'
  | 'finances.view'
  | 'payouts.manage'
  | 'team.invite'
  | 'team.remove'
  | 'team.changeRole'
  | 'organization.manage'
  | 'policy.manage';

const CAPABILITY_MATRIX: Record<Capability, readonly MembershipRole[]> = {
  'bookings.manage': ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
  'fulfillment.manage': ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
  'fleet.manage': ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
  'locations.manage': ['OWNER', 'ADMIN', 'MANAGER'],
  'finances.view': ['OWNER', 'ADMIN'],
  'payouts.manage': ['OWNER', 'ADMIN'],
  'team.invite': ['OWNER', 'ADMIN'],
  'team.remove': ['OWNER', 'ADMIN'],
  'team.changeRole': ['OWNER'],
  'organization.manage': ['OWNER', 'ADMIN'],
  'policy.manage': ['OWNER', 'ADMIN'],
};

/**
 * Vérifie si un rôle possède une capacité donnée.
 */
export function can(role: MembershipRole, capability: Capability): boolean {
  const allowed = CAPABILITY_MATRIX[capability];
  return allowed ? allowed.includes(role) : false;
}

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
 * Vérifie qu'une membership active possède la capacité requise.
 */
export function requireCapability(
  membership: MembershipRecord | null | undefined,
  capability: Capability,
): MembershipRecord {
  if (!membership) {
    throw new AuthorizationError('Aucune appartenance à cette organisation.');
  }
  if (membership.status !== 'ACTIVE') {
    throw new AuthorizationError(`Appartenance non active (statut: ${membership.status}).`);
  }
  if (!can(membership.role, capability)) {
    throw new AuthorizationError(
      `Permission refusée : le rôle ${membership.role} ne possède pas la capacité ${capability}.`,
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
export const LOCATION_MANAGERS: readonly MembershipRole[] = CAPABILITY_MATRIX['locations.manage'];

/**
 * Rôles autorisés à inviter des membres.
 */
export const MEMBER_INVITERS: readonly MembershipRole[] = CAPABILITY_MATRIX['team.invite'];

/**
 * Rôles autorisés à gérer les rôles des membres (changeMemberRole).
 */
export const ROLE_MANAGERS: readonly MembershipRole[] = CAPABILITY_MATRIX['team.changeRole'];

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
