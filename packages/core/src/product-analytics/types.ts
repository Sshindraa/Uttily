/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Types et contrats du module analytics. Union discriminée pour l'enregistrement
 * d'événements, options pour l'agrégation, la purge et la lecture du résumé.
 */

export type AnalyticsEnvironment = 'DEVELOPMENT' | 'TEST' | 'PRODUCTION';

export type AnalyticsEventType =
  'PUBLIC_SEARCH_PERFORMED' | 'BOOKING_ATTEMPTED' | 'BOOKING_CONFIRMED';

export interface RecordEventCommon {
  environment: AnalyticsEnvironment;
  sourceId: string;
  occurredAt: Date;
}

export type RecordProductAnalyticsEventInput =
  | (RecordEventCommon & { eventType: 'PUBLIC_SEARCH_PERFORMED'; hasResults: boolean })
  | (RecordEventCommon & { eventType: 'BOOKING_ATTEMPTED' })
  | (RecordEventCommon & { eventType: 'BOOKING_CONFIRMED' });

/**
 * Entree d'enregistrement sans environnement (G7H-B).
 * L'environnement est ajoute par le safe recorder a partir du resolveur.
 */
export type SafeRecordEventInput =
  | (Omit<RecordEventCommon, 'environment'> & {
      eventType: 'PUBLIC_SEARCH_PERFORMED';
      hasResults: boolean;
    })
  | (Omit<RecordEventCommon, 'environment'> & { eventType: 'BOOKING_ATTEMPTED' })
  | (Omit<RecordEventCommon, 'environment'> & { eventType: 'BOOKING_CONFIRMED' });

export interface AggregateProductAnalyticsDaysOptions {
  fromDay: string; // YYYY-MM-DD inclusive
  toDayExclusive: string; // YYYY-MM-DD exclusive
  environment: AnalyticsEnvironment;
}

export interface PurgeExpiredProductAnalyticsOptions {
  asOf?: Date;
  rawLimit?: number;
}

export interface PurgeResult {
  rawEventsDeleted: number;
  aggregatesDeleted: number;
}

export interface GetProductAnalyticsSummaryOptions {
  environment: AnalyticsEnvironment;
  fromDay: string; // YYYY-MM-DD inclusive
  toDayExclusive: string; // YYYY-MM-DD exclusive
}

export interface ProductAnalyticsSummary {
  searches: number;
  searchesWithResults: number;
  bookingAttempts: number;
  bookingsConfirmed: number;
}
