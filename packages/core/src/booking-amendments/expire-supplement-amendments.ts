/**
 * G7M-C4-A — expiration atomique des suppléments.
 *
 * L'expiration est volontairement indépendante des webhooks et du provider.
 * Une seule transaction capture l'horloge, revendique un batch borné, verrouille
 * les lignes dans l'ordre ADR-023, libère les holds/segments et publie le
 * signal outbox idempotent.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  bookingAmendmentAllocations,
  bookingAmendmentSegments,
  bookingAmendments,
  inventoryBlocks,
  outboxEvents,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';

export const BOOKING_AMENDMENT_EXPIRED_AGGREGATE_TYPE = 'BOOKING' as const;
export const BOOKING_AMENDMENT_EXPIRED_EVENT_TYPE = 'BOOKING_AMENDMENT_EXPIRED' as const;
export const BOOKING_AMENDMENT_EXPIRED_EVENT_VERSION = 'v1' as const;

const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 100;

export interface ExpireSupplementAmendmentsOptions {
  readonly batchLimit?: number;
  /** Filtre tenant optionnel pour les workers partitionnés. */
  readonly organizationId?: string;
  /** Horloge de test ; en production elle est capturée par PostgreSQL. */
  readonly asOf?: Date;
}

export interface ExpiredSupplementAmendment {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
  readonly expiredAt: string;
  readonly holdBlockIds: readonly string[];
  readonly segmentIds: readonly string[];
  readonly allocationIds: readonly string[];
}

export interface ExpireSupplementAmendmentsResult {
  readonly asOf: string;
  readonly processedCount: number;
  readonly expiredCount: number;
  readonly expired: readonly ExpiredSupplementAmendment[];
}

function validateBatchLimit(batchLimit: number): void {
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new Error(`batchLimit doit être un entier entre 1 et ${MAX_BATCH_LIMIT}.`);
  }
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Horloge PostgreSQL invalide.');
  return date;
}

async function captureAsOf(tx: DatabaseTransaction, override: Date | undefined): Promise<Date> {
  if (override !== undefined) {
    if (!Number.isFinite(override.getTime())) throw new Error('asOf invalide.');
    return new Date(override.getTime());
  }
  const rows = await tx.execute(sql`SELECT transaction_timestamp() AS as_of`);
  const value = (rows[0] as unknown as { as_of: Date | string } | undefined)?.as_of;
  if (value === undefined) throw new Error('Horloge PostgreSQL absente.');
  return toDate(value);
}

