/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Arithmétique sûre sur entiers en unités mineures.
 * Toute opération qui dépasserait Number.MAX_SAFE_INTEGER lève
 * FlexiblePricingError(AMOUNT_OVERFLOW).
 */

import { FlexiblePricingError } from './errors';

/**
 * Multiplication sûre de deux entiers.
 * @throws FlexiblePricingError(AMOUNT_OVERFLOW) si le résultat dépasse MAX_SAFE_INTEGER
 *   ou si les entrées ne sont pas des safe integers.
 */
export function safeMultiply(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `safeMultiply: opérande non safe-integer (${a}, ${b})`,
    );
  }
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `safeMultiply: ${a} × ${b} dépasse Number.MAX_SAFE_INTEGER`,
    );
  }
  return result;
}

/**
 * Addition sûre de deux entiers.
 * @throws FlexiblePricingError(AMOUNT_OVERFLOW) si le résultat dépasse MAX_SAFE_INTEGER
 *   ou si les entrées ne sont pas des safe integers.
 */
export function safeAdd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `safeAdd: opérande non safe-integer (${a}, ${b})`,
    );
  }
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `safeAdd: ${a} + ${b} dépasse Number.MAX_SAFE_INTEGER`,
    );
  }
  return result;
}

/**
 * Calcule le montant après réduction en arrondi commercial half-up
 * (arrondi au plus proche, .5 vers le haut) en arithmétique entière pure.
 *
 * Formule : discount = (amount * percent * 2 + 100) / (100 * 2)  (division entière)
 *           result   = amount - discount
 *
 * Le +100 au numérateur avant division par 200 implémente le half-up :
 * si le reste de la division par 200 est >= 100, on arrondit vers le haut.
 *
 * @param amountMinor       Montant en unités mineures (entier >= 0)
 * @param discountPercent   Pourcentage entier (0..99)
 * @returns                 Montant après réduction en unités mineures
 * @throws FlexiblePricingError(AMOUNT_OVERFLOW) en cas d'overflow
 */
export function halfUpRound(amountMinor: number, discountPercent: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `halfUpRound: amountMinor invalide (${amountMinor})`,
    );
  }
  if (!Number.isSafeInteger(discountPercent) || discountPercent < 0 || discountPercent >= 100) {
    throw new FlexiblePricingError(
      'VALIDATION',
      `halfUpRound: discountPercent invalide (${discountPercent})`,
    );
  }
  // amount * percent peut dépasser MAX_SAFE_INTEGER ; on vérifie via safeMultiply.
  const scaled = safeMultiply(amountMinor, discountPercent);
  const doubled = safeMultiply(scaled, 2);
  const numerator = safeAdd(doubled, 100);
  const discount = Math.floor(numerator / 200);
  const result = amountMinor - discount;
  if (!Number.isSafeInteger(result)) {
    throw new FlexiblePricingError(
      'AMOUNT_OVERFLOW',
      `halfUpRound: résultat dépasse Number.MAX_SAFE_INTEGER`,
    );
  }
  return result;
}
