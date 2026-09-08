import { describe, it, expect } from 'vitest';
import {
  IntentProposalSchema,
  type IntentProposal,
} from './intent-compiler';
import { confident, abstain } from './confidence';
import {
  FakeIntentCompilerProvider,
} from '../fakes/fake-intent-compiler';

describe('IntentProposalSchema', () => {
  it('valide une proposition complète et bien formée', () => {
    const valid: IntentProposal = {
      destination: confident('Annecy', 0.98),
      destinationPublicId: confident('dest_123', 0.98),
      dates: confident(
        {
          mode: 'DAY_RANGE',
          startDate: '2026-09-12',
          endDateExclusive: '2026-09-13',
        },
        0.95,
      ),
      peopleCount: confident(2, 0.9),
      requirements: [
        {
          categorySlug: 'bike',
          electricPreferred: true,
        },
      ],
      rawQueryCleaned: '2 vélos électriques à Annecy',
      explanationFr: '2 vélos électriques à Annecy pour le 12 septembre.',
    };

    const parsed = IntentProposalSchema.parse(valid);
    expect(parsed.destination.value).toBe('Annecy');
    expect(parsed.destinationPublicId.value).toBe('dest_123');
    expect(parsed.dates.value?.mode).toBe('DAY_RANGE');
    expect(parsed.requirements).toHaveLength(1);
  });

  it('valide une proposition avec abstention sur la destination', () => {
    const abstaining: IntentProposal = {
      destination: abstain('Aucune ville ou station détectée dans la requête'),
      destinationPublicId: abstain(),
      dates: confident(
        {
          mode: 'DAY_RANGE',
          startDate: '2026-09-15',
        },
        0.8,
      ),
      peopleCount: confident(1, 0.9),
      requirements: [
        {
          categorySlug: 'kayak',
        },
      ],
      rawQueryCleaned: 'kayak pour moi mardi',
    };

    const parsed = IntentProposalSchema.parse(abstaining);
    expect(parsed.destination.value).toBeNull();
    expect(parsed.destination.confidence).toBe(0);
    expect(parsed.requirements[0]?.categorySlug).toBe('kayak');
  });

  it('rejette un nombre de personnes négatif ou supérieur à 99', () => {
    const invalid = {
      destination: confident('Chamonix', 0.95),
      destinationPublicId: confident('dest_chamonix', 0.95),
      dates: confident({ mode: 'DAY_RANGE' }, 0.9),
      peopleCount: confident(150, 0.9), // > 99
      requirements: [],
      rawQueryCleaned: 'test',
    };

    expect(() => IntentProposalSchema.parse(invalid)).toThrow();
  });
});

describe('FakeIntentCompilerProvider', () => {
  it('compile une requête naturelle avec matching de destination et dates', async () => {
    const provider = new FakeIntentCompilerProvider();
    const result = await provider.compileIntent({
      rawQuery: '2 vélos électriques à Annecy ce samedi',
      locale: 'fr',
      userContext: {
        currentDateTimeIso: '2026-09-07T12:00:00Z',
        availableDestinations: [
          { publicId: 'dest-annecy', label: 'Annecy', slug: 'annecy' },
          { publicId: 'dest-chamonix', label: 'Chamonix', slug: 'chamonix' },
        ],
        availableCategories: [
          { id: 'cat-bike', name: 'Vélo', slug: 'bike' },
          { id: 'cat-kayak', name: 'Kayak', slug: 'kayak' },
        ],
      },
    });

    expect(result.proposal.destination.value).toBe('Annecy');
    expect(result.proposal.destinationPublicId.value).toBe('dest-annecy');
    expect(result.proposal.peopleCount.value).toBe(2);
    expect(result.proposal.requirements[0]?.categorySlug).toBe('bike');
    expect(result.proposal.requirements[0]?.electricPreferred).toBe(true);
    expect(result.model).toBe('fake-intent-compiler');
  });

  it('détecte les requêtes pour une personne seule ou une famille', async () => {
    const provider = new FakeIntentCompilerProvider();
    const solo = await provider.compileIntent({
      rawQuery: 'Un kayak pour moi seul demain',
      locale: 'fr',
    });
    expect(solo.proposal.peopleCount.value).toBe(1);
    expect(solo.proposal.requirements[0]?.categorySlug).toBe('kayak');

    const family = await provider.compileIntent({
      rawQuery: 'Sortie famille à Chamonix ce week-end',
      locale: 'fr',
    });
    expect(family.proposal.peopleCount.value).toBe(4);
  });

  it('lève une exception lorsque shouldFail est activé', async () => {
    const failingProvider = new FakeIntentCompilerProvider({
      shouldFail: true,
      failureMessage: 'Panne intentionnelle',
    });

    await expect(
      failingProvider.compileIntent({
        rawQuery: 'test',
        locale: 'fr',
      }),
    ).rejects.toThrow('Panne intentionnelle');
  });

  it('ne déduit JAMAIS arbitrairement un nombre de personnes omis (ADR-041 anti-hallucination)', async () => {
    const provider = new FakeIntentCompilerProvider();
    const result = await provider.compileIntent({
      rawQuery: 'Tour du lac d’Annecy en VTT électrique ce samedi',
      locale: 'fr',
    });

    // peopleCount doit être strictement abstenu
    expect(result.proposal.peopleCount.value).toBeNull();
    expect(result.proposal.peopleCount.confidence).toBe(0);

    // Dates doivent être strictement 1 jour : 12 sept -> 13 sept exclusif
    expect(result.proposal.dates.value?.startDate).toBe('2026-09-12');
    expect(result.proposal.dates.value?.endDateExclusive).toBe('2026-09-13');
  });
});
