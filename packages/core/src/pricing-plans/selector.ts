/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Sélection déterministe d'un seul candidat par variante.
 * Tie-break order exact (voir ADR-018 §7 et spec G7P-B1 §11).
 */

import type { Candidate } from './types';
import { FlexiblePricingError } from './errors';

/**
 * Sélectionne le meilleur candidat parmi une liste de candidats éligibles
 * pour une même variante.
 *
 * Tie-break order (exact) :
 * 1. Lowest lineTotalAmountMinor
 * 2. Exact duration match (billedDurationMinutes === requestedDurationMinutes
 *    or coveredDurationMinutes === requestedDurationMinutes) — true sorts first
 * 3. Smallest covered/billed duration sufficient (smaller billedDurationMinutes
 *    or coveredDurationMinutes sorts first)
 * 4. Least unused time (smaller coveredDurationMinutes - requestedDurationMinutes
 *    for FIXED, or billedDurationMinutes - requestedDurationMinutes for HOURLY)
 * 5. priority ascending (lower priority value first)
 * 6. version ascending
 * 7. pricingPlanId lexical ascending (UUID string comparison)
 *
 * @throws FlexiblePricingError(NO_ELIGIBLE_PLAN) si la liste est vide.
 */
export function selectBestCandidate(candidates: Candidate[]): Candidate {
  if (candidates.length === 0) {
    throw new FlexiblePricingError(
      'NO_ELIGIBLE_PLAN',
      'selectBestCandidate: aucun candidat éligible',
    );
  }

  // Trier selon l'ordre de tie-break.
  const sorted = [...candidates].sort(compareCandidates);

  return sorted[0]!;
}

/**
 * Comparateur déterministe pour le tie-break order.
 * Retourne < 0 si a doit être choisi avant b, > 0 sinon.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  // 1. Lowest lineTotalAmountMinor
  if (a.lineTotalAmountMinor !== b.lineTotalAmountMinor) {
    return a.lineTotalAmountMinor - b.lineTotalAmountMinor;
  }

  // 2. Exact duration match — true sorts first (false=1, true=0)
  const aExact = a.exactDurationMatch ? 0 : 1;
  const bExact = b.exactDurationMatch ? 0 : 1;
  if (aExact !== bExact) return aExact - bExact;

  // 3. Smallest covered/billed duration sufficient
  const aDuration = a.sufficientDuration;
  const bDuration = b.sufficientDuration;
  if (aDuration !== bDuration) return aDuration - bDuration;

  // 4. Least unused time
  if (a.unusedTime !== b.unusedTime) return a.unusedTime - b.unusedTime;

  // 5. priority ascending
  if (a.plan.priority !== b.plan.priority) return a.plan.priority - b.plan.priority;

  // 6. version ascending
  if (a.plan.version !== b.plan.version) return a.plan.version - b.plan.version;

  // 7. pricingPlanId lexical ascending
  if (a.plan.id < b.plan.id) return -1;
  if (a.plan.id > b.plan.id) return 1;
  return 0;
}
