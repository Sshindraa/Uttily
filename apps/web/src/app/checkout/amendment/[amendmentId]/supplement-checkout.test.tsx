import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as auth from '@/lib/auth';
import * as core from '@uttily/core';
import AmendmentCheckoutPage from './page';
import { SupplementCheckoutClient } from './supplement-checkout-client';

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
    getSupplementCheckoutSummary: vi.fn(),
  };
});

const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

describe('AmendmentCheckoutPage — Server Component (G7M-C5-C)', () => {
  const amendmentId = '11111111-1111-4111-8111-111111111111';
  const mockUser = { id: '22222222-2222-4222-8222-222222222222', email: 'cust@example.com' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. redirige vers /sign-in si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    await expect(
      AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) }),
    ).rejects.toThrow('REDIRECT:/sign-in');
    expect(mockRedirect).toHaveBeenCalledWith('/sign-in');
  });

  it('2. affiche l état NOT_FOUND sans fuite d information', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'NOT_FOUND',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Paiement introuvable');
    expect(html).toContain('Ce paiement de modification n&#x27;existe pas');
    expect(html).not.toContain(amendmentId);
  });

  it('3. affiche l état EXPIRED', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'EXPIRED',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Délai de paiement expiré');
    expect(html).toContain('Le délai de 10 minutes pour régler cette modification a expiré');
  });

  it('4. affiche l état PAID', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PAID',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Modification déjà réglée');
  });

  it('5. affiche l état PROCESSING', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PROCESSING',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Paiement en cours de traitement');
  });

  it('6. affiche l état INVALID_STATE', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'INVALID_STATE',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Paiement indisponible');
  });

  it('7. affiche le composant client pour l état PAYABLE avec montant et fuseau', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(
      mockUser as unknown as { id: string },
    );
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PAYABLE',
      amountMinor: 5000,
      currency: 'EUR',
      holdDeadline: '2026-06-01T12:00:00.000Z',
      timeZone: 'Europe/Paris',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Règlement du supplément');
    expect(html).toContain('50,00');
    expect(html).toContain('Payer 50,00');
    expect(html).toContain('Europe/Paris');
    expect(html).not.toContain(amendmentId);
  });
});

describe('SupplementCheckoutClient — Client Component Rendu Initial (G7M-C5-C)', () => {
  const defaultProps = {
    amendmentId: '11111111-1111-4111-8111-111111111111',
    amountMinor: 3500,
    currency: 'EUR',
    holdDeadline: '2026-06-01T12:00:00.000Z',
    timeZone: 'Europe/Paris',
  };

  it('1. affiche le montant formaté et le bouton unique d initiation', () => {
    const html = renderToStaticMarkup(<SupplementCheckoutClient {...defaultProps} />);
    expect(html).toContain('35,00');
    expect(html).toContain('Payer 35,00');
    expect(html).toContain('Échéance de réservation');
    expect(html).toContain('Europe/Paris');
    expect(html).not.toContain(defaultProps.amendmentId);
  });
});
