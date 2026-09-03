import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingItems,
  bookings,
  inventoryBlocks,
  inventoryItems,
  lockOrganization,
  outboxEvents,
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
import type { BookingStatus } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const ACTIVE_BLOCK_STATUSES = ['ACTIVE', 'PAYMENT_PROCESSING'] as const;

export interface DeclareBookingUnreturnedLostInput {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  idempotencyKey: string;
  /** Circonstances opérateur facultatives, conservées dans l'audit et l'outbox. */
  reason?: string | null | undefined;
  /** Horloge injectée pour les tests ; l'instant courant est utilisé en production. */
  now?: Date | undefined;
}

export interface DeclareBookingUnreturnedLostResult {
  kind: 'APPLIED';
  bookingId: string;
  previousStatus: 'ACTIVE';
  status: 'CLOSED';
  lostItemCount: number;
  releasedBlockCount: number;
}

/**
 * Une déclaration de non-restitution est strictement réservée à une location
 * active dont l'échéance contractuelle est déjà dépassée.
 */
export function isBookingUnreturnedLostEligible(
  status: BookingStatus,
  customerEndAt: Date,
  now: Date,
): status is 'ACTIVE' {
  return (
    status === 'ACTIVE' &&
    Number.isFinite(customerEndAt.getTime()) &&
    Number.isFinite(now.getTime()) &&
    now.getTime() > customerEndAt.getTime()
  );
}

/** Normalise le texte libre sans laisser passer une valeur non bornée. */
export function normalizeUnreturnedLostReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') {
    throw new FulfillmentError('VALIDATION', 'reason doit être une chaîne.');
  }
  const normalized = reason.trim();
  if (normalized.length > MAX_REASON_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `reason ne doit pas dépasser ${MAX_REASON_LENGTH} caractères.`,
    );
  }
  return normalized.length > 0 ? normalized : null;
}

/**
 * Déclare une réservation active comme non restituée et clôture son dossier.
 *
 * L'opération verrouille le dossier, ses lignes, ses blocs et ses exemplaires
 * dans un ordre déterministe. Elle ne touche à aucune colonne financière : les
 * snapshots restent ceux de la confirmation et le traitement caution/assurance
 * est laissé à l'outbox BOOKING_DECLARED_LOST.
 */
