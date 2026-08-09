/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Sélection et application des paliers de réduction multi-jours.
 * Pas de cumul : seul le meilleur palier applicable est utilisé.
 */

import type { ResolvedTier } from './types';
import { halfUpRound } from './safe-arithmetic';

/**
 * Sélectionne le palier de remise applicable pour un plan et un nombre de jours.
 *
 * Règle : trouve le palier avec le plus grand thresholdDays qui est <= dayCount.
 * Seuls les paliers du MÊME plan sont considérés (pas de fusion avec les paliers
 * du plan par défaut).
 *
 * @returns le palier applicable ou null si aucun ne correspond (dayCount < tous les seuils).
 */
export function selectDiscountTier(
  planId: string,
  tiers: ResolvedTier[],
  dayCount: number,
): ResolvedTier | null {
  let best: ResolvedTier | null = null;
  for (const tier of tiers) {
    if (tier.pricingPlanId !== planId) continue;
    if (tier.thresholdDays > dayCount) continue;
    if (best === null || tier.thresholdDays > best.thresholdDays) {
      best = tier;
    }
  }
  return best;
}

/**
 * Applique une réduction en pourcentage à un montant en unités mineures.
 * Utilise l'arrondi commercial half-up (halfUpRound).
 *
 * @param amountBeforeDiscount  Montant avant remise (entier >= 0)
 * @param discountPercent        Pourcentage entier (1..99)
 * @returns                      { amountAfterDiscount, discountAmount }
 */
export function applyDiscount(
  amountBeforeDiscount: number,
  discountPercent: number,
): { amountAfterDiscount: number; discountAmount: number } {
  const amountAfterDiscount = halfUpRound(amountBeforeDiscount, discountPercent);
  const discountAmount = amountBeforeDiscount - amountAfterDiscount;
  return { amountAfterDiscount, discountAmount };
}
