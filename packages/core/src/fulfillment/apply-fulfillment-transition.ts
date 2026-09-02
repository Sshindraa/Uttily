import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import { bookings, bookingFulfillmentEvents, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey } from '../idempotency/idempotency';
import type { IdempotencyRecordRow } from '../idempotency/types';
import { writeAuditEntry } from '../identity/audit';
import { projectBookingStatus } from './project-booking-status';
import { BookingTransitionError } from './errors';
import { FulfillmentError } from './fulfillment-errors';
import { computeFulfillmentFingerprint } from './fingerprint';
import type { BookingStatus, FulfillmentEventType } from './types';
import {
  decodePersistedFulfillmentError,
  isBookingStatus,
  persistFulfillmentFailureSafely,
  verifyFulfillmentMembership,
} from './fulfillment-shared';

/**
 * @uttily/core — Use case commun transactionnel pour les transitions terrain (G3A).
 *
 * Factorisation interne commune aux 4 opérations (prepare, pickup, return, close)
 * pour éviter 4 implémentations divergentes. Garantit l'atomicité des quatre
 * écritures (statut booking, fulfillment event, audit, outbox) et de l'idempotence.
 *
 * Ordre des verrous (cohérent avec les Lots 4/5) :
 * 1. lockKey(tx, idempotencyRecordId) — verrou la ligne idempotency
 * 2. lockOrganization(tx, organizationId) — verrou advisory organisation
 * 3. SELECT ... FROM bookings WHERE id = bookingId FOR UPDATE — verrou le booking
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Entrée commune pour toutes les transitions terrain.
 */
export interface FulfillmentTransitionInput {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  idempotencyKey: string;
}

/**
 * Contexte fourni à une opération qui doit compléter la transition dans la
 * même transaction (par exemple la protection maintenance d'un retour).
 */
export interface FulfillmentAppliedContext {
  tx: DatabaseTransaction;
  booking: typeof bookings.$inferSelect;
  input: FulfillmentTransitionInput;
  previousStatus: BookingStatus;
  nextStatus: BookingStatus;
  fulfillmentEventId: string;
  occurredAt: Date;
}

/**
 * Résultat rejouable d'une transition terrain.
 */
export type FulfillmentTransitionResult =
  | {
      kind: 'APPLIED';
      bookingId: string;
      previousStatus: BookingStatus;
      nextStatus: BookingStatus;
      fulfillmentEventId: string;
    }
  | { kind: 'NOOP'; bookingId: string; currentStatus: BookingStatus };

/**
 * Spécification d'une opération de fulfillment (une par transition).
 */
export interface FulfillmentOperationSpec {
  operation: string;
  eventType: FulfillmentEventType;
  requestedStatus: BookingStatus;
  auditAction: string;
  outboxEventType: string;
  /** Empreinte spécifique lorsque l'opération possède un payload additionnel. */
  computeRequestFingerprint?: (input: FulfillmentTransitionInput) => string;
  /** Écritures complémentaires exécutées avant l'audit et l'outbox génériques. */
  afterApplied?: (context: FulfillmentAppliedContext) => Promise<void>;
}

/**
 * Applique une transition de fulfillment de manière transactionnelle, idempotente,
 * autorisée et auditée.
 *
 * Étapes :
 * 1. Valide les UUID, la clé d'idempotence et les entrées
 * 2. Calcule l'empreinte canonique
 * 3. Réserve la clé via reserveKey
 * 4. Gère REPLAY (retourne la réponse persistée) et CONFLICT (lève FulfillmentError)
 * 5. Dans une transaction :
 *    - lockKey(tx, recordId) → LOCKED ou REPLAY
 *    - lockOrganization(tx, organizationId)
 *    - Charge et verrouille le booking avec SELECT ... FOR UPDATE
 *    - Vérifie booking.organizationId === organizationId (sinon ORGANIZATION_MISMATCH)
 *    - Vérifie membership ACTIVE de actorUserId (sinon FORBIDDEN)
 *    - Appelle projectBookingStatus(booking.status, requestedStatus)
 *    - Si NOOP : termine la clé idempotente en COMPLETED sans event/audit/outbox
 *    - Si APPLIED : UPDATE booking, INSERT fulfillment event, audit, outbox, completeKey
 * 6. Retourne un résultat typé rejouable
 */
