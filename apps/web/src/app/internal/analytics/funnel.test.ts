import { describe, it, expect } from 'vitest';
import type { ProductAnalyticsSummary } from '@uttily/core';
import {
  buildInternalFunnelView,
  deriveFunnelRatios,
  formatFunnelCount,
  formatFunnelRate,
  parseFunnelRange,
  resolveFunnelWindow,
  DEFAULT_FUNNEL_RANGE,
  FUNNEL_ENVIRONMENTS,
  PRODUCTION_COLLECTION_NOTICE,
} from './funnel';

/**
 * Chantier 18-A — Modèle de lecture du funnel interne.
 *
 * Ces tests sont purs et rapides : ils prouvent les calculs du funnel, en
 * particulier le cas du dénominateur nul, qui ne doit produire ni NaN, ni
 * Infinity, ni un faux 0 %.
 */

function summary(overrides: Partial<ProductAnalyticsSummary> = {}): ProductAnalyticsSummary {
  return {
    searches: 0,
    searchesWithResults: 0,
    bookingAttempts: 0,
    bookingsConfirmed: 0,
    ...overrides,
  };
}

describe('18-A — Funnel interne : période et fenêtre', () => {
  it('accepte uniquement 7 ou 30 jours, et retombe sur la période par défaut', () => {
    expect(parseFunnelRange('7')).toBe(7);
    expect(parseFunnelRange('30')).toBe(30);

    // Aucune période arbitraire n'est acceptée : pas de fuite d'historique.
    expect(parseFunnelRange('365')).toBe(DEFAULT_FUNNEL_RANGE);
    expect(parseFunnelRange('0')).toBe(DEFAULT_FUNNEL_RANGE);
    expect(parseFunnelRange('nimportequoi')).toBe(DEFAULT_FUNNEL_RANGE);
    expect(parseFunnelRange(undefined)).toBe(DEFAULT_FUNNEL_RANGE);
  });

  it('la fenêtre 7 jours couvre 7 jours, jour courant inclus', () => {
    const now = new Date('2026-08-28T17:45:00.000Z');
    const window = resolveFunnelWindow(now, 7);

    expect(window.fromDay).toBe('2026-08-22');
    expect(window.toDayExclusive).toBe('2026-08-29');

    const from = new Date(`${window.fromDay}T00:00:00.000Z`);
    const to = new Date(`${window.toDayExclusive}T00:00:00.000Z`);
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBe(7);
  });

  it('la fenêtre 30 jours couvre 30 jours, jour courant inclus', () => {
    const now = new Date('2026-08-28T17:45:00.000Z');
    const window = resolveFunnelWindow(now, 30);

    const from = new Date(`${window.fromDay}T00:00:00.000Z`);
    const to = new Date(`${window.toDayExclusive}T00:00:00.000Z`);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(30);
    expect(window.toDayExclusive).toBe('2026-08-29');
  });

  it('la fenêtre est calculée en UTC et non dans le fuseau du serveur', () => {
    // 2026-01-01T00:30Z : le jour UTC est le 1er, quel que soit le fuseau local.
    const window = resolveFunnelWindow(new Date('2026-01-01T00:30:00.000Z'), 7);
    expect(window.toDayExclusive).toBe('2026-01-02');
    expect(window.fromDay).toBe('2025-12-26');
  });
});

