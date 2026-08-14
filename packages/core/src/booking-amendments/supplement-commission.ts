/**
 * Calcule la commission d'un supplément depuis les snapshots financiers
 * immuables de la réservation.
 *
 * Ce module reste interne au package Core : le helper n'est pas réexporté par
 * le barrel public. BigInt est utilisé pour que le produit intermédiaire ne
 * passe jamais par Number.
 */

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class SupplementCommissionCalculationError extends Error {
  constructor() {
    super('Incohérence financière du calcul de commission du supplément.');
    this.name = 'SupplementCommissionCalculationError';
  }
}

function assertSafeNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SupplementCommissionCalculationError();
  }
}

/**
 * Formule ADR-023 :
 * round_half_up(supplement * originalCommission / originalTotal).
 */
export function calculateSupplementCommission(
  supplementAmountMinor: number,
  totalOriginalMinor: number,
  commissionOriginalMinor: number,
): number {
  assertSafeNonNegativeInteger(supplementAmountMinor);
  assertSafeNonNegativeInteger(totalOriginalMinor);
  assertSafeNonNegativeInteger(commissionOriginalMinor);

  if (totalOriginalMinor === 0) {
    if (commissionOriginalMinor !== 0) {
      throw new SupplementCommissionCalculationError();
    }
    return 0;
  }

  const supplement = BigInt(supplementAmountMinor);
  const totalOriginal = BigInt(totalOriginalMinor);
  const commissionOriginal = BigInt(commissionOriginalMinor);
  const rounded = (supplement * commissionOriginal + totalOriginal / 2n) / totalOriginal;
  const bounded = rounded < 0n ? 0n : rounded > supplement ? supplement : rounded;

  if (bounded > MAX_SAFE_INTEGER_BIGINT) {
    throw new SupplementCommissionCalculationError();
  }
  return Number(bounded);
}
