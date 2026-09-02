import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingItems,
  bookings,
  inventoryBlocks,
  outboxEvents,
  lockOrganization,
} from '@uttily/database';
import { reserveKey, lockKey, completeKey } from '../idempotency/idempotency';
import type { IdempotencyRecordRow } from '../idempotency/types';
import { writeAuditEntry } from '../identity/audit';
import { FulfillmentError } from './fulfillment-errors';
import {
  decodePersistedFulfillmentError,
  persistFulfillmentFailureSafely,
  verifyFulfillmentMembership,
} from './fulfillment-shared';
import { computeCounterIncidentFingerprint } from './counter-incidents-fingerprint';
import {
  isBookingNoShowEligible,
  type RecordBookingNoShowInput,
  type RecordBookingNoShowResult,
} from './counter-incidents-types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

/**
 * Signale l'absence au départ sans passer par l'annulation financière.
 *
 * Le statut booking devient CANCELLED, les blocs actifs deviennent RELEASED
 * (état libérable canonique du schéma actuel), et la cause est conservée dans
 * l'audit/outbox. Aucun paiement, remboursement ou snapshot financier n'est
 * lu pour être recalculé ni modifié.
 */
export async function recordBookingNoShow(
  db: DatabaseClient,
  input: RecordBookingNoShowInput,
): Promise<RecordBookingNoShowResult> {
  const normalized = validateAndNormalize(input);
  const requestFingerprint = computeCounterIncidentFingerprint({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    actorUserId: input.actorUserId,
    operation: 'record_booking_no_show',
    reason: normalized.reason,
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'record_booking_no_show',
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayPersistedNoShow(reservation.record, input.bookingId);
  }
  if (reservation.kind === 'CONFLICT') {
    throw new FulfillmentError(
      'IDEMPOTENCY_CONFLICT',
      "Clé d'idempotence réutilisée avec un payload différent.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return replayPersistedNoShow(lock.record, input.bookingId);
      }

      await lockOrganization(tx, input.organizationId);

      const bookingRows = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .for('update')
        .limit(1);
      if (bookingRows.length === 0) {
        throw new FulfillmentError(
          'BOOKING_NOT_FOUND',
          `Réservation ${input.bookingId} introuvable.`,
        );
      }

      const booking = bookingRows[0]!;
      if (booking.organizationId !== input.organizationId) {
        throw new FulfillmentError(
          'ORGANIZATION_MISMATCH',
          "La réservation n'appartient pas à l'organisation.",
        );
      }
      await verifyFulfillmentMembership(tx, input.organizationId, input.actorUserId);

      if (!isBookingNoShowEligible(booking.status, booking.customerStartAt, normalized.now)) {
        throw new FulfillmentError(
          'INVALID_TRANSITION',
          "Le no-show est possible uniquement pour une réservation confirmée ou prête dont l'heure de départ est atteinte.",
        );
      }

      const updatedBookings = await tx
        .update(bookings)
        .set({ status: 'CANCELLED', updatedAt: sql`now()` })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, booking.status)))
        .returning({ id: bookings.id });
      if (updatedBookings.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          `La réservation ${booking.id} a été modifiée concurremment.`,
        );
      }

      const itemRows = await tx
        .select({ bookingBlockId: bookingItems.bookingBlockId })
        .from(bookingItems)
        .where(eq(bookingItems.bookingId, booking.id));
      const bookingBlockIds = itemRows.map((row) => row.bookingBlockId);
      const releaseScope =
        bookingBlockIds.length > 0
          ? or(
              eq(inventoryBlocks.sourceId, booking.id),
              inArray(inventoryBlocks.id, bookingBlockIds),
            )
          : eq(inventoryBlocks.sourceId, booking.id);

      const releasedBlocks = await tx
        .update(inventoryBlocks)
        .set({ status: 'RELEASED', updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryBlocks.organizationId, input.organizationId),
            inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
            releaseScope,
          ),
        )
        .returning({ id: inventoryBlocks.id });

      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'BOOKING_NO_SHOW',
        targetType: 'BOOKING',
        targetId: booking.id,
        metadata: {
          organizationId: input.organizationId,
          eventType: 'NO_SHOW',
          previousStatus: booking.status,
          nextStatus: 'CANCELLED',
          releasedBlockCount: releasedBlocks.length,
          financialSnapshotUntouched: true,
          ...(normalized.reason !== null ? { reason: normalized.reason } : {}),
        },
      });

      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'BOOKING',
          aggregateId: booking.id,
          eventType: 'BOOKING_NO_SHOW',
          eventVersion: 'v1',
          payload: {
            organizationId: input.organizationId,
            bookingId: booking.id,
            eventType: 'NO_SHOW',
            previousStatus: booking.status,
            nextStatus: 'CANCELLED',
            releasedBlockCount: releasedBlocks.length,
            ...(normalized.reason !== null ? { reason: normalized.reason } : {}),
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: sql`now()`,
          idempotencyKey: `booking_no_show_${booking.id}_${normalized.idempotencyKey}`,
        })
        .returning({ id: outboxEvents.id });
      if (outboxRows.length === 0) {
        throw new FulfillmentError('UNKNOWN', "Échec de l'insertion de l'événement no-show.");
      }

      const result: RecordBookingNoShowResult = {
        kind: 'APPLIED',
        bookingId: booking.id,
        previousStatus: booking.status,
        status: 'CANCELLED',
        releasedBlockCount: releasedBlocks.length,
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: booking.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (err) {
    if (err instanceof FulfillmentError) {
      await persistFulfillmentFailureSafely(db, reservation.record.id, err);
      throw err;
    }
    const sanitized = new FulfillmentError(
      'UNKNOWN',
      'Erreur inattendue lors de la déclaration du no-show.',
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

function validateAndNormalize(input: RecordBookingNoShowInput): {
  idempotencyKey: string;
  reason: string | null;
  now: Date;
} {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new FulfillmentError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.bookingId)) {
    throw new FulfillmentError('VALIDATION', 'bookingId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.actorUserId)) {
    throw new FulfillmentError('VALIDATION', 'actorUserId doit être un UUID valide.');
  }

  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length === 0) {
    throw new FulfillmentError('VALIDATION', 'idempotencyKey est requis (string non vide).');
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `idempotencyKey ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
    );
  }

  let reason: string | null = null;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== 'string') {
      throw new FulfillmentError('VALIDATION', 'reason doit être une chaîne.');
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length > MAX_REASON_LENGTH) {
      throw new FulfillmentError(
        'VALIDATION',
        `reason ne doit pas dépasser ${MAX_REASON_LENGTH} caractères.`,
      );
    }
    reason = trimmedReason.length > 0 ? trimmedReason : null;
  }

  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new FulfillmentError('VALIDATION', 'now doit être une Date valide.');
  }
  return { idempotencyKey, reason, now };
}

function replayPersistedNoShow(
  record: IdempotencyRecordRow,
  bookingId: string,
): RecordBookingNoShowResult {
  if (record.status === 'FAILED') throw decodePersistedFulfillmentError(record);
  if (record.status !== 'COMPLETED') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `Statut idempotency inattendu lors du replay: ${record.status}.`,
    );
  }

  const body = record.responseBody;
  if (body === null || typeof body !== 'object') {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse no-show malformée.');
  }
  const raw = body as Record<string, unknown>;
  if (
    raw.kind !== 'APPLIED' ||
    raw.status !== 'CANCELLED' ||
    typeof raw.bookingId !== 'string' ||
    raw.bookingId !== bookingId ||
    record.resourceId !== bookingId ||
    record.responseStatusCode !== 200 ||
    (raw.previousStatus !== 'CONFIRMED' && raw.previousStatus !== 'READY_FOR_PICKUP') ||
    typeof raw.releasedBlockCount !== 'number' ||
    !Number.isSafeInteger(raw.releasedBlockCount) ||
    raw.releasedBlockCount < 0
  ) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse no-show incohérente.');
  }

  return {
    kind: 'APPLIED',
    bookingId,
    previousStatus: raw.previousStatus,
    status: 'CANCELLED',
    releasedBlockCount: raw.releasedBlockCount,
  };
}
