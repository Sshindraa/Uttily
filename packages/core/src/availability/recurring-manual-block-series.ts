import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import {
  inventoryBlocks,
  inventoryItems,
  locations,
  lockOrganization,
  manualBlockSeries,
  manualBlockSeriesOccurrences,
} from '@uttily/database';
import { isActionErrorCode, type ActionErrorCode } from '@uttily/contracts';
import { CatalogError } from '../catalog/errors';
import { AuthorizationError } from '../identity/permissions';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotencyRecordRow } from '../idempotency';
import {
  calculateWeeklyRecurringManualBlockOccurrences,
  normalizeRecurringManualBlockSchedule,
  RECURRING_MANUAL_BLOCK_FREQUENCY,
  type RecurringManualBlockOccurrencePeriod,
  type RecurringManualBlockScheduleInput,
} from './recurring-manual-block';

export const CREATE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION =
  'CREATE_RECURRING_MANUAL_BLOCK_SERIES';
export const UPDATE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION =
  'UPDATE_RECURRING_MANUAL_BLOCK_SERIES';
export const SUSPEND_RECURRING_MANUAL_BLOCK_SERIES_OPERATION =
  'SUSPEND_RECURRING_MANUAL_BLOCK_SERIES';
export const RESUME_RECURRING_MANUAL_BLOCK_SERIES_OPERATION =
  'RESUME_RECURRING_MANUAL_BLOCK_SERIES';
export const DELETE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION =
  'DELETE_RECURRING_MANUAL_BLOCK_SERIES';
export const RELEASE_RECURRING_MANUAL_BLOCK_OCCURRENCE_OPERATION =
  'RELEASE_RECURRING_MANUAL_BLOCK_OCCURRENCE';

export type RecurringManualBlockSeriesStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface RecurringManualBlockSeriesRecord {
  id: string;
  organizationId: string;
  locationId: string;
  inventoryItemId: string;
  frequency: typeof RECURRING_MANUAL_BLOCK_FREQUENCY;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  status: RecurringManualBlockSeriesStatus;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RecurringManualBlockSeriesOccurrenceRecord {
  id: string;
  seriesId: string;
  inventoryBlockId: string;
  occurrenceDate: string;
  status: 'ACTIVE' | 'RELEASED' | 'PAYMENT_PROCESSING' | 'CONVERTED' | 'EXPIRED';
  blockedStartAt: Date;
  blockedEndAt: Date;
}

export interface CreateRecurringManualBlockSeriesInput extends RecurringManualBlockScheduleInput {
  organizationId: string;
  inventoryItemId: string;
  locationId: string;
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface UpdateRecurringManualBlockSeriesInput {
  organizationId: string;
  seriesId: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface SeriesLifecycleInput {
  organizationId: string;
  seriesId: string;
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface ReleaseRecurringManualBlockOccurrenceInput {
  organizationId: string;
  seriesId: string;
  occurrenceId: string;
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface RecurringManualBlockSeriesMutationResult {
  kind: 'APPLIED' | 'NO_OP';
  seriesId: string;
  status: RecurringManualBlockSeriesStatus;
  occurrenceCount: number;
  createdOccurrenceIds: string[];
  updatedOccurrenceIds: string[];
}

export interface ReleaseRecurringManualBlockOccurrenceResult {
  kind: 'APPLIED' | 'NO_OP';
  seriesId: string;
  occurrenceId: string;
  inventoryBlockId: string;
  status: 'RELEASED';
}

export interface RecurringManualBlockSeriesView {
  series: RecurringManualBlockSeriesRecord;
  occurrences: RecurringManualBlockSeriesOccurrenceRecord[];
}

export interface RecurringManualBlockOperationOptions {
  /** Horloge injectée uniquement par les tests ; les actions ne la contrôlent pas. */
  now?: Date;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

type PersistedFailure = { code: ActionErrorCode; message: string };

/** Liste tenant-safe des séries encore gérables et de leur historique d'occurrences. */
export async function listRecurringManualBlockSeries(
  db: DatabaseClient,
  organizationId: string,
): Promise<RecurringManualBlockSeriesView[]> {
  assertUuid(organizationId, 'organizationId');
  const seriesRows = await db
    .select()
    .from(manualBlockSeries)
    .where(
      and(
        eq(manualBlockSeries.organizationId, organizationId),
        isNull(manualBlockSeries.deletedAt),
      ),
    )
    .orderBy(asc(manualBlockSeries.startDate), asc(manualBlockSeries.id));

  const views: RecurringManualBlockSeriesView[] = [];
  for (const row of seriesRows) {
    const occurrenceRows = await db
      .select({
        id: manualBlockSeriesOccurrences.id,
        seriesId: manualBlockSeriesOccurrences.seriesId,
        inventoryBlockId: manualBlockSeriesOccurrences.inventoryBlockId,
        occurrenceDate: manualBlockSeriesOccurrences.occurrenceDate,
        status: inventoryBlocks.status,
        blockedStartAt: inventoryBlocks.blockedStartAt,
        blockedEndAt: inventoryBlocks.blockedEndAt,
      })
      .from(manualBlockSeriesOccurrences)
      .innerJoin(
        inventoryBlocks,
        eq(manualBlockSeriesOccurrences.inventoryBlockId, inventoryBlocks.id),
      )
      .where(
        and(
          eq(manualBlockSeriesOccurrences.seriesId, row.id),
          eq(inventoryBlocks.organizationId, organizationId),
        ),
      )
      .orderBy(asc(manualBlockSeriesOccurrences.occurrenceDate));
    views.push({
      series: mapSeries(row),
      occurrences: occurrenceRows.map((occurrence) => ({
        id: occurrence.id,
        seriesId: occurrence.seriesId,
        inventoryBlockId: occurrence.inventoryBlockId,
        occurrenceDate: occurrence.occurrenceDate,
        status: occurrence.status as RecurringManualBlockSeriesOccurrenceRecord['status'],
        blockedStartAt: occurrence.blockedStartAt,
        blockedEndAt: occurrence.blockedEndAt,
      })),
    });
  }
  return views;
}

/** Crée la série et toutes ses occurrences dans une transaction unique. */
export async function createRecurringManualBlockSeries(
  db: DatabaseClient,
  input: CreateRecurringManualBlockSeriesInput,
): Promise<RecurringManualBlockSeriesMutationResult> {
  const normalized = normalizeCreateInput(input);
  const schedule = normalizeRecurringManualBlockSchedule(normalized);
  const periods = calculateWeeklyRecurringManualBlockOccurrences(schedule);
  const requestFingerprint = fingerprint({
    organizationId: normalized.organizationId,
    inventoryItemId: normalized.inventoryItemId,
    locationId: normalized.locationId,
    ...schedule,
  });
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: CREATE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') return replaySeriesMutation(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replaySeriesMutation(lock.record);

      await lockOrganization(tx, normalized.organizationId);
      const item = await lockActiveItem(tx, normalized.organizationId, normalized.inventoryItemId);
      const location = await lockLocation(tx, normalized.organizationId, normalized.locationId);
      assertItemAtLocation(item, location.id);
      assertTimeZoneMatches(schedule.timeZone, location.timeZone);

      const [series] = await tx
        .insert(manualBlockSeries)
        .values({
          organizationId: normalized.organizationId,
          locationId: normalized.locationId,
          inventoryItemId: normalized.inventoryItemId,
          frequency: RECURRING_MANUAL_BLOCK_FREQUENCY,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          timeZone: schedule.timeZone,
          status: 'ACTIVE',
          createdBy: normalized.actorUserId ?? null,
        })
        .returning();
      if (!series) throw new CatalogError('UNKNOWN', 'Échec de création de la série.');

      const createdOccurrenceIds: string[] = [];
      for (const period of periods) {
        const created = await insertOccurrence(tx, {
          seriesId: series.id,
          organizationId: normalized.organizationId,
          inventoryItemId: normalized.inventoryItemId,
          period,
          actorUserId: normalized.actorUserId,
        });
        createdOccurrenceIds.push(created.occurrenceId);
      }

      const result: RecurringManualBlockSeriesMutationResult = {
        kind: 'APPLIED',
        seriesId: series.id,
        status: 'ACTIVE',
        occurrenceCount: createdOccurrenceIds.length,
        createdOccurrenceIds,
        updatedOccurrenceIds: [],
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: series.id,
        responseStatusCode: 201,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(
      db,
      reservation.record.id,
      error,
      'La série de blocages n’a pas pu être créée.',
    );
    throw error;
  }
}

/**
 * Modifie le calendrier sans toucher aux occurrences passées ou déjà commencées.
 * Une occurrence active future qui sortirait du nouveau calendrier est refusée :
 * sa libération doit rester une action explicite.
 */
export async function updateRecurringManualBlockSeries(
  db: DatabaseClient,
  input: UpdateRecurringManualBlockSeriesInput,
  options?: RecurringManualBlockOperationOptions,
): Promise<RecurringManualBlockSeriesMutationResult> {
  const normalized = normalizeUpdateInput(input);
  const requestFingerprint = fingerprint({
    organizationId: normalized.organizationId,
    seriesId: normalized.seriesId,
    startDate: normalized.startDate ?? null,
    endDate: normalized.endDate ?? null,
    startTime: normalized.startTime ?? null,
    endTime: normalized.endTime ?? null,
  });
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: UPDATE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') return replaySeriesMutation(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replaySeriesMutation(lock.record);

      await lockOrganization(tx, normalized.organizationId);
      const series = await lockSeries(tx, normalized.organizationId, normalized.seriesId);
      if (series.status === 'DELETED') {
        throw new CatalogError('VALIDATION', 'Une série supprimée ne peut plus être modifiée.');
      }
      const item = await lockActiveItem(tx, normalized.organizationId, series.inventoryItemId);
      const location = await lockLocation(tx, normalized.organizationId, series.locationId);
      assertItemAtLocation(item, location.id);
      assertTimeZoneMatches(series.timeZone, location.timeZone);

      const schedule = normalizeRecurringManualBlockSchedule({
        frequency: series.frequency,
        startDate: normalized.startDate ?? series.startDate,
        endDate: normalized.endDate ?? series.endDate,
        startTime: normalized.startTime ?? series.startTime,
        endTime: normalized.endTime ?? series.endTime,
        timeZone: series.timeZone,
      });
      const periods = calculateWeeklyRecurringManualBlockOccurrences(schedule);
      const existing = await lockSeriesOccurrences(tx, series.id);
      const existingByDate = new Map(existing.map((row) => [row.occurrenceDate, row]));
      const proposedByDate = new Map(periods.map((period) => [period.occurrenceDate, period]));
      const now = options?.now ?? new Date();

      for (const row of existing) {
        if (
          row.status === 'ACTIVE' &&
          row.blockedStartAt > now &&
          !proposedByDate.has(row.occurrenceDate)
        ) {
          throw new CatalogError(
            'CONFLICT_BLOCK',
            'La modification supprimerait un blocage futur actif. Libérez cette occurrence explicitement avant de réduire la série.',
          );
        }
      }

      const createdOccurrenceIds: string[] = [];
      const updatedOccurrenceIds: string[] = [];
      if (series.status === 'ACTIVE') {
        for (const period of periods) {
          const current = existingByDate.get(period.occurrenceDate);
          if (!current) {
            // Une modification ne fabrique jamais rétroactivement une
            // occurrence déjà passée ou commencée.
            if (period.startAt <= now) continue;
            const created = await insertOccurrence(tx, {
              seriesId: series.id,
              organizationId: series.organizationId,
              inventoryItemId: series.inventoryItemId,
              period,
              actorUserId: normalized.actorUserId,
            });
            createdOccurrenceIds.push(created.occurrenceId);
            continue;
          }

          if (current.status === 'ACTIVE' && current.blockedStartAt > now) {
            if (period.startAt <= now) {
              throw new CatalogError(
                'VALIDATION',
                'La modification ne peut pas déplacer une occurrence future vers une période déjà commencée.',
              );
            }
            if (
              current.blockedStartAt.getTime() === period.startAt.getTime() &&
              current.blockedEndAt.getTime() === period.endAt.getTime()
            ) {
              continue;
            }
            await updateOccurrencePeriod(tx, current.inventoryBlockId, period);
            updatedOccurrenceIds.push(current.id);
          }
        }
      } else {
        // Une série suspendue garde ses lignes d'audit et ne matérialise rien
        // de nouveau jusqu'à une reprise explicite.
        for (const period of periods) {
          const current = existingByDate.get(period.occurrenceDate);
          if (current && current.status === 'ACTIVE' && current.blockedStartAt > now) {
            if (period.startAt <= now) {
              throw new CatalogError(
                'VALIDATION',
                'La modification ne peut pas déplacer une occurrence future vers une période déjà commencée.',
              );
            }
            if (
              current.blockedStartAt.getTime() === period.startAt.getTime() &&
              current.blockedEndAt.getTime() === period.endAt.getTime()
            ) {
              continue;
            }
            await updateOccurrencePeriod(tx, current.inventoryBlockId, period);
            updatedOccurrenceIds.push(current.id);
          }
        }
      }

      const [updatedSeries] = await tx
        .update(manualBlockSeries)
        .set({
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          updatedAt: new Date(),
        })
        .where(eq(manualBlockSeries.id, series.id))
        .returning();
      if (!updatedSeries) throw new CatalogError('NOT_FOUND', 'Série introuvable.');

      const result: RecurringManualBlockSeriesMutationResult = {
        kind: createdOccurrenceIds.length + updatedOccurrenceIds.length > 0 ? 'APPLIED' : 'NO_OP',
        seriesId: series.id,
        status: updatedSeries.status as RecurringManualBlockSeriesStatus,
        occurrenceCount: existing.length + createdOccurrenceIds.length,
        createdOccurrenceIds,
        updatedOccurrenceIds,
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: series.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(
      db,
      reservation.record.id,
      error,
      'La série de blocages n’a pas pu être modifiée.',
    );
    throw error;
  }
}

/** Suspend le cycle sans libérer les occurrences déjà matérialisées. */
export async function suspendRecurringManualBlockSeries(
  db: DatabaseClient,
  input: SeriesLifecycleInput,
): Promise<RecurringManualBlockSeriesMutationResult> {
  return transitionSeries(db, input, SUSPEND_RECURRING_MANUAL_BLOCK_SERIES_OPERATION, 'SUSPENDED');
}

/** Reprend explicitement une série et matérialise sa fenêtre restante. */
export async function resumeRecurringManualBlockSeries(
  db: DatabaseClient,
  input: SeriesLifecycleInput,
  options?: RecurringManualBlockOperationOptions,
): Promise<RecurringManualBlockSeriesMutationResult> {
  const normalized = normalizeLifecycleInput(input);
  const fingerprintValue = fingerprint(normalized);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: RESUME_RECURRING_MANUAL_BLOCK_SERIES_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint: fingerprintValue,
  });
  if (reservation.kind === 'REPLAY') return replaySeriesMutation(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replaySeriesMutation(lock.record);
      await lockOrganization(tx, normalized.organizationId);
      const series = await lockSeries(tx, normalized.organizationId, normalized.seriesId);
      if (series.status === 'DELETED') {
        throw new CatalogError('VALIDATION', 'Une série supprimée ne peut pas être reprise.');
      }
      const item = await lockActiveItem(tx, normalized.organizationId, series.inventoryItemId);
      const location = await lockLocation(tx, normalized.organizationId, series.locationId);
      assertItemAtLocation(item, location.id);
      assertTimeZoneMatches(series.timeZone, location.timeZone);
      const schedule = normalizeRecurringManualBlockSchedule(series);
      const periods = calculateWeeklyRecurringManualBlockOccurrences(schedule);
      const existing = await lockSeriesOccurrences(tx, series.id);
      const existingDates = new Set(existing.map((row) => row.occurrenceDate));
      const now = options?.now ?? new Date();
      const createdOccurrenceIds: string[] = [];

      if (series.status === 'SUSPENDED') {
        for (const period of periods) {
          if (period.startAt <= now || existingDates.has(period.occurrenceDate)) continue;
          const created = await insertOccurrence(tx, {
            seriesId: series.id,
            organizationId: series.organizationId,
            inventoryItemId: series.inventoryItemId,
            period,
            actorUserId: normalized.actorUserId,
          });
          createdOccurrenceIds.push(created.occurrenceId);
        }
      }

      const [updatedSeries] = await tx
        .update(manualBlockSeries)
        .set({ status: 'ACTIVE', updatedAt: new Date() })
        .where(eq(manualBlockSeries.id, series.id))
        .returning();
      if (!updatedSeries) throw new CatalogError('NOT_FOUND', 'Série introuvable.');

      const result: RecurringManualBlockSeriesMutationResult = {
        kind: series.status === 'SUSPENDED' ? 'APPLIED' : 'NO_OP',
        seriesId: series.id,
        status: 'ACTIVE',
        occurrenceCount: existing.length + createdOccurrenceIds.length,
        createdOccurrenceIds,
        updatedOccurrenceIds: [],
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: series.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(
      db,
      reservation.record.id,
      error,
      'La série de blocages n’a pas pu être reprise.',
    );
    throw error;
  }
}

/** Suppression logique : les occurrences existantes restent auditables et actives. */
export async function deleteRecurringManualBlockSeries(
  db: DatabaseClient,
  input: SeriesLifecycleInput,
): Promise<RecurringManualBlockSeriesMutationResult> {
  const normalized = normalizeLifecycleInput(input);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: DELETE_RECURRING_MANUAL_BLOCK_SERIES_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint: fingerprint(normalized),
  });
  if (reservation.kind === 'REPLAY') return replaySeriesMutation(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replaySeriesMutation(lock.record);
      await lockOrganization(tx, normalized.organizationId);
      const series = await lockSeries(tx, normalized.organizationId, normalized.seriesId);
      if (series.status === 'DELETED') {
        const result = noOpSeriesResult(series, 'DELETED');
        await completeKey(tx, reservation.record.id, {
          resourceId: series.id,
          responseStatusCode: 200,
          responseBody: result,
        });
        return result;
      }
      const [updatedSeries] = await tx
        .update(manualBlockSeries)
        .set({ status: 'DELETED', deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(manualBlockSeries.id, series.id))
        .returning();
      if (!updatedSeries) throw new CatalogError('NOT_FOUND', 'Série introuvable.');
      const result = noOpSeriesResult(updatedSeries, 'DELETED', 'APPLIED');
      await completeKey(tx, reservation.record.id, {
        resourceId: series.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(
      db,
      reservation.record.id,
      error,
      'La série de blocages n’a pas pu être supprimée.',
    );
    throw error;
  }
}

/** Libération explicite d'une occurrence, protégée par sa propre clé. */
export async function releaseRecurringManualBlockOccurrence(
  db: DatabaseClient,
  input: ReleaseRecurringManualBlockOccurrenceInput,
): Promise<ReleaseRecurringManualBlockOccurrenceResult> {
  const normalized = normalizeOccurrenceInput(input);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: RELEASE_RECURRING_MANUAL_BLOCK_OCCURRENCE_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint: fingerprint(normalized),
  });
  if (reservation.kind === 'REPLAY') return replayOccurrenceResult(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replayOccurrenceResult(lock.record);
      await lockOrganization(tx, normalized.organizationId);
      const series = await lockSeries(tx, normalized.organizationId, normalized.seriesId);
      const [row] = await tx
        .select({
          occurrenceId: manualBlockSeriesOccurrences.id,
          inventoryBlockId: manualBlockSeriesOccurrences.inventoryBlockId,
          blockStatus: inventoryBlocks.status,
          blockType: inventoryBlocks.type,
        })
        .from(manualBlockSeriesOccurrences)
        .innerJoin(
          inventoryBlocks,
          eq(manualBlockSeriesOccurrences.inventoryBlockId, inventoryBlocks.id),
        )
        .where(
          and(
            eq(manualBlockSeriesOccurrences.id, normalized.occurrenceId),
            eq(manualBlockSeriesOccurrences.seriesId, series.id),
            eq(inventoryBlocks.organizationId, normalized.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!row)
        throw new CatalogError('NOT_FOUND', 'Occurrence introuvable dans cette organisation.');
      if (row.blockType !== 'MANUAL_BLOCK') {
        throw new CatalogError('VALIDATION', 'Cette occurrence n’est pas un blocage manuel.');
      }

      let kind: 'APPLIED' | 'NO_OP' = 'NO_OP';
      if (row.blockStatus === 'ACTIVE') {
        const [updated] = await tx
          .update(inventoryBlocks)
          .set({ status: 'RELEASED', updatedAt: new Date() })
          .where(eq(inventoryBlocks.id, row.inventoryBlockId))
          .returning({ id: inventoryBlocks.id });
        if (!updated) throw new CatalogError('NOT_FOUND', 'Blocage introuvable.');
        kind = 'APPLIED';
      } else if (row.blockStatus !== 'RELEASED') {
        throw new CatalogError(
          'BLOCK_INVALID_TRANSITION',
          `Transition invalide : une occurrence ${row.blockStatus} ne peut pas être libérée.`,
        );
      }

      const result: ReleaseRecurringManualBlockOccurrenceResult = {
        kind,
        seriesId: series.id,
        occurrenceId: row.occurrenceId,
        inventoryBlockId: row.inventoryBlockId,
        status: 'RELEASED',
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: row.occurrenceId,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(db, reservation.record.id, error, 'L’occurrence n’a pas pu être libérée.');
    throw error;
  }
}

async function transitionSeries(
  db: DatabaseClient,
  input: SeriesLifecycleInput,
  operation: string,
  targetStatus: 'SUSPENDED',
): Promise<RecurringManualBlockSeriesMutationResult> {
  const normalized = normalizeLifecycleInput(input);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation,
    key: normalized.idempotencyKey,
    requestFingerprint: fingerprint(normalized),
  });
  if (reservation.kind === 'REPLAY') return replaySeriesMutation(reservation.record);
  if (reservation.kind === 'CONFLICT') throw idempotencyConflict();

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replaySeriesMutation(lock.record);
      await lockOrganization(tx, normalized.organizationId);
      const series = await lockSeries(tx, normalized.organizationId, normalized.seriesId);
      if (series.status === 'DELETED') {
        throw new CatalogError('VALIDATION', 'Une série supprimée ne peut pas être suspendue.');
      }
      if (series.status === targetStatus) {
        const result = noOpSeriesResult(series, targetStatus);
        await completeKey(tx, reservation.record.id, {
          resourceId: series.id,
          responseStatusCode: 200,
          responseBody: result,
        });
        return result;
      }
      const [updatedSeries] = await tx
        .update(manualBlockSeries)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(eq(manualBlockSeries.id, series.id))
        .returning();
      if (!updatedSeries) throw new CatalogError('NOT_FOUND', 'Série introuvable.');
      const result = noOpSeriesResult(updatedSeries, targetStatus, 'APPLIED');
      await completeKey(tx, reservation.record.id, {
        resourceId: series.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    await persistFailure(
      db,
      reservation.record.id,
      error,
      'La série de blocages n’a pas pu être suspendue.',
    );
    throw error;
  }
}

async function lockActiveItem(
  tx: DatabaseTransaction,
  organizationId: string,
  inventoryItemId: string,
) {
  const [item] = await tx
    .select({
      id: inventoryItems.id,
      organizationId: inventoryItems.organizationId,
      currentLocationId: inventoryItems.currentLocationId,
      status: inventoryItems.status,
      deletedAt: inventoryItems.deletedAt,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId))
    .for('update')
    .limit(1);
  if (!item || item.organizationId !== organizationId || item.deletedAt !== null) {
    throw new CatalogError('NOT_FOUND', 'Exemplaire introuvable dans cette organisation.');
  }
  if (item.status !== 'ACTIVE') {
    throw new CatalogError(
      'VALIDATION',
      'Seul un exemplaire actif peut porter une série récurrente.',
    );
  }
  return item;
}

async function lockLocation(tx: DatabaseTransaction, organizationId: string, locationId: string) {
  const [location] = await tx
    .select({
      id: locations.id,
      organizationId: locations.organizationId,
      timeZone: locations.timeZone,
    })
    .from(locations)
    .where(and(eq(locations.id, locationId), isNull(locations.deletedAt)))
    .for('update')
    .limit(1);
  if (!location || location.organizationId !== organizationId) {
    throw new CatalogError('NOT_FOUND', 'Établissement introuvable dans cette organisation.');
  }
  return location;
}

async function lockSeries(
  tx: DatabaseTransaction,
  organizationId: string,
  seriesId: string,
): Promise<RecurringManualBlockSeriesRecord> {
  const [row] = await tx
    .select()
    .from(manualBlockSeries)
    .where(
      and(eq(manualBlockSeries.id, seriesId), eq(manualBlockSeries.organizationId, organizationId)),
    )
    .for('update')
    .limit(1);
  if (!row) throw new CatalogError('NOT_FOUND', 'Série introuvable dans cette organisation.');
  return mapSeries(row);
}

async function lockSeriesOccurrences(tx: DatabaseTransaction, seriesId: string) {
  return tx
    .select({
      id: manualBlockSeriesOccurrences.id,
      occurrenceDate: manualBlockSeriesOccurrences.occurrenceDate,
      inventoryBlockId: manualBlockSeriesOccurrences.inventoryBlockId,
      status: inventoryBlocks.status,
      blockedStartAt: inventoryBlocks.blockedStartAt,
      blockedEndAt: inventoryBlocks.blockedEndAt,
    })
    .from(manualBlockSeriesOccurrences)
    .innerJoin(
      inventoryBlocks,
      eq(manualBlockSeriesOccurrences.inventoryBlockId, inventoryBlocks.id),
    )
    .where(eq(manualBlockSeriesOccurrences.seriesId, seriesId))
    .orderBy(asc(manualBlockSeriesOccurrences.occurrenceDate), asc(manualBlockSeriesOccurrences.id))
    .for('update');
}

async function insertOccurrence(
  tx: DatabaseTransaction,
  input: {
    seriesId: string;
    organizationId: string;
    inventoryItemId: string;
    period: RecurringManualBlockOccurrencePeriod;
    actorUserId?: string | null;
  },
): Promise<{ occurrenceId: string; inventoryBlockId: string }> {
  const occurrenceId = randomUUID();
  const inventoryBlockId = randomUUID();
  try {
    await tx.insert(inventoryBlocks).values({
      id: inventoryBlockId,
      organizationId: input.organizationId,
      inventoryItemId: input.inventoryItemId,
      type: 'MANUAL_BLOCK',
      status: 'ACTIVE',
      customerStartAt: input.period.startAt,
      customerEndAt: input.period.endAt,
      blockedStartAt: input.period.startAt,
      blockedEndAt: input.period.endAt,
      expiresAt: null,
      sourceId: occurrenceId,
      createdBy: input.actorUserId ?? null,
    });
    await tx.insert(manualBlockSeriesOccurrences).values({
      id: occurrenceId,
      seriesId: input.seriesId,
      inventoryBlockId,
      occurrenceDate: input.period.occurrenceDate,
    });
  } catch (error) {
    if (isExclusionViolation(error, 'no_overlapping_blocks')) {
      throw new CatalogError(
        'CONFLICT_BLOCK',
        'Une occurrence de la série entre en conflit avec une réservation, un hold, une maintenance ou un autre blocage.',
      );
    }
    throw error;
  }
  return { occurrenceId, inventoryBlockId };
}

async function updateOccurrencePeriod(
  tx: DatabaseTransaction,
  inventoryBlockId: string,
  period: RecurringManualBlockOccurrencePeriod,
): Promise<void> {
  try {
    const updated = await tx
      .update(inventoryBlocks)
      .set({
        customerStartAt: period.startAt,
        customerEndAt: period.endAt,
        blockedStartAt: period.startAt,
        blockedEndAt: period.endAt,
        updatedAt: new Date(),
      })
      .where(eq(inventoryBlocks.id, inventoryBlockId))
      .returning({ id: inventoryBlocks.id });
    if (!updated[0]) throw new CatalogError('NOT_FOUND', 'Occurrence introuvable.');
  } catch (error) {
    if (isExclusionViolation(error, 'no_overlapping_blocks')) {
      throw new CatalogError(
        'CONFLICT_BLOCK',
        'La nouvelle période entre en conflit avec une réservation, un hold, une maintenance ou un autre blocage.',
      );
    }
    throw error;
  }
}

function assertItemAtLocation(item: { currentLocationId: string }, locationId: string): void {
  if (item.currentLocationId !== locationId) {
    throw new CatalogError(
      'VALIDATION',
      "L'établissement sélectionné n'est pas l'établissement courant de l'exemplaire.",
    );
  }
}

function assertTimeZoneMatches(requested: string, actual: string): void {
  if (requested !== actual) {
    throw new CatalogError(
      'VALIDATION',
      "Le fuseau fourni doit être exactement celui de l'établissement.",
      { timeZone: "Le fuseau doit correspondre à celui de l'établissement." },
    );
  }
}

function normalizeCreateInput(input: CreateRecurringManualBlockSeriesInput) {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.inventoryItemId, 'inventoryItemId');
  assertUuid(input.locationId, 'locationId');
  return {
    ...input,
    organizationId: input.organizationId,
    inventoryItemId: input.inventoryItemId,
    locationId: input.locationId,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    actorUserId: input.actorUserId ?? null,
  };
}

function normalizeUpdateInput(input: UpdateRecurringManualBlockSeriesInput) {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.seriesId, 'seriesId');
  if (
    input.startDate === undefined &&
    input.endDate === undefined &&
    input.startTime === undefined &&
    input.endTime === undefined
  ) {
    throw new CatalogError('VALIDATION', 'Au moins un élément du calendrier doit être modifié.');
  }
  return {
    ...input,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    actorUserId: input.actorUserId ?? null,
  };
}

function normalizeLifecycleInput(input: SeriesLifecycleInput) {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.seriesId, 'seriesId');
  return {
    ...input,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    actorUserId: input.actorUserId ?? null,
  };
}

function normalizeOccurrenceInput(input: ReleaseRecurringManualBlockOccurrenceInput) {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.seriesId, 'seriesId');
  assertUuid(input.occurrenceId, 'occurrenceId');
  return {
    ...input,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    actorUserId: input.actorUserId ?? null,
  };
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new CatalogError('VALIDATION', `${field} doit être un UUID valide.`, {
      [field]: 'Identifiant invalide.',
    });
  }
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length === 0) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.", {
      idempotencyKey: "La clé d'idempotence est requise.",
    });
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      { idempotencyKey: `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.` },
    );
  }
  return key;
}

function fingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function mapSeries(row: typeof manualBlockSeries.$inferSelect): RecurringManualBlockSeriesRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    frequency: row.frequency as typeof RECURRING_MANUAL_BLOCK_FREQUENCY,
    startDate: row.startDate,
    endDate: row.endDate,
    startTime: row.startTime,
    endTime: row.endTime,
    timeZone: row.timeZone,
    status: row.status as RecurringManualBlockSeriesStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function noOpSeriesResult(
  series: RecurringManualBlockSeriesRecord | typeof manualBlockSeries.$inferSelect,
  status: RecurringManualBlockSeriesStatus,
  kind: 'APPLIED' | 'NO_OP' = 'NO_OP',
): RecurringManualBlockSeriesMutationResult {
  return {
    kind,
    seriesId: series.id,
    status,
    occurrenceCount: 0,
    createdOccurrenceIds: [],
    updatedOccurrenceIds: [],
  };
}

async function persistFailure(
  db: DatabaseClient,
  recordId: string,
  error: unknown,
  fallback: string,
): Promise<void> {
  const failure = toPersistedFailure(error, fallback);
  await db
    .transaction(async (tx) => {
      await failKey(tx, recordId, {
        responseStatusCode: failure.code === 'UNKNOWN' ? 500 : 400,
        responseBody: failure,
      });
    })
    .catch(() => undefined);
}

