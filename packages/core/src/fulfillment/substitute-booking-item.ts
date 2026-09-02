import { and, asc, eq, exists, inArray, isNull, not, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingItems,
  bookingLines,
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
import {
  isSubstitutionEligibleStatus,
  isUsableSubstitutionCondition,
  type SubstitutionCandidate,
  type SubstituteBookingItemInput,
  type SubstituteBookingItemResult,
} from './counter-incidents-types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const USABLE_CONDITIONS = ['NEW', 'GOOD', 'FAIR'] as const;
const ACTIVE_BLOCK_STATUSES = ['ACTIVE', 'PAYMENT_PROCESSING'] as const;
const MAX_SUBSTITUTION_CANDIDATES = 100;

/**
 * Retourne les exemplaires équivalents encore libres pour le créneau complet.
 * La liste est informative : la mutation revalide chaque invariant dans sa
 * propre transaction juste avant l'échange.
 */
export async function listSubstitutionCandidates(
  db: DatabaseClient,
  organizationId: string,
  bookingId: string,
  bookingItemId: string,
): Promise<SubstitutionCandidate[]> {
  assertUuid(organizationId, 'organizationId');
  assertUuid(bookingId, 'bookingId');
  assertUuid(bookingItemId, 'bookingItemId');

  const bookingRows = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (bookingRows.length === 0) {
    throw new FulfillmentError('BOOKING_NOT_FOUND', `Réservation ${bookingId} introuvable.`);
  }
  const booking = bookingRows[0]!;
  if (booking.organizationId !== organizationId) {
    throw new FulfillmentError(
      'ORGANIZATION_MISMATCH',
      "La réservation n'appartient pas à l'organisation.",
    );
  }
  if (!isSubstitutionEligibleStatus(booking.status)) {
    throw new FulfillmentError(
      'INVALID_TRANSITION',
      `La substitution est impossible dans l'état ${booking.status}.`,
    );
  }

  const itemRows = await db
    .select({
      id: bookingItems.id,
      inventoryItemId: bookingItems.inventoryItemId,
      variantId: bookingLines.variantId,
    })
    .from(bookingItems)
    .innerJoin(bookingLines, eq(bookingItems.bookingLineId, bookingLines.id))
    .where(and(eq(bookingItems.id, bookingItemId), eq(bookingItems.bookingId, booking.id)))
    .limit(1);
  const bookingItem = itemRows[0];
  if (!bookingItem) {
    const itemExists = await db
      .select({ bookingId: bookingItems.bookingId })
      .from(bookingItems)
      .where(eq(bookingItems.id, bookingItemId))
      .limit(1);
    if (itemExists.length === 0) {
      throw new FulfillmentError(
        'BOOKING_ITEM_NOT_FOUND',
        `Élément de réservation ${bookingItemId} introuvable.`,
      );
    }
    throw new FulfillmentError(
      'BOOKING_ITEM_MISMATCH',
      "L'élément de réservation n'appartient pas à la réservation.",
    );
  }

  const currentItemRows = await db
    .select({ organizationId: inventoryItems.organizationId })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, bookingItem.inventoryItemId))
    .limit(1);
  if (currentItemRows.length === 0 || currentItemRows[0]!.organizationId !== organizationId) {
    throw new FulfillmentError(
      'ORGANIZATION_MISMATCH',
      "L'exemplaire affecté n'appartient pas à l'organisation.",
    );
  }

  const candidateRows = await db
    .select({
      id: inventoryItems.id,
      internalSku: inventoryItems.internalSku,
      serialNumber: inventoryItems.serialNumber,
      condition: inventoryItems.condition,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.currentLocationId, booking.locationId),
        eq(inventoryItems.productVariantId, bookingItem.variantId),
        eq(inventoryItems.status, 'ACTIVE'),
        isNull(inventoryItems.deletedAt),
        inArray(inventoryItems.condition, [...USABLE_CONDITIONS]),
        not(eq(inventoryItems.id, bookingItem.inventoryItemId)),
        not(
          exists(
            db
              .select({ id: bookingItems.id })
              .from(bookingItems)
              .where(
                and(
                  eq(bookingItems.bookingId, booking.id),
                  eq(bookingItems.inventoryItemId, inventoryItems.id),
                ),
              ),
          ),
        ),
        not(
          exists(
            db
              .select({ id: inventoryBlocks.id })
              .from(inventoryBlocks)
              .where(
                and(
                  eq(inventoryBlocks.inventoryItemId, inventoryItems.id),
                  inArray(inventoryBlocks.status, [...ACTIVE_BLOCK_STATUSES]),
                  isNull(inventoryBlocks.deletedAt),
                  sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${booking.blockedStartAt.toISOString()}::timestamptz, ${booking.blockedEndAt.toISOString()}::timestamptz)`,
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(inventoryItems.internalSku), asc(inventoryItems.id))
    .limit(MAX_SUBSTITUTION_CANDIDATES);

  return candidateRows;
}

/**
 * Remplace atomiquement l'exemplaire d'une ligne de réservation.
 *
 * Le bloc BOOKING existant est conservé et déplacé vers le nouvel exemplaire;
 * cela libère l'ancien équipement sans créer de fenêtre non bloquée. La
 * contrainte d'exclusion PostgreSQL reste la dernière barrière contre une
 * réservation concurrente.
 */
export async function substituteBookingItem(
  db: DatabaseClient,
  input: SubstituteBookingItemInput,
): Promise<SubstituteBookingItemResult> {
  const normalized = validateInput(input);
  const requestFingerprint = computeCounterIncidentFingerprint({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    bookingItemId: input.bookingItemId,
    replacementInventoryItemId: input.replacementInventoryItemId,
    actorUserId: input.actorUserId,
    operation: 'substitute_booking_item',
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'substitute_booking_item',
    key: normalized.idempotencyKey,
    requestFingerprint,
  });
  if (reservation.kind === 'REPLAY') {
    return replayPersistedSubstitution(
      reservation.record,
      input.bookingId,
      input.bookingItemId,
      input.replacementInventoryItemId,
    );
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
        return replayPersistedSubstitution(
          lock.record,
          input.bookingId,
          input.bookingItemId,
          input.replacementInventoryItemId,
        );
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
      if (!isSubstitutionEligibleStatus(booking.status)) {
        throw new FulfillmentError(
          'INVALID_TRANSITION',
          `La substitution est impossible dans l'état ${booking.status}.`,
        );
      }

      const itemRows = await tx
        .select()
        .from(bookingItems)
        .where(eq(bookingItems.id, input.bookingItemId))
        .for('update')
        .limit(1);
      if (itemRows.length === 0) {
        throw new FulfillmentError(
          'BOOKING_ITEM_NOT_FOUND',
          `Élément de réservation ${input.bookingItemId} introuvable.`,
        );
      }
      const bookingItem = itemRows[0]!;
      if (bookingItem.bookingId !== booking.id) {
        throw new FulfillmentError(
          'BOOKING_ITEM_MISMATCH',
          "L'élément de réservation n'appartient pas à la réservation.",
        );
      }
      if (bookingItem.inventoryItemId === input.replacementInventoryItemId) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement doit être différent de l'exemplaire actuel.",
        );
      }

      const lineRows = await tx
        .select({ bookingId: bookingLines.bookingId, variantId: bookingLines.variantId })
        .from(bookingLines)
        .where(eq(bookingLines.id, bookingItem.bookingLineId))
        .limit(1);
      if (lineRows.length === 0 || lineRows[0]!.bookingId !== booking.id) {
        throw new FulfillmentError(
          'BOOKING_ITEM_MISMATCH',
          'La ligne de réservation associée est incohérente.',
        );
      }
      const line = lineRows[0]!;

      const blockRows = await tx
        .select()
        .from(inventoryBlocks)
        .where(eq(inventoryBlocks.id, bookingItem.bookingBlockId))
        .for('update')
        .limit(1);
      if (blockRows.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "Le bloc d'inventaire associé est introuvable.",
        );
      }
      const bookingBlock = blockRows[0]!;
      if (
        bookingBlock.organizationId !== input.organizationId ||
        bookingBlock.type !== 'BOOKING' ||
        bookingBlock.status !== 'ACTIVE' ||
        bookingBlock.deletedAt !== null ||
        bookingBlock.inventoryItemId !== bookingItem.inventoryItemId ||
        bookingBlock.blockedStartAt.getTime() !== booking.blockedStartAt.getTime() ||
        bookingBlock.blockedEndAt.getTime() !== booking.blockedEndAt.getTime()
      ) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "Le bloc d'inventaire associé n'est plus cohérent avec la réservation.",
        );
      }

      // Les deux lignes d'inventaire sont verrouillées dans l'ordre de leur UUID.
      // Cela évite qu'une substitution croisée puisse créer un deadlock.
      const inventoryItemIds = [
        bookingItem.inventoryItemId,
        input.replacementInventoryItemId,
      ].sort();
      const lockedInventoryItems = await tx
        .select()
        .from(inventoryItems)
        .where(inArray(inventoryItems.id, inventoryItemIds))
        .orderBy(asc(inventoryItems.id))
        .for('update');
      const currentInventoryItem = lockedInventoryItems.find(
        (item) => item.id === bookingItem.inventoryItemId,
      );
      const replacementInventoryItem = lockedInventoryItems.find(
        (item) => item.id === input.replacementInventoryItemId,
      );
      if (!currentInventoryItem || !replacementInventoryItem) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement est introuvable.",
        );
      }
      if (currentInventoryItem.organizationId !== input.organizationId) {
        throw new FulfillmentError(
          'ORGANIZATION_MISMATCH',
          "L'exemplaire actuel n'appartient pas à l'organisation.",
        );
      }
      if (replacementInventoryItem.organizationId !== input.organizationId) {
        throw new FulfillmentError(
          'ORGANIZATION_MISMATCH',
          "L'exemplaire de remplacement n'appartient pas à l'organisation.",
        );
      }
      if (
        replacementInventoryItem.currentLocationId !== booking.locationId ||
        replacementInventoryItem.productVariantId !== line.variantId ||
        replacementInventoryItem.status !== 'ACTIVE' ||
        replacementInventoryItem.deletedAt !== null ||
        !isUsableSubstitutionCondition(replacementInventoryItem.condition)
      ) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement n'est pas un équivalent disponible dans cet établissement.",
        );
      }

      const duplicateRows = await tx
        .select({ id: bookingItems.id })
        .from(bookingItems)
        .where(
          and(
            eq(bookingItems.bookingId, booking.id),
            eq(bookingItems.inventoryItemId, replacementInventoryItem.id),
            not(eq(bookingItems.id, bookingItem.id)),
          ),
        )
        .limit(1);
      if (duplicateRows.length > 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement est déjà affecté à cette réservation.",
        );
      }

      const conflictRows = await tx
        .select({ id: inventoryBlocks.id })
        .from(inventoryBlocks)
        .where(
          and(
            eq(inventoryBlocks.inventoryItemId, replacementInventoryItem.id),
            inArray(inventoryBlocks.status, [...ACTIVE_BLOCK_STATUSES]),
            isNull(inventoryBlocks.deletedAt),
            sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${booking.blockedStartAt.toISOString()}::timestamptz, ${booking.blockedEndAt.toISOString()}::timestamptz)`,
          ),
        )
        .limit(1);
      if (conflictRows.length > 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement n'est pas disponible sur tout le créneau.",
        );
      }

      const updatedItems = await tx
        .update(bookingItems)
        .set({ inventoryItemId: replacementInventoryItem.id })
        .where(
          and(
            eq(bookingItems.id, bookingItem.id),
            eq(bookingItems.bookingId, booking.id),
            eq(bookingItems.inventoryItemId, currentInventoryItem.id),
          ),
        )
        .returning({ id: bookingItems.id });
      if (updatedItems.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'élément de réservation a été modifié concurremment.",
        );
      }

      const updatedBlocks = await tx
        .update(inventoryBlocks)
        .set({ inventoryItemId: replacementInventoryItem.id, updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryBlocks.id, bookingBlock.id),
            eq(inventoryBlocks.inventoryItemId, currentInventoryItem.id),
            eq(inventoryBlocks.status, 'ACTIVE'),
          ),
        )
        .returning({ id: inventoryBlocks.id });
      if (updatedBlocks.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "Le bloc d'inventaire a été modifié concurremment.",
        );
      }

      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'SUBSTITUTED',
        targetType: 'BOOKING_ITEM',
        targetId: bookingItem.id,
        metadata: {
          organizationId: input.organizationId,
          bookingId: booking.id,
          bookingItemId: bookingItem.id,
          bookingBlockId: bookingBlock.id,
          previousInventoryItemId: currentInventoryItem.id,
          previousSku: currentInventoryItem.internalSku,
          replacementInventoryItemId: replacementInventoryItem.id,
          replacementSku: replacementInventoryItem.internalSku,
          productVariantId: line.variantId,
          locationId: booking.locationId,
        },
      });

      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'BOOKING',
          aggregateId: booking.id,
          eventType: 'BOOKING_ITEM_SUBSTITUTED',
          eventVersion: 'v1',
          payload: {
            organizationId: input.organizationId,
            bookingId: booking.id,
            bookingItemId: bookingItem.id,
            bookingBlockId: bookingBlock.id,
            previousInventoryItemId: currentInventoryItem.id,
            previousSku: currentInventoryItem.internalSku,
            replacementInventoryItemId: replacementInventoryItem.id,
            replacementSku: replacementInventoryItem.internalSku,
            productVariantId: line.variantId,
            locationId: booking.locationId,
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: sql`now()`,
          idempotencyKey: `booking_item_substituted_${bookingItem.id}_${normalized.idempotencyKey}`,
        })
        .returning({ id: outboxEvents.id });
      if (outboxRows.length === 0) {
        throw new FulfillmentError(
          'UNKNOWN',
          "Échec de l'insertion de l'événement de substitution.",
        );
      }

      const result: SubstituteBookingItemResult = {
        kind: 'APPLIED',
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        bookingBlockId: bookingBlock.id,
        previousInventoryItemId: currentInventoryItem.id,
        replacementInventoryItemId: replacementInventoryItem.id,
        previousSku: currentInventoryItem.internalSku,
        replacementSku: replacementInventoryItem.internalSku,
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: bookingItem.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (err) {
    const expectedError =
      err instanceof FulfillmentError
        ? err
        : isInventoryExclusionViolation(err)
          ? new FulfillmentError(
              'CONCURRENT_MODIFICATION',
              "L'exemplaire de remplacement est devenu indisponible pendant l'opération.",
            )
          : null;
    if (expectedError) {
      await persistFulfillmentFailureSafely(db, reservation.record.id, expectedError);
      throw expectedError;
    }
    const sanitized = new FulfillmentError(
      'UNKNOWN',
      'Erreur inattendue lors de la substitution de l’exemplaire.',
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new FulfillmentError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}

function validateInput(input: SubstituteBookingItemInput): { idempotencyKey: string } {
  assertUuid(input.organizationId, 'organizationId');
  assertUuid(input.bookingId, 'bookingId');
  assertUuid(input.bookingItemId, 'bookingItemId');
  assertUuid(input.replacementInventoryItemId, 'replacementInventoryItemId');
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
  return { idempotencyKey };
}

function isInventoryExclusionViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  return (
    candidate.code === '23P01' ||
    candidate.constraint === 'no_overlapping_blocks' ||
    candidate.constraint_name === 'no_overlapping_blocks'
  );
}

function replayPersistedSubstitution(
  record: IdempotencyRecordRow,
  bookingId: string,
  bookingItemId: string,
  replacementInventoryItemId: string,
): SubstituteBookingItemResult {
  if (record.status === 'FAILED') throw decodePersistedFulfillmentError(record);
  if (record.status !== 'COMPLETED') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `Statut idempotency inattendu lors du replay: ${record.status}.`,
    );
  }
  const body = record.responseBody;
  if (body === null || typeof body !== 'object') {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse substitution malformée.');
  }
  const raw = body as Record<string, unknown>;
  const uuidFields = [
    'bookingId',
    'bookingItemId',
    'bookingBlockId',
    'previousInventoryItemId',
    'replacementInventoryItemId',
  ] as const;
  if (
    raw.kind !== 'APPLIED' ||
    raw.bookingId !== bookingId ||
    raw.bookingItemId !== bookingItemId ||
    raw.replacementInventoryItemId !== replacementInventoryItemId ||
    record.resourceId !== bookingItemId ||
    record.responseStatusCode !== 200 ||
    typeof raw.previousSku !== 'string' ||
    typeof raw.replacementSku !== 'string' ||
    uuidFields.some(
      (field) => typeof raw[field] !== 'string' || !UUID_REGEX.test(raw[field] as string),
    )
  ) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse substitution incohérente.');
  }

  return {
    kind: 'APPLIED',
    bookingId,
    bookingItemId,
    bookingBlockId: raw.bookingBlockId as string,
    previousInventoryItemId: raw.previousInventoryItemId as string,
    replacementInventoryItemId,
    previousSku: raw.previousSku,
    replacementSku: raw.replacementSku,
  };
}
