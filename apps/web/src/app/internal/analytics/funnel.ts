/**
 * /internal/analytics — Modèle de lecture du funnel interne (Chantier 18-A).
 *
 * Surface STRICTEMENT INTERNE Uttily (back-office), jamais exposée aux Pros.
 *
 * Ce module est PUR : il ne touche ni à la base, ni à l'authentification. Il
 * transforme les agrégats privacy-safe déjà livrés par Core en un modèle
 * affichable, et dérive les ratios côté présentation.
 *
 * Confidentialité — le funnel n'affiche QUE les quatre compteurs agrégés :
 * - aucune dimension personnelle ;
 * - aucun customerId, organizationId, adresse IP ;
 * - aucune destination, produit, SKU ni identifiant Stripe.
 */

import type { ProductAnalyticsSummary, ResolvedAnalyticsEnvironment } from '@uttily/core';
import type { MaintenanceAnalyticsEnvironment } from '@/lib/product-analytics-maintenance';

/** Périodes affichables. */
export type FunnelRangeDays = 7 | 30;

/** Périodes autorisées, fermées et ordonnées. */
export const FUNNEL_RANGES: readonly FunnelRangeDays[] = [7, 30];

/** Période par défaut. */
export const DEFAULT_FUNNEL_RANGE: FunnelRangeDays = 7;

/** Environnements affichés, toujours séparés et jamais fusionnés. */
export const FUNNEL_ENVIRONMENTS: readonly MaintenanceAnalyticsEnvironment[] = [
  'DEVELOPMENT',
  'TEST',
];

/**
 * Message de vérité affiché en permanence : la collecte PRODUCTION est
 * désactivée par construction (verrou G7H-B), aucune donnée de production
 * n'est donc collectée, agrégée ni affichée ici.
 */
export const PRODUCTION_COLLECTION_NOTICE =
  "Collecte PRODUCTION désactivée : aucune donnée de production n'est collectée, agrégée ni affichée dans cette page.";

/** Fenêtre [fromDay, toDayExclusive) en jours UTC (YYYY-MM-DD). */
export interface FunnelWindow {
  fromDay: string;
  toDayExclusive: string;
}

/**
 * Ratios dérivés côté présentation.
 *
 * `null` signifie « dénominateur nul » : l'UI affiche alors un tiret et non
 * `NaN`, `Infinity` ou `0 %`, qui seraient des affirmations fausses.
 */
export interface FunnelRatios {
  /** Taux recherche → résultat. */
  searchToResultRate: number | null;
  /** Taux tentative → confirmation. */
  attemptToConfirmationRate: number | null;
}

/** Bloc affichable pour un environnement donné. */
export interface FunnelEnvironmentView {
  environment: MaintenanceAnalyticsEnvironment;
  summary: ProductAnalyticsSummary;
  ratios: FunnelRatios;
}

/** Modèle complet transmis à la vue. */
export interface InternalFunnelView {
  rangeDays: FunnelRangeDays;
  window: FunnelWindow;
  /** Environnement de collecte résolu au moment de la lecture. */
  collectionEnvironment: ResolvedAnalyticsEnvironment;
  /** Invariant constant, affiché et vérifiable. */
  productionCollectionEnabled: false;
  productionNotice: string;
  environments: FunnelEnvironmentView[];
}

/** Entrée de construction du modèle. */
export interface BuildInternalFunnelViewInput {
  rangeDays: FunnelRangeDays;
  window: FunnelWindow;
  collectionEnvironment: ResolvedAnalyticsEnvironment;
  summaries: Record<MaintenanceAnalyticsEnvironment, ProductAnalyticsSummary>;
}

/**
 * Parse une période depuis un paramètre d'URL.
 * Toute valeur absente ou non autorisée retombe sur la période par défaut :
 * aucune période arbitraire n'est acceptée (pas de fuite d'historique).
 */
export function parseFunnelRange(value: string | undefined): FunnelRangeDays {
  if (value === '30') return 30;
  return DEFAULT_FUNNEL_RANGE;
}

/**
 * Calcule la fenêtre des N derniers jours, jour courant inclus :
 * [aujourd'hui - (N - 1), aujourd'hui + 1).
 */
export function resolveFunnelWindow(now: Date, days: FunnelRangeDays): FunnelWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const from = new Date(today.getTime());
  from.setUTCDate(from.getUTCDate() - (days - 1));

  const toExclusive = new Date(today.getTime());
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  return {
    fromDay: from.toISOString().slice(0, 10),
    toDayExclusive: toExclusive.toISOString().slice(0, 10),
  };
}

/**
 * Dérive les deux ratios du funnel depuis les compteurs agrégés.
 *
 * Dénominateur nul → `null` (et non 0, NaN ou Infinity) : on ne peut pas
 * affirmer un taux sans dénominateur.
 */
export function deriveFunnelRatios(summary: ProductAnalyticsSummary): FunnelRatios {
  return {
    searchToResultRate:
      summary.searches === 0 ? null : summary.searchesWithResults / summary.searches,
    attemptToConfirmationRate:
      summary.bookingAttempts === 0 ? null : summary.bookingsConfirmed / summary.bookingAttempts,
  };
}

/**
 * Formate un ratio en pourcentage lisible.
 * `null` (dénominateur nul) → tiret. Format déterministe, indépendant de la
 * locale du serveur.
 */
export function formatFunnelRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1).replace('.', ',')} %`;
}

/**
 * Formate un compteur entier avec groupement des milliers.
 *
 * Implémentation manuelle volontaire : `toLocaleString` dépend de la version
 * d'ICU du runtime et rendrait les assertions non déterministes. Le séparateur
 * est une espace fine insécable (U+202F), conforme à la convention française.
 */
export function formatFunnelCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Construit le modèle complet, ratios inclus. */
export function buildInternalFunnelView(input: BuildInternalFunnelViewInput): InternalFunnelView {
  const environments: FunnelEnvironmentView[] = FUNNEL_ENVIRONMENTS.map((environment) => ({
    environment,
    summary: input.summaries[environment],
    ratios: deriveFunnelRatios(input.summaries[environment]),
  }));

  return {
    rangeDays: input.rangeDays,
    window: input.window,
    collectionEnvironment: input.collectionEnvironment,
    productionCollectionEnabled: false,
    productionNotice: PRODUCTION_COLLECTION_NOTICE,
    environments,
  };
}
