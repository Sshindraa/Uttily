import type { DatabaseClient } from '@uttily/database';
import type { PackRequest, FunctionalRequirement } from './party-model';
import { solvePackForParty, type SolvedPackCandidate } from './pack-solver';
import type { RankedPackCandidate } from './pack-ranker';

export interface PackTimeShiftAlternative {
  readonly candidate: RankedPackCandidate<SolvedPackCandidate>;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly timeSlotLabel: string;
  readonly titleFr: string;
  readonly titleEn: string;
  readonly descriptionFr: string;
  readonly descriptionEn: string;
  readonly ctaLabelFr: string;
  readonly ctaLabelEn: string;
}

export interface PackDateShiftAlternative {
  readonly candidate: RankedPackCandidate<SolvedPackCandidate>;
  readonly dateIso: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly titleFr: string;
  readonly titleEn: string;
  readonly descriptionFr: string;
  readonly descriptionEn: string;
  readonly ctaLabelFr: string;
  readonly ctaLabelEn: string;
}

export interface PackEquipmentAlternative {
  readonly candidate: RankedPackCandidate<SolvedPackCandidate>;
  readonly titleFr: string;
  readonly titleEn: string;
  readonly descriptionFr: string;
  readonly descriptionEn: string;
  readonly ctaLabelFr: string;
  readonly ctaLabelEn: string;
}

export interface SolvedPackAlternatives {
  readonly equipmentAlternative: PackEquipmentAlternative | null;
  readonly timeShiftAlternative: PackTimeShiftAlternative | null;
  readonly dateShiftAlternative: PackDateShiftAlternative | null;
  readonly totalAlternativesCount: number;
}

/**
 * Résout dynamiquement les alternatives viables et auditables d'un pack (ADR-041).
 *
 * Règles d'or :
 * 1. Zéro texte codé en dur : toute alternative reflète l'inventaire physique réel en base.
 * 2. Aucune carte fantôme : si un créneau ou une date n'a pas 100% du matériel libre,
 *    l'alternative vaut null et aucune fausse promesse n'est affichée au client.
 * 3. Zéro mention d'enfant ou d'accessoire s'ils ne font pas partie de la demande.
 */
