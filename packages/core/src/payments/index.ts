/**
 * @uttily/core — Module Payments (Lot 5, ADR-010 §3, §5, §14).
 *
 * Adapter Stripe et provider de paiement injectable. Le SDK Stripe n'est
 * importé que dans stripe-adapter.ts ; le contrat du domaine (types.ts) est
 * indépendant du fournisseur. Les montants sont des entiers en unités
 * mineures avec devise EUR. Aucune méthode ne doit être appelée pendant une
 * transaction PostgreSQL ou sous un verrou FOR UPDATE.
 */

export * from './types';
export * from './errors';
export * from './stripe-adapter';
export * from './controller-config';
// Fake déterministe pour tests (ADR-010). Test-only — un guard runtime lève
// si NODE_ENV === 'production'. Exporté pour permettre aux tests d'intégration
// de apps/web de mocker `@/lib/stripe` avec un FakeStripeAdapter.
export * from './fake-stripe-adapter';
