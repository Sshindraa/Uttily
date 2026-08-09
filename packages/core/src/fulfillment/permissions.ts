import type { MembershipRecord } from '../identity/types';
import { AuthorizationError } from '../identity/permissions';
import { FULFILLMENT_OPERATORS } from './operators';

/**
 * @uttily/core — Permissions serveur — module Fulfillment (G4A).
 *
 * MVP (ADR-011) : tous les membres actifs (OWNER, ADMIN, MANAGER, STAFF) sont autorisés.
 * La vérification d'appartenance active se fait côté serveur dans chaque use case Core
 * (verifyFulfillmentMembership) ET dans le helper Web (requireFulfillmentOperatorOf).
 * Defense in depth : le helper Web ne remplace jamais l'autorisation Core.
 */

/**
 * Vérifie qu'une membership est active et autorisée à exécuter les opérations
 * terrain de fulfillment (préparer, remettre, réceptionner, clôturer, rapports).
 * Lance AuthorizationError si refusé. Retourne la membership validée.
 */
export function requireFulfillmentOperator(
  membership: MembershipRecord | null | undefined,
): MembershipRecord {
  if (!membership) {
    throw new AuthorizationError('Aucune appartenance à cette organisation.');
  }
  if (membership.status !== 'ACTIVE') {
    throw new AuthorizationError(`Appartenance non active (statut: ${membership.status}).`);
  }
  if (!FULFILLMENT_OPERATORS.includes(membership.role)) {
    throw new AuthorizationError(
      `Rôle insuffisant pour les opérations terrain: ${membership.role}.`,
    );
  }
  return membership;
}