function toPersistedFailure(error: unknown, fallback: string): PersistedFailure {
  if (error instanceof CatalogError) return { code: error.code, message: error.message };
  if (error instanceof AuthorizationError) return { code: 'NOT_FOUND', message: error.message };
  return { code: 'UNKNOWN', message: fallback };
}

function idempotencyConflict(): CatalogError {
  return new CatalogError(
    'CONFLICT_IDEMPOTENCY',
    "La clé d'idempotence a déjà été utilisée avec un calendrier différent.",
  );
}

function replaySeriesMutation(
  record: IdempotencyRecordRow,
): RecurringManualBlockSeriesMutationResult {
  if (record.status === 'FAILED')
    throwPersistedFailure(record, 'Réponse idempotente de série invalide.');
  if (
    record.status !== 'COMPLETED' ||
    (record.responseStatusCode !== 200 && record.responseStatusCode !== 201) ||
    !record.resourceId
  ) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de série invalide.');
  }
  const body = record.responseBody;
  if (!isSeriesMutationResult(body) || body.seriesId !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de série invalide.');
  }
  return body;
}

function replayOccurrenceResult(
  record: IdempotencyRecordRow,
): ReleaseRecurringManualBlockOccurrenceResult {
  if (record.status === 'FAILED')
    throwPersistedFailure(record, 'Réponse idempotente d’occurrence invalide.');
  if (record.status !== 'COMPLETED' || record.responseStatusCode !== 200 || !record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente d’occurrence invalide.');
  }
  const body = record.responseBody;
  if (!isOccurrenceResult(body) || body.occurrenceId !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente d’occurrence invalide.');
  }
  return body;
}

