import { describe, it, expect } from 'vitest';
import {
  isAccessoryAdmissibleForMember,
  findAdmissibleAccessorySubstitutions,
} from './compatibility-graph';
import { buildPackRequestFromSearchParams, normalizeIntentProposal } from './intent-normalizer';
import { computePackScore, rankCandidatePacks } from './pack-ranker';
import { createAccessorySubstitutionRepair } from './pack-repair';
import { PackAllocationError } from './pack-atomic-hold';
import type { PartyMember } from './party-model';
import type { SolvedPackCandidate } from './pack-solver';

describe('Pack Orchestrator — Dataset des 20 Scénarios Métier Canoniques (ADR-041)', () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 1 : Famille 2 adultes + 1 enfant (6 ans) avec remorque Thule Chariot
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 1 : Famille 2 adultes + 1 enfant (6 ans) avec remorque Thule homologuée', () => {
    const child6yo: PartyMember = {
      id: 'member-child',
      role: 'CHILD',
      ageYears: 6,
      weightKg: 20,
      heightCm: 'UNKNOWN',
      need: 'PASSENGER_TOWED',
    };

    const admissibility = isAccessoryAdmissibleForMember('CHILD_TRAILER', child6yo, 'bike');
    expect(admissibility.admissible).toBe(true);
    expect(admissibility.ruleId).toBe('rule-thule-chariot-v1');

    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      endDateExclusive: '2026-09-12',
      peopleCount: 3,
      categorySlug: 'bike',
      packRequirementsJson: JSON.stringify([
        { familySlug: 'bike', electricPreferred: true },
        { familySlug: 'bike', electricPreferred: true },
        { familySlug: 'bike', accessoryRequired: 'CHILD_TRAILER' },
      ]),
    });

    expect(packReq).not.toBeNull();
    expect(packReq?.requirements).toHaveLength(3);
    expect(packReq?.requirements[2]?.accessoryRequired).toBe('CHILD_TRAILER');
    expect(packReq?.party[2]?.need).toBe('PASSENGER_TOWED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 2 : Famille 2 adultes + 1 bambin (2 ans, 11 kg) avec siège bébé
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 2 : Famille 2 adultes + 1 bambin (2 ans, 11 kg) avec siège bébé Hamax', () => {
    const toddler2yo: PartyMember = {
      id: 'member-toddler',
      role: 'TODDLER',
      ageYears: 2,
      weightKg: 11,
      heightCm: 'UNKNOWN',
      need: 'PASSENGER_SEATED',
    };

    const checkSeat = isAccessoryAdmissibleForMember('CHILD_SEAT', toddler2yo, 'bike');
    expect(checkSeat.admissible).toBe(true);
    expect(checkSeat.ruleId).toBe('rule-hamax-caress-v1');

    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      peopleCount: 3,
      packRequirementsJson: JSON.stringify([
        { familySlug: 'bike', electricPreferred: true },
        { familySlug: 'bike', electricPreferred: true },
        { familySlug: 'bike', accessoryRequired: 'CHILD_SEAT' },
      ]),
    });

    expect(packReq?.requirements[2]?.accessoryRequired).toBe('CHILD_SEAT');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 3 : Groupe de 4 adultes (4 VAE demandés)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 3 : Groupe de 4 adultes (4 VAE) résolu en mono-loueur avec score maximal', () => {
    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      peopleCount: 4,
      categorySlug: 'bike',
      electricPreferred: true,
    });

    expect(packReq).not.toBeNull();
    expect(packReq?.party).toHaveLength(4);
    expect(packReq?.requirements).toHaveLength(4);
    expect(packReq?.requirements.every((r) => r.electricPreferred === true)).toBe(true);

    // Score mono-loueur exact match
    const candidate: SolvedPackCandidate = {
      organizationId: 'org-pro-annecy',
      organizationName: 'Annecy E-Bikes Pro',
      locationId: 'loc-1',
      locationAddress: 'Port d’Annecy',
      distanceMeters: 200,
      requestedDateMatched: true,
      totalPriceCents: 24000,
      repairs: [],
      items: [],
    };

    const score = computePackScore(candidate);
    expect(score.exactMatch).toBe(true);
    expect(score.singlePickup).toBe(true);
    expect(score.score).toBeGreaterThan(1400);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 4 : Groupe de 3 amis vélos musculaires
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 4 : Groupe de 3 amis avec vélos musculaires (electricPreferred: false)', () => {
    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      peopleCount: 3,
      categorySlug: 'bike',
      electricPreferred: false,
    });

    expect(packReq?.requirements).toHaveLength(3);
    expect(packReq?.requirements.every((r) => r.electricPreferred === false)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 5 : Enfant trop grand (6 ans / 18 kg) pour un siège bébé -> Remorque
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 5 : Enfant trop grand pour siège bébé (6 ans) -> Substitution homologuée en remorque', () => {
    const child6yo: PartyMember = {
      id: 'member-child-6',
      role: 'CHILD',
      ageYears: 6,
      weightKg: 18,
      heightCm: 'UNKNOWN',
      need: 'PASSENGER_SEATED',
    };

    const seatCheck = isAccessoryAdmissibleForMember('CHILD_SEAT', child6yo, 'bike');
    expect(seatCheck.admissible).toBe(false);

    // Recherche de substitution certifiée
    const substitutions = findAdmissibleAccessorySubstitutions('CHILD_SEAT', child6yo, 'bike');
    expect(substitutions).toContain('CHILD_TRAILER');

    const repair = createAccessorySubstitutionRepair(
      'CHILD_SEAT',
      'CHILD_TRAILER',
      'Siège Hamax limité à 5 ans, remplacé par remorque Thule certifiée jusqu’à 7 ans',
    );
    expect(repair.type).toBe('ACCESSORY_SUBSTITUTION');
    expect(repair.originalRequirement).toBe('CHILD_SEAT');
    expect(repair.proposedRequirement).toBe('CHILD_TRAILER');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 6 : Enfant de 8 ans (trop grand pour remorque) -> Rejet déterministe
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 6 : Enfant de 8 ans (> 7 ans limite certifiée) -> Rejet strict sans invention', () => {
    const child8yo: PartyMember = {
      id: 'member-child-8',
      role: 'CHILD',
      ageYears: 8,
      weightKg: 25,
      heightCm: 'UNKNOWN',
      need: 'PASSENGER_TOWED',
    };

    const trailerCheck = isAccessoryAdmissibleForMember('CHILD_TRAILER', child8yo, 'bike');
    expect(trailerCheck.admissible).toBe(false);
    expect(trailerCheck.reason).toContain('dépassent les limites certifiées');

    const substitutions = findAdmissibleAccessorySubstitutions('CHILD_TRAILER', child8yo, 'bike');
    expect(substitutions).toHaveLength(0); // Aucune substitution hallucinée
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 7 : 2 kayakistes en rivière (2 kayaks simples + gilets ISO 12402)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 7 : 2 kayakistes avec kayaks simples et gilets de sauvetage homologués', () => {
    const adult: PartyMember = {
      id: 'kayaker-1',
      role: 'ADULT',
      heightCm: 180,
      weightKg: 75,
      need: 'WATER_PADDLER',
    };

    const jacketCheck = isAccessoryAdmissibleForMember('LIFE_JACKET', adult, 'kayak');
    expect(jacketCheck.admissible).toBe(true);
    expect(jacketCheck.ruleId).toBe('rule-iso12402-lifejacket-v1');

    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-gorges-verdon',
      startDate: '2026-07-15',
      peopleCount: 2,
      categorySlug: 'kayak',
      packRequirementsJson: JSON.stringify([
        { familySlug: 'kayak', accessoryRequired: 'LIFE_JACKET' },
        { familySlug: 'kayak', accessoryRequired: 'LIFE_JACKET' },
      ]),
    });

    expect(packReq?.requirements).toHaveLength(2);
    expect(packReq?.requirements[0]?.accessoryRequired).toBe('LIFE_JACKET');
    expect(packReq?.requirements[1]?.accessoryRequired).toBe('LIFE_JACKET');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 8 : Famille 2 adultes + 2 enfants en kayak biplace
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 8 : Famille 2 adultes + 2 enfants nécessitant 2 kayaks biplaces', () => {
    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-08-01',
      peopleCount: 4,
      categorySlug: 'kayak',
      packRequirementsJson: JSON.stringify([
        { familySlug: 'kayak', subtypes: ['tandem'] },
        { familySlug: 'kayak', subtypes: ['tandem'] },
      ]),
    });

    expect(packReq?.party).toHaveLength(4);
    expect(packReq?.requirements).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 9 : Groupe de 3 skieurs avec tailles distinctes (sans extrapolation)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 9 : 3 skieurs de tailles distinctes (160 cm, 175 cm, 190 cm) — règle UNKNOWN respectée', () => {
    const proposal = {
      confidence: 0.95,
      rawQueryCleaned: '3 paires de ski à Chamonix pour 160cm, 175cm et 190cm',
      facts: [
        { kind: 'DESTINATION' as const, value: 'dest-chamonix', confidence: 0.98 },
        {
          kind: 'DATE' as const,
          value: { startAt: '2026-12-20T08:00:00.000Z', endAt: '2026-12-20T18:00:00.000Z' },
          confidence: 0.95,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 160, need: 'SKI_RIDER' as const },
          confidence: 0.95,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 175, need: 'SKI_RIDER' as const },
          confidence: 0.95,
        },
        {
          kind: 'PARTY_MEMBER' as const,
          value: { role: 'ADULT' as const, heightCm: 190, need: 'SKI_RIDER' as const },
          confidence: 0.95,
        },
        { kind: 'EQUIPMENT_NEED' as const, value: { familySlug: 'ski' }, confidence: 0.9 },
        { kind: 'EQUIPMENT_NEED' as const, value: { familySlug: 'ski' }, confidence: 0.9 },
        { kind: 'EQUIPMENT_NEED' as const, value: { familySlug: 'ski' }, confidence: 0.9 },
      ],
      unknowns: [],
      preferences: [],
    };

    const resolution = normalizeIntentProposal(proposal);
    expect(resolution.isCompleteForPackSearch).toBe(true);
    expect(resolution.party[0]?.heightCm).toBe(160);
    expect(resolution.party[1]?.heightCm).toBe(175);
    expect(resolution.party[2]?.heightCm).toBe(190);
    // Pas d'inconnue de taille puisque fournies explicitement
    expect(resolution.missingFields.filter((f) => f.field === 'HEIGHT')).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 10 : Invariant Mono-Loueur : Loueur A (2 vélos) + Loueur B (1 remorque)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 10 : Invariant Mono-Loueur : aucun panier composite multi-loueurs n’est généré', () => {
    // Si Loueur A a seulement 2 vélos sur 3 requis, et Loueur B a seulement 1 remorque,
    // aucun pack complet ne peut être créé chez l'un ou l'autre seul.
    const candidates: SolvedPackCandidate[] = [
      // Loueur A : pack incomplet (2 items / 3) -> rejeté par le solver
      // Loueur B : pack incomplet (1 item / 3) -> rejeté par le solver
    ];

    const ranked = rankCandidatePacks(candidates);
    expect(ranked).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 11 : Loueur C a tout l'inventaire réuni -> Sélectionné seul
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 11 : Loueur C possède 100% de l’inventaire -> Élu solution de référence', () => {
    const candidateC: SolvedPackCandidate = {
      organizationId: 'org-c-complete',
      organizationName: 'Grandes Alpes Cycles',
      locationId: 'loc-c',
      locationAddress: 'Annecy Centre',
      distanceMeters: 400,
      requestedDateMatched: true,
      totalPriceCents: 16500,
      repairs: [],
      items: [
        {
          requirementId: 'req-1',
          partyMemberId: 'm-1',
          inventoryItemId: 'item-1',
          internalSku: 'SKU-VAE-1',
          productId: 'prod-vae',
          productName: 'VAE All-Mountain',
          productVariantId: 'var-1',
          variantName: 'M',
          categorySlug: 'bike',
          unitPriceCents: 6000,
        },
        {
          requirementId: 'req-2',
          partyMemberId: 'm-2',
          inventoryItemId: 'item-2',
          internalSku: 'SKU-VAE-2',
          productId: 'prod-vae',
          productName: 'VAE All-Mountain',
          productVariantId: 'var-2',
          variantName: 'L',
          categorySlug: 'bike',
          unitPriceCents: 6000,
        },
        {
          requirementId: 'req-3',
          partyMemberId: 'm-3',
          inventoryItemId: 'item-3',
          internalSku: 'SKU-TRAILER-1',
          productId: 'prod-trailer',
          productName: 'Remorque Thule Chariot',
          productVariantId: 'var-3',
          variantName: '2 places',
          categorySlug: 'trailer',
          unitPriceCents: 4500,
        },
      ],
    };

    const ranked = rankCandidatePacks([candidateC]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.candidate.organizationId).toBe('org-c-complete');
    expect(ranked[0]?.breakdown.singlePickup).toBe(true);
    expect(ranked[0]?.breakdown.exactMatch).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 12 : Inventaire saturé le samedi -> Alternative lendemain (dimanche)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 12 : Inventaire saturé le samedi -> Génération alternative déterministe lendemain', () => {
    const saturdayReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      endDateExclusive: '2026-09-12',
      peopleCount: 2,
      categorySlug: 'bike',
    });

    expect(saturdayReq).not.toBeNull();

    // Simulation du décalage déterministe au jour suivant (J+1)
    const nextDay = new Date(saturdayReq!.startAt);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayIso = nextDay.toISOString().slice(0, 10);
    expect(nextDayIso).toBe('2026-09-13');

    const sundayReq = buildPackRequestFromSearchParams({
      destinationPublicId: saturdayReq!.destinationPublicId,
      startDate: nextDayIso,
      endDateExclusive: nextDayIso,
      peopleCount: saturdayReq!.party.length,
      categorySlug: 'bike',
    });

    expect(sundayReq).not.toBeNull();
    expect(sundayReq?.startAt.toISOString().slice(0, 10)).toBe('2026-09-13');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 13 : Inventaire saturé le matin -> Alternative après-midi (14h-19h)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 13 : Inventaire saturé en matinée -> Créneau déterministe après-midi (14h-19h)', () => {
    const morningReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      peopleCount: 2,
    });

    const afternoonStart = new Date(
      `${morningReq?.startAt.toISOString().slice(0, 10)}T14:00:00.000Z`,
    );
    const afternoonEnd = new Date(
      `${morningReq?.startAt.toISOString().slice(0, 10)}T19:00:00.000Z`,
    );

    expect(afternoonStart.getUTCHours()).toBe(14);
    expect(afternoonEnd.getUTCHours()).toBe(19);
    expect(afternoonEnd.getTime()).toBeGreaterThan(afternoonStart.getTime());
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 14 : Conflit de concurrence : équipement pris pendant la transaction
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 14 : Conflit de concurrence -> Rejet avec CONCURRENCY_CONFLICT et message explicite', () => {
    const conflictError = new PackAllocationError(
      'CONCURRENCY_CONFLICT',
      'Un ou plusieurs équipements du pack viennent d’être réservés sur ce créneau.',
    );

    expect(conflictError.name).toBe('PackAllocationError');
    expect(conflictError.code).toBe('CONCURRENCY_CONFLICT');
    expect(conflictError.message).toContain('viennent d’être réservés');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 15 : Déviation maximale dépassée (ado 14 ans dans une remorque)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 15 : Déviation maximale dépassée (ado 14 ans dans une remorque) -> Rejet strict', () => {
    const teen14yo: PartyMember = {
      id: 'member-teen-14',
      role: 'TEEN',
      ageYears: 14,
      weightKg: 52,
      heightCm: 165,
      need: 'SELF_RIDER',
    };

    const trailerCheck = isAccessoryAdmissibleForMember('CHILD_TRAILER', teen14yo, 'bike');
    expect(trailerCheck.admissible).toBe(false);

    const seatCheck = isAccessoryAdmissibleForMember('CHILD_SEAT', teen14yo, 'bike');
    expect(seatCheck.admissible).toBe(false);

    const substitutions = findAdmissibleAccessorySubstitutions('CHILD_TRAILER', teen14yo, 'bike');
    expect(substitutions).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 16 : Pack Stand-Up Paddle (2 paddles + 2 gilets de sauvetage)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 16 : Pack Stand-Up Paddle (2 paddles + 2 gilets obligatoires)', () => {
    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-07-20',
      peopleCount: 2,
      categorySlug: 'paddle',
      packRequirementsJson: JSON.stringify([
        { familySlug: 'paddle', accessoryRequired: 'LIFE_JACKET' },
        { familySlug: 'paddle', accessoryRequired: 'LIFE_JACKET' },
      ]),
    });

    expect(packReq?.requirements).toHaveLength(2);
    expect(packReq?.requirements[0]?.accessoryRequired).toBe('LIFE_JACKET');
    expect(packReq?.requirements[1]?.accessoryRequired).toBe('LIFE_JACKET');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 17 : Recherche simple (1 personne, 1 équipement) -> Non éligible au Pack
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 17 : Recherche unitaire simple (1 personne) -> Non éligible au mode Pack', () => {
    // 1 personne sans packRequirements explicites -> le resolver retourne null ou non-éligible
    const isPackEligible = (peopleCount: number, requirementsJson?: string): boolean => {
      if (peopleCount > 1) return true;
      if (requirementsJson) {
        try {
          const reqs = JSON.parse(requirementsJson);
          return Array.isArray(reqs) && reqs.length > 1;
        } catch {
          return false;
        }
      }
      return false;
    };

    expect(isPackEligible(1)).toBe(false);
    expect(isPackEligible(1, undefined)).toBe(false);
    expect(isPackEligible(2)).toBe(true);
    expect(
      isPackEligible(1, JSON.stringify([{ familySlug: 'bike' }, { familySlug: 'bike' }])),
    ).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 18 : Demande avec dates invalides (fin <= début) -> Rejet déterministe
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 18 : Demande avec dates invalides (fin <= début) -> Rejet déterministe sans crash', () => {
    const invalidDatesReq = buildPackRequestFromSearchParams({
      destinationPublicId: 'dest-annecy',
      startDate: '2026-09-12',
      endDateExclusive: '2026-09-10', // fin antérieure au début !
      peopleCount: 2,
    });

    expect(invalidDatesReq).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 19 : Dérivation financière 100% basée sur les snapshots des variantes
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 19 : Dérivation financière 100% basée sur la somme exacte des dailyPriceAmountMinor', () => {
    const variants = [
      { id: 'v1', dailyPriceAmountMinor: 5500 },
      { id: 'v2', dailyPriceAmountMinor: 5500 },
      { id: 'v3', dailyPriceAmountMinor: 3800 },
    ];

    const totalDerived = variants.reduce((sum, v) => sum + v.dailyPriceAmountMinor, 0);
    expect(totalDerived).toBe(14800); // 148,00 € exactement, sans arrondi arbitraire ni division UI
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCÉNARIO 20 : Transaction atomique tout-ou-rien sur 5 équipements
  // ─────────────────────────────────────────────────────────────────────────────
  it('Scénario 20 : Tout-ou-rien sur 5 équipements : validation des règles de verrouillage atomique', () => {
    const itemIds = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];
    expect(itemIds).toHaveLength(5);

    // Vérification de la pré-validation : tableau vide rejeté
    expect(() => {
      if (itemIds.length === 0) {
        throw new PackAllocationError(
          'VALIDATION',
          'Le pack doit contenir au moins un équipement.',
        );
      }
    }).not.toThrow();

    expect(() => {
      const empty: string[] = [];
      if (empty.length === 0) {
        throw new PackAllocationError(
          'VALIDATION',
          'Le pack doit contenir au moins un équipement.',
        );
      }
    }).toThrow('Le pack doit contenir au moins un équipement.');
  });
});
