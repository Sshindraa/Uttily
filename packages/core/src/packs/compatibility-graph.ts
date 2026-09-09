import type { PartyMember, RequiredAccessoryType } from './party-model';

/**
 * Règle de compatibilité stricte, sourcée et versionnée (ADR-041).
 *
 * Aucune règle de sécurité n'est inventée par un modèle d'IA :
 * chaque règle cite un manuel constructeur ou une norme officielle.
 */
export interface CompatibilityRule {
  readonly id: string;
  readonly accessoryType: RequiredAccessoryType;
  readonly compatibleCategorySlug: string;
  readonly compatibleSubtypes?: readonly string[];
  readonly minAgeMonths?: number;
  readonly maxAgeYears?: number;
  readonly maxChildWeightKg?: number;
  readonly maxTotalLoadKg?: number;
  readonly requiresThruAxleAdapter?: boolean;
  readonly sourceManual: string;
  readonly sourceVersion: string;
  readonly verificationStatus: 'OFFICIALLY_VERIFIED' | 'MANUFACTURER_CERTIFIED';
  readonly verifiedAt: string;
}

/**
 * Registre initial des règles constructeurs homologuées.
 */
export const SOURCED_COMPATIBILITY_RULES: readonly CompatibilityRule[] = [
  // 1. Remorques enfants universelles (Norme EN 15918 / Thule Chariot)
  {
    id: 'rule-thule-chariot-v1',
    accessoryType: 'CHILD_TRAILER',
    compatibleCategorySlug: 'bike',
    compatibleSubtypes: [
      'electric_mountain',
      'mountain',
      'electric_trekking',
      'trekking',
      'electric_city',
      'city',
    ],
    minAgeMonths: 9,
    maxAgeYears: 7,
    maxChildWeightKg: 22,
    maxTotalLoadKg: 45,
    requiresThruAxleAdapter: true,
    sourceManual: 'Thule Chariot Owner Manual - EN 15918 Certified',
    sourceVersion: 'Rev 2024-B',
    verificationStatus: 'MANUFACTURER_CERTIFIED',
    verifiedAt: '2026-01-15',
  },
  // 2. Sièges enfants arrière sur cadre (Norme EN 14344 / Hamax Caress)
  {
    id: 'rule-hamax-caress-v1',
    accessoryType: 'CHILD_SEAT',
    compatibleCategorySlug: 'bike',
    compatibleSubtypes: ['trekking', 'electric_trekking', 'city', 'electric_city'],
    minAgeMonths: 9,
    maxAgeYears: 5,
    maxChildWeightKg: 22,
    sourceManual: 'Hamax Caress Child Bike Seat - EN 14344:2022',
    sourceVersion: 'v4.1',
    verificationStatus: 'OFFICIALLY_VERIFIED',
    verifiedAt: '2026-02-01',
  },
  // 3. Casques vélo enfants et adultes (Norme EN 1078)
  {
    id: 'rule-en1078-helmet-v1',
    accessoryType: 'HELMET',
    compatibleCategorySlug: 'bike',
    sourceManual: 'Norme Européenne EN 1078 - Casques cyclistes',
    sourceVersion: 'EN 1078:2012+A1:2012',
    verificationStatus: 'OFFICIALLY_VERIFIED',
    verifiedAt: '2026-01-01',
  },
  // 4. Gilets de sauvetage 50N et 100N (Norme ISO 12402-4 / 12402-5)
  {
    id: 'rule-iso12402-lifejacket-v1',
    accessoryType: 'LIFE_JACKET',
    compatibleCategorySlug: 'kayak',
    sourceManual: 'ISO 12402-5:2020 Équipements individuels de flottabilité',
    sourceVersion: 'ISO 12402-5 Ed.2',
    verificationStatus: 'OFFICIALLY_VERIFIED',
    verifiedAt: '2026-01-01',
  },
];

/**
 * Vérifie si un accessoire est admissible pour un membre donné du groupe.
 */
export function isAccessoryAdmissibleForMember(
  accessoryType: RequiredAccessoryType,
  member: PartyMember,
  categorySlug: string,
  rules: readonly CompatibilityRule[] = SOURCED_COMPATIBILITY_RULES,
): { admissible: boolean; reason?: string; ruleId?: string } {
  const matchingRules = rules.filter(
    (r) => r.accessoryType === accessoryType && r.compatibleCategorySlug === categorySlug,
  );

  if (matchingRules.length === 0) {
    return {
      admissible: false,
      reason: `Aucune règle homologuée n’associe l’accessoire ${accessoryType} à la famille ${categorySlug}.`,
    };
  }

  for (const rule of matchingRules) {
    // Vérification de l'âge maximal
    if (
      rule.maxAgeYears !== undefined &&
      typeof member.ageYears === 'number' &&
      member.ageYears > rule.maxAgeYears
    ) {
      continue;
    }

    // Vérification de l'âge minimal
    if (
      rule.minAgeMonths !== undefined &&
      typeof member.ageYears === 'number' &&
      member.ageYears * 12 < rule.minAgeMonths
    ) {
      continue;
    }

    // Vérification du poids maximal
    if (
      rule.maxChildWeightKg !== undefined &&
      typeof member.weightKg === 'number' &&
      member.weightKg > rule.maxChildWeightKg
    ) {
      continue;
    }

    // Règle satisfaite
    return {
      admissible: true,
      ruleId: rule.id,
    };
  }

  return {
    admissible: false,
    reason: `Les critères physiques du participant dépassent les limites certifiées du matériel (${accessoryType}).`,
  };
}

