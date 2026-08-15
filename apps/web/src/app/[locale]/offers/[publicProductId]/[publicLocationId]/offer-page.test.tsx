import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as auth from '@/lib/auth';
import * as core from '@uttily/core';
import type { PublicOfferDetails } from '@uttily/core';
import PublicOfferPage from './page';
import { OfferBookingForm } from './offer-booking-form';

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

describe('PublicOfferPage — Server Component & OfferBookingForm', () => {
  const publicProductId = '11111111-1111-4111-8111-111111111111';
  const publicLocationId = '22222222-2222-4222-8222-222222222222';
  const internalOrgId = '99999999-9999-4999-8999-999999999999';

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
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Modèle Standard',
        skuSuffix: null,
        attributes: {},
        dailyPriceAmountMinor: 4500,
        currency: 'EUR',
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

    // Absence de fuite d'IDs internes sensibles
    expect(html).not.toContain(internalOrgId);
  });

  it('2. Renders public offer details in English', async () => {
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

  it('3. Appelle notFound() si getPublicOfferDetails retourne NOT_FOUND', async () => {
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

  it('4. OfferBookingForm renders multi-variants option list if more than 1 variant', () => {
    const multiVariantOffer: PublicOfferDetails = {
      ...mockOffer,
      variants: [
        {
          id: '11111111-0000-0000-0000-000000000001',
          name: 'Taille M',
          skuSuffix: 'M',
          attributes: {},
          dailyPriceAmountMinor: 4000,
          currency: 'EUR',
        },
        {
          id: '11111111-0000-0000-0000-000000000002',
          name: 'Taille L',
          skuSuffix: 'L',
          attributes: {},
          dailyPriceAmountMinor: 5000,
          currency: 'EUR',
        },
      ],
    };

    const html = renderToStaticMarkup(
      <OfferBookingForm
        offer={multiVariantOffer}
        locale="fr"
        isAuthenticated={false}
      />,
    );

    expect(html).toContain('Taille M');
    expect(html).toContain('40.00 EUR');
    expect(html).toContain('Taille L');
    expect(html).toContain('50.00 EUR');
    expect(html).toContain('Réserver');
  });
});
