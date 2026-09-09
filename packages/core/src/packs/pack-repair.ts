/**
 * Moteur de relaxation et réparation explicite de pack (ADR-041).
 *
 * Lorsque le pack parfait n'est pas disponible chez un seul loueur,
 * le moteur explore des relaxations en cascade et quantifie la déviation
 * par rapport à l'intention originale.
 *
 * Règle d'or : Jamais de modification silencieuse de la demande.
 */

export type PackRepairType =
  | 'ACCESSORY_SUBSTITUTION'
  | 'EQUIPMENT_SUBSTITUTION'
  | 'TIME_SHIFT'
  | 'DATE_SHIFT'
  | 'RADIUS_EXPANSION';

export interface PackRepair {
  readonly type: PackRepairType;
  readonly originalRequirement: string;
  readonly proposedRequirement: string;
  readonly reason: string;
  readonly deviationScore: number;
  readonly explanationFr: string;
  readonly explanationEn: string;
}

export const DEVIATION_SCORES: Record<PackRepairType, number> = {
  ACCESSORY_SUBSTITUTION: 10,
  EQUIPMENT_SUBSTITUTION: 20,
  TIME_SHIFT: 25,
  DATE_SHIFT: 50,
  RADIUS_EXPANSION: 60,
};

export function createAccessorySubstitutionRepair(
  originalAccessory: string,
  proposedAccessory: string,
  reason: string,
): PackRepair {
  return {
    type: 'ACCESSORY_SUBSTITUTION',
    originalRequirement: originalAccessory,
    proposedRequirement: proposedAccessory,
    reason,
    deviationScore: DEVIATION_SCORES.ACCESSORY_SUBSTITUTION,
    explanationFr: `Remplacement de l'accessoire : ${proposedAccessory} proposé à la place de ${originalAccessory}.`,
    explanationEn: `Accessory replacement: ${proposedAccessory} offered instead of ${originalAccessory}.`,
  };
}

export function createDateShiftRepair(originalDate: string, proposedDate: string): PackRepair {
  return {
    type: 'DATE_SHIFT',
    originalRequirement: originalDate,
    proposedRequirement: proposedDate,
    reason: `Matériel saturé le ${originalDate}, disponible en totalité le ${proposedDate}.`,
    deviationScore: DEVIATION_SCORES.DATE_SHIFT,
    explanationFr: `Date alternative : Pack disponible le ${proposedDate} (au lieu du ${originalDate}).`,
    explanationEn: `Alternative date: Pack available on ${proposedDate} (instead of ${originalDate}).`,
  };
}
