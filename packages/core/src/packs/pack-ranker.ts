import type { PackRepair } from './pack-repair';

/**
 * Détail déterministe et auditable du score d'un pack (ADR-041).
 */
export interface PackRankBreakdown {
  readonly score: number;
  readonly exactMatch: boolean;
  readonly singlePickup: boolean;
  readonly distanceMeters: number;
  readonly repairs: readonly PackRepair[];
  readonly totalPriceCents: number;
  readonly reasonsFr: readonly string[];
  readonly reasonsEn: readonly string[];
}

export interface ScorablePackCandidate {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly locationId: string;
  readonly locationAddress: string;
  readonly distanceMeters: number;
  readonly requestedDateMatched: boolean;
  readonly totalPriceCents: number;
  readonly repairs: readonly PackRepair[];
}

export interface RankedPackCandidate<T extends ScorablePackCandidate = ScorablePackCandidate> {
  readonly candidate: T;
  readonly breakdown: PackRankBreakdown;
}

/**
 * Calcule le score auditable d'un pack candidat selon la formule ADR-041.
 */
export function computePackScore(candidate: ScorablePackCandidate): PackRankBreakdown {
  const isExact = candidate.repairs.length === 0;
  let score = 0;
  const reasonsFr: string[] = [];
  const reasonsEn: string[] = [];

  if (isExact) {
    score += 1000;
    reasonsFr.push('Correspondance exacte avec votre demande');
    reasonsEn.push('Exact match with your requirements');
  } else {
    const totalDeviation = candidate.repairs.reduce((acc, r) => acc + r.deviationScore, 0);
    score -= totalDeviation * 10;
    for (const r of candidate.repairs) {
      reasonsFr.push(r.explanationFr);
      reasonsEn.push(r.explanationEn);
    }
  }

  // Bonus retrait unique
  score += 300;
  reasonsFr.push('Tous les équipements retirés au même endroit');
  reasonsEn.push('All equipment picked up at the same location');

  // Bonus date exacte
  if (candidate.requestedDateMatched) {
    score += 200;
    reasonsFr.push('Disponible sur la date demandée');
    reasonsEn.push('Available on the requested date');
  }

  // Pénalité de distance (1 point par tranche de 10 mètres)
  const distancePenalty = Math.round(candidate.distanceMeters * 0.1);
  score -= distancePenalty;

  // Tie breaker prix (infime pour ne départager que les ex-aequo)
  score -= Math.round(candidate.totalPriceCents * 0.0001);

  return {
    score,
    exactMatch: isExact,
    singlePickup: true,
    distanceMeters: candidate.distanceMeters,
    repairs: candidate.repairs,
    totalPriceCents: candidate.totalPriceCents,
    reasonsFr,
    reasonsEn,
  };
}

/**
 * Classe une liste de packs candidats par score décroissant.
 */
export function rankCandidatePacks<T extends ScorablePackCandidate>(
  candidates: readonly T[],
): readonly RankedPackCandidate<T>[] {
  return candidates
    .map((candidate) => ({
      candidate,
      breakdown: computePackScore(candidate),
    }))
    .sort((a, b) => b.breakdown.score - a.breakdown.score);
}
