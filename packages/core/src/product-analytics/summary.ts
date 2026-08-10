/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Lecture du résumé agrégé des quatre mesures produit sur une plage de jours.
 *
 * `getProductAnalyticsSummary` :
 * - Valide environnement, fromDay, toDayExclusive.
 * - Valide que la plage est positive et <= 366 jours.
 * - Interroge product_analytics_daily pour [fromDay, toDayExclusive) et environnement.
 * - Sommer les quatre compteurs.
 * - Convertit BIGINT en number avec vérification d'overflow.
 * - Retourne { searches, searchesWithResults, bookingAttempts, bookingsConfirmed }.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { productAnalyticsDaily } from '@uttily/database';
import { ProductAnalyticsError } from './errors';
import type { GetProductAnalyticsSummaryOptions, ProductAnalyticsSummary } from './types';
import {
  decodeNonNegativeBigInt,
  safeBigIntToNumber,
  validateDayRange,
  validateEnvironment,
} from './validation';

/**
 * Retourne le résumé agrégé des quatre mesures produit sur la plage de jours.
 *
 * @param db Client de base de données.
 * @param options Environnement et plage [fromDay, toDayExclusive).
 * @returns Les quatre compteurs sommés sur la plage.
 * @throws {ProductAnalyticsError} INVALID_ENVIRONMENT, INVALID_DATE,
 *   INVALID_DAY_RANGE, RANGE_TOO_LARGE, OVERFLOW, ANALYTICS_UNAVAILABLE.
 */
export async function getProductAnalyticsSummary(
  db: DatabaseClient,
  options: GetProductAnalyticsSummaryOptions,
): Promise<ProductAnalyticsSummary> {
  validateEnvironment(options.environment);
  validateDayRange(options.fromDay, options.toDayExclusive, 366);

  try {
    const [row] = await db
      .select({
        searches: sql<bigint>`COALESCE(SUM(${productAnalyticsDaily.searches}), 0)::bigint`,
        searchesWithResults: sql<bigint>`COALESCE(SUM(${productAnalyticsDaily.searchesWithResults}), 0)::bigint`,
        bookingAttempts: sql<bigint>`COALESCE(SUM(${productAnalyticsDaily.bookingAttempts}), 0)::bigint`,
        bookingsConfirmed: sql<bigint>`COALESCE(SUM(${productAnalyticsDaily.bookingsConfirmed}), 0)::bigint`,
      })
      .from(productAnalyticsDaily)
      .where(
        and(
          eq(productAnalyticsDaily.environment, options.environment),
          gte(productAnalyticsDaily.day, options.fromDay),
          lt(productAnalyticsDaily.day, options.toDayExclusive),
        ),
      );

    return {
      searches: safeBigIntToNumber(decodeNonNegativeBigInt(row?.searches ?? 0n, 'searches')),
      searchesWithResults: safeBigIntToNumber(
        decodeNonNegativeBigInt(row?.searchesWithResults ?? 0n, 'searchesWithResults'),
      ),
      bookingAttempts: safeBigIntToNumber(
        decodeNonNegativeBigInt(row?.bookingAttempts ?? 0n, 'bookingAttempts'),
      ),
      bookingsConfirmed: safeBigIntToNumber(
        decodeNonNegativeBigInt(row?.bookingsConfirmed ?? 0n, 'bookingsConfirmed'),
      ),
    };
  } catch (error) {
    if (error instanceof ProductAnalyticsError) {
      throw error;
    }
    throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'Service analytics indisponible.', {
      cause: error,
    });
  }
}
