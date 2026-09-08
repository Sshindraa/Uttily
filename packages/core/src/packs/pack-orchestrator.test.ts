import { describe, it, expect } from 'vitest';
import {
  isAccessoryAdmissibleForMember,
  findAdmissibleAccessorySubstitutions,
} from './compatibility-graph';
import { computePackScore, rankCandidatePacks } from './pack-ranker';
import { createAccessorySubstitutionRepair } from './pack-repair';
import type { PartyMember } from './party-model';

describe('CompatibilityGraph (ADR-041)', () => {
  const child4yo: PartyMember = {
    id: 'm-1',
    role: 'CHILD',
    ageYears: 4,
    heightCm: 'UNKNOWN',
    weightKg: 16,
    need: 'PASSENGER_TOWED',
  };

  const child6yo: PartyMember = {
    id: 'm-2',
    role: 'CHILD',
    ageYears: 6,
    heightCm: 'UNKNOWN',
    weightKg: 20,
    need: 'PASSENGER_TOWED',
  };

  const teen9yo: PartyMember = {
    id: 'm-3',
    role: 'TEEN',
    ageYears: 9,
    heightCm: 'UNKNOWN',
    need: 'SELF_RIDER',
  };

  it('homologue la remorque enfant Thule pour un enfant de 4 ans et 6 ans (< 7 ans)', () => {
    const check4yo = isAccessoryAdmissibleForMember('CHILD_TRAILER', child4yo, 'bike');
    expect(check4yo.admissible).toBe(true);
    expect(check4yo.ruleId).toBe('rule-thule-chariot-v1');

    const check6yo = isAccessoryAdmissibleForMember('CHILD_TRAILER', child6yo, 'bike');
    expect(check6yo.admissible).toBe(true);
  });

  it('rejette la remorque enfant pour un jeune de 9 ans (> 7 ans certifié)', () => {
    const check9yo = isAccessoryAdmissibleForMember('CHILD_TRAILER', teen9yo, 'bike');
    expect(check9yo.admissible).toBe(false);
    expect(check9yo.reason).toContain('dépassent les limites');
  });

  it('rejette le siège bébé pour un enfant de 6 ans (> 5 ans homologué Hamax)', () => {
    const checkSeat = isAccessoryAdmissibleForMember('CHILD_SEAT', child6yo, 'bike');
    expect(checkSeat.admissible).toBe(false);
  });

  it('trouve la remorque comme substitution admissible si le siège bébé est demandé pour un enfant de 4 ans', () => {
    const subs = findAdmissibleAccessorySubstitutions('CHILD_SEAT', child4yo, 'bike');
    expect(subs).toContain('CHILD_TRAILER');
  });
});

describe('PackRanker (ADR-041)', () => {
  it('calcule un score auditable favorisant la correspondance exacte et le retrait unique', () => {
    const exactCandidate = {
      organizationId: 'org-1',
      organizationName: 'Alpes Vélo',
      locationId: 'loc-1',
      locationAddress: '15 rue du lac, Annecy',
      distanceMeters: 200,
      requestedDateMatched: true,
      totalPriceCents: 12000,
      repairs: [],
    };

    const breakdown = computePackScore(exactCandidate);
    expect(breakdown.exactMatch).toBe(true);
    expect(breakdown.singlePickup).toBe(true);
    expect(breakdown.score).toBeGreaterThan(1400); // 1000 + 300 + 200 - 20
    expect(breakdown.reasonsFr).toContain('Correspondance exacte avec votre demande');
  });

  it('classe une solution exacte devant une solution avec substitution d’accessoire', () => {
    const exact = {
      organizationId: 'org-1',
      organizationName: 'Annecy Bikes',
      locationId: 'loc-1',
      locationAddress: '10 rue du port',
      distanceMeters: 500,
      requestedDateMatched: true,
      totalPriceCents: 13000,
      repairs: [],
    };

    const withRepair = {
      organizationId: 'org-2',
      organizationName: 'Lac Aventure',
      locationId: 'loc-2',
      locationAddress: '5 rue neuve',
      distanceMeters: 100,
      requestedDateMatched: true,
      totalPriceCents: 12500,
      repairs: [
        createAccessorySubstitutionRepair(
          'CHILD_SEAT',
          'CHILD_TRAILER',
          'Siège indisponible, remorque Thule certifiée disponible',
        ),
      ],
    };

    const ranked = rankCandidatePacks([withRepair, exact]);
    expect(ranked[0]?.candidate.organizationId).toBe('org-1'); // Exact match l'emporte
    expect(ranked[1]?.breakdown.exactMatch).toBe(false);
    expect(ranked[1]?.breakdown.repairs).toHaveLength(1);
  });
});

