import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RankedPackCandidate, SolvedPackCandidate } from '@uttily/core';
import { PackSolutionCard } from './pack-solution-card';

const mockExactPack: RankedPackCandidate<SolvedPackCandidate> = {
  candidate: {
    organizationId: 'org-cyclo-annecy',
    organizationName: 'Cyclo Annecy',
    locationId: 'loc-annecy-centre',
    locationAddress: 'Annecy · 600 m du lac',
    distanceMeters: 600,
    requestedDateMatched: true,
    totalPriceCents: 7600,
    repairs: [],
    items: [
      {
        requirementId: 'req-1',
        partyMemberId: 'member-1',
        inventoryItemId: 'item-vae-1',
        internalSku: 'VAE-001',
        productId: 'prod-vae',
        productName: 'VAE confort',
        productVariantId: 'var-vae-m',
        variantName: 'Taille M',
        categorySlug: 'bike',
        unitPriceCents: 3800,
      },
      {
        requirementId: 'req-2',
        partyMemberId: 'member-2',
        inventoryItemId: 'item-vae-2',
        internalSku: 'VAE-002',
        productId: 'prod-vae',
        productName: 'VAE confort',
        productVariantId: 'var-vae-l',
        variantName: 'Taille L',
        categorySlug: 'bike',
        unitPriceCents: 3800,
      },
    ],
  },
  breakdown: {
    score: 1500,
    exactMatch: true,
    singlePickup: true,
    distanceMeters: 600,
    repairs: [],
    totalPriceCents: 7600,
    reasonsFr: ['Correspondance exacte avec votre demande'],
    reasonsEn: ['Exact match with your requirements'],
  },
};

const mockRepairedPack: RankedPackCandidate<SolvedPackCandidate> = {
  candidate: {
    organizationId: 'org-alpes-glisse',
    organizationName: 'Alpes Glisse',
    locationId: 'loc-alpes-1',
    locationAddress: 'Annecy-le-Vieux',
    distanceMeters: 1200,
    requestedDateMatched: true,
    totalPriceCents: 8500,
    repairs: [
      {
        type: 'ACCESSORY_SUBSTITUTION',
        originalRequirement: 'CHILD_SEAT',
        proposedRequirement: 'CHILD_TRAILER',
        reason: 'Substitution homologuée',
        deviationScore: 10,
        explanationFr: 'Remorque enfant proposée à la place du siège demandé.',
        explanationEn: 'Child trailer offered instead of requested seat.',
      },
    ],
    items: [
      {
        requirementId: 'req-1',
        partyMemberId: 'member-1',
        inventoryItemId: 'item-vae-1',
        internalSku: 'VAE-001',
        productId: 'prod-vae',
        productName: 'VAE confort',
        productVariantId: 'var-vae',
        variantName: 'Standard',
        categorySlug: 'bike',
        unitPriceCents: 4500,
      },
    ],
  },
  breakdown: {
    score: 1300,
    exactMatch: false,
    singlePickup: true,
    distanceMeters: 1200,
    repairs: [],
    totalPriceCents: 8500,
    reasonsFr: ['Remorque enfant proposée à la place du siège demandé.'],
    reasonsEn: ['Child trailer offered instead of requested seat.'],
  },
};

describe('PackSolutionCard', () => {
  it('affiche le pack exact avec ✓ Solution complète et libellé "Choisir ce pack →"', () => {
    const html = renderToStaticMarkup(
      <PackSolutionCard
        pack={mockExactPack}
        locale="fr"
        datesSummary="samedi 12 septembre"
        onSelectPack={() => {}}
      />,
    );

    expect(html).toContain('Solution complète');
    expect(html).toContain('Cyclo Annecy');
    expect(html).toContain('2 ×');
    expect(html).toContain('VAE confort');
    expect(html).toContain('76,00 €');
    expect(html).toContain('Choisir ce pack →');
    expect(html).toContain('Un seul retrait au même comptoir');
    expect(html).toContain('samedi 12 septembre');
    expect(html).not.toContain('Pack IA');
    expect(html).not.toContain('Solver');
  });

  it('affiche le pack adapté avec le badge "Alternative disponible" et l’explication de substitution', () => {
    const html = renderToStaticMarkup(
      <PackSolutionCard pack={mockRepairedPack} locale="fr" onSelectPack={() => {}} />,
    );

    expect(html).toContain('Alternative disponible');
    expect(html).toContain('Remorque enfant proposée à la place du siège demandé.');
    expect(html).toContain('85,00 €');
    expect(html).toContain('Choisir ce pack →');
  });
});
