import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as auth from '@/lib/auth';
import type { AuthenticatedUser } from '@uttily/core';
import * as core from '@uttily/core';
import AmendmentCheckoutPage from './page';
import {
  SupplementCheckoutClient,
  isHoldExpired,
  mapStripeErrorToSafeMessage,
  canSubmitPayment,
  formatHoldDeadline,
  formatAmount,
} from './supplement-checkout-client';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@clerk/nextjs', () => ({
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  UserButton: () => null,
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
  usePathname: () => '/checkout/amendment/test-amendment',
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

describe('AmendmentCheckoutPage — Server Component (G7M-C5-C)', () => {
  const amendmentId = '11111111-1111-4111-8111-111111111111';
  const mockUser: AuthenticatedUser = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'cust@example.com',
    oidcSubject: 'sub_123',
    emailVerified: true,
    isPlatformAdmin: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. redirige vers /sign-in avec redirect_url interne encodé si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

    await expect(
      AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) }),
    ).rejects.toThrow(
      'REDIRECT:/sign-in?redirect_url=' + encodeURIComponent('/checkout/amendment/' + amendmentId),
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      '/sign-in?redirect_url=' + encodeURIComponent('/checkout/amendment/' + amendmentId),
    );
  });

  it('2. affiche l état NOT_FOUND sans fuite d information', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
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
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'EXPIRED',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Délai de paiement expiré');
    expect(html).toContain('Le délai de 10 minutes pour régler cette modification a expiré');
  });

  it('4. affiche l état PAID', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PAID',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Modification déjà réglée');
  });

  it('5. affiche l état PROCESSING', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PROCESSING',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Paiement en cours de traitement');
  });

  it('6. affiche l état INVALID_STATE', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'INVALID_STATE',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Paiement indisponible');
  });

  it('7. affiche le composant client pour l état PAYABLE avec montant et fuseau', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(mockUser);
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    vi.spyOn(core, 'getSupplementCheckoutSummary').mockResolvedValueOnce({
      kind: 'PAYABLE',
      amountMinor: 5000,
      currency: 'EUR',
      holdDeadline: futureDeadline,
      timeZone: 'Europe/Paris',
    });

    const jsx = await AmendmentCheckoutPage({ params: Promise.resolve({ amendmentId }) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain('Règlement du supplément');
    expect(html).toContain('50,00');
    expect(html).toContain('Préparation du paiement sécurisé…');
    expect(html).not.toContain(amendmentId);
  });
});

