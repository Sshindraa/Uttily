import { describe, it, expect, vi } from 'vitest';
import { solvePackAlternatives } from './pack-alternatives-solver';
import type { PackRequest } from './party-model';
import type { RankedPackCandidate } from './pack-ranker';
import type { SolvedPackCandidate } from './pack-solver';
import * as packSolverModule from './pack-solver';

describe('Pack Alternatives Solver (ADR-041)', () => {
  const adultOnlyRequest: PackRequest = {
    destinationPublicId: 'dest-annecy',
    startAt: new Date('2026-09-12T09:00:00.000Z'),
    endAt: new Date('2026-09-12T18:00:00.000Z'),
    party: [
      { id: 'm-1', role: 'ADULT', heightCm: 'UNKNOWN', need: 'SELF_RIDER' },
      { id: 'm-2', role: 'ADULT', heightCm: 'UNKNOWN', need: 'SELF_RIDER' },
      { id: 'm-3', role: 'ADULT', heightCm: 'UNKNOWN', need: 'SELF_RIDER' },
    ],
    requirements: [
      { id: 'req-1', partyMemberId: 'm-1', familySlug: 'bike', electricPreferred: true },
      { id: 'req-2', partyMemberId: 'm-2', familySlug: 'bike', electricPreferred: true },
      { id: 'req-3', partyMemberId: 'm-3', familySlug: 'bike', electricPreferred: true },
    ],
  };

  const mockCandidate = (orgName: string): RankedPackCandidate<SolvedPackCandidate> => ({
    candidate: {
      organizationId: 'org-1',
      organizationName: orgName,
      locationId: 'loc-1',
      locationAddress: 'Annecy · 200m lac',
      distanceMeters: 200,
      requestedDateMatched: true,
      totalPriceCents: 12000,
      repairs: [],
      items: [],
    },
    breakdown: {
      score: 950,
      exactMatch: true,
      singlePickup: true,
      distanceMeters: 200,
      repairs: [],
      totalPriceCents: 12000,
      reasonsFr: ['Disponible'],
      reasonsEn: ['Available'],
    },
  });

  it('ne mentionne jamais d’enfant ou de remorque pour un groupe d’adultes', async () => {
    const mockDb = {} as any;
    vi.spyOn(packSolverModule, 'solvePackForParty').mockResolvedValue([mockCandidate('Cyclo Annecy')]);

    const alternatives = await solvePackAlternatives(mockDb, adultOnlyRequest, []);

    if (alternatives.timeShiftAlternative) {
      expect(alternatives.timeShiftAlternative.descriptionFr).not.toMatch(/enfant|siège|remorque/i);
      expect(alternatives.timeShiftAlternative.descriptionFr).toContain('Cyclo Annecy');
      expect(alternatives.timeShiftAlternative.ctaLabelFr).toBe('Décaler à 14h00');
    }

    if (alternatives.dateShiftAlternative) {
      expect(alternatives.dateShiftAlternative.descriptionFr).not.toMatch(/enfant|siège|remorque/i);
      expect(alternatives.dateShiftAlternative.descriptionFr).toContain('Cyclo Annecy');
      expect(alternatives.dateShiftAlternative.dateIso).toBe('2026-09-13');
    }

    vi.restoreAllMocks();
  });

  it('génère une alternative de substitution fidèle quand une réparation explicite existe', async () => {
    const mockDb = {} as any;
    const repairedCandidate: RankedPackCandidate<SolvedPackCandidate> = {
      ...mockCandidate('Vélo Pro Annecy'),
      candidate: {
        ...mockCandidate('Vélo Pro Annecy').candidate,
        repairs: [
          {
            type: 'EQUIPMENT_SUBSTITUTION',
            originalRequirement: 'bike_electric',
            proposedRequirement: 'bike_hybrid',
            reason: 'VAE épuisé',
            deviationScore: 20,
            explanationFr: 'Vélo Tout Chemin proposé au lieu du vélo électrique',
            explanationEn: 'Hybrid bike offered instead of e-bike',
          },
        ],
      },
    };

    vi.spyOn(packSolverModule, 'solvePackForParty').mockResolvedValue([]);

    const alternatives = await solvePackAlternatives(mockDb, adultOnlyRequest, [repairedCandidate]);

    expect(alternatives.equipmentAlternative).not.toBeNull();
    expect(alternatives.equipmentAlternative?.descriptionFr).toBe(
      'Vélo Tout Chemin proposé au lieu du vélo électrique',
    );
    expect(alternatives.equipmentAlternative?.titleFr).toBe('Substitution homologuée');

    vi.restoreAllMocks();
  });

  it('renvoie des alternatives nulles sans fausses promesses si rien n’est disponible', async () => {
    const mockDb = {} as any;
    vi.spyOn(packSolverModule, 'solvePackForParty').mockResolvedValue([]);

    const alternatives = await solvePackAlternatives(mockDb, adultOnlyRequest, []);

    expect(alternatives.equipmentAlternative).toBeNull();
    expect(alternatives.timeShiftAlternative).toBeNull();
    expect(alternatives.dateShiftAlternative).toBeNull();
    expect(alternatives.totalAlternativesCount).toBe(0);

    vi.restoreAllMocks();
  });
});