describe('18-A — Funnel interne : ratios et dénominateur zéro', () => {
  it('calcule le taux recherche → résultat', () => {
    const ratios = deriveFunnelRatios(summary({ searches: 200, searchesWithResults: 50 }));
    expect(ratios.searchToResultRate).toBe(0.25);
  });

  it('calcule le taux tentative → confirmation', () => {
    const ratios = deriveFunnelRatios(
      summary({ bookingAttempts: 80, bookingsConfirmed: 20, searches: 10, searchesWithResults: 5 }),
    );
    expect(ratios.attemptToConfirmationRate).toBe(0.25);
  });

  it('dénominateur zéro : les deux ratios sont null, jamais NaN ni Infinity', () => {
    const ratios = deriveFunnelRatios(summary());

    expect(ratios.searchToResultRate).toBeNull();
    expect(ratios.attemptToConfirmationRate).toBeNull();
    expect(Number.isNaN(ratios.searchToResultRate as unknown as number)).toBe(false);
  });

  it('dénominateur zéro sur un seul des deux ratios', () => {
    const ratios = deriveFunnelRatios(summary({ bookingAttempts: 10, bookingsConfirmed: 3 }));

    // Aucune recherche → pas de taux recherche → résultat.
    expect(ratios.searchToResultRate).toBeNull();
    // Des tentatives → taux tentative → confirmation calculable.
    expect(ratios.attemptToConfirmationRate).toBe(0.3);
  });

  it('un ratio nul mais défini reste 0 et non null', () => {
    const ratios = deriveFunnelRatios(summary({ searches: 12, searchesWithResults: 0 }));
    expect(ratios.searchToResultRate).toBe(0);
    expect(formatFunnelRate(ratios.searchToResultRate)).toBe('0,0 %');
  });

  it('formate un dénominateur nul en tiret, jamais en 0 %', () => {
    expect(formatFunnelRate(null)).toBe('—');
    expect(formatFunnelRate(0.256)).toBe('25,6 %');
  });

  it('formate les compteurs de façon déterministe', () => {
    expect(formatFunnelCount(0)).toBe('0');
    expect(formatFunnelCount(999)).toBe('999');
    // Espace fine insécable (U+202F), indépendante de la version d'ICU.
    expect(formatFunnelCount(1234)).toBe('1 234');
    expect(formatFunnelCount(1234567)).toBe('1 234 567');
  });
});

describe('18-A — Funnel interne : modèle et invariants privacy', () => {
  it('sépare explicitement DEVELOPMENT et TEST, jamais fusionnés', () => {
    const view = buildInternalFunnelView({
      rangeDays: 7,
      window: { fromDay: '2026-08-22', toDayExclusive: '2026-08-29' },
      collectionEnvironment: 'DEVELOPMENT',
      summaries: {
        DEVELOPMENT: summary({ searches: 10, searchesWithResults: 4 }),
        TEST: summary({ searches: 3, searchesWithResults: 1 }),
      },
    });

    expect(view.environments.map((e) => e.environment)).toEqual(['DEVELOPMENT', 'TEST']);
    expect(FUNNEL_ENVIRONMENTS).not.toContain('PRODUCTION');
    expect(view.environments[0]!.summary.searches).toBe(10);
    expect(view.environments[1]!.summary.searches).toBe(3);
  });

  it('affirme toujours que la collecte PRODUCTION est désactivée', () => {
    const view = buildInternalFunnelView({
      rangeDays: 30,
      window: { fromDay: '2026-07-30', toDayExclusive: '2026-08-29' },
      collectionEnvironment: 'DISABLED',
      summaries: {
        DEVELOPMENT: summary(),
        TEST: summary(),
      },
    });

    expect(view.productionCollectionEnabled).toBe(false);
    expect(view.productionNotice).toBe(PRODUCTION_COLLECTION_NOTICE);
    expect(view.collectionEnvironment).toBe('DISABLED');
  });

  it('le modèle ne transporte aucune dimension interdite', () => {
    const view = buildInternalFunnelView({
      rangeDays: 7,
      window: { fromDay: '2026-08-22', toDayExclusive: '2026-08-29' },
      collectionEnvironment: 'TEST',
      summaries: {
        DEVELOPMENT: summary({ searches: 1 }),
        TEST: summary({ searches: 2 }),
      },
    });

    // Seules les clés attendues sont présentes : aucun identifiant, aucune IP,
    // aucune destination, aucun produit, aucun SKU, aucun ID Stripe.
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      'customerId',
      'organizationId',
      'ip',
      'destination',
      'productId',
      'sku',
      'stripe',
      'email',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    expect(Object.keys(view.environments[0]!.summary).sort()).toEqual([
      'bookingAttempts',
      'bookingsConfirmed',
      'searches',
      'searchesWithResults',
    ]);
  });
});