describe('SupplementCheckoutClient — Helpers Purs de Logique Client (G7M-C5-C)', () => {
  describe('isHoldExpired', () => {
    it('retourne false si now est strictement avant holdDeadline', () => {
      const future = new Date('2026-06-01T12:00:00.000Z');
      const now = new Date('2026-06-01T11:59:59.000Z').getTime();
      expect(isHoldExpired(future, now)).toBe(false);
    });

    it('retourne true si now est supérieur ou égal au holdDeadline', () => {
      const deadline = new Date('2026-06-01T12:00:00.000Z');
      const nowExact = deadline.getTime();
      const nowAfter = deadline.getTime() + 1000;
      expect(isHoldExpired(deadline, nowExact)).toBe(true);
      expect(isHoldExpired(deadline, nowAfter)).toBe(true);
    });

    it('retourne true si la date est invalide (fail-closed)', () => {
      expect(isHoldExpired('invalid-date')).toBe(true);
    });
  });

  describe('mapStripeErrorToSafeMessage', () => {
    it('mappe card_error et validation_error vers le message de refus sécurisé', () => {
      expect(mapStripeErrorToSafeMessage({ type: 'card_error', message: 'Raw secret leak' })).toBe(
        'Votre moyen de paiement a été refusé ou contient des informations invalides.',
      );
      expect(mapStripeErrorToSafeMessage({ type: 'validation_error', message: 'Raw error' })).toBe(
        'Votre moyen de paiement a été refusé ou contient des informations invalides.',
      );
    });

    it('mappe les autres erreurs Stripe vers un message générique sans fuite', () => {
      expect(mapStripeErrorToSafeMessage({ type: 'api_connection_error' })).toBe(
        'Une erreur est survenue lors de la validation du paiement.',
      );
      expect(mapStripeErrorToSafeMessage(null)).toBe(
        'Une erreur est survenue lors de la validation du paiement.',
      );
      expect(mapStripeErrorToSafeMessage(new Error('Network crash'))).toBe(
        'Une erreur est survenue lors de la validation du paiement.',
      );
    });
  });

  describe('canSubmitPayment', () => {
    const deadlineMs = 1000000;
    const nowMs = 900000;

    it('autorise la soumission si stripe, elements sont présents et non expiré', () => {
      const res = canSubmitPayment({
        stripe: true,
        elements: true,
        submitting: false,
        isExpired: false,
        holdDeadlineMs: deadlineMs,
        nowMs,
      });
      expect(res.canSubmit).toBe(true);
    });

    it('bloque la soumission si déjà en cours de soumission', () => {
      const res = canSubmitPayment({
        stripe: true,
        elements: true,
        submitting: true,
        isExpired: false,
        holdDeadlineMs: deadlineMs,
        nowMs,
      });
      expect(res.canSubmit).toBe(false);
      expect(res.reason).toBe('ALREADY_SUBMITTING');
    });

    it('bloque la soumission si expiré', () => {
      const resExpired = canSubmitPayment({
        stripe: true,
        elements: true,
        submitting: false,
        isExpired: true,
        holdDeadlineMs: deadlineMs,
        nowMs,
      });
      expect(resExpired.canSubmit).toBe(false);
      expect(resExpired.reason).toBe('EXPIRED');

      const resAfterDeadline = canSubmitPayment({
        stripe: true,
        elements: true,
        submitting: false,
        isExpired: false,
        holdDeadlineMs: deadlineMs,
        nowMs: deadlineMs + 1,
      });
      expect(resAfterDeadline.canSubmit).toBe(false);
      expect(resAfterDeadline.reason).toBe('EXPIRED');
    });

    it('bloque la soumission si stripe ou elements sont absents', () => {
      const resNoStripe = canSubmitPayment({
        stripe: false,
        elements: true,
        submitting: false,
        isExpired: false,
        holdDeadlineMs: deadlineMs,
        nowMs,
      });
      expect(resNoStripe.canSubmit).toBe(false);
      expect(resNoStripe.reason).toBe('MISSING_STRIPE');

      const resNoElements = canSubmitPayment({
        stripe: true,
        elements: false,
        submitting: false,
        isExpired: false,
        holdDeadlineMs: deadlineMs,
        nowMs,
      });
      expect(resNoElements.canSubmit).toBe(false);
      expect(resNoElements.reason).toBe('MISSING_ELEMENTS');
    });
  });

  describe('formatHoldDeadline & formatAmount', () => {
    it('formate le montant en euros', () => {
      expect(formatAmount(5000, 'EUR')).toContain('50,00');
    });

    it('formate la date avec le fuseau horaire spécifié', () => {
      const formatted = formatHoldDeadline('2026-06-01T10:30:00.000Z', 'Europe/Paris');
      expect(formatted).not.toBe('date non disponible');
      expect(formatted).toMatch(/\d/);
    });

    it('retourne date non disponible pour une date invalide', () => {
      expect(formatHoldDeadline('invalid-iso', 'Europe/Paris')).toBe('date non disponible');
    });
  });
});

describe('SupplementCheckoutClient — Rendu Statique (G7M-C5-C)', () => {
  const defaultProps = {
    amendmentId: '11111111-1111-4111-8111-111111111111',
    amountMinor: 3500,
    currency: 'EUR',
    holdDeadline: new Date(Date.now() + 600_000).toISOString(),
    timeZone: 'Europe/Paris',
  };

  it('1. affiche le montant formaté, le statut de préparation et ne divulgue pas l UUID', () => {
    const html = renderToStaticMarkup(<SupplementCheckoutClient {...defaultProps} />);
    expect(html).toContain('35,00');
    expect(html).toContain('Préparation du paiement sécurisé…');
    expect(html).toContain('Échéance de réservation');
    expect(html).not.toContain(defaultProps.amendmentId);
  });

  it('2. affiche la section expirée sans divulgation d UUID si le hold est expiré', () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const html = renderToStaticMarkup(
      <SupplementCheckoutClient {...defaultProps} holdDeadline={pastDeadline} />,
    );
    expect(html).toContain('Délai de paiement expiré');
    expect(html).toContain('Le délai de 10 minutes pour régler cette modification a expiré');
    expect(html).not.toContain(defaultProps.amendmentId);
  });
});
