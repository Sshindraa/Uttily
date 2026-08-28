import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorizationError } from '@uttily/core';
import * as auth from '@/lib/auth';
import * as core from '@uttily/core';

import InternalAnalyticsPage from './page';

/**
 * Chantier 18-A — Surface interne /internal/analytics.
 *
 * La garde d'accès N'EST PAS simulée : `@/lib/auth` est le seul point mocké,
 * donc `requireSupportPlatformAdmin` (support-auth) et `requirePlatformAdmin`
 * (Core) s'exécutent réellement. Un utilisateur Pro est donc rejeté par la
 * véritable chaîne d'autorisation, pas par un doublure de test.
 */

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/product-analytics', () => ({
  getAnalyticsEnvironment: vi.fn(() => 'DEVELOPMENT'),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getProductAnalyticsSummary: vi.fn(),
  };
});

/** Utilisateur Pro : authentifié, mais PAS admin plateforme Uttily. */
const PRO_USER = {
  id: 'user-pro-owner',
  email: 'boss@location-pro.fr',
  isPlatformAdmin: false,
  oidcSubject: 'sub_pro_owner',
  emailVerified: true,
};

/** Compte interne Uttily : seul profil autorisé. */
const INTERNAL_ADMIN = {
  id: 'user-uttily-ops',
  email: 'ops@uttily.com',
  isPlatformAdmin: true,
  oidcSubject: 'sub_uttily_ops',
  emailVerified: true,
};

describe('18-A — /internal/analytics : accès strictement interne', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuse l’accès à un utilisateur Pro (OWNER, isPlatformAdmin = false)', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(PRO_USER as never);

    await expect(
      InternalAnalyticsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuse l’accès à un utilisateur non authentifié', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(null as never);

    await expect(InternalAnalyticsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'UNAUTHENTICATED',
    );
  });

  it('n’appelle jamais la lecture analytics pour un utilisateur Pro', async () => {
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(PRO_USER as never);

    await expect(InternalAnalyticsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow();
    expect(core.getProductAnalyticsSummary).not.toHaveBeenCalled();
  });
});

describe('18-A — /internal/analytics : rendu du funnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.getAuthenticatedUser).mockResolvedValue(INTERNAL_ADMIN as never);
    vi.mocked(core.getProductAnalyticsSummary).mockImplementation(async (_db, options) => {
      if (options.environment === 'DEVELOPMENT') {
        return {
          searches: 200,
          searchesWithResults: 50,
          bookingAttempts: 80,
          bookingsConfirmed: 20,
        };
      }
      return { searches: 0, searchesWithResults: 0, bookingAttempts: 0, bookingsConfirmed: 0 };
    });
  });

  async function renderPage(searchParams: Record<string, string> = {}): Promise<string> {
    const element = await InternalAnalyticsPage({
      searchParams: Promise.resolve(searchParams),
    });
    return renderToStaticMarkup(element);
  }

  it('affiche les quatre mesures pour chaque environnement, séparément', async () => {
    const html = await renderPage();

    expect(html).toContain('DEVELOPMENT');
    expect(html).toContain('TEST');
    expect(html).toContain('Recherches');
    expect(html).toContain('Recherches avec résultat');
    expect(html).toContain('Tentatives de réservation');
    expect(html).toContain('Réservations confirmées');
    // Compteurs DEVELOPMENT.
    expect(html).toContain('200');
    expect(html).toContain('50');
    expect(html).toContain('80');
    expect(html).toContain('20');
  });

  it('affiche les deux ratios dérivés', async () => {
    const html = await renderPage();

    expect(html).toContain('Taux recherche');
    expect(html).toContain('Taux tentative');
    // 50/200 = 25,0 % et 20/80 = 25,0 %.
    expect(html).toContain('25,0 %');
  });

  it('affiche un tiret et non 0 % quand le dénominateur est nul', async () => {
    const html = await renderPage();

    // L’environnement TEST est vide : ses deux ratios valent null → « — ».
    expect(html).toContain('—');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('dit explicitement que la collecte PRODUCTION est désactivée', async () => {
    const html = await renderPage();

    expect(html).toContain('PRODUCTION');
    expect(html).toContain('Collecte PRODUCTION');
    // Aucune affirmation trompeuse : on ne prétend jamais afficher la production.
    expect(html).not.toContain('Données PRODUCTION collectées');
  });

  it('ne rend aucune dimension personnelle ni identifiant métier', async () => {
    const html = await renderPage();

    for (const forbidden of [
      'customerId',
      'organizationId',
      'Stripe',
      'SKU',
      'sku',
      'patrick@',
      '@location-pro.fr',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('propose les périodes 7 et 30 jours', async () => {
    const html = await renderPage({ range: '30' });

    expect(html).toContain('7 derniers jours');
    expect(html).toContain('30 derniers jours');
    expect(html).toContain('range=30');
  });

  it('lit les agrégats sur une fenêtre de 30 jours quand la période est 30', async () => {
    await renderPage({ range: '30' });

    const firstCall = vi.mocked(core.getProductAnalyticsSummary).mock.calls[0]!;
    const options = firstCall[1];
    const from = new Date(`${options.fromDay}T00:00:00.000Z`);
    const to = new Date(`${options.toDayExclusive}T00:00:00.000Z`);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(30);
  });
});
