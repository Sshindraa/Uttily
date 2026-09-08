/**
 * Modèle canonique de groupe et besoins fonctionnels d'Uttily (ADR-041).
 *
 * Ce modèle appartient souverainement à @uttily/core.
 * Il peut être alimenté indifféremment par du langage naturel (via @uttily/intelligence),
 * par des formulaires UI, des conciergeries ou des intégrations partenaires.
 */

export type PartyMemberRole = 'ADULT' | 'TEEN' | 'CHILD' | 'TODDLER';

export type PartyMemberNeed =
  'SELF_RIDER' | 'PASSENGER_SEATED' | 'PASSENGER_TOWED' | 'WATER_PADDLER' | 'SKI_RIDER';

export interface PartyMember {
  readonly id: string;
  readonly role: PartyMemberRole;
  readonly heightCm: number | 'UNKNOWN';
  readonly weightKg?: number | 'UNKNOWN';
  readonly ageYears?: number | 'UNKNOWN';
  readonly need: PartyMemberNeed;
}

export type RequiredAccessoryType =
  'CHILD_TRAILER' | 'CHILD_SEAT' | 'HELMET' | 'PADDLE' | 'LIFE_JACKET';

export interface FunctionalRequirement {
  readonly id: string;
  readonly partyMemberId: string;
  readonly familySlug: string;
  readonly electricPreferred?: boolean;
  readonly subtypesAllowed?: readonly string[];
  readonly accessoryRequired?: RequiredAccessoryType;
}

export interface PackRequest {
  readonly destinationPublicId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly party: readonly PartyMember[];
  readonly requirements: readonly FunctionalRequirement[];
  readonly maxPickupDistanceMeters?: number;
}
