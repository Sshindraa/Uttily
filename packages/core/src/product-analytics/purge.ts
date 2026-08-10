/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Purge des événements raw expirés (90 jours) et des agrégats expirés (24 mois)
 * avec le modèle de compaction.
 *
 * `purgeExpiredProductAnalytics` :
 * - Capture asOf une fois (défaut : new Date()).
 * - Valide asOf (Date finie, représentable).
 * - Normalise rawLimit (défaut 1000, max 5000, fail-closed sur invalide).
 * - Exécute sélection, compaction, upsert et deletions dans une SEULE transaction.
 * - Refuse asOf dans le futur par rapport à l'horloge PostgreSQL (SELECT now()).
 * - Sélectionne au plus rawLimit candidats avec ordre déterministe
 *   (occurred_at ASC, id ASC) SANS row lock (juste pour identifier les groupes
 *   et partitionner le budget). Les row locks sont acquis ultérieurement.
 * - Groupe les candidats par (jour UTC, environnement), trié pour éviter les deadlocks.
 * - Pour chaque groupe :
 *   a. Acquiert un advisory lock par (day, environment) EN PREMIER.
 *   b. Re-sélectionne et verrouille les lignes réelles avec FOR UPDATE SKIP LOCKED
 *      dans le scope de l'advisory lock (ordre : advisory lock -> row lock).
 *   c. Lit les compteurs compactés existants.
 *   d. Compte TOUS les événements raw encore présents (avant suppression).
 *   e. Compte les candidats verrouillés par type (en TypeScript).
 *   f. new compacted = old compacted + candidats.
 *   g. total = old compacted + tous les raw (avant suppression).
 *   h. UPSERT avec total + new compacted.
 *   i. Supprime uniquement les candidats verrouillés de ce groupe.
 * - Purge les agrégats expirés (24 mois), bornée par rawLimit.
 *   Lock order : advisory lock FIRST, puis row lock (FOR UPDATE sur re-read).
 *   Un agrégat n'est supprimé que si AUCUN événement raw ne reste pour ce jour.
 * - Retourne { rawEventsDeleted, aggregatesDeleted }.
 *
 * Modèle de compaction :
 * - Les compteurs compactés accumulent les contributions des événements supprimés.
 * - Les compteurs publics (total) = compacted + raw encore présent.
 * - Cela garantit que les purges bornées successives ne perdent pas d'événements.
 */

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { productAnalyticsDaily, productAnalyticsEvents } from '@uttily/database';
import { ProductAnalyticsError } from './errors';
import type {
  AnalyticsEnvironment,
  PurgeExpiredProductAnalyticsOptions,
  PurgeResult,
} from './types';
import {
  calculateAggregateRetentionBoundary,
  calculateRawRetentionBoundary,
  decodeNonNegativeBigInt,
  normalizeRawLimit,
  validateAsOfRepresentable,
} from './validation';
import { advisoryLockKey } from './aggregate';

/**
 * Purge les événements raw expirés et les agrégats expirés.
 *
 * @param db Client de base de données.
 * @param options asOf optionnel (défaut : now), rawLimit optionnel (défaut 1000, max 5000).
 * @returns `{ rawEventsDeleted, aggregatesDeleted }`.
 * @throws {ProductAnalyticsError} INVALID_INPUT, ANALYTICS_UNAVAILABLE.
 */
