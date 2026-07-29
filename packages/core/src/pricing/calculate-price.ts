import { PricingError } from './errors';
import type { PricingLineInput, PricingLineResult, PricingResult } from './types';

/**
 * Multiplication sûre d'entiers en unités mineures.
 * @throws PricingError(VALIDATION) en cas d'overflow (dépassement de MAX_SAFE_INTEGER).
 */
function safeMultiply(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new PricingError(
      'VALIDATION',
      `Overflow: opération sur valeurs non-safe-integer (${a}, ${b})`,
    );
  }
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new PricingError('VALIDATION', `Overflow: ${a} × ${b} dépasse Number.MAX_SAFE_INTEGER`);
  }
  return result;
}

/**
 * Addition sûre d'entiers en unités mineures.
 * @throws PricingError(VALIDATION) en cas d'overflow (dépassement de MAX_SAFE_INTEGER).
 */
function safeAdd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new PricingError(
      'VALIDATION',
      `Overflow: opération sur valeurs non-safe-integer (${a}, ${b})`,
    );
  }
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new PricingError('VALIDATION', `Overflow: ${a} + ${b} dépasse Number.MAX_SAFE_INTEGER`);
  }
  return result;
}

/**
 * Calcule le prix d'un brouillon à partir des lignes et du nombre de jours
 * civils facturables (Lot 4).
 *
 * Calcul pur : aucune dépendance base de données, aucune écriture.
 * Les montants sont des entiers en unités mineures (centimes) avec devise EUR.
 *
 * @throws PricingError(VALIDATION) pour les erreurs de validation
 *   (lignes vides, quantité/prix invalide, devise non EUR, dayCount invalide,
 *   overflow arithmétique).
 */
export function calculatePrice(lines: PricingLineInput[], billableDayCount: number): PricingResult {
  if (!Number.isSafeInteger(billableDayCount) || billableDayCount <= 0) {
    throw new PricingError(
      'VALIDATION',
      `billableDayCount doit être un entier strictement positif (reçu : ${billableDayCount})`,
    );
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PricingError('VALIDATION', 'Au moins une ligne de prix est requise');
  }

  const results: PricingLineResult[] = [];
  let subtotal = 0;

  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new PricingError(
        'VALIDATION',
        `quantité invalide pour la variante ${line.variantId} (reçu : ${line.quantity})`,
      );
    }
    if (!Number.isSafeInteger(line.unitPriceAmountMinor) || line.unitPriceAmountMinor <= 0) {
      throw new PricingError(
        'VALIDATION',
        `prix unitaire invalide pour la variante ${line.variantId} (reçu : ${line.unitPriceAmountMinor})`,
      );
    }
    if (line.currency !== 'EUR') {
      throw new PricingError(
        'VALIDATION',
        `devise non supportée pour la variante ${line.variantId} (reçu : ${line.currency}, attendu : EUR)`,
      );
    }

    // lineTotal = unitPrice × billableDayCount × quantity
    const step1 = safeMultiply(line.unitPriceAmountMinor, billableDayCount);
    const lineTotal = safeMultiply(step1, line.quantity);

    subtotal = safeAdd(subtotal, lineTotal);

    results.push({
      variantId: line.variantId,
      unitPriceAmountMinor: line.unitPriceAmountMinor,
      quantity: line.quantity,
      billableUnitCount: billableDayCount,
      lineTotalAmountMinor: lineTotal,
      currency: 'EUR',
      variantSnapshot: { ...line.variantSnapshot },
    });
  }

  const mandatoryFees = 0;
  const total = safeAdd(subtotal, mandatoryFees);

  return {
    lines: results,
    billableUnit: 'DAY',
    billableUnitCount: billableDayCount,
    currency: 'EUR',
    subtotalAmountMinor: subtotal,
    mandatoryFeesAmountMinor: mandatoryFees,
    totalAmountMinor: total,
    taxStatus: 'UNDETERMINED',
    taxAmountMinor: null,
    taxRateBps: null,
    commissionAmountMinor: null,
  };
}