export async function applyFulfillmentTransition(
  db: DatabaseClient,
  spec: FulfillmentOperationSpec,
  input: FulfillmentTransitionInput,
): Promise<FulfillmentTransitionResult> {
  const idempotencyKey = validateInput(input);

  const requestFingerprint =
    spec.computeRequestFingerprint?.(input) ??
    computeFulfillmentFingerprint({
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      actorUserId: input.actorUserId,
      operation: spec.operation,
    });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: spec.operation,
    key: idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayPersistedRecord(reservation.record, input.bookingId);
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
        return replayPersistedRecord(lock.record, input.bookingId);
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
          `La réservation ${input.bookingId} n'appartient pas à l'organisation ${input.organizationId}.`,
        );
      }

      await verifyFulfillmentMembership(tx, input.organizationId, input.actorUserId);

      let transition;
      try {
        transition = projectBookingStatus(booking.status, spec.requestedStatus);
      } catch (err) {
        if (err instanceof BookingTransitionError) {
          throw new FulfillmentError(err.code, err.message, {
            fromStatus: err.fromStatus,
            toStatus: err.toStatus,
          });
        }
        throw err;
      }

      if (transition.kind === 'NOOP') {
        const noopBody: FulfillmentTransitionResult = {
          kind: 'NOOP',
          bookingId: booking.id,
          currentStatus: transition.currentStatus,
        };
        await completeKey(tx, reservation.record.id, {
          resourceId: booking.id,
          responseStatusCode: 200,
          responseBody: noopBody,
        });
        return noopBody;
      }

      const updated = await tx
        .update(bookings)
        .set({ status: transition.nextStatus, updatedAt: sql`now()` })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, transition.previousStatus)))
        .returning();

      if (updated.length === 0) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          `Le statut de la réservation ${booking.id} a été modifié concurremment.`,
        );
      }

      const eventRows = await tx
        .insert(bookingFulfillmentEvents)
        .values({
          organizationId: input.organizationId,
          bookingId: booking.id,
          eventType: spec.eventType,
          previousStatus: transition.previousStatus,
          nextStatus: transition.nextStatus,
          actorUserId: input.actorUserId,
          idempotencyKey,
        })
        .returning({
          id: bookingFulfillmentEvents.id,
          occurredAt: bookingFulfillmentEvents.occurredAt,
        });

      const fulfillmentEventId = eventRows[0]!.id;
      const occurredAt = eventRows[0]!.occurredAt;

      if (spec.afterApplied) {
        await spec.afterApplied({
          tx,
          booking,
          input,
          previousStatus: transition.previousStatus,
          nextStatus: transition.nextStatus,
          fulfillmentEventId,
          occurredAt,
        });
      }

      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: spec.auditAction,
        targetType: 'BOOKING',
        targetId: booking.id,
        metadata: {
          organizationId: input.organizationId,
          previousStatus: transition.previousStatus,
          nextStatus: transition.nextStatus,
          eventType: spec.eventType,
        },
      });

      const outboxIdempotencyKey = `${spec.outboxEventType.toLowerCase()}_${booking.id}_${fulfillmentEventId}`;
      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'BOOKING',
          aggregateId: booking.id,
          eventType: spec.outboxEventType,
          eventVersion: 'v1',
          payload: {
            bookingId: booking.id,
            organizationId: input.organizationId,
            previousStatus: transition.previousStatus,
            nextStatus: transition.nextStatus,
            fulfillmentEventId,
            occurredAt: occurredAt.toISOString(),
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: sql`now()`,
          idempotencyKey: outboxIdempotencyKey,
        })
        .returning({ id: outboxEvents.id });

      if (outboxRows.length === 0) {
        throw new FulfillmentError(
          'UNKNOWN',
          "Échec de l'insertion de l'événement outbox fulfillment.",
        );
      }

      const appliedBody: FulfillmentTransitionResult = {
        kind: 'APPLIED',
        bookingId: booking.id,
        previousStatus: transition.previousStatus,
        nextStatus: transition.nextStatus,
        fulfillmentEventId,
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: booking.id,
        responseStatusCode: 200,
        responseBody: appliedBody,
      });

      return appliedBody;
    });
  } catch (err) {
    if (err instanceof FulfillmentError) {
      // Erreur métier attendue : persister le message public stable.
      await persistFulfillmentFailureSafely(db, reservation.record.id, err);
      throw err;
    }
    // Erreur inattendue (DB, trigger, etc.) : ne pas persister le message brut
    // (potentiellement sensible : noms de tables, contraintes, stack).
    // Persister un message générique stable ; relancer l'erreur originale pour les logs.
    const sanitized = new FulfillmentError(
      'UNKNOWN',
      'Erreur inattendue lors de la transition fulfillment.',
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

/**
 * Valide les UUID et la clé d'idempotence des entrées.
 * @returns la clé d'idempotence normalisée (trimée).
 * @throws FulfillmentError('VALIDATION') si une entrée est invalide.
 */
function validateInput(input: FulfillmentTransitionInput): string {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new FulfillmentError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.bookingId)) {
    throw new FulfillmentError('VALIDATION', 'bookingId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.actorUserId)) {
    throw new FulfillmentError('VALIDATION', 'actorUserId doit être un UUID valide.');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new FulfillmentError('VALIDATION', 'idempotencyKey est requis (string non vide).');
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `idempotencyKey ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
    );
  }
  return idempotencyKey;
}

/**
 * Rejoue un enregistrement idempotent terminal (COMPLETED ou FAILED).
 *
 * - COMPLETED : retourne le FulfillmentTransitionResult persisté (APPLIED/NOOP).
 * - FAILED : reconstruit et lance une FulfillmentError avec le même code, message
 *   et fromStatus/toStatus que l'erreur originale persistée.
 * - Statut inattendu (PENDING) ou responseBody malformé : lance
 *   FulfillmentError('IDEMPOTENCY_REPLAY_INVALID').
 *
 * Ne tente jamais de re-réserver ou de re-exécuter la transaction.
 * @throws FulfillmentError si l'enregistrement est FAILED ou malformé.
 */
function replayPersistedRecord(
  record: IdempotencyRecordRow,
  bookingId: string,
): FulfillmentTransitionResult {
  if (record.status === 'COMPLETED') {
    return replayCompletedResponse(record, bookingId);
  }
  if (record.status === 'FAILED') {
    throw decodePersistedFulfillmentError(record);
  }
  // PENDING ne devrait jamais arriver ici (reserveKey/lockKey gèrent PENDING séparément).
  throw new FulfillmentError(
    'IDEMPOTENCY_REPLAY_INVALID',
    `Statut idempotency inattendu lors du replay: ${record.status}.`,
  );
}

/**
 * Rejoue une réponse COMPLETED (APPLIED ou NOOP).
 * Valide tous les champs du responseBody persisté pour éviter tout cast non vérifié.
 * @throws FulfillmentError('IDEMPOTENCY_REPLAY_INVALID') si le responseBody est malformé
 *         ou si un champ est invalide.
 */
function replayCompletedResponse(
  record: IdempotencyRecordRow,
  bookingId: string,
): FulfillmentTransitionResult {
  const body = record.responseBody;
  if (body === null || typeof body !== 'object' || !('kind' in body)) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse COMPLETED malformée.');
  }
  const raw = body as Record<string, unknown>;
  if (raw.kind !== 'APPLIED' && raw.kind !== 'NOOP') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `Kind COMPLETED inattendu: ${String(raw.kind)}.`,
    );
  }
  if (typeof raw.bookingId !== 'string' || !UUID_REGEX.test(raw.bookingId)) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'bookingId rejoué invalide (non-UUID).',
    );
  }
  if (raw.bookingId !== bookingId) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'Le bookingId rejoué ne correspond pas.',
    );
  }
  if (raw.kind === 'APPLIED') {
    if (!isBookingStatus(raw.previousStatus)) {
      throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'previousStatus rejoué invalide.');
    }
    if (!isBookingStatus(raw.nextStatus)) {
      throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'nextStatus rejoué invalide.');
    }
    if (typeof raw.fulfillmentEventId !== 'string' || !UUID_REGEX.test(raw.fulfillmentEventId)) {
      throw new FulfillmentError(
        'IDEMPOTENCY_REPLAY_INVALID',
        'fulfillmentEventId rejoué invalide (non-UUID).',
      );
    }
    return {
      kind: 'APPLIED',
      bookingId: raw.bookingId,
      previousStatus: raw.previousStatus,
      nextStatus: raw.nextStatus,
      fulfillmentEventId: raw.fulfillmentEventId,
    };
  }
  // NOOP
  if (!isBookingStatus(raw.currentStatus)) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'currentStatus rejoué invalide.');
  }
  return {
    kind: 'NOOP',
    bookingId: raw.bookingId,
    currentStatus: raw.currentStatus,
  };
}