function throwPersistedFailure(record: IdempotencyRecordRow, fallback: string): never {
  const body = record.responseBody;
  if (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    isActionErrorCode(body.code) &&
    'message' in body &&
    typeof body.message === 'string'
  ) {
    throw new CatalogError(body.code, body.message);
  }
  throw new CatalogError('UNKNOWN', fallback);
}

function isSeriesMutationResult(value: unknown): value is RecurringManualBlockSeriesMutationResult {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    (body.kind === 'APPLIED' || body.kind === 'NO_OP') &&
    typeof body.seriesId === 'string' &&
    (body.status === 'ACTIVE' || body.status === 'SUSPENDED' || body.status === 'DELETED') &&
    typeof body.occurrenceCount === 'number' &&
    Array.isArray(body.createdOccurrenceIds) &&
    body.createdOccurrenceIds.every((id) => typeof id === 'string') &&
    Array.isArray(body.updatedOccurrenceIds) &&
    body.updatedOccurrenceIds.every((id) => typeof id === 'string')
  );
}

function isOccurrenceResult(value: unknown): value is ReleaseRecurringManualBlockOccurrenceResult {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    (body.kind === 'APPLIED' || body.kind === 'NO_OP') &&
    typeof body.seriesId === 'string' &&
    typeof body.occurrenceId === 'string' &&
    typeof body.inventoryBlockId === 'string' &&
    body.status === 'RELEASED'
  );
}

interface PostgresConstraintError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

function isExclusionViolation(error: unknown, constraintName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as PostgresConstraintError;
  return (
    pgError.code === '23P01' &&
    (pgError.constraint_name === constraintName || pgError.constraint === constraintName)
  );
}
