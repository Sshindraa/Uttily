/**
 * @uttily/core — Constantes et validation de planification partagées (G5D, ADR-013 §7).
 *
 * Ce module centralise les constantes de planification communes au worker de
 * compensation (ADR-010 §13) et au worker de documents transactionnels
 * (ADR-013 §7). Le module compensation-execution re-exporte ces constantes
 * pour préserver sa compatibilité ascendante.
 */

import { sql } from 'drizzle-orm';

/** Limite maximale absolue du batch. */
export const MAX_BATCH_LIMIT = 10;

/** Limite par défaut du batch. */
export const DEFAULT_BATCH_LIMIT = 10;

/** Durée du lease (2 minutes). */
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
 * @returns Nombre de secondes (entier) — utilisé comme paramètre bindé en SQL,
 *   jamais interpolé via sql.raw.
 */
export function getBackoffIntervalSeconds(attemptCount: number): number {
  return 30 * Math.pow(2, attemptCount);
}