async function lockAndExpireOne(
  tx: DatabaseTransaction,
  candidate: { id: string; organizationId: string },
  asOf: Date,
): Promise<ExpiredSupplementAmendment | null> {
  // La sélection détient déjà le verrou SKIP LOCKED sur l'amendment. Cette
  // relecture tenant-scoped rend l'invariant explicite et protège les retries
  // contre une donnée mal rattachée.
  const amendmentRows = await tx
    .select()
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.id, candidate.id),
        eq(bookingAmendments.organizationId, candidate.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const amendment = amendmentRows[0];
  if (!amendment || amendment.holdDeadline === null) return null;
  if (
    amendment.type !== 'SUPPLEMENT' ||
    (amendment.status !== 'HOLD_PENDING' && amendment.status !== 'READY_TO_APPLY') ||
    amendment.holdDeadline.getTime() > asOf.getTime()
  ) {
    return null;
  }

  // Lectures sans verrou pour calculer les ensembles, puis acquisition dans
  // l'ordre canonique : blocks → allocations → segments.
  const allocationIdsRows = await tx
    .select({ id: bookingAmendmentAllocations.id })
    .from(bookingAmendmentAllocations)
    .where(
      and(
        eq(bookingAmendmentAllocations.amendmentId, amendment.id),
        eq(bookingAmendmentAllocations.organizationId, candidate.organizationId),
      ),
    )
    .orderBy(asc(bookingAmendmentAllocations.id));
  const allocationIds = allocationIdsRows.map((row) => row.id);

  const blockIdsRows = await tx
    .select({ id: inventoryBlocks.id })
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.sourceId, amendment.id),
        eq(inventoryBlocks.organizationId, candidate.organizationId),
        eq(inventoryBlocks.type, 'HOLD'),
      ),
    )
    .orderBy(asc(inventoryBlocks.id));
  const blockIds = blockIdsRows.map((row) => row.id);

  const lockedBlocks =
    blockIds.length === 0
      ? []
      : await tx
          .select({ id: inventoryBlocks.id, status: inventoryBlocks.status })
          .from(inventoryBlocks)
          .where(
            and(
              inArray(inventoryBlocks.id, blockIds),
              eq(inventoryBlocks.organizationId, candidate.organizationId),
            ),
          )
          .orderBy(asc(inventoryBlocks.id))
          .for('update');
  if (lockedBlocks.length !== blockIds.length) {
    throw new Error('Un hold du supplément appartient à un autre tenant ou est introuvable.');
  }

  const lockedAllocations =
    allocationIds.length === 0
      ? []
      : await tx
          .select({
            id: bookingAmendmentAllocations.id,
            status: bookingAmendmentAllocations.status,
          })
          .from(bookingAmendmentAllocations)
          .where(
            and(
              inArray(bookingAmendmentAllocations.id, allocationIds),
              eq(bookingAmendmentAllocations.organizationId, candidate.organizationId),
            ),
          )
          .orderBy(asc(bookingAmendmentAllocations.id))
          .for('update');
  if (lockedAllocations.length !== allocationIds.length) {
    throw new Error(
      'Une allocation du supplément appartient à un autre tenant ou est introuvable.',
    );
  }

  const lockedSegments =
    allocationIds.length === 0
      ? []
      : await tx
          .select({
            id: bookingAmendmentSegments.id,
            holdBlockId: bookingAmendmentSegments.holdBlockId,
          })
          .from(bookingAmendmentSegments)
          .where(
            and(
              inArray(bookingAmendmentSegments.allocationId, allocationIds),
              eq(bookingAmendmentSegments.organizationId, candidate.organizationId),
            ),
          )
          .orderBy(asc(bookingAmendmentSegments.id))
          .for('update');

  await tx
    .update(inventoryBlocks)
    .set({ status: 'EXPIRED', updatedAt: asOf })
    .where(
      and(
        inArray(inventoryBlocks.id, blockIds),
        eq(inventoryBlocks.organizationId, candidate.organizationId),
        sql`${inventoryBlocks.status} IN ('ACTIVE', 'PAYMENT_PROCESSING')`,
      ),
    );
  if (lockedSegments.length > 0) {
    await tx
      .update(bookingAmendmentSegments)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          inArray(
            bookingAmendmentSegments.id,
            lockedSegments.map((segment) => segment.id),
          ),
          eq(bookingAmendmentSegments.organizationId, candidate.organizationId),
          eq(bookingAmendmentSegments.status, 'PROPOSED'),
        ),
      );
  }
  if (lockedAllocations.length > 0) {
    await tx
      .update(bookingAmendmentAllocations)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          inArray(
            bookingAmendmentAllocations.id,
            lockedAllocations.map((allocation) => allocation.id),
          ),
          eq(bookingAmendmentAllocations.organizationId, candidate.organizationId),
          eq(bookingAmendmentAllocations.status, 'PROPOSED'),
        ),
      );
  }

  await tx
    .update(bookingAmendments)
    .set({ status: 'EXPIRED', expiredAt: asOf, updatedAt: asOf })
    .where(
      and(
        eq(bookingAmendments.id, amendment.id),
        eq(bookingAmendments.organizationId, candidate.organizationId),
      ),
    );

  const payload = {
    organizationId: candidate.organizationId,
    bookingId: amendment.bookingId,
    amendmentId: amendment.id,
  };
  await tx
    .insert(outboxEvents)
    .values({
      organizationId: candidate.organizationId,
      aggregateType: BOOKING_AMENDMENT_EXPIRED_AGGREGATE_TYPE,
      aggregateId: amendment.bookingId,
      eventType: BOOKING_AMENDMENT_EXPIRED_EVENT_TYPE,
      eventVersion: BOOKING_AMENDMENT_EXPIRED_EVENT_VERSION,
      payload,
      status: 'PENDING',
      attemptCount: 0,
      availableAt: asOf,
      idempotencyKey: `booking_amendment_expired_${amendment.id}`,
    })
    .onConflictDoNothing({ target: [outboxEvents.idempotencyKey] });

  return {
    organizationId: candidate.organizationId,
    bookingId: amendment.bookingId,
    amendmentId: amendment.id,
    expiredAt: asOf.toISOString(),
    holdBlockIds: blockIds,
    segmentIds: lockedSegments.map((segment) => segment.id),
    allocationIds,
  };
}

export async function expireSupplementAmendmentsBatch(
  db: DatabaseClient,
  options: ExpireSupplementAmendmentsOptions = {},
): Promise<ExpireSupplementAmendmentsResult> {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  validateBatchLimit(batchLimit);

  return await db.transaction(async (tx) => {
    const asOf = await captureAsOf(tx, options.asOf);
    const rows = options.organizationId
      ? await tx.execute(sql`
          SELECT ba.id, ba.organization_id
          FROM booking_amendments ba
          WHERE ba.organization_id = ${options.organizationId}
            AND ba.type = 'SUPPLEMENT'
            AND ba.status IN ('HOLD_PENDING', 'READY_TO_APPLY')
            AND ba.hold_deadline IS NOT NULL
            AND ba.hold_deadline <= ${asOf.toISOString()}
          ORDER BY ba.hold_deadline ASC, ba.id ASC
          LIMIT ${batchLimit}
          FOR UPDATE OF ba SKIP LOCKED
        `)
      : await tx.execute(sql`
          SELECT ba.id, ba.organization_id
          FROM booking_amendments ba
          WHERE ba.type = 'SUPPLEMENT'
            AND ba.status IN ('HOLD_PENDING', 'READY_TO_APPLY')
            AND ba.hold_deadline IS NOT NULL
            AND ba.hold_deadline <= ${asOf.toISOString()}
          ORDER BY ba.hold_deadline ASC, ba.id ASC
          LIMIT ${batchLimit}
          FOR UPDATE OF ba SKIP LOCKED
        `);
    const candidates = rows as unknown as Array<{ id: string; organization_id: string }>;
    const expired: ExpiredSupplementAmendment[] = [];
    for (const candidate of candidates) {
      const result = await lockAndExpireOne(
        tx,
        { id: candidate.id, organizationId: candidate.organization_id },
        asOf,
      );
      if (result !== null) expired.push(result);
    }
    return {
      asOf: asOf.toISOString(),
      processedCount: candidates.length,
      expiredCount: expired.length,
      expired,
    };
  });
}
