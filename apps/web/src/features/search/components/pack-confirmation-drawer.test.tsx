import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RankedPackCandidate, SolvedPackCandidate } from '@uttily/core';
import { PackConfirmationDrawer } from './pack-confirmation-drawer';

const mockPack: RankedPackCandidate<SolvedPackCandidate> = {
  candidate: {
    organizationId: 'org-1',
    organizationName: 'Cyclo Annecy',
    locationId: 'loc-1',
    locationAddress: 'Annecy · 600 m du lac',
    distanceMeters: 600,
    requestedDateMatched: true,
    totalPriceCents: 12000,
    repairs: [],
    items: [
      {
        requirementId: 'req-1',
        partyMemberId: 'm-1',
        inventoryItemId: 'item-1',
        internalSku: 'SKU-1',
        productId: 'p-1',
        productName: 'VAE Tout-Chemin',
        productVariantId: 'v-1',
        variantName: 'M',
        categorySlug: 'bike',
        unitPriceCents: 6000,
      },
      {
        requirementId: 'req-2',
        partyMemberId: 'm-2',
        inventoryItemId: 'item-2',
        internalSku: 'SKU-2',
        productId: 'p-2',
        productName: 'Remorque Enfant Thule',
        productVariantId: 'v-2',
        variantName: 'Unique',
        categorySlug: 'trailer',
        unitPriceCents: 6000,
      },
    ],
  },
  breakdown: {
    score: 1500,
    exactMatch: true,
    singlePickup: true,
    distanceMeters: 600,
    repairs: [],
    totalPriceCents: 12000,
    reasonsFr: ['Solution complète'],
    reasonsEn: ['Complete solution'],
  },
};

describe('PackConfirmationDrawer (UI Formulations & Integrity)', () => {
  it('affiche les formulations exactes et tempérées exigées', () => {
    const html = renderToStaticMarkup(
      <PackConfirmationDrawer
        pack={mockPack}
        onClose={() => {}}
        locale="fr"
        startAtIso="2026-09-12T08:00:00.000Z"
        endAtIso="2026-09-12T19:00:00.000Z"
        datesSummary="samedi 12 septembre"
      />,
    );

    // Formulation tempérée du blocage atomique
    expect(html).toContain(
      'Tous les équipements seront bloqués ensemble lors de votre réservation',
    );
    // Formulation conditionnée de la caution
    expect(html).toContain(
      'Caution selon les conditions du loueur (empreinte bancaire ou chèque au comptoir)',
    );
    // Pas d'affirmation trop absolue
    expect(html).not.toContain('Tous les équipements sont garantis et bloqués ensemble');
    expect(html).not.toContain('Caution prise au comptoir');

    // Affichage des éléments et du prix dérivé
    expect(html).toContain('Cyclo Annecy');
    expect(html).toContain('VAE Tout-Chemin');
    expect(html).toContain('Remorque Enfant Thule');
    expect(html).toContain('120,00 €');
    expect(html).toContain('Continuer vers la réservation →');
  });

  it('affiche la version anglaise avec les mentions appropriées', () => {
    const html = renderToStaticMarkup(
      <PackConfirmationDrawer
        pack={mockPack}
        onClose={() => {}}
        locale="en"
        startAtIso="2026-09-12T08:00:00.000Z"
        endAtIso="2026-09-12T19:00:00.000Z"
      />,
    );

    expect(html).toContain('All equipment will be held together upon booking');
    expect(html).toContain('Deposit per shop policy');
    expect(html).toContain('Continue to booking →');
  });
});
