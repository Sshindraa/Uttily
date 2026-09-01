import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UnifiedBikeSummary } from '@uttily/core';
import { BikesListView } from './bikes-list-view';

const summary = (categorySlug: string): UnifiedBikeSummary => ({
  id: 'product-1',
  name: 'Kayak de démonstration',
  slug: 'kayak-de-demonstration',
  categoryName:
    categorySlug === 'equipment'
      ? 'Équipements'
      : categorySlug === 'surf'
        ? 'Surf'
        : categorySlug === 'ski'
          ? 'Ski & Snowboard'
          : 'Kayak',
  categorySlug,
  variantName: 'Standard',
  variantId: 'variant-1',
  publicationStatus: 'PUBLISHED',
  photoCount: 2,
  hasRequiredPhotos: false,
  heroPhotoPublicId: null,
  priceAmountMinor: 2500,
  pricingPlanType: 'DAILY',
  pricingCurrency: 'EUR',
  activeInventoryCount: 1,
  totalInventoryCount: 1,
  isPublicationReady: true,
  isOfferAvailable: true,
  statusSummary: 'ONLINE_AVAILABLE',
});

describe('Mes équipements — liste', () => {
  it('affiche une catégorie non vélo avec les libellés génériques du registre', () => {
    const html = renderToStaticMarkup(
      <BikesListView organizationId="org-1" bikes={[summary('equipment')]} canManage />,
    );

    expect(html).toContain('🧰');
    expect(html).toContain('Équipements');
    expect(html).toContain('2/3 photos');
    expect(html).toContain('Gérer l’équipement');
    expect(html).not.toContain('vues requises');
  });

  it('garde la présentation dédiée au vélo', () => {
    const html = renderToStaticMarkup(
      <BikesListView organizationId="org-1" bikes={[summary('bike')]} canManage />,
    );

    expect(html).toContain('🚲');
    expect(html).toContain('2/3 vues requises');
  });

  it('présente le socle surf avec le gestionnaire photo neutre', () => {
    const html = renderToStaticMarkup(
      <BikesListView organizationId="org-1" bikes={[summary('surf')]} canManage />,
    );

    expect(html).toContain('🏄');
    expect(html).toContain('Surf');
    expect(html).toContain('2/3 photos');
    expect(html).not.toContain('vues requises');
  });

  it('présente le ski sans le libellé snowboard ni les slots vélo', () => {
    const html = renderToStaticMarkup(
      <BikesListView organizationId="org-1" bikes={[summary('ski')]} canManage />,
    );

    expect(html).toContain('🎿');
    expect(html).toContain('ski');
    expect(html).toContain('2/3 photos');
    expect(html).not.toContain('Snowboard');
    expect(html).not.toContain('vues requises');
  });
});
