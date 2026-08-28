/**
 * apps/web — Maintenance analytics produit (Chantier 18-A).
 *
 * Orchestration de la maintenance déjà livrée par Core (G7H-A) : agrégation
 * quotidienne puis purge avec compaction. Ce module ne contient AUCUNE logique
 * SQL : il délègue intégralement à `aggregateProductAnalyticsDays` et
 * `purgeExpiredProductAnalytics`.
 *
 * Invariants conservés :
 * - La collecte PRODUCTION reste désactivée : l'agrégation de maintenance ne
 *   cible que DEVELOPMENT et TEST. PRODUCTION est exclu du TYPE
 *   (`Exclude<AnalyticsEnvironment, 'PRODUCTION'>`) et de la valeur, donc un
 *   oubli ne compile pas.
 * - La maintenance n'active et ne désactive aucune collecte : elle ne lit et
 *   n'écrit que des compteurs déjà agrégés.
 * - Le rejeu est sûr : l'agrégation est un recalcul idempotent et la purge est
 *   une compaction additive (aucun événement perdu).
 */

import {
  aggregateProductAnalyticsDays,
  purgeExpiredProductAnalytics,
  resolveAnalyticsEnvironmentFromProcessEnv,
  type AnalyticsEnvironment,
  type PurgeResult,
  type ResolvedAnalyticsEnvironment,
} from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

/**
 * Environnements éligibles à l'agrégation de maintenance.
 * PRODUCTION est exclu au niveau du type : la maintenance ne peut pas
 * l'atteindre, même par erreur de saisie.
 */
export type MaintenanceAnalyticsEnvironment = Exclude<AnalyticsEnvironment, 'PRODUCTION'>;

/** Liste fermée et ordonnée des environnements maintenus. */
export const ANALYTICS_MAINTENANCE_ENVIRONMENTS: readonly MaintenanceAnalyticsEnvironment[] = [
  'DEVELOPMENT',
  'TEST',
];

/**
 * Profondeur de rattrapage de la fenêtre d'agrégation, en jours.
 *
 * Un cron quotidien manqué est récupéré sans retraiter l'historique : la
 * fenêtre couvre `LOOKBACK + 1` jours (dont le jour courant). La borne Core
 * autorise 31 jours ; 3 reste très en deçà et borne le coût par exécution.
 */
export const ANALYTICS_AGGREGATION_LOOKBACK_DAYS = 2;

/** Fenêtre [fromDay, toDayExclusive) en jours UTC (YYYY-MM-DD). */
export interface AnalyticsMaintenanceWindow {
  fromDay: string;
  toDayExclusive: string;
}

/** Résultat déterministe de la maintenance : uniquement des compteurs. */
export interface AnalyticsMaintenanceResult {
  window: AnalyticsMaintenanceWindow;
  /** Environnement de collecte résolu au moment de l'exécution (jamais PRODUCTION). */
  collectionEnvironment: ResolvedAnalyticsEnvironment;
  /**
   * Invariant explicite et constant : la maintenance n'active jamais la
   * collecte PRODUCTION. Exposé pour rendre la garantie vérifiable par les
   * tests et lisible dans les journaux.
   */
  productionCollectionEnabled: false;
  aggregatedEnvironments: MaintenanceAnalyticsEnvironment[];
  aggregationDaysProcessed: number;
  purge: PurgeResult;
}

/** Options d'exécution de la maintenance. */
export interface RunProductAnalyticsMaintenanceOptions {
  /** Horloge injectable (défaut : `new Date()`). Rend la fenêtre testable. */
  now?: Date;
}

/** Formate une date en jour UTC `YYYY-MM-DD`. */
function toUtcDayString(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Décale une date UTC d'un nombre entier de jours. */
function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Calcule la fenêtre d'agrégation à partir d'une horloge injectée.
 *
 * Couvre [aujourd'hui - LOOKBACK, aujourd'hui + 1) : le jour courant est
 * inclus et un cron manqué depuis LOOKBACK jours est rattrapé.
 */
export function resolveMaintenanceWindow(now: Date): AnalyticsMaintenanceWindow {
  const today = toUtcDayString(now);
  const from = addUtcDays(today, -ANALYTICS_AGGREGATION_LOOKBACK_DAYS);
  const toExclusive = addUtcDays(today, 1);
  return {
    fromDay: from.toISOString().slice(0, 10),
    toDayExclusive: toExclusive.toISOString().slice(0, 10),
  };
}

/**
 * Exécute la maintenance analytics : agrégation des jours de la fenêtre pour
 * chaque environnement maintenu, puis purge avec compaction.
 *
 * Sûre en rejeu : l'agrégation recalcule des totaux (compacted + raw) et la
 * purge n'efface que des événements déjà compactés dans les compteurs. Une
 * seconde exécution sur la même fenêtre produit le même état.
 *
 * @param db Client de base de données.
 * @param options Horloge injectable.
 * @returns Compteurs déterministes, sans aucune donnée sensible.
 * @throws {ProductAnalyticsError} Erreur Core typée, à borner par l'appelant.
 */
export async function runProductAnalyticsMaintenance(
  db: DatabaseClient,
  options: RunProductAnalyticsMaintenanceOptions = {},
): Promise<AnalyticsMaintenanceResult> {
  const now = options.now ?? new Date();
  const window = resolveMaintenanceWindow(now);

  const aggregatedEnvironments: MaintenanceAnalyticsEnvironment[] = [];
  let aggregationDaysProcessed = 0;

  for (const environment of ANALYTICS_MAINTENANCE_ENVIRONMENTS) {
    const result = await aggregateProductAnalyticsDays(db, {
      fromDay: window.fromDay,
      toDayExclusive: window.toDayExclusive,
      environment,
    });
    aggregatedEnvironments.push(environment);
    aggregationDaysProcessed += result.daysProcessed;
  }

  const purge = await purgeExpiredProductAnalytics(db, { asOf: now });

  return {
    window,
    collectionEnvironment: resolveAnalyticsEnvironmentFromProcessEnv(),
    productionCollectionEnabled: false,
    aggregatedEnvironments,
    aggregationDaysProcessed,
    purge,
  };
}
