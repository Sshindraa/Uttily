/**
 * Intent Normalizer — Traduction de la proposition d'intention IA vers le modèle canonique (@uttily/core).
 *
 * Conforme à l'ADR-041 (Principes 3.1 & 3.2) :
 * - L'IA (@uttily/intelligence) produit une proposition probabiliste (CompiledIntentProposal).
 * - Le modèle de groupe (PartyModel) et les exigences fonctionnelles (FunctionalRequirement)
 *   sont instanciés et validés souverainement par @uttily/core.
 * - Règle du UNKNOWN : Zéro supposition statistique (tailles adultes ou enfants non extrapolées).
 */

import type { PartyMember, FunctionalRequirement, PackRequest } from './party-model';

export interface ExtractedFactInput {
  readonly kind: 'DESTINATION' | 'DATE' | 'TIME' | 'PARTY_MEMBER' | 'EQUIPMENT_NEED';
  readonly value: unknown;
  readonly confidence: number;
}

export interface MissingFieldInput {
  readonly field: 'DESTINATION' | 'DATES' | 'HEIGHT' | 'AGE' | 'WEIGHT';
  readonly partyMemberIndex?: number;
  readonly promptReason: string;
}

export interface ProposedPreferenceInput {
  readonly key: string;
  readonly value: unknown;
  readonly confidence: number;
}

export interface CompiledIntentProposalInput {
  readonly facts: readonly ExtractedFactInput[];
  readonly unknowns: readonly MissingFieldInput[];
  readonly preferences: readonly ProposedPreferenceInput[];
  readonly confidence: number;
  readonly rawQueryCleaned: string;
  readonly explanationFr?: string;
  readonly explanationEn?: string;
}

export interface NormalizedIntentResolution {
  readonly destinationPublicId?: string;
  readonly startAt?: Date;
  readonly endAt?: Date;
  readonly party: readonly PartyMember[];
  readonly requirements: readonly FunctionalRequirement[];
  readonly missingFields: readonly MissingFieldInput[];
  readonly isCompleteForPackSearch: boolean;
  readonly packRequest?: PackRequest;
}

/**
 * Normalise une proposition d'intention compilée vers les entités canoniques de @uttily/core.
 */
export function normalizeIntentProposal(
  proposal: CompiledIntentProposalInput,
): NormalizedIntentResolution {
  let destinationPublicId: string | undefined;
  let startAt: Date | undefined;
  let endAt: Date | undefined;
  const party: PartyMember[] = [];
  const requirements: FunctionalRequirement[] = [];
  const missingFields: MissingFieldInput[] = [...proposal.unknowns];

  // 1. Extraction des faits certains ou confiants
  for (const fact of proposal.facts) {
    if (fact.kind === 'DESTINATION' && typeof fact.value === 'string' && fact.value) {
      destinationPublicId = fact.value;
    } else if (
      fact.kind === 'DATE' &&
      typeof fact.value === 'object' &&
      fact.value !== null &&
      'startAt' in fact.value &&
      'endAt' in fact.value
    ) {
      const datesObj = fact.value as { startAt?: string; endAt?: string };
      if (datesObj.startAt && datesObj.endAt) {
        startAt = new Date(datesObj.startAt);
        endAt = new Date(datesObj.endAt);
      }
    } else if (fact.kind === 'PARTY_MEMBER' && typeof fact.value === 'object' && fact.value !== null) {
      const val = fact.value as {
        role?: 'ADULT' | 'TEEN' | 'CHILD' | 'TODDLER';
        heightCm?: number | 'UNKNOWN';
        ageYears?: number | 'UNKNOWN';
        need?: 'SELF_RIDER' | 'PASSENGER_SEATED' | 'PASSENGER_TOWED' | 'WATER_PADDLER' | 'SKI_RIDER';
      };

      const memberIndex = party.length;
      const role = val.role || 'ADULT';
      const heightCm: number | 'UNKNOWN' =
        typeof val.heightCm === 'number' && val.heightCm > 0 ? val.heightCm : 'UNKNOWN';

      party.push({
        id: `party-member-${memberIndex + 1}`,
        role,
        heightCm,
        ageYears: val.ageYears ?? 'UNKNOWN',
        need:
          val.need ||
          (role === 'CHILD' || role === 'TODDLER' ? 'PASSENGER_SEATED' : 'SELF_RIDER'),
      });

      if (heightCm === 'UNKNOWN' && role === 'ADULT') {
        missingFields.push({
          field: 'HEIGHT',
          partyMemberIndex: memberIndex,
          promptReason: `Taille du participant ${memberIndex + 1} (${role}) non précisée.`,
        });
      }
    } else if (fact.kind === 'EQUIPMENT_NEED' && typeof fact.value === 'object' && fact.value !== null) {
      const val = fact.value as {
        familySlug?: string;
        electricPreferred?: boolean;
        subtypesAllowed?: string[];
        accessoryRequired?: 'CHILD_TRAILER' | 'CHILD_SEAT' | 'HELMET' | 'PADDLE' | 'LIFE_JACKET';
        partyMemberId?: string;
      };

      if (val.familySlug) {
        requirements.push({
          id: `req-${requirements.length + 1}`,
          partyMemberId: val.partyMemberId || `party-member-${Math.min(party.length, 1)}`,
          familySlug: val.familySlug,
          ...(val.electricPreferred !== undefined ? { electricPreferred: val.electricPreferred } : {}),
          ...(val.subtypesAllowed ? { subtypesAllowed: val.subtypesAllowed } : {}),
          ...(val.accessoryRequired ? { accessoryRequired: val.accessoryRequired } : {}),
        });
      }
    }
  }

  // Si aucun membre explicite n'a été extrait des faits, créer les membres par défaut
  if (party.length === 0) {
    party.push({
      id: 'party-member-1',
      role: 'ADULT',
      heightCm: 'UNKNOWN',
      need: 'SELF_RIDER',
    });
    missingFields.push({
      field: 'HEIGHT',
      partyMemberIndex: 0,
      promptReason: 'Taille du conducteur principal non précisée.',
    });
  }

  // Vérifier la présence des éléments obligatoires pour un PackRequest
  if (!destinationPublicId) {
    missingFields.push({
      field: 'DESTINATION',
      promptReason: 'Destination non identifiée dans la demande.',
    });
  }

  if (!startAt || !endAt) {
    missingFields.push({
      field: 'DATES',
      promptReason: 'Dates de réservation non identifiées.',
    });
  }

  const isCompleteForPackSearch =
    Boolean(destinationPublicId) &&
    Boolean(startAt) &&
    Boolean(endAt) &&
    party.length > 0 &&
    requirements.length > 0;

  const packRequest: PackRequest | undefined =
    isCompleteForPackSearch && destinationPublicId && startAt && endAt
      ? {
          destinationPublicId,
          startAt,
          endAt,
          party,
          requirements,
        }
      : undefined;

  return {
    ...(destinationPublicId ? { destinationPublicId } : {}),
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    party,
    requirements,
    missingFields,
    isCompleteForPackSearch,
    ...(packRequest ? { packRequest } : {}),
  };
}

