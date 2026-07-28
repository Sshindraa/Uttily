import type { MembershipRecord, MembershipRole, AuthenticatedUser } from '../identity/types';
import { AuthorizationError } from '../identity/permissions';

/**
 * Permissions serveur — module Catalog & Inventory (Lot 2A).
 *
 * Rôles autorisés à gérer le catalogue (création, édition, publication).
 */
export const CATALOG_MANAGERS: readonly MembershipRole[] = ['OWNER', 'ADMIN', 'MANAGER'] as const;

/**
 * Rôles autorisés à consulter le catalogue et l'inventaire.
 */
export const CATALOG_VIEWERS: readonly MembershipRole[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'STAFF',
] as const;

/**
 * Vérifie qu'une membership est active et autorisée à gérer le catalogue.
 * Lance AuthorizationError si refusé. Retourne la membership validée.
 */
export function requireCatalogManager(
  membership: MembershipRecord | null | undefined,
): MembershipRecord {
  if (!membership) {
    throw new AuthorizationError('Aucune appartenance à cette organisation.');
  }
  if (membership.status !== 'ACTIVE') {
    throw new AuthorizationError(`Appartenance non active (statut: ${membership.status}).`);
  }
  if (!CATALOG_MANAGERS.includes(membership.role)) {
    throw new AuthorizationError(
      `Rôle insuffisant pour gérer le catalogue: ${membership.role} (requis: ${CATALOG_MANAGERS.join(', ')}).`,
    );
  }
  return membership;
}

/**
 * Vérifie qu'une membership est active et autorisée à consulter le catalogue.
 */
export function requireCatalogViewer(
  membership: MembershipRecord | null | undefined,
): MembershipRecord {
  if (!membership) {
    throw new AuthorizationError('Aucune appartenance à cette organisation.');
  }
  if (membership.status !== 'ACTIVE') {
    throw new AuthorizationError(`Appartenance non active (statut: ${membership.status}).`);
  }
  if (!CATALOG_VIEWERS.includes(membership.role)) {
    throw new AuthorizationError(
      `Rôle insuffisant pour consulter le catalogue: ${membership.role}.`,
    );
  }
  return membership;
}

/**
 * Vérifie qu'un utilisateur est admin Uttily (gestion des catégories globales).
 */
export function requireCategoryManager(user: AuthenticatedUser): void {
  if (!user.isPlatformAdmin) {
    throw new AuthorizationError('Gestion des catégories réservée à l\u2019administrateur Uttily.');
  }
}
