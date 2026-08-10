/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Agrégation UTC quotidienne des événements raw vers product_analytics_daily.
 *
 * `aggregateProductAnalyticsDays` :
 * - Valide fromDay, toDayExclusive (YYYY-MM-DD strict).
 * - Valide que la plage est positive et <= 31 jours.
 * - Pour chaque jour dans [fromDay, toDayExclusive) :
 *   a. Acquiert un advisory lock par (day, environment) dans une transaction.
 *   b. Lit les compteurs compactés existants (ou 0n si pas de ligne).
 *   c. Compte les événements raw encore présents pour ce jour+environnement.
 *   d. Calcule : total = compacted + raw.
 *   e. UPSERT : compteurs totaux + compteurs compactés inchangés.
 * - Un jour sans événement produit des zéros (compacted=0, total=0).
 * - Recalcul idempotent (rejeu → même résultat).
 * - Les compteurs compactés ne sont modifiés que par la purge, jamais par l'agrégation.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { productAnalyticsDaily, productAnalyticsEvents } from '@uttily/database';
import { ProductAnalyticsError } from './errors';
import type { AggregateProductAnalyticsDaysOptions } from './types';
import { decodeNonNegativeBigInt, validateDayRange, validateEnvironment } from './validation';

/**
 * Génère une clé de advisory lock déterministe à partir de (day, environment).
 * La clé est un bigint positif sur 63 bits pour pg_advisory_xact_lock.
 */
export function advisoryLockKey(day: string, environment: string): bigint {
  const str = `${day}|${environment}`;
  let hash = 0n;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31n + BigInt(str.charCodeAt(i))) & ((1n << 63n) - 1n);
  }
  return hash;
}

/**
 * Agrège les événements raw en agrégats UTC quotidiens.
 *
 * @param db Client de base de données.
 * @param options Plage de jours [fromDay, toDayExclusive) et environnement.
 * @returns `{ daysProcessed }` — nombre de jours traités.
 * @throws {ProductAnalyticsError} INVALID_DATE, INVALID_DAY_RANGE, RANGE_TOO_LARGE,
 *   INVALID_ENVIRONMENT, ANALYTICS_UNAVAILABLE.
 */
export async function aggregateProductAnalyticsDays(
  db: DatabaseClient,
  options: AggregateProductAnalyticsDaysOptions,
): Promise<{ daysProcessed: number }> {
  validateEnvironment(options.environment);
  const { fromDayNum, dayCount } = validateDayRange(options.fromDay, options.toDayExclusive, 31);

  let daysProcessed = 0;
  for (let offset = 0; offset < dayCount; offset++) {
    const currentDayNum = fromDayNum + offset;
    const dayStr = dayNumberToDate(currentDayNum);

    try {
      await db.transaction(async (tx) => {
        const lockKey = advisoryLockKey(dayStr, options.environment);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()})`);

        const dayStart = new Date(`${dayStr}T00:00:00.000Z`);
        const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        // Lit les compteurs compactés existants.
        const [existing] = await tx
          .select()
          .from(productAnalyticsDaily)
          .where(
            and(
              eq(productAnalyticsDaily.day, dayStr),
              eq(productAnalyticsDaily.environment, options.environment),
            ),
          )
          .limit(1);

        const compactedSearches = existing
          ? decodeNonNegativeBigInt(existing.compactedSearches, 'compactedSearches')
          : 0n;
        const compactedSearchesWithResults = existing
          ? decodeNonNegativeBigInt(
              existing.compactedSearchesWithResults,
              'compactedSearchesWithResults',
            )
          : 0n;
        const compactedBookingAttempts = existing
          ? decodeNonNegativeBigInt(existing.compactedBookingAttempts, 'compactedBookingAttempts')
          : 0n;
        const compactedBookingsConfirmed = existing
          ? decodeNonNegativeBigInt(
              existing.compactedBookingsConfirmed,
              'compactedBookingsConfirmed',
            )
          : 0n;

        // Compte les événements raw encore présents pour ce jour.
        const [counts] = await tx
          .select({
            rawSearches: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'PUBLIC_SEARCH_PERFORMED' THEN 1 ELSE 0 END), 0)::bigint`,
            rawSearchesWithResults: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'PUBLIC_SEARCH_PERFORMED' AND ${productAnalyticsEvents.hasResults} = true THEN 1 ELSE 0 END), 0)::bigint`,
            rawBookingAttempts: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'BOOKING_ATTEMPTED' THEN 1 ELSE 0 END), 0)::bigint`,
            rawBookingsConfirmed: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'BOOKING_CONFIRMED' THEN 1 ELSE 0 END), 0)::bigint`,
          })
          .from(productAnalyticsEvents)
          .where(
            and(
              eq(productAnalyticsEvents.environment, options.environment),
              gte(productAnalyticsEvents.occurredAt, dayStart),
              lt(productAnalyticsEvents.occurredAt, nextDayStart),
            ),
          );

        const rawSearches = decodeNonNegativeBigInt(counts?.rawSearches ?? 0n, 'rawSearches');
        const rawSearchesWithResults = decodeNonNegativeBigInt(
          counts?.rawSearchesWithResults ?? 0n,
          'rawSearchesWithResults',
        );
        const rawBookingAttempts = decodeNonNegativeBigInt(
          counts?.rawBookingAttempts ?? 0n,
          'rawBookingAttempts',
        );
        const rawBookingsConfirmed = decodeNonNegativeBigInt(
          counts?.rawBookingsConfirmed ?? 0n,
          'rawBookingsConfirmed',
        );

        // total = compacted + raw
        const searches = compactedSearches + rawSearches;
        const searchesWithResults = compactedSearchesWithResults + rawSearchesWithResults;
        const bookingAttempts = compactedBookingAttempts + rawBookingAttempts;
        const bookingsConfirmed = compactedBookingsConfirmed + rawBookingsConfirmed;

        await tx
          .insert(productAnalyticsDaily)
          .values({
            day: dayStr,
            environment: options.environment,
            searches,
            searchesWithResults,
            bookingAttempts,
            bookingsConfirmed,
            compactedSearches,
            compactedSearchesWithResults,
            compactedBookingAttempts,
            compactedBookingsConfirmed,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [productAnalyticsDaily.day, productAnalyticsDaily.environment],
            set: {
              searches,
              searchesWithResults,
              bookingAttempts,
              bookingsConfirmed,
              // Les compteurs compactés ne sont PAS modifiés par l'agrégation.
              updatedAt: new Date(),
            },
          });
      });
      daysProcessed++;
    } catch (error) {
      if (error instanceof ProductAnalyticsError) throw error;
      throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'Service analytics indisponible.', {
        cause: error,
      });
    }
  }
  return { daysProcessed };
}

/**
 * Convertit un numéro de jour (depuis l'époque Unix) en chaîne YYYY-MM-DD.
 * Utilise l'objet Date UTC pour éviter les erreurs d'algorithme manuel.
 */
function dayNumberToDate(dayNum: number): string {
  const date = new Date(Date.UTC(1970, 0, 1));
  date.setUTCDate(date.getUTCDate() + dayNum);
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
}