export async function declareBookingUnreturnedLost(
  db: DatabaseClient,
  input: DeclareBookingUnreturnedLostInput,
): Promise<DeclareBookingUnreturnedLostResult> {
  const normalized = validateAndNormalize(input);
  const requestFingerprint = computeCounterIncidentFingerprint({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    actorUserId: input.actorUserId,
    operation: 'declare_booking_unreturned_lost',
    reason: normalized.reason,
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'declare_booking_unreturned_lost',
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayPersistedUnreturnedLost(reservation.record, input.bookingId);
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
        return replayPersistedUnreturnedLost(lock.record, input.bookingId);
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

      if (!isBookingUnreturnedLostEligible(booking.status, booking.customerEndAt, normalized.now)) {
        throw new FulfillmentError(
          'INVALID_TRANSITION',
          "La non-restitution est possible uniquement pour une réservation ACTIVE dont l'échéance est dépassée.",
        );
      }

      // Verrouillage déterministe : booking → lignes → blocs → exemplaires.
      // Les autres mutations terrain verrouillent déjà le booking en premier.
      const itemRows = await tx
        .select()
        .from(bookingItems)
        .where(eq(bookingItems.bookingId, booking.id))
        .orderBy(asc(bookingItems.id))
        .for('update');
      if (itemRows.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          'La réservation ne contient plus aucun exemplaire alloué.',
        );
      }

      const inventoryItemIds = [...new Set(itemRows.map((item) => item.inventoryItemId))].sort();
      const bookingBlockIds = itemRows.map((item) => item.bookingBlockId);
      const sourceHoldBlockIds = itemRows
        .map((item) => item.sourceHoldBlockId)
        .filter((id): id is string => id !== null);
      const linkedBlockIds = [...new Set([...bookingBlockIds, ...sourceHoldBlockIds])].sort();

      const linkedBlockRows = await tx
        .select()
        .from(inventoryBlocks)
        .where(inArray(inventoryBlocks.id, linkedBlockIds))
        .orderBy(asc(inventoryBlocks.id))
        .for('update');
      const blockById = new Map(linkedBlockRows.map((block) => [block.id, block]));

      for (const item of itemRows) {
        const bookingBlock = blockById.get(item.bookingBlockId);
        if (
          !bookingBlock ||
          bookingBlock.organizationId !== input.organizationId ||
          bookingBlock.inventoryItemId !== item.inventoryItemId ||
          bookingBlock.type !== 'BOOKING' ||
          (bookingBlock.status !== 'ACTIVE' && bookingBlock.status !== 'PAYMENT_PROCESSING') ||
          bookingBlock.deletedAt !== null ||
          bookingBlock.blockedStartAt.getTime() !== booking.blockedStartAt.getTime() ||
          bookingBlock.blockedEndAt.getTime() !== booking.blockedEndAt.getTime()
        ) {
          throw new FulfillmentError(
            'CONCURRENT_MODIFICATION',
            "Le bloc d'inventaire associé n'est plus cohérent avec la réservation.",
          );
        }

        if (item.sourceHoldBlockId !== null) {
          const sourceHoldBlock = blockById.get(item.sourceHoldBlockId);
          if (
            !sourceHoldBlock ||
            sourceHoldBlock.organizationId !== input.organizationId ||
            sourceHoldBlock.inventoryItemId !== item.inventoryItemId ||
            sourceHoldBlock.type !== 'HOLD'
          ) {
            throw new FulfillmentError(
              'CONCURRENT_MODIFICATION',
              "Le hold source associé n'est plus cohérent avec l'exemplaire.",
            );
          }
        }
      }

      const lockedInventoryItems = await tx
        .select()
        .from(inventoryItems)
        .where(inArray(inventoryItems.id, inventoryItemIds))
        .orderBy(asc(inventoryItems.id))
        .for('update');
      const inventoryById = new Map(lockedInventoryItems.map((item) => [item.id, item]));
      for (const item of itemRows) {
        const inventoryItem = inventoryById.get(item.inventoryItemId);
        if (!inventoryItem) {
          throw new FulfillmentError(
            'CONCURRENT_MODIFICATION',
            "L'exemplaire associé à la réservation est introuvable.",
          );
        }
        if (inventoryItem.organizationId !== input.organizationId) {
          throw new FulfillmentError(
            'ORGANIZATION_MISMATCH',
            "L'exemplaire associé n'appartient pas à l'organisation.",
          );
        }
        if (inventoryItem.deletedAt !== null) {
          throw new FulfillmentError(
            'CONCURRENT_MODIFICATION',
            "L'exemplaire associé à la réservation n'est plus actif dans le parc.",
          );
        }
      }

      const releaseScope = or(
        inArray(inventoryBlocks.id, linkedBlockIds),
        eq(inventoryBlocks.sourceId, booking.id),
      );
      const releasedBlocks = await tx
        .update(inventoryBlocks)
        .set({ status: 'RELEASED', updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryBlocks.organizationId, input.organizationId),
            inArray(inventoryBlocks.status, [...ACTIVE_BLOCK_STATUSES]),
            isNull(inventoryBlocks.deletedAt),
            releaseScope,
          ),
        )
        .returning({ id: inventoryBlocks.id });

      const updatedItems = await tx
        .update(inventoryItems)
        .set({ status: 'LOST', updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryItems.organizationId, input.organizationId),
            inArray(inventoryItems.id, inventoryItemIds),
            isNull(inventoryItems.deletedAt),
          ),
        )
        .returning({ id: inventoryItems.id });
      if (updatedItems.length !== inventoryItemIds.length) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          'Un ou plusieurs exemplaires ont été modifiés pendant la déclaration.',
        );
      }

      const updatedBookings = await tx
        .update(bookings)
        .set({ status: 'CLOSED', updatedAt: sql`now()` })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'ACTIVE')))
        .returning({ id: bookings.id });
      if (updatedBookings.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          `La réservation ${booking.id} a été modifiée concurremment.`,
        );
      }

      const lostItems = itemRows.map((item) => {
        const inventoryItem = inventoryById.get(item.inventoryItemId)!;
        return { inventoryItemId: inventoryItem.id, sku: inventoryItem.internalSku };
      });
      const metadata = {
        organizationId: input.organizationId,
        bookingId: booking.id,
        classification: 'UNRETURNED_LOST',
        previousStatus: 'ACTIVE',
        nextStatus: 'CLOSED',
        customerEndAt: booking.customerEndAt.toISOString(),
        lostItems,
        lostItemCount: lostItems.length,
        releasedBlockCount: releasedBlocks.length,
        financialSnapshotUntouched: true,
        ...(normalized.reason !== null ? { reason: normalized.reason } : {}),
      };

      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'BOOKING_DECLARED_LOST',
        targetType: 'BOOKING',
        targetId: booking.id,
        metadata,
      });

      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'BOOKING',
          aggregateId: booking.id,
          eventType: 'BOOKING_DECLARED_LOST',
          eventVersion: 'v1',
          payload: {
            ...metadata,
            actorUserId: input.actorUserId,
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: sql`now()`,
          idempotencyKey: `booking_declared_lost_${booking.id}_${normalized.idempotencyKey}`,
        })
        .returning({ id: outboxEvents.id });
      if (outboxRows.length === 0) {
        throw new FulfillmentError(
          'UNKNOWN',
          "Échec de l'insertion de l'événement de non-restitution.",
        );
      }

      const result: DeclareBookingUnreturnedLostResult = {
        kind: 'APPLIED',
        bookingId: booking.id,
        previousStatus: 'ACTIVE',
        status: 'CLOSED',
        lostItemCount: lostItems.length,
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
      'Erreur inattendue lors de la déclaration de non-restitution.',
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

function validateAndNormalize(input: DeclareBookingUnreturnedLostInput): {
  idempotencyKey: string;
  reason: string | null;
  now: Date;
} {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.bookingId, 'bookingId');
  assertUuid(input.actorUserId, 'actorUserId');

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

  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new FulfillmentError('VALIDATION', 'now doit être une Date valide.');
  }

  return {
    idempotencyKey,
    reason: normalizeUnreturnedLostReason(input.reason),
    now,
  };
}

