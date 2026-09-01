import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UnifiedBike } from '@uttily/core';
import * as core from '@uttily/core';
import * as catalogAuth from '@/lib/catalog-auth';
import { formatMoneyAmount } from '@/lib/status-presentation';
import UnifiedBikePage from './page';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const VARIANT_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogViewerOf: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getUnifiedBike: vi.fn(),
    listCategories: vi.fn(),
    listLocations: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

function buildBike(currency = 'EUR'): UnifiedBike {
  return {
    product: {
      id: PRODUCT_ID,
      organizationId: ORGANIZATION_ID,
      categoryId: 'cat-1',
      categoryName: 'VTT',
      categorySlug: 'vtt',
      name: 'Canyon Roadlite',
      slug: 'canyon-roadlite',
      description: 'Un vélo de ville léger et fiable.',
      publicationStatus: 'PUBLISHED',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    variant: {
      id: VARIANT_ID,
      name: 'Taille M',
      skuSuffix: 'M',
      isActive: true,
      attributes: { size: 'M' },
      currency,
    },
    photos: { count: 3, minRequired: 3, isComplete: true, items: [] },
    pricing: {
      activePlan: {
        id: 'plan-1',
        organizationId: ORGANIZATION_ID,
        productVariantId: VARIANT_ID,
        locationId: null,
        planType: 'DAILY',
        currency,
        priceAmountMinor: 3150,
        internalLabel: 'Tarif journalier',
        lifecycleState: 'ACTIVE',
        version: 1,
        discountTiers: [{ id: 'tier-7', thresholdDays: 7, discountPercent: 20 }],
        translations: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      draftPlan: null,
      isPriced: true,
    },
    inventory: {
      totalCount: 2,
      activeCount: 2,
      maintenanceCount: 0,
      retiredCount: 0,
      items: [
        {
          id: 'item-1',
          locationId: 'location-1',
          sku: 'CAN-001',
          serialNumber: 'SN-2026-001',
          status: 'ACTIVE',
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'item-2',
          locationId: 'location-1',
          sku: 'CAN-002',
          serialNumber: 'SN-2026-002',
          status: 'ACTIVE',
          notes: null,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ],
    },
    publication: { status: 'PUBLISHED', ready: true, failures: [] },
    offerReadiness: { hasPricing: true, hasInventory: true, isAvailable: true },
    statusSummary: 'ONLINE_AVAILABLE',
  };
}

async function renderBikePage(bike: UnifiedBike): Promise<string> {
  vi.mocked(catalogAuth.requireCatalogViewerOf).mockResolvedValue({
    db: {} as never,
    organizationId: ORGANIZATION_ID,
    user: { id: 'user-1' },
  } as never);
  vi.mocked(core.getUnifiedBike).mockResolvedValue(bike);
  vi.mocked(core.listCategories).mockResolvedValue([{ id: 'cat-1', name: 'VTT' }] as never);
  vi.mocked(core.listLocations).mockResolvedValue([
    { id: 'location-1', name: 'Boutique Lyon' },
  ] as never);

  const element = await UnifiedBikePage({
    params: Promise.resolve({ orgId: ORGANIZATION_ID, bikeId: PRODUCT_ID }),
  });
  return renderToStaticMarkup(element);
}

describe('Fiche vélo — surface loueur', () => {
  beforeEach(() => vi.clearAllMocks());

  it('n’expose aucun jargon technique et rend les libellés métier', async () => {
    const html = await renderBikePage(buildBike());

    expect(html).not.toMatch(/Variante|SKU/i);
    expect(html).toContain('Version');
    expect(html).toContain('Référence exemplaire');
    expect(html).toContain('Exemplaires en flotte');
    expect(html).not.toContain('Flotte physique &amp; exemplaires');
    expect(html).not.toContain('Aucun exemplaire physique enregistré');
  });

  it('conserve les valeurs utiles de la fiche et de la flotte', async () => {
    const html = await renderBikePage(buildBike());

    expect(html).toContain('Canyon Roadlite');
    expect(html).toContain('VTT');
    expect(html).toContain('Taille M');
    expect(html).toContain('Un vélo de ville léger et fiable.');
    expect(html).toContain('CAN-001');
    expect(html).toContain('SN-2026-001');
    expect(html).toContain('2 exemplaire(s) en service');
  });

  it('formate le prix avec la devise portée par le read model', async () => {
    const html = await renderBikePage(buildBike('USD'));
    const formattedPrice = formatMoneyAmount(3150, 'USD');

    expect(html).toContain(formattedPrice);
    expect(html).not.toContain('€');
  });

  it('présente une catégorie générique sans activer les sections spécifiques au vélo', async () => {
    const equipment = buildBike();
    equipment.product.categorySlug = 'equipment';
    equipment.product.categoryName = 'Équipements';
    equipment.variant.name = 'Standard';
    equipment.variant.attributes = { capacity: '2 personnes' };
    equipment.photos = { count: 2, minRequired: 3, isComplete: false, items: [] };

    const html = await renderBikePage(equipment);

    expect(html).toContain('équipement');
    expect(html).toContain('2/3 photos');
    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).toContain('Exemplaires en flotte');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('vues requises');
    expect(html).not.toContain('HERO_PROFILE');
  });

  it('présente une fiche surf sans Photo Coach ni slots vélo', async () => {
    const surf = buildBike();
    surf.product.categorySlug = 'surf';
    surf.product.categoryName = 'Surf';
    surf.variant.name = 'Longboard';
    surf.variant.attributes = { subtype: 'longboard' };
    surf.photos = { count: 2, minRequired: 3, isComplete: false, items: [] };

    const html = await renderBikePage(surf);

    expect(html).toContain('🏄');
    expect(html).toContain('Longboard');
    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('vues requises');
  });

  it('présente une fiche ski avec le sous-type existant, sans règles vélo', async () => {
    const ski = buildBike();
    ski.product.categorySlug = 'ski';
    ski.product.categoryName = 'Ski & Snowboard';
    ski.variant.name = 'Ski alpin';
    ski.variant.attributes = { subtype: 'alpine' };
    ski.photos = { count: 2, minRequired: 3, isComplete: false, items: [] };

    const html = await renderBikePage(ski);

    expect(html).toContain('🎿');
    expect(html).toContain('Sous-type : <strong>alpine</strong>');
    expect(html).toContain('ski');
    expect(html.match(/>ski</g)).toHaveLength(1);
    expect(html).toContain('Photos de l’équipement');
    expect(html).not.toContain('Snowboard');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('vues requises');
  });

  it('présente une fiche snowboard neutre sans règles ski ou vélo', async () => {
    const snowboard = buildBike();
    snowboard.product.categorySlug = 'snowboard';
    snowboard.product.categoryName = 'Snowboard';
    snowboard.variant.name = 'Standard';
    snowboard.variant.attributes = {};
    snowboard.photos = { count: 2, minRequired: 3, isComplete: false, items: [] };

    const html = await renderBikePage(snowboard);

    expect(html).toContain('🏂');
    expect(html).toContain('Snowboard');
    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).not.toContain('🎿');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('vues requises');
  });

  it('présente une fiche canoë nautique neutre sans Photo Coach ni slots vélo', async () => {
    const canoe = buildBike();
    canoe.product.categorySlug = 'canoe';
    canoe.product.categoryName = 'Canoës';
    canoe.variant.name = 'Standard';
    canoe.variant.attributes = {};
    canoe.photos = { count: 2, minRequired: 3, isComplete: false, items: [] };

    const html = await renderBikePage(canoe);

    expect(html).toContain('🛶');
    expect(html).toContain('canoë');
    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('vues requises');
  });

  it('associe les photos aux slots canoniques plutôt qu’à leur ordre d’insertion', async () => {
    const bike = buildBike();
    bike.product.categorySlug = 'bike';
    bike.photos = {
      count: 2,
      minRequired: 3,
      isComplete: false,
      items: [
        {
          id: 'photo-secondary',
          publicId: 'secondary-public',
          storageKey: 'secondary-storage',
          sortOrder: 0,
          slotKey: 'SECONDARY_VIEW',
          fileState: 'AVAILABLE',
          byteSize: 1024,
          mimeType: 'image/jpeg',
          checksumSha256: 'secondary-sha',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'photo-hero',
          publicId: 'hero-public',
          storageKey: 'hero-storage',
          sortOrder: 1,
          slotKey: 'HERO_PROFILE',
          fileState: 'AVAILABLE',
          byteSize: 1024,
          mimeType: 'image/jpeg',
          checksumSha256: 'hero-sha',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    };

    const html = await renderBikePage(bike);
    const heroIndex = html.indexOf('/api/public/product-photos/hero-public');
    const secondaryIndex = html.indexOf('/api/public/product-photos/secondary-public');

    expect(html).toContain('Standard Photo Coach (3 vues obligatoires)');
    expect(html).toContain('Profil latéral Hero');
    expect(html).toContain('3/4 Avant dynamique');
    expect(html).toContain('Vue libre valorisante');
    expect(heroIndex).toBeGreaterThanOrEqual(0);
    expect(secondaryIndex).toBeGreaterThan(heroIndex);
  });

  it('respecte l’organisation autorisée lors du chargement de la fiche', async () => {
    await renderBikePage(buildBike());

    expect(catalogAuth.requireCatalogViewerOf).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(core.getUnifiedBike).toHaveBeenCalledWith({}, ORGANIZATION_ID, PRODUCT_ID);
  });
});
