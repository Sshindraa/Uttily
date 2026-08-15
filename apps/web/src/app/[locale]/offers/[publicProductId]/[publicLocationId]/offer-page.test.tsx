import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as auth from '@/lib/auth';
import * as core from '@uttily/core';
import type { PublicOfferDetails } from '@uttily/core';
import PublicOfferPage from './page';
import {
  OfferBookingForm,
  computeBookingFormFingerprint,
  getOrCreateIdempotencyKey,
} from './offer-booking-form';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getPublicOfferDetails: vi.fn(),
  };
});

const mockNotFound = vi.fn();
vi.mock('next/navigation', () => ({
  notFound: () => {
    mockNotFound();
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('PublicOfferPage & OfferBookingForm — SSR et Idempotence', () => {
  const publicProductId = '11111111-1111-4111-8111-111111111111';
  const publicLocationId = '22222222-2222-4222-8222-222222222222';
  const publicVariant1Id = '33333333-3333-4333-8333-333333333333';
  const publicVariant2Id = '44444444-4444-4444-8444-444444444444';

  const mockOffer: PublicOfferDetails = {
    publicProductId,
    publicLocationId,
    organizationPublicDisplayName: 'Loueur Pro Annecy',
    productName: 'Kayak Gonflable 2 Places',
    productDescription: 'Kayak de randonnée léger et stable.',
    locationName: 'Base Nautique Annecy',
    timeZone: 'Europe/Paris',
    operatingCurrency: 'EUR',
    addressLine1: '12 Avenue du Lac',
    addressLine2: 'Ponton B',
    city: 'Annecy',
    postalCode: '74000',
    countryCode: 'FR',
    variants: [
      {
        publicVariantId: publicVariant1Id,
        name: 'Modèle Standard',
      },
    ],
    openingHours: [
      { weekday: 1, openTime: '08:00:00', closeTime: '18:00:00' },
      { weekday: 2, openTime: '08:00:00', closeTime: '18:00:00' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Renders public offer details in French', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);
    vi.mocked(core.getPublicOfferDetails).mockResolvedValue({
      kind: 'SUCCESS',
      offer: mockOffer,
    });

    const page = await PublicOfferPage({
      params: Promise.resolve({ locale: 'fr', publicProductId, publicLocationId }),
      searchParams: Promise.resolve({
        intent: 'DAY_RANGE',
        startDate: '2026-09-01',
        endDateExclusive: '2026-09-03',
      }),
    });

    const html = renderToStaticMarkup(page);

    expect(html).toContain('Kayak Gonflable 2 Places');
    expect(html).toContain('Loueur Pro Annecy');
    expect(html).toContain('Base Nautique Annecy');
    expect(html).toContain('12 Avenue du Lac');
    expect(html).toContain('74000 Annecy, FR');
    expect(html).toContain('Europe/Paris');
    expect(html).toContain('Lundi');
    expect(html).toContain('08:00 - 18:00');
    expect(html).toContain('Réserver');
    expect(html).toContain('value="2026-09-01"');
    expect(html).toContain('value="2026-09-03"');
    expect(html).toContain('montant contractuel exact');
  });

  it('2. Sentinelles : prouve qu’aucun ID interne ou secret n’apparaît dans le HTML SSR', async () => {
    const internalOrgId = '99999999-9999-4999-8999-999999999999';
    const internalVariantId = '88888888-8888-4888-8888-888888888888';
    const sentinelSku = 'SENTINEL_SKU_TEST_123';

    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);
    vi.mocked(core.getPublicOfferDetails).mockResolvedValue({
      kind: 'SUCCESS',
      offer: mockOffer,
    });

    const page = await PublicOfferPage({
      params: Promise.resolve({ locale: 'fr', publicProductId, publicLocationId }),
      searchParams: Promise.resolve({}),
    });

    const html = renderToStaticMarkup(page);

    expect(html).not.toContain(internalOrgId);
    expect(html).not.toContain(internalVariantId);
    expect(html).not.toContain(sentinelSku);
    expect(html).toContain(publicProductId);
    expect(html).toContain(publicLocationId);
  });

  it('3. Renders public offer details in English', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);
    vi.mocked(core.getPublicOfferDetails).mockResolvedValue({
      kind: 'SUCCESS',
      offer: mockOffer,
    });

    const page = await PublicOfferPage({
      params: Promise.resolve({ locale: 'en', publicProductId, publicLocationId }),
      searchParams: Promise.resolve({
        intent: 'TIME_RANGE',
        startAt: '2026-09-01T10:00',
        endAt: '2026-09-01T14:00',
      }),
    });

    const html = renderToStaticMarkup(page);

    expect(html).toContain('Kayak Gonflable 2 Places');
    expect(html).toContain('Book now');
    expect(html).toContain('Pickup &amp; return location');
    expect(html).toContain('Monday');
    expect(html).toContain('value="2026-09-01T10:00"');
    expect(html).toContain('value="2026-09-01T14:00"');
  });

  it('4. Appelle notFound() si getPublicOfferDetails retourne NOT_FOUND', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null);
    vi.mocked(core.getPublicOfferDetails).mockResolvedValue({
      kind: 'NOT_FOUND',
    });

    await expect(
      PublicOfferPage({
        params: Promise.resolve({ locale: 'fr', publicProductId, publicLocationId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalled();
  });

  it('5. OfferBookingForm affiche les options de variantes sans prix individuel', () => {
    const multiVariantOffer: PublicOfferDetails = {
      ...mockOffer,
      variants: [
        {
          publicVariantId: publicVariant1Id,
          name: 'Taille M',
        },
        {
          publicVariantId: publicVariant2Id,
          name: 'Taille L',
        },
      ],
    };

    const html = renderToStaticMarkup(
      <OfferBookingForm offer={multiVariantOffer} locale="fr" isAuthenticated={false} />,
    );

    expect(html).toContain('Taille M');
    expect(html).toContain('Taille L');
    expect(html).toContain(publicVariant1Id);
    expect(html).toContain(publicVariant2Id);
    // Absence de prix individuel sur les variantes
    expect(html).not.toContain('40.00 EUR');
    expect(html).not.toContain('50.00 EUR');
    expect(html).toContain('Réserver');
  });

  describe('Fonctions pures d’idempotence de formulaire', () => {
    const baseParams = {
      publicProductId,
      publicLocationId,
      publicVariantId: publicVariant1Id,
      intentKind: 'DAY_RANGE' as const,
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-03',
    };

    it('A. Même payload soumis deux fois produit la même empreinte et réutilise la même clé', () => {
      const fp1 = computeBookingFormFingerprint(baseParams);
      const fp2 = computeBookingFormFingerprint(baseParams);
      expect(fp1).toBe(fp2);

      const mockUuidGen = vi.fn().mockReturnValue('uuid-key-1');
      const rec1 = getOrCreateIdempotencyKey(null, fp1, mockUuidGen);
      expect(rec1.idempotencyKey).toBe('uuid-key-1');
      expect(mockUuidGen).toHaveBeenCalledTimes(1);

      // Deuxième soumission identique (ex: retry après incident réseau)
      const rec2 = getOrCreateIdempotencyKey(rec1, fp2, mockUuidGen);
      expect(rec2.idempotencyKey).toBe('uuid-key-1');
      expect(mockUuidGen).toHaveBeenCalledTimes(1); // pas de nouvel appel UUID
    });

    it('B. Payload modifié produit une nouvelle empreinte et génère une nouvelle clé', () => {
      const fp1 = computeBookingFormFingerprint(baseParams);
      const fp2 = computeBookingFormFingerprint({
        ...baseParams,
        endDateExclusive: '2026-09-04',
      });
      expect(fp1).not.toBe(fp2);

      const mockUuidGen = vi
        .fn()
        .mockReturnValueOnce('uuid-key-1')
        .mockReturnValueOnce('uuid-key-2');

      const rec1 = getOrCreateIdempotencyKey(null, fp1, mockUuidGen);
      expect(rec1.idempotencyKey).toBe('uuid-key-1');

      const rec2 = getOrCreateIdempotencyKey(rec1, fp2, mockUuidGen);
      expect(rec2.idempotencyKey).toBe('uuid-key-2');
      expect(mockUuidGen).toHaveBeenCalledTimes(2);
    });
  });
});