function replayPersistedUnreturnedLost(
  record: IdempotencyRecordRow,
  bookingId: string,
): DeclareBookingUnreturnedLostResult {
  if (record.status === 'FAILED') throw decodePersistedFulfillmentError(record);
  if (record.status !== 'COMPLETED') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `Statut idempotency inattendu lors du replay: ${record.status}.`,
    );
  }

  const body = record.responseBody;
  if (body === null || typeof body !== 'object') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'Réponse de non-restitution malformée.',
    );
  }
  const raw = body as Record<string, unknown>;
  if (
    raw.kind !== 'APPLIED' ||
    raw.bookingId !== bookingId ||
    record.resourceId !== bookingId ||
    record.responseStatusCode !== 200 ||
    raw.previousStatus !== 'ACTIVE' ||
    raw.status !== 'CLOSED' ||
    typeof raw.lostItemCount !== 'number' ||
    !Number.isSafeInteger(raw.lostItemCount) ||
    raw.lostItemCount < 1 ||
    typeof raw.releasedBlockCount !== 'number' ||
    !Number.isSafeInteger(raw.releasedBlockCount) ||
    raw.releasedBlockCount < 0
  ) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'Réponse de non-restitution incohérente.',
    );
  }

  return {
    kind: 'APPLIED',
    bookingId,
    previousStatus: 'ACTIVE',
    status: 'CLOSED',
    lostItemCount: raw.lostItemCount,
    releasedBlockCount: raw.releasedBlockCount,
  };
}

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new FulfillmentError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}
