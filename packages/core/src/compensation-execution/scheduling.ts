/**
 * @uttily/core — Constantes et validation de planification (Phase 8, ADR-010 §13).
 */

import { sql } from 'drizzle-orm';

/** Limite maximale absolue du batch. */
export const MAX_BATCH_LIMIT = 10;

/** Limite par défaut du batch. */
export const DEFAULT_BATCH_LIMIT = 10;

/** Durée du lease de compensation (2 minutes). */
export const LEASE_INTERVAL = sql.raw("interval '2 minutes'");

/** Nombre maximum de tentatives avant de marquer FAILED. */
export const MAX_ATTEMPTS = 5;

/** Intervalle de base du backoff exponentiel (30 secondes). */
export const BASE_BACKOFF_INTERVAL = sql.raw("interval '30 seconds'");

/**
 * Valide que batchLimit est un entier entre 1 et MAX_BATCH_LIMIT.
 *
 * @returns batchLimit validé.
 * @throws Error si invalide.
 */
export function validateBatchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
    throw new Error(`batchLimit invalide : ${limit} (attendu : entier 1-${MAX_BATCH_LIMIT})`);
  }
  return limit;
}

/**
 * Calcule l'intervalle de backoff exponentiel pour un nombre de tentatives donné.
 *
 * Backoff : 30s, 60s, 120s, 240s, 480s (30 * 2^attemptCount).
 *
 * @returns Expression SQL `interval 'N seconds'`.
 */
export function getBackoffInterval(attemptCount: number): string {
  const seconds = 30 * Math.pow(2, attemptCount);
  return `interval '${seconds} seconds'`;
}
