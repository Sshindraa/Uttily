import type {
  IntentCompilerPort,
  IntentCompilerInput,
  IntentCompilerExecutionResult,
  IntentProposal,
} from '../ports/intent-compiler';
import { confident, abstain } from '../schemas/confidence';

export const DEFAULT_FAKE_INTENT_PROPOSAL: IntentProposal = {
  destination: confident('Annecy', 0.98, 'Mention explicite de la ville d’Annecy'),
  destinationPublicId: confident(
    'dest-annecy-001',
    0.98,
    'Correspondance exacte dans le catalogue',
  ),
  dates: confident(
    {
      mode: 'DAY_RANGE',
      startDate: '2026-09-12',
      endDateExclusive: '2026-09-13',
    },
    0.95,
    'Samedi prochain',
  ),
  peopleCount: confident(3, 0.95, '2 adultes et 1 enfant'),
  requirements: [
    {
      categorySlug: 'bike',
      subtypes: ['electric_mountain'],
      electricPreferred: true,
    },
    {
      categorySlug: 'bike',
      subtypes: ['electric_mountain'],
      electricPreferred: true,
    },
    {
      categorySlug: 'accessory',
      subtypes: ['child_trailer', 'child_seat'],
    },
  ],
  rawQueryCleaned: '2 vélos électriques et 1 remorque enfant à Annecy ce samedi',
  explanationFr:
    'Sortie en famille à Annecy : 2 vélos électriques adultes et un équipement adapté pour un enfant.',
  explanationEn: 'Family outing in Annecy: 2 adult e-bikes and suitable equipment for a child.',
};

export interface FakeIntentCompilerOptions {
  customProposal?: IntentProposal;
  latencyMs?: number;
  shouldFail?: boolean;
  failureMessage?: string;
}

export class FakeIntentCompilerProvider implements IntentCompilerPort {
  private readonly options: FakeIntentCompilerOptions;

  constructor(options: FakeIntentCompilerOptions = {}) {
    this.options = options;
  }

  async compileIntent(input: IntentCompilerInput): Promise<IntentCompilerExecutionResult> {
    if (this.options.shouldFail) {
      throw new Error(
        this.options.failureMessage || 'Erreur simulée du compilateur d’intention Fake.',
      );
    }

    if (this.options.customProposal) {
      return {
        proposal: this.options.customProposal,
        latencyMs: this.options.latencyMs ?? 15,
        model: 'fake-intent-compiler',
      };
    }

    const q = input.rawQuery.toLowerCase();

    // 1. Destination matching
    let destName = 'Annecy';
    let destPublicId = 'dest-annecy-001';
    let destConf = 0.95;

    if (
      input.userContext?.availableDestinations &&
      input.userContext.availableDestinations.length > 0
    ) {
      const matched = input.userContext.availableDestinations.find(
        (d) => q.includes(d.label.toLowerCase()) || q.includes(d.slug.toLowerCase()),
      );
      if (matched) {
        destName = matched.label;
        destPublicId = matched.publicId;
        destConf = 0.98;
      } else {
        // First destination as fallback if none matched
        const fallback = input.userContext.availableDestinations[0]!;
        destName = fallback.label;
        destPublicId = fallback.publicId;
        destConf = 0.6;
      }
    }

    // 2. Dates
    const isTomorrow = q.includes('demain');
    const isSaturday = q.includes('samedi');
    const isWeekend = q.includes('week-end') || q.includes('weekend') || isSaturday;
    const hasTimes = q.includes('h') && (q.includes('14h') || q.includes('9h') || q.includes(':'));

    let startDate = '2026-09-09';
    let endDate = '2026-09-10';

    if (isTomorrow) {
      startDate = '2026-09-08';
      endDate = '2026-09-09';
    } else if (isWeekend) {
      startDate = '2026-09-12';
      if (q.includes('dimanche') || q.includes('week-end') || q.includes('weekend')) {
        endDate = '2026-09-14';
      } else {
        // Single-day Saturday rental: Saturday 12 Sept -> endDateExclusive Sunday 13 Sept
        endDate = '2026-09-13';
      }
    }

    // 3. People count (Strict ADR-041: Abstention > Hallucination)
    let peopleCountField = abstain<number>('Non précisé dans la requête');
    const peopleMatch = q.match(
      /(\d+)\s*(?:personnes?|pers|adultes?|locataires?|vélos?|velos?|kayaks?|skis?)/,
    );
    if (peopleMatch && peopleMatch[1]) {
      const parsed = parseInt(peopleMatch[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 99) {
        peopleCountField = confident(
          parsed,
          0.95,
          `Détecté d'après la requête : "${peopleMatch[0]}"`,
        );
      }
    } else if (q.includes('seul') || q.includes('pour moi') || q.includes('solo')) {
      peopleCountField = confident(1, 0.95, 'Usage solo explicite');
    } else if (q.includes('couple') || q.includes('à deux') || q.includes('a deux')) {
      peopleCountField = confident(2, 0.95, 'Sortie en couple');
    } else if (q.includes('famille')) {
      peopleCountField = confident(4, 0.85, 'Sortie en famille');
    }

    // 4. Category
    let categorySlug = 'bike';
    let categoryId = 'cat-bike-001';
    if (q.includes('kayak')) {
      categorySlug = 'kayak';
    } else if (q.includes('ski')) {
      categorySlug = 'ski';
    } else if (q.includes('surf') || q.includes('paddle')) {
      categorySlug = 'paddle';
    }

    if (input.userContext?.availableCategories) {
      const matchedCat = input.userContext.availableCategories.find(
        (c) => c.slug.toLowerCase() === categorySlug || q.includes(c.name.toLowerCase()),
      );
      if (matchedCat) {
        categorySlug = matchedCat.slug;
        categoryId = matchedCat.id;
      }
    }

    const proposal: IntentProposal = {
      destination: confident(destName, destConf, `Détecté d'après la requête : "${destName}"`),
      destinationPublicId: confident(destPublicId, destConf),
      dates: confident(
        hasTimes
          ? {
              mode: 'TIME_RANGE',
              startDate,
              startAt: `${startDate}T09:00:00Z`,
              endAt: `${startDate}T18:00:00Z`,
            }
          : {
              mode: 'DAY_RANGE',
              startDate,
              endDateExclusive: endDate,
            },
        0.9,
      ),
      peopleCount: peopleCountField,
      requirements: [
        {
          categorySlug,
          categoryId,
          electricPreferred:
            q.includes('électrique') || q.includes('vae') || q.includes('electrique'),
        },
      ],
      rawQueryCleaned: input.rawQuery.trim(),
      explanationFr:
        peopleCountField.value != null
          ? `Recherche compilée pour ${peopleCountField.value} personne(s) à ${destName} du ${startDate}.`
          : `Recherche compilée à ${destName} du ${startDate} (nombre de participants à préciser).`,
      explanationEn:
        peopleCountField.value != null
          ? `Compiled search for ${peopleCountField.value} people in ${destName} starting ${startDate}.`
          : `Compiled search in ${destName} starting ${startDate} (party size to specify).`,
    };

    return {
      proposal,
      latencyMs: this.options.latencyMs ?? 20,
      model: 'fake-intent-compiler',
    };
  }
}
