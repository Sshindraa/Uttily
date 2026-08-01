/**
 * @uttily/core — Constantes et validation de planification (Phase 7A, ADR-010 §12).
 */

import { sql } from 'drizzle-orm';
import { ReconciliationError } from './errors';

/** Limite maximale absolue du batch. */
export const MAX_BATCH_LIMIT = 10;

/** Limite par défaut du batch. */
export const DEFAULT_BATCH_LIMIT = 10;

/** Durée du lease de réconciliation (2 minutes). */
export const LEASE_INTERVAL = sql.raw("interval '2 minutes'");

/** Backoff technique après échéance (5 minutes, constant). */
export const RECONCILIATION_BACKOFF_INTERVAL = sql.raw("interval '5 minutes'");

/** Délai de traitement avant expiration (30 minutes). */
export const PROCESSING_DEADLINE_INTERVAL = sql.raw("interval '30 minutes'");

/**
 * Âge maximum de la clé d'idempotency Stripe (ADR-010 §8).
 *
 * Stripe conserve les clés d'idempotency pendant 24h. Pour rester conservative
 * et absorber le drift d'horloge entre Node.js et PostgreSQL, on utilise 23h
 * (1h de marge de sécurité). La vérification est faite côté PostgreSQL avec
 * `transaction_timestamp()` dans la transaction de claim (P1-4), pas avec
 * `Date.now()` côté application.
 */
export const IDEMPOTENCY_KEY_MAX_AGE_HOURS = 23;

/**
 * @deprecated Utiliser {@link IDEMPOTENCY_KEY_MAX_AGE_HOURS} (23h avec marge).
 * Conservé pour référence documentaire — la décision d'expiration se fait
 * désormais côté PostgreSQL dans la transaction de claim (P1-4).
 */
export const MAX_IDEMPOTENCY_KEY_AGE_HOURS = 24;

/**
 * Valide que batchLimit est un entier entre 1 et MAX_BATCH_LIMIT.
 *
 * @returns batchLimit validé.
 * @throws ReconciliationError('BATCH_LIMIT_INVALID') si invalide.
 */
export function validateBatchLimit(batchLimit: number): number {
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new ReconciliationError(
      'BATCH_LIMIT_INVALID',
      `BATCH_LIMIT_INVALID: batchLimit doit être entre 1 et ${MAX_BATCH_LIMIT}`,
    );
  }
  return batchLimit;
}
