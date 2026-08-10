/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Fondations privacy-first des quatre mesures produit : recherches,
 * résultats disponibles, tentatives de réservation et réservations confirmées.
 * Ledger PostgreSQL append-only borné, agrégats UTC quotidiens, rétention
 * 90 jours (raw) et 24 mois (agrégats). Aucune collecte active dans les
 * parcours applicatifs à ce stade. Production désactivée jusqu'à validation
 * privacy/juridique.
 */

export { ProductAnalyticsError, type ProductAnalyticsErrorCode } from './errors';
export * from './types';
export { recordProductAnalyticsEvent } from './record-event';
export { aggregateProductAnalyticsDays } from './aggregate';
export { purgeExpiredProductAnalytics } from './purge';
export { getProductAnalyticsSummary } from './summary';
export {
  resolveAnalyticsEnvironment,
  resolveAnalyticsEnvironmentWithDiagnostic,
  resolveAnalyticsEnvironmentFromProcessEnv,
  type AnalyticsEnvironmentConfig,
  type ResolvedAnalyticsEnvironment,
  type ResolvedAnalyticsEnvironmentResult,
} from './runtime';
// AnalyticsEnvironment is re-exported from ./types above.
export {
  safeRecordAnalyticsEvent,
  safeRecordAnalyticsEventInTransaction,
  type SafeRecordResult,
} from './safe-record';
