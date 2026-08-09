/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Calcul des montants pour chaque candidat.
 * Tous les montants sont en unités mineures (entiers).
 */

import type { Candidate } from './types';
import { FlexiblePricingError } from './errors';
import { safeMultiply } from './safe-arithmetic';
import { applyDiscount, selectDiscountTier } from './discount-calculator';
import type { ResolvedTier } from './types';

/**
 * Calcule le montant pour un candidat.
 * Remplit lineTotalAmountMinor et les champs de remise si applicable.
 *
 * - HOURLY : lineTotal = unitPrice × increments × quantity (pas de remise)
 * - FIXED_DURATION : lineTotal = priceAmountMinor × quantity (pas de remise)
 * - DAILY : amountBeforeDiscount = unitPrice × billedDays × quantity,
 *   puis remise si un palier applicable existe.
 *
 * @throws FlexiblePricingError(AMOUNT_OVERFLOW) en cas d'overflow.
 */
export function calculateAmount(candidate: Candidate, tiers: ResolvedTier[]): Candidate {
  const plan = candidate.plan;
  const quantity = candidate.quantity;

  switch (plan.planType) {
    case 'HOURLY': {
      if (plan.billingIncrementMinutes === null || candidate.billedDurationMinutes === null) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `calculateAmount: HOURLY plan ${plan.id} sans billingIncrementMinutes ou billedDurationMinutes`,
        );
      }
      const increments = candidate.billedDurationMinutes / plan.billingIncrementMinutes;
      // G7P-B2-B Round 2 — Defect 4 : vérifier la division exacte et la sécurité entière.
      if (!Number.isInteger(increments)) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `calculateAmount: HOURLY plan ${plan.id} — billedDurationMinutes (${candidate.billedDurationMinutes}) n'est pas un multiple exact de billingIncrementMinutes (${plan.billingIncrementMinutes})`,
        );
      }
      if (increments <= 0 || !Number.isSafeInteger(increments)) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `calculateAmount: HOURLY plan ${plan.id} — billableUnitCount invalide (${increments})`,
        );
      }
      const billableUnitCount = increments;
      const unitAmount = plan.priceAmountMinor;
      const total = safeMultiply(safeMultiply(unitAmount, billableUnitCount), quantity);
      return { ...candidate, lineTotalAmountMinor: total, billableUnitCount };
    }

    case 'FIXED_DURATION': {
      const total = safeMultiply(plan.priceAmountMinor, quantity);
      // G7P-B2-B Round 2 — Defect 4 : FIXED_DURATION = 1 unité facturable.
      return { ...candidate, lineTotalAmountMinor: total, billableUnitCount: 1 };
    }

    case 'DAILY': {
      if (candidate.billedDays === null) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `calculateAmount: DAILY plan ${plan.id} sans billedDays`,
        );
      }
      // G7P-B2-B Round 2 — Defect 4 : vérifier billedDays > 0.
      if (candidate.billedDays <= 0 || !Number.isSafeInteger(candidate.billedDays)) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `calculateAmount: DAILY plan ${plan.id} — billedDays invalide (${candidate.billedDays})`,
        );
      }
      const billableUnitCount = candidate.billedDays;
      const unitAmount = plan.priceAmountMinor;
      const amountBeforeDiscount = safeMultiply(
        safeMultiply(unitAmount, candidate.billedDays),
        quantity,
      );

      // Sélectionner le palier de remise applicable.
      const tier = selectDiscountTier(plan.id, tiers, candidate.billedDays);

      if (tier) {
        const { amountAfterDiscount } = applyDiscount(amountBeforeDiscount, tier.discountPercent);
        return {
          ...candidate,
          amountBeforeDiscountMinor: amountBeforeDiscount,
          amountAfterDiscountMinor: amountAfterDiscount,
          discountThresholdDays: tier.thresholdDays,
          discountPercent: tier.discountPercent,
          lineTotalAmountMinor: amountAfterDiscount,
          billableUnitCount,
        };
      }

      // Pas de remise applicable.
      return {
        ...candidate,
        amountBeforeDiscountMinor: amountBeforeDiscount,
        amountAfterDiscountMinor: amountBeforeDiscount,
        discountThresholdDays: null,
        discountPercent: null,
        lineTotalAmountMinor: amountBeforeDiscount,
        billableUnitCount,
      };
    }
  }
}