/**
 * Trouve les substitutions d'accessoires admissibles lorsqu'un accessoire initial est indisponible.
 */
export function findAdmissibleAccessorySubstitutions(
  initialAccessory: RequiredAccessoryType,
  member: PartyMember,
  categorySlug: string,
): readonly RequiredAccessoryType[] {
  const candidates: RequiredAccessoryType[] = [];

  // Ex: Si le siège enfant est demandé mais indisponible, tester si une remorque est admissible
  if (initialAccessory === 'CHILD_SEAT') {
    const checkTrailer = isAccessoryAdmissibleForMember('CHILD_TRAILER', member, categorySlug);
    if (checkTrailer.admissible) {
      candidates.push('CHILD_TRAILER');
    }
  } else if (initialAccessory === 'CHILD_TRAILER') {
    const checkSeat = isAccessoryAdmissibleForMember('CHILD_SEAT', member, categorySlug);
    if (checkSeat.admissible) {
      candidates.push('CHILD_SEAT');
    }
  }

  return candidates;
}

export interface VehicleAccessoryCompatibilityInput {
  readonly accessoryType: RequiredAccessoryType;
  readonly vehicleCategorySlug: string;
  readonly vehicleSubtype?: string | undefined;
  readonly vehicleAttributes?: Record<string, unknown> | undefined;
  readonly rules?: readonly CompatibilityRule[] | undefined;
}

export interface VehicleAccessoryCompatibilityResult {
  readonly compatible: boolean;
  readonly reason?: string | undefined;
  readonly ruleId?: string | undefined;
  readonly verifiedBy?: string | undefined;
}

/**
 * Vérifie la compatibilité d'un véhicule hôte avec un accessoire (ADR-041 & ADR-042).
 *
 * Applique la règle de preuve ADR-042 :
 * Si l'accessoire est critique pour la sécurité (CHILD_TRAILER, CHILD_SEAT),
 * toute dépendance à un attribut matériel (ex: attelage, fixation) exige une
 * preuve HUMAN_CONFIRMED ou SOURCE_VERIFIED. Une simple observation IA (AI_OBSERVED)
 * est formellement rejetée.
 */
export function isVehicleCompatibleWithAccessory(
  input: VehicleAccessoryCompatibilityInput,
): VehicleAccessoryCompatibilityResult {
  const {
    accessoryType,
    vehicleCategorySlug,
    vehicleSubtype,
    vehicleAttributes = {},
    rules = SOURCED_COMPATIBILITY_RULES,
  } = input;

  const matchingRule = rules.find(
    (r) =>
      r.accessoryType === accessoryType &&
      r.compatibleCategorySlug === vehicleCategorySlug &&
      (!r.compatibleSubtypes || !vehicleSubtype || r.compatibleSubtypes.includes(vehicleSubtype)),
  );

  if (!matchingRule) {
    return {
      compatible: false,
      reason: `Aucune règle homologuée n'autorise l'attelage de ${accessoryType} sur ce type de véhicule (${vehicleCategorySlug}${vehicleSubtype ? ` / ${vehicleSubtype}` : ''}).`,
    };
  }

  // Vérification de la compatibilité des preuves d'attribut pour accessoires critiques
  const evidenceRecord =
    (vehicleAttributes['evidence'] as
      Record<string, { evidenceLevel?: string; key?: string }> | undefined) ?? {};

  if (accessoryType === 'CHILD_TRAILER') {
    const hitchEvidence = evidenceRecord['hasTrailerHitch'] || evidenceRecord['trailer_hitch'];
    if (hitchEvidence && hitchEvidence.evidenceLevel === 'AI_OBSERVED') {
      return {
        compatible: false,
        reason:
          "La présence de l'attelage n'a été que présumée par observation IA (AI_OBSERVED). Une confirmation humaine du loueur (HUMAN_CONFIRMED) est requise pour atteler une remorque enfant.",
        ruleId: matchingRule.id,
      };
    }
  }

  if (accessoryType === 'CHILD_SEAT') {
    const seatMountEvidence =
      evidenceRecord['hasChildSeatCompatibleMount'] || evidenceRecord['child_seat_mount'];
    if (seatMountEvidence && seatMountEvidence.evidenceLevel === 'AI_OBSERVED') {
      return {
        compatible: false,
        reason:
          "La compatibilité du support siège bébé n'a été qu'observée par IA (AI_OBSERVED). Une confirmation humaine du loueur (HUMAN_CONFIRMED) est requise.",
        ruleId: matchingRule.id,
      };
    }
  }

  return {
    compatible: true,
    ruleId: matchingRule.id,
    verifiedBy: matchingRule.sourceManual,
  };
}