describe('IntentNormalizer (ADR-041)', () => {
  it('traduit une proposition IA en PartyModel et FunctionalRequirement sans extrapolation de taille', async () => {
    const { normalizeIntentProposal } = await import('./intent-normalizer');

    const proposal = {
      confidence: 0.95,
      rawQueryCleaned: '2 adultes et 1 enfant de 6 ans, vélos électriques Annecy samedi',
      facts: [
        { kind: 'DESTINATION' as const, value: 'dest-annecy', confidence: 0.98 },
        {
          kind: 'DATE' as const,
          value: { startAt: '2026-09-12T09:00:00.000Z', endAt: '2026-09-12T18:00:00.000Z' },
          confidence: 0.95,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 'UNKNOWN' as const, need: 'SELF_RIDER' as const },
          confidence: 0.9,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 'UNKNOWN' as const, need: 'SELF_RIDER' as const },
          confidence: 0.9,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'CHILD' as const, ageYears: 6, heightCm: 'UNKNOWN' as const, need: 'PASSENGER_TOWED' as const },
          confidence: 0.9,
        },
        {
          kind: 'EQUIPMENT_NEED' as const,
          value: { familySlug: 'bike', electricPreferred: true, partyMemberId: 'party-member-1' },
          confidence: 0.9,
        },
        {
          kind: 'EQUIPMENT_NEED' as const,
          value: { familySlug: 'bike', electricPreferred: true, partyMemberId: 'party-member-2' },
          confidence: 0.9,
        },
        {
          kind: 'EQUIPMENT_NEED' as const,
          value: { familySlug: 'bike', accessoryRequired: 'CHILD_TRAILER' as const, partyMemberId: 'party-member-3' },
          confidence: 0.9,
        },
      ],
      unknowns: [],
      preferences: [{ key: 'ELECTRIC', value: true, confidence: 0.9 }],
    };

    const resolution = normalizeIntentProposal(proposal);

    expect(resolution.isCompleteForPackSearch).toBe(true);
    expect(resolution.destinationPublicId).toBe('dest-annecy');
    expect(resolution.party).toHaveLength(3);
    expect(resolution.requirements).toHaveLength(3);

    // Règle du UNKNOWN : aucune extrapolation statistique de taille
    expect(resolution.party[0]?.heightCm).toBe('UNKNOWN');
    expect(resolution.party[1]?.heightCm).toBe('UNKNOWN');
    expect(resolution.party[2]?.role).toBe('CHILD');

    // Les inconnues de taille sont signalées pour l'UI visuelle
    const heightUnknowns = resolution.missingFields.filter((f) => f.field === 'HEIGHT');
    expect(heightUnknowns.length).toBeGreaterThanOrEqual(2);

    expect(resolution.packRequest).toBeDefined();
    expect(resolution.packRequest?.destinationPublicId).toBe('dest-annecy');
  });

  it('détecte les éléments manquants bloquants (destination absente)', async () => {
    const { normalizeIntentProposal } = await import('./intent-normalizer');

    const incompleteProposal = {
      confidence: 0.7,
      rawQueryCleaned: '2 adultes vélos électriques',
      facts: [
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 'UNKNOWN' as const, need: 'SELF_RIDER' as const },
          confidence: 0.9,
        },
      ],
      unknowns: [],
      preferences: [],
    };

    const resolution = normalizeIntentProposal(incompleteProposal);
    expect(resolution.isCompleteForPackSearch).toBe(false);
    expect(resolution.packRequest).toBeUndefined();
    expect(resolution.missingFields.some((f) => f.field === 'DESTINATION')).toBe(true);
    expect(resolution.missingFields.some((f) => f.field === 'DATES')).toBe(true);
  });
});