export interface RawPackRequirementInput {
  readonly familySlug?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly electricPreferred?: boolean | undefined;
  readonly subtypes?: readonly string[] | undefined;
  readonly accessoryRequired?:
    | 'CHILD_TRAILER'
    | 'CHILD_SEAT'
    | 'HELMET'
    | 'PADDLE'
    | 'LIFE_JACKET'
    | undefined;
}

export interface PublicSearchPackParamsInput {
  readonly destinationPublicId: string;
  readonly startDate: string;
  readonly endDateExclusive?: string | undefined;
  readonly peopleCount: number;
  readonly categoryId?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly electricPreferred?: boolean | undefined;
  readonly packRequirementsJson?: string | undefined;
}

/**
 * Construit un PackRequest canonique à partir des critères de recherche publique HTTP (ADR-041).
 */
export function buildPackRequestFromSearchParams(
  input: PublicSearchPackParamsInput,
): PackRequest | null {
  if (!input.destinationPublicId || !input.startDate || input.peopleCount < 1) {
    return null;
  }

  const startAt = new Date(`${input.startDate}T08:00:00.000Z`);
  const endDate = input.endDateExclusive || input.startDate;
  const endAt = new Date(`${endDate}T19:00:00.000Z`);

  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    return null;
  }

  const party: PartyMember[] = [];
  const requirements: FunctionalRequirement[] = [];

  let explicitRequirements: RawPackRequirementInput[] | null = null;
  if (input.packRequirementsJson) {
    try {
      const parsed = JSON.parse(input.packRequirementsJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        explicitRequirements = parsed;
      }
    } catch {
      // Ignorer l'erreur de parsing et continuer avec le fallback
    }
  }

  if (explicitRequirements && explicitRequirements.length > 0) {
    for (let i = 0; i < explicitRequirements.length; i++) {
      const item = explicitRequirements[i]!;
      const memberId = `member-${i + 1}`;
      const isTrailer = item.accessoryRequired === 'CHILD_TRAILER';
      const isSeat = item.accessoryRequired === 'CHILD_SEAT';
      const role = isTrailer || isSeat ? 'CHILD' : 'ADULT';
      const need = isTrailer ? 'PASSENGER_TOWED' : isSeat ? 'PASSENGER_SEATED' : 'SELF_RIDER';

      party.push({
        id: memberId,
        role,
        heightCm: 'UNKNOWN',
        need,
      });

      requirements.push({
        id: `req-${i + 1}`,
        partyMemberId: memberId,
        familySlug: item.familySlug || item.categorySlug || input.categorySlug || 'bike',
        ...(item.electricPreferred !== undefined ? { electricPreferred: item.electricPreferred } : {}),
        ...(item.subtypes?.length ? { subtypesAllowed: item.subtypes } : {}),
        ...(item.accessoryRequired ? { accessoryRequired: item.accessoryRequired } : {}),
      });
    }

    // Si peopleCount est supérieur au nombre d'équipements requis (ex: 4 personnes pour 2 kayaks biplaces)
    for (let i = explicitRequirements.length; i < input.peopleCount; i++) {
      party.push({
        id: `member-${i + 1}`,
        role: 'ADULT',
        heightCm: 'UNKNOWN',
        need: 'SELF_RIDER',
      });
    }
  } else {
    const familySlug = input.categorySlug || 'bike';

    for (let i = 0; i < input.peopleCount; i++) {
      const memberId = `member-${i + 1}`;
      party.push({
        id: memberId,
        role: 'ADULT',
        heightCm: 'UNKNOWN',
        need: 'SELF_RIDER',
      });

      requirements.push({
        id: `req-${i + 1}`,
        partyMemberId: memberId,
        familySlug,
        ...(input.electricPreferred !== undefined
          ? { electricPreferred: input.electricPreferred }
          : {}),
      });
    }
  }

  return {
    destinationPublicId: input.destinationPublicId,
    startAt,
    endAt,
    party,
    requirements,
  };
}
