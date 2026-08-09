import type { MembershipRole } from '../identity/types';

/**
 * Rôles autorisés à exécuter les opérations terrain de fulfillment (ADR-011, MVP).
 * Tous les membres actifs de l'organisation sont autorisés.
 * La vérification d'appartenance active se fait côté serveur dans chaque use case.
 */
export const FULFILLMENT_OPERATORS: readonly MembershipRole[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'STAFF',
] as const;
