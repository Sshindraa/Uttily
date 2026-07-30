/**
 * @uttily/core — Module Financial Terms (Lot 5, ADR-010 §6).
 *
 * Résolution pure des termes financiers avant initiation du paiement.
 * Aucune dépendance base de données, aucun appel Stripe, aucun effet de bord.
 * Les montants sont des entiers en unités mineures avec devise EUR.
 */

export * from './types';
export * from './errors';
export * from './resolve-financial-terms';