export async function solvePackAlternatives(
  db: DatabaseClient,
  request: PackRequest,
  currentCandidates: readonly RankedPackCandidate<SolvedPackCandidate>[] = [],
): Promise<SolvedPackAlternatives> {
  const dateStr = request.startAt.toISOString().slice(0, 10);
  const startHour = request.startAt.getUTCHours();

  // 1. Recherche d'alternative temporelle (Après-midi 14h - 19h le même jour)
  // Applicable uniquement si la recherche initiale portait sur la matinée ou journée complète
  let timeShiftPromise: Promise<PackTimeShiftAlternative | null> = Promise.resolve(null);
  if (startHour < 14) {
    const afternoonStart = new Date(`${dateStr}T14:00:00.000Z`);
    const afternoonEnd = new Date(`${dateStr}T19:00:00.000Z`);
    timeShiftPromise = solvePackForParty(
      db,
      { ...request, startAt: afternoonStart, endAt: afternoonEnd },
      { allowRepairs: true },
    )
      .then((candidates) => {
        const best = candidates[0];
        if (!best) return null;
        const orgName = best.candidate.organizationName;
        return {
          candidate: best,
          startAt: afternoonStart,
          endAt: afternoonEnd,
          timeSlotLabel: '14h00 – 19h00',
          titleFr: 'Disponible cet après-midi',
          titleEn: 'Available this afternoon',
          descriptionFr: `L'ensemble de vos équipements est disponible dès 14h00 chez ${orgName}.`,
          descriptionEn: `All your equipment is available from 2:00 PM at ${orgName}.`,
          ctaLabelFr: 'Décaler à 14h00',
          ctaLabelEn: 'Shift to 2:00 PM',
        };
      })
      .catch((err) => {
        console.error('Error solving time shift alternative:', err);
        return null;
      });
  }

  // 2. Recherche d'alternative calendaire (Lendemain J+1)
  const tomorrow = new Date(request.startAt);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  const tomorrowStart = new Date(`${tomorrowIso}T08:00:00.000Z`);
  const tomorrowEnd = new Date(`${tomorrowIso}T19:00:00.000Z`);

  const dateShiftPromise: Promise<PackDateShiftAlternative | null> = solvePackForParty(
    db,
    { ...request, startAt: tomorrowStart, endAt: tomorrowEnd },
    { allowRepairs: true },
  )
    .then((candidates) => {
      const best = candidates[0];
      if (!best) return null;
      const orgName = best.candidate.organizationName;
      return {
        candidate: best,
        dateIso: tomorrowIso,
        startAt: tomorrowStart,
        endAt: tomorrowEnd,
        titleFr: 'Tout disponible le lendemain',
        titleEn: 'All available tomorrow',
        descriptionFr: `Configuration 100% libre et prête dès le matin chez ${orgName}.`,
        descriptionEn: `Configuration 100% available and ready in the morning at ${orgName}.`,
        ctaLabelFr: 'Rechercher le lendemain',
        ctaLabelEn: 'Search next day',
      };
    })
    .catch((err) => {
      console.error('Error solving date shift alternative:', err);
      return null;
    });

  // 3. Recherche d'alternative de matériel / substitution sur le même créneau
  let equipmentAlternative: PackEquipmentAlternative | null = null;
  const repairedCurrent = currentCandidates.find((c) => c.candidate.repairs.length > 0);

  if (repairedCurrent) {
    const firstRepair = repairedCurrent.candidate.repairs[0]!;
    equipmentAlternative = {
      candidate: repairedCurrent,
      titleFr: 'Substitution homologuée',
      titleEn: 'Approved substitution',
      descriptionFr: firstRepair.explanationFr,
      descriptionEn: firstRepair.explanationEn,
      ctaLabelFr: 'Choisir cette solution →',
      ctaLabelEn: 'Choose this solution →',
    };
  } else {
    // Si aucun pack n'était solvable, tenter une relaxation des préférences d'équipements
    // ex: préférence électrique relaxée si des modèles classiques ou mixtes sont disponibles
    const hasElectricPref = request.requirements.some((r) => r.electricPreferred);
    if (hasElectricPref) {
      const relaxedReqs: FunctionalRequirement[] = request.requirements.map((r) => {
        const { electricPreferred: _, ...rest } = r;
        return rest;
      });
      const relaxedCandidates = await solvePackForParty(
        db,
        { ...request, requirements: relaxedReqs },
        { allowRepairs: true },
      ).catch(() => []);

      const bestRelaxed = relaxedCandidates[0];
      if (bestRelaxed) {
        const orgName = bestRelaxed.candidate.organizationName;
        equipmentAlternative = {
          candidate: bestRelaxed,
          titleFr: 'Matériel alternatif disponible',
          titleEn: 'Alternative equipment available',
          descriptionFr: `Modèles équivalents disponibles chez ${orgName} pour équiper l'ensemble de votre groupe.`,
          descriptionEn: `Equivalent models available at ${orgName} to equip your entire party.`,
          ctaLabelFr: 'Voir cette solution →',
          ctaLabelEn: 'View this solution →',
        };
      }
    }
  }

  const [timeShiftAlternative, dateShiftAlternative] = await Promise.all([
    timeShiftPromise,
    dateShiftPromise,
  ]);

  const totalAlternativesCount =
    (equipmentAlternative ? 1 : 0) +
    (timeShiftAlternative ? 1 : 0) +
    (dateShiftAlternative ? 1 : 0);

  return {
    equipmentAlternative,
    timeShiftAlternative,
    dateShiftAlternative,
    totalAlternativesCount,
  };
}
