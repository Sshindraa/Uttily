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

// Lot 4 — Prix et calcul des jours civils.
export * from './pricing/index';

// Lot 4 — Idempotence persistée.
export * from './idempotency/index';

// Lot 4 — Création atomique de brouillon de réservation.
export * from './booking-drafts/index';

// Lot 5 — Résolution des termes financiers (ADR-010).
export * from './financial-terms/index';

// Lot 5 — Adapter Stripe et provider de paiement (ADR-010).
export * from './payments/index';

// Lot 5 — Initiation de paiement (ADR-010 §7).
export * from './payment-initiation/index';

// Lot 5 — Traitement des webhooks Stripe (ADR-010 §9, §10, §11, §13, §14).
export * from './webhook-handler/index';
