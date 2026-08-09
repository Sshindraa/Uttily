/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Validation de la cohérence de la grille tarifaire.
 * Vérifie que les candidats d'une même variante ne créent pas d'incohérence
 * financière (un forfait plus long moins cher qu'un plus court, etc.).
 */

import type { Candidate } from './types';
import { FlexiblePricingError } from './errors';

/**
 * Valide la cohérence de la grille pour tous les candidats d'une même variante.
 *
 * Règles :
 * 1. Un plan FIXED_DURATION plus long ne doit pas coûter moins cher qu'un plus
 *    court (pour la même variante, même devise).
 *    Si planA.includedDurationMinutes > planB.includedDurationMinutes
 *    ET planA.lineTotal < planB.lineTotal → PRICING_CONFIGURATION_INVALID.
 *
 * 2. Pour les plans DAILY, le total après remise ne doit pas décroître quand
 *    on ajoute un jour. Si pour dayCount N le total > total pour N+1
 *    → PRICING_CONFIGURATION_INVALID. (Cette vérification compare les candidats
 *    DAILY d'une même variante avec des billedDays différents.)
 *
 * @throws FlexiblePricingError(PRICING_CONFIGURATION_INVALID) si incohérence détectée.
 */
export function validateGrid(candidates: Candidate[]): void {
  if (candidates.length < 2) return;

  // Règle 1 : FIXED_DURATION — non-décroissance du montant avec la durée.
  const fixedCandidates = candidates.filter(
    (c) => c.plan.planType === 'FIXED_DURATION' && c.coveredDurationMinutes !== null,
  );
  for (let i = 0; i < fixedCandidates.length; i++) {
    for (let j = 0; j < fixedCandidates.length; j++) {
      if (i === j) continue;
      const a = fixedCandidates[i]!;
      const b = fixedCandidates[j]!;
      if (
        a.coveredDurationMinutes! > b.coveredDurationMinutes! &&
        a.lineTotalAmountMinor < b.lineTotalAmountMinor
      ) {
        throw new FlexiblePricingError(
          'PRICING_CONFIGURATION_INVALID',
          `Grille incohérente : le forfait FIXED_DURATION de ${a.coveredDurationMinutes}min (${a.lineTotalAmountMinor}) coûte moins cher que celui de ${b.coveredDurationMinutes}min (${b.lineTotalAmountMinor})`,
        );
      }
    }
  }

  // Règle 2 : DAILY — non-décroissance du total après remise avec le nombre de jours.
  const dailyCandidates = candidates.filter(
    (c) =>
      c.plan.planType === 'DAILY' && c.billedDays !== null && c.amountAfterDiscountMinor !== null,
  );
  // Trier par billedDays croissant.
  const sorted = [...dailyCandidates].sort((a, b) => a.billedDays! - b.billedDays!);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (
      prev.billedDays! < curr.billedDays! &&
      prev.amountAfterDiscountMinor! > curr.amountAfterDiscountMinor!
    ) {
      throw new FlexiblePricingError(
        'PRICING_CONFIGURATION_INVALID',
        `Grille incohérente : le total après remise pour ${prev.billedDays} jour(s) (${prev.amountAfterDiscountMinor}) est supérieur à celui pour ${curr.billedDays} jour(s) (${curr.amountAfterDiscountMinor})`,
      );
    }
  }
}
