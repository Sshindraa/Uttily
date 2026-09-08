import type { EvidenceLevel, EquipmentAttributeEvidence } from '@uttily/contracts';
import type { RequiredAccessoryType } from './party-model';

/**
 * Hiérarchie ordonnée des niveaux de preuve d'attribut matériel (ADR-042).
 *
 * AI_OBSERVED (1) < HUMAN_CONFIRMED (2) < SOURCE_VERIFIED (3).
 */
export const EVIDENCE_LEVEL_RANKS: Record<EvidenceLevel, number> = {
  AI_OBSERVED: 1,
  HUMAN_CONFIRMED: 2,
  SOURCE_VERIFIED: 3,
};

/**
 * Accessoires critiques pour la sécurité physique des personnes (ADR-042).
 * Ces équipements engagent la responsabilité légale et le transport d'enfants.
 */
export const SAFETY_CRITICAL_ACCESSORIES: readonly RequiredAccessoryType[] = [
  'CHILD_TRAILER',
  'CHILD_SEAT',
] as const;

/**
 * Détermine si un accessoire relève des équipements critiques de sécurité.
 */
export function isSafetyCriticalAccessory(accessoryType: RequiredAccessoryType): boolean {
  return (SAFETY_CRITICAL_ACCESSORIES as readonly string[]).includes(accessoryType);
}

/**
 * Vérifie si le niveau de preuve atteint ou dépasse le seuil requis.
 */
export function hasSufficientEvidence(
  currentLevel: EvidenceLevel | undefined,
  requiredLevel: EvidenceLevel,
): boolean {
  if (!currentLevel) return false;
  return EVIDENCE_LEVEL_RANKS[currentLevel] >= EVIDENCE_LEVEL_RANKS[requiredLevel];
}

export interface ValidateSafetyAttributeCompatibilityInput {
  readonly accessoryType: RequiredAccessoryType;
  readonly attributeKey: string;
  readonly attributeEvidence?: EquipmentAttributeEvidence | undefined;
  readonly isManufacturerCertified?: boolean | undefined;
}

export interface SafetyCompatibilityVerdict {
  readonly isCompatible: boolean;
  readonly reason?: string | undefined;
  readonly effectiveEvidenceLevel: EvidenceLevel;
}

/**
 * Vérifie formellement la conformité de preuve d'un équipement porteur (ADR-042).
 *
 * Règle d'or :
 * Une relation safety-critical (remorque enfant, siège bébé) ne peut JAMAIS
 * être validée sur la foi d'une simple inférence d'IA (AI_OBSERVED).
 * Elle exige soit une certification constructeur (SOURCE_VERIFIED),
 * soit a minima une confirmation humaine formelle (HUMAN_CONFIRMED).
 */
export function validateSafetyAttributeCompatibility(
  input: ValidateSafetyAttributeCompatibilityInput,
): SafetyCompatibilityVerdict {
  const { accessoryType, attributeKey, attributeEvidence, isManufacturerCertified } = input;

  // Si le modèle de vélo est officiellement certifié pour cet usage
  if (isManufacturerCertified) {
    return {
      isCompatible: true,
      effectiveEvidenceLevel: 'SOURCE_VERIFIED',
    };
  }

  const isSafetyCritical = isSafetyCriticalAccessory(accessoryType);
  const currentLevel = attributeEvidence?.evidenceLevel;

  // Si non safety-critical, une observation IA est tolérable avec niveau AI_OBSERVED
  if (!isSafetyCritical) {
    return {
      isCompatible: true,
      effectiveEvidenceLevel: currentLevel || 'AI_OBSERVED',
    };
  }

  // Pour les accessoires safety-critical (enfants) : HUMAN_CONFIRMED ou SOURCE_VERIFIED obligatoire
  if (!currentLevel || currentLevel === 'AI_OBSERVED') {
    return {
      isCompatible: false,
      reason: `L'attribut « ${attributeKey} » n'a été qu'observé par vision IA (AI_OBSERVED). Les règles de sécurité Uttily exigent une confirmation humaine formelle (HUMAN_CONFIRMED) ou une certification constructeur (SOURCE_VERIFIED) pour le transport d'enfants (${accessoryType}).`,
      effectiveEvidenceLevel: currentLevel || 'AI_OBSERVED',
    };
  }

  return {
    isCompatible: true,
    effectiveEvidenceLevel: currentLevel,
  };
}
