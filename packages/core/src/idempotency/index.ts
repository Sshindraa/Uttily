/**
 * @uttily/core — Module Idempotency (Lot 4).
 *
 * Persistance de l'idempotence via la table idempotency_records (ADR-009).
 * Calcul de l'empreinte SHA-256 canonique, réservation de clé PENDING,
 * terminaison COMPLETED/FAILED atomique.
 */

export * from './types';
export * from './errors';
export * from './fingerprint';
export * from './idempotency';