export async function purgeExpiredProductAnalytics(
  db: DatabaseClient,
  options: PurgeExpiredProductAnalyticsOptions = {},
): Promise<PurgeResult> {
  const asOf = options.asOf ?? new Date();
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) {
    throw new ProductAnalyticsError('INVALID_INPUT', 'asOf invalide.');
  }
  validateAsOfRepresentable(asOf);
  const rawLimit = normalizeRawLimit(options.rawLimit);
  const rawBoundary = calculateRawRetentionBoundary(asOf);

  try {
    return await db.transaction(async (tx) => {
      // 1. Refuse future asOf relative to PostgreSQL clock.
      const nowResult = await tx.execute(sql`SELECT now() AS now`);
      const pgNowRaw = (nowResult[0] as unknown as { now: Date | string }).now;
      const pgNow = pgNowRaw instanceof Date ? pgNowRaw : new Date(pgNowRaw);
      if (asOf.getTime() > pgNow.getTime()) {
        throw new ProductAnalyticsError('INVALID_INPUT', 'asOf ne peut pas être dans le futur.');
      }

      // 2. Select at most rawLimit candidate keys WITHOUT row lock (just to
      //    identify the groups and partition the budget deterministically).
      //    Row locks are acquired later, within the advisory lock scope, to
      //    ensure consistent lock ordering: advisory lock FIRST, then row lock
      //    (matching the aggregate purge phase and preventing deadlocks).
      const candidates = await tx
        .select({
          id: productAnalyticsEvents.id,
          occurredAt: productAnalyticsEvents.occurredAt,
          environment: productAnalyticsEvents.environment,
        })
        .from(productAnalyticsEvents)
        .where(lt(productAnalyticsEvents.occurredAt, rawBoundary))
        .orderBy(productAnalyticsEvents.occurredAt, productAnalyticsEvents.id)
        .limit(rawLimit);

      // 3. Group by (UTC day, environment), sorted to avoid deadlocks.
      //    Only the group key (day, environment) is needed here — the actual
      //    rows are re-selected and locked per group within the advisory lock.
      const groups = new Map<
        string,
        {
          day: string;
          environment: string;
        }
      >();
      for (const c of candidates) {
        const day = c.occurredAt.toISOString().slice(0, 10);
        const key = `${day}|${c.environment}`;
        if (!groups.has(key)) {
          groups.set(key, { day, environment: c.environment });
        }
      }

      // Sort groups by (day, environment) for deterministic lock ordering.
      const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

      // 4. For each group: acquire advisory lock FIRST, then re-select and lock
      //    the actual rows with FOR UPDATE SKIP LOCKED within the advisory lock
      //    scope. This ensures lock order is always: advisory lock -> row lock,
      //    matching the aggregate purge phase and preventing deadlocks between
      //    concurrent purges or between purge and aggregation.
      let rawEventsDeleted = 0;
      let remainingBudget = rawLimit;
      for (const [, g] of sortedGroups) {
        if (remainingBudget <= 0) break;

        const lockKey = advisoryLockKey(g.day, g.environment);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()})`);

        const dayStart = new Date(`${g.day}T00:00:00.000Z`);
        const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        // 4a. Re-select and lock the actual candidate rows for this group,
        //     within the advisory lock scope. FOR UPDATE SKIP LOCKED partitions
        //     rows between concurrent purges that somehow reach the same group
        //     (should not happen with advisory locks, but kept for safety).
        const lockedCandidates = await tx
          .select({
            id: productAnalyticsEvents.id,
            occurredAt: productAnalyticsEvents.occurredAt,
            environment: productAnalyticsEvents.environment,
            eventType: productAnalyticsEvents.eventType,
            hasResults: productAnalyticsEvents.hasResults,
          })
          .from(productAnalyticsEvents)
          .where(
            and(
              eq(productAnalyticsEvents.environment, g.environment as AnalyticsEnvironment),
              gte(productAnalyticsEvents.occurredAt, dayStart),
              lt(productAnalyticsEvents.occurredAt, nextDayStart),
              lt(productAnalyticsEvents.occurredAt, rawBoundary),
            ),
          )
          .orderBy(productAnalyticsEvents.occurredAt, productAnalyticsEvents.id)
          .limit(remainingBudget)
          .for('update', { skipLocked: true });

        // No rows to purge for this group (deleted by a concurrent purge).
        if (lockedCandidates.length === 0) {
          continue;
        }

        // Read existing compacted counters.
        const [existing] = await tx
          .select()
          .from(productAnalyticsDaily)
          .where(
            and(
              eq(productAnalyticsDaily.day, g.day),
              eq(productAnalyticsDaily.environment, g.environment as AnalyticsEnvironment),
            ),
          )
          .limit(1);

        const oldCompactedSearches = existing
          ? decodeNonNegativeBigInt(existing.compactedSearches, 'compactedSearches')
          : 0n;
        const oldCompactedSearchesWithResults = existing
          ? decodeNonNegativeBigInt(
              existing.compactedSearchesWithResults,
              'compactedSearchesWithResults',
            )
          : 0n;
        const oldCompactedBookingAttempts = existing
          ? decodeNonNegativeBigInt(existing.compactedBookingAttempts, 'compactedBookingAttempts')
          : 0n;
        const oldCompactedBookingsConfirmed = existing
          ? decodeNonNegativeBigInt(
              existing.compactedBookingsConfirmed,
              'compactedBookingsConfirmed',
            )
          : 0n;

        // Count ALL raw events still present (before deletion).
        const [allCounts] = await tx
          .select({
            searches: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'PUBLIC_SEARCH_PERFORMED' THEN 1 ELSE 0 END), 0)::bigint`,
            searchesWithResults: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'PUBLIC_SEARCH_PERFORMED' AND ${productAnalyticsEvents.hasResults} = true THEN 1 ELSE 0 END), 0)::bigint`,
            bookingAttempts: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'BOOKING_ATTEMPTED' THEN 1 ELSE 0 END), 0)::bigint`,
            bookingsConfirmed: sql<bigint>`COALESCE(SUM(CASE WHEN ${productAnalyticsEvents.eventType} = 'BOOKING_CONFIRMED' THEN 1 ELSE 0 END), 0)::bigint`,
          })
          .from(productAnalyticsEvents)
          .where(
            and(
              eq(productAnalyticsEvents.environment, g.environment as AnalyticsEnvironment),
              gte(productAnalyticsEvents.occurredAt, dayStart),
              lt(productAnalyticsEvents.occurredAt, nextDayStart),
            ),
          );

        const allSearches = decodeNonNegativeBigInt(allCounts?.searches ?? 0n, 'searches');
        const allSearchesWithResults = decodeNonNegativeBigInt(
          allCounts?.searchesWithResults ?? 0n,
          'searchesWithResults',
        );
        const allBookingAttempts = decodeNonNegativeBigInt(
          allCounts?.bookingAttempts ?? 0n,
          'bookingAttempts',
        );
        const allBookingsConfirmed = decodeNonNegativeBigInt(
          allCounts?.bookingsConfirmed ?? 0n,
          'bookingsConfirmed',
        );

        // Count ONLY the locked candidates by type.
        let candSearches = 0n,
          candSearchesWithResults = 0n,
          candBookingAttempts = 0n,
          candBookingsConfirmed = 0n;
        for (const e of lockedCandidates) {
          if (e.eventType === 'PUBLIC_SEARCH_PERFORMED') {
            candSearches++;
            if (e.hasResults === true) candSearchesWithResults++;
          } else if (e.eventType === 'BOOKING_ATTEMPTED') {
            candBookingAttempts++;
          } else if (e.eventType === 'BOOKING_CONFIRMED') {
            candBookingsConfirmed++;
          }
        }

        // new compacted = old compacted + candidates
        const newCompactedSearches = oldCompactedSearches + candSearches;
        const newCompactedSearchesWithResults =
          oldCompactedSearchesWithResults + candSearchesWithResults;
        const newCompactedBookingAttempts = oldCompactedBookingAttempts + candBookingAttempts;
        const newCompactedBookingsConfirmed = oldCompactedBookingsConfirmed + candBookingsConfirmed;

        // total history = old compacted + all raw (before deletion)
        const totalSearches = oldCompactedSearches + allSearches;
        const totalSearchesWithResults = oldCompactedSearchesWithResults + allSearchesWithResults;
        const totalBookingAttempts = oldCompactedBookingAttempts + allBookingAttempts;
        const totalBookingsConfirmed = oldCompactedBookingsConfirmed + allBookingsConfirmed;

        // UPSERT with both total and new compacted.
        await tx
          .insert(productAnalyticsDaily)
          .values({
            day: g.day,
            environment: g.environment as AnalyticsEnvironment,
            searches: totalSearches,
            searchesWithResults: totalSearchesWithResults,
            bookingAttempts: totalBookingAttempts,
            bookingsConfirmed: totalBookingsConfirmed,
            compactedSearches: newCompactedSearches,
            compactedSearchesWithResults: newCompactedSearchesWithResults,
            compactedBookingAttempts: newCompactedBookingAttempts,
            compactedBookingsConfirmed: newCompactedBookingsConfirmed,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [productAnalyticsDaily.day, productAnalyticsDaily.environment],
            set: {
              searches: totalSearches,
              searchesWithResults: totalSearchesWithResults,
              bookingAttempts: totalBookingAttempts,
              bookingsConfirmed: totalBookingsConfirmed,
              compactedSearches: newCompactedSearches,
              compactedSearchesWithResults: newCompactedSearchesWithResults,
              compactedBookingAttempts: newCompactedBookingAttempts,
              compactedBookingsConfirmed: newCompactedBookingsConfirmed,
              updatedAt: new Date(),
            },
          });

        // Delete ONLY the locked candidates for this group.
        const candidateIds = lockedCandidates.map((e) => e.id);
        const deleted = await tx
          .delete(productAnalyticsEvents)
          .where(inArray(productAnalyticsEvents.id, candidateIds))
          .returning({ id: productAnalyticsEvents.id });
        rawEventsDeleted += deleted.length;
        remainingBudget -= deleted.length;
      }

      // 5. Purge expired aggregates, bounded by rawLimit.
      // Lock order: advisory lock FIRST, then row lock. This matches the
      // aggregation/compaction phase and prevents deadlocks.
      const aggregateBoundary = calculateAggregateRetentionBoundary(asOf);
      const aggregateBoundaryStr = aggregateBoundary.toISOString().slice(0, 10);

      // 5a. Select candidate keys WITHOUT row lock.
      const expiredAggregateKeys = await tx
        .select({ day: productAnalyticsDaily.day, environment: productAnalyticsDaily.environment })
        .from(productAnalyticsDaily)
        .where(lt(productAnalyticsDaily.day, aggregateBoundaryStr))
        .orderBy(productAnalyticsDaily.day, productAnalyticsDaily.environment)
        .limit(rawLimit);

      let aggregatesDeleted = 0;
      for (const agg of expiredAggregateKeys) {
        // 5b. Acquire advisory lock FIRST (matches aggregate/compaction order).
        const lockKey = advisoryLockKey(agg.day, agg.environment);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()})`);

        // 5c. Re-read the exact daily row with FOR UPDATE (now safe — we hold the advisory lock).
        const [existing] = await tx
          .select({ day: productAnalyticsDaily.day })
          .from(productAnalyticsDaily)
          .where(
            and(
              eq(productAnalyticsDaily.day, agg.day),
              eq(productAnalyticsDaily.environment, agg.environment as AnalyticsEnvironment),
            ),
          )
          .for('update')
          .limit(1);

        // 5d. Row may have been deleted by a concurrent purge — skip silently.
        if (!existing) {
          continue;
        }

        // 5e. Check that NO raw events remain for this day+environment.
        const dayStart = new Date(`${agg.day}T00:00:00.000Z`);
        const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const [rawCount] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(productAnalyticsEvents)
          .where(
            and(
              eq(productAnalyticsEvents.environment, agg.environment as AnalyticsEnvironment),
              gte(productAnalyticsEvents.occurredAt, dayStart),
              lt(productAnalyticsEvents.occurredAt, nextDayStart),
            ),
          );

        // 5f. If raw events remain, skip (do NOT delete).
        if ((rawCount?.count ?? 0) > 0) {
          continue;
        }

        // 5g. Delete the aggregate row.
        await tx
          .delete(productAnalyticsDaily)
          .where(
            and(
              eq(productAnalyticsDaily.day, agg.day),
              eq(productAnalyticsDaily.environment, agg.environment as AnalyticsEnvironment),
            ),
          );
        aggregatesDeleted++;
      }

      return { rawEventsDeleted, aggregatesDeleted };
    });
  } catch (error) {
    if (error instanceof ProductAnalyticsError) throw error;
    throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'Service analytics indisponible.', {
      cause: error,
    });
  }
}
