/**
 * @uttily/core — Module Identity & Organizations (Lot 1).
 *
 * Source de vérité des rôles, permissions et invariants métier.
 * Indépendant de Next.js et de Clerk. Les actions serveur de apps/web
 * délèguent à ce module.
 */

export * from './identity/permissions';
export * from './identity/types';
export * from './identity/slug';
export * from './identity/time-zone';
export * from './identity/organizations';
export * from './identity/memberships';
export * from './identity/locations';
export * from './identity/invitations';
export * from './identity/audit';
export * from './identity/provisioning';

// Lot 2A — Catalogue et inventaire physique.
export * from './catalog/index';

// Lot 3 — Disponibilité et blocages (InventoryBlock).
export * from './availability/index';
