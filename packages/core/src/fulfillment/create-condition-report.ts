import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingItems,
  conditionReports,
  inventoryItems,
  outboxEvents,
} from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey } from '../idempotency/idempotency';
import type { IdempotencyRecordRow } from '../idempotency/types';
import { writeAuditEntry } from '../identity/audit';
import { FulfillmentError } from './fulfillment-errors';
import type { BookingStatus } from './types';
import type { InventoryCondition } from '../catalog/types';
import {
  isConditionReportPhase,
  isInventoryCondition,
  type ConditionReportInput,
  type ConditionReportPhase,
  type ConditionReportResult,
} from './report-types';
import { computeConditionReportFingerprint } from './report-fingerprints';
import {
  decodePersistedFulfillmentError,
  persistFulfillmentFailureSafely,
  verifyFulfillmentMembership,
} from './fulfillment-shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES_LENGTH = 5000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * @uttily/core — Use case transactionnel de création de rapport d'état (G3B).
 *
 * Règles métier MVP :
 * - phase PICKUP : booking.status doit être READY_FOR_PICKUP
 * - phase RETURN : booking.status doit être ACTIVE
 * - booking_item doit appartenir au booking
 * - inventoryItemId est DÉRIVÉ du booking_item verrouillé (jamais accepté du client)
 * - actor doit avoir une membership ACTIVE dans FULFILLMENT_OPERATORS
 *
 * Ordre des verrous :
 * 1. lockKey(tx, idempotencyRecordId)
 * 2. lockOrganization(tx, organizationId)
 * 3. booking FOR UPDATE
 * 4. booking_item FOR UPDATE
 *
 * Atomicité : condition_reports + audit_log + outbox_events + completeKey
 * dans une seule transaction. Aucun appel externe.
 */
export async function createConditionReport(
  db: DatabaseClient,
  input: ConditionReportInput,
): Promise<ConditionReportResult> {
  const normalized = validateAndNormalize(input);

  const requestFingerprint = computeConditionReportFingerprint({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    bookingItemId: input.bookingItemId,
    actorUserId: input.actorUserId,
    phase: normalized.phase,
    condition: normalized.condition,
    notes: normalized.notes,
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'create_condition_report',
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayPersistedConditionReport(
      reservation.record,
      input.bookingId,
      input.bookingItemId,
      normalized.phase,
      normalized.condition,
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
        return replayPersistedConditionReport(
          lock.record,
          input.bookingId,
          input.bookingItemId,
          normalized.phase,
          normalized.condition,
        );
      }

      await lockOrganization(tx, input.organizationId);

      // 3. booking FOR UPDATE
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
          `La réservation n'appartient pas à l'organisation.`,
        );
      }

      // membership ACTIVE + rôle
      await verifyFulfillmentMembership(tx, input.organizationId, input.actorUserId);

      // 4. booking_item FOR UPDATE
      const itemRows = await tx
        .select()
        .from(bookingItems)
        .where(eq(bookingItems.id, input.bookingItemId))
        .for('update')
        .limit(1);
      if (itemRows.length === 0) {
        throw new FulfillmentError(
          'BOOKING_ITEM_NOT_FOUND',
          `Booking item ${input.bookingItemId} introuvable.`,
        );
      }
      const bookingItem = itemRows[0]!;
      if (bookingItem.bookingId !== booking.id) {
        throw new FulfillmentError(
          'BOOKING_ITEM_MISMATCH',
          `Le booking item n'appartient pas à la réservation.`,
        );
      }

      // Vérifier que l'inventory_item appartient à l'organisation (multi-tenant)
      const invRows = await tx
        .select({ organizationId: inventoryItems.organizationId })
        .from(inventoryItems)
        .where(eq(inventoryItems.id, bookingItem.inventoryItemId))
        .limit(1);
      if (invRows.length === 0 || invRows[0]!.organizationId !== input.organizationId) {
        throw new FulfillmentError(
          'ORGANIZATION_MISMATCH',
          `L'exemplaire n'appartient pas à l'organisation.`,
        );
      }

      // Dériver inventoryItemId du booking_item (jamais du client)
      const inventoryItemId = bookingItem.inventoryItemId;

      // Vérifier le statut compatible avec la phase
      const requiredStatus: BookingStatus =
        normalized.phase === 'PICKUP' ? 'READY_FOR_PICKUP' : 'ACTIVE';
      if (booking.status !== requiredStatus) {
        throw new FulfillmentError(
          'REPORT_PHASE_NOT_ALLOWED',
          `Rapport d'état ${normalized.phase} refusé : le statut booking est ${booking.status}, attendu ${requiredStatus}.`,
        );
      }

      // INSERT condition_reports avec RETURNING (id, createdAt)
      const reportRows = await tx
        .insert(conditionReports)
        .values({
          organizationId: input.organizationId,
          bookingId: booking.id,
          bookingItemId: bookingItem.id,
          inventoryItemId,
          phase: normalized.phase,
          condition: normalized.condition,
          notes: normalized.notes,
          reporterUserId: input.actorUserId,
          idempotencyKey: normalized.idempotencyKey,
        })
        .returning({ id: conditionReports.id, createdAt: conditionReports.createdAt });
      if (reportRows.length === 0) {
        throw new FulfillmentError('UNKNOWN', "Échec de l'insertion du rapport d'état.");
      }
      const reportId = reportRows[0]!.id;
      const createdAt = reportRows[0]!.createdAt;

      // Audit (SANS notes)
      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'CONDITION_REPORT_CREATED',
        targetType: 'CONDITION_REPORT',
        targetId: reportId,
        metadata: {
          organizationId: input.organizationId,
          bookingId: booking.id,
          bookingItemId: bookingItem.id,
          inventoryItemId,
          phase: normalized.phase,
          condition: normalized.condition,
        },
      });

      // Outbox (SANS notes, avec createdAt PostgreSQL)
      const outboxIdempotencyKey = `condition_report_created_${reportId}`;
      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'CONDITION_REPORT',
          aggregateId: reportId,
          eventType: 'CONDITION_REPORT_CREATED',
          eventVersion: 'v1',
          payload: {
            reportId,
            bookingId: booking.id,
            bookingItemId: bookingItem.id,
            inventoryItemId,
            organizationId: input.organizationId,
            phase: normalized.phase,
            condition: normalized.condition,
            createdAt: createdAt.toISOString(),
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: sql`now()`,
          idempotencyKey: outboxIdempotencyKey,
        })
        .returning({ id: outboxEvents.id });
      if (outboxRows.length === 0) {
        throw new FulfillmentError('UNKNOWN', "Échec de l'insertion de l'événement outbox.");
      }

      const result: ConditionReportResult = {
        kind: 'APPLIED',
        reportId,
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        inventoryItemId,
        phase: normalized.phase,
        condition: normalized.condition,
      };
      await completeKey(tx, reservation.record.id, {
        resourceId: reportId,
        responseStatusCode: 201,
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
      "Erreur inattendue lors de la création du rapport d'état.",
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

/**
 * Validation et normalisation des entrées.
 * @throws FulfillmentError('VALIDATION') pour UUID invalide, idempotencyKey invalide, phase invalide.
 * @throws FulfillmentError('INVALID_CONDITION') pour condition invalide.
 */
function validateAndNormalize(input: ConditionReportInput): {
  phase: ConditionReportPhase;
  condition: InventoryCondition;
  notes: string | null;
  idempotencyKey: string;
} {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new FulfillmentError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.bookingId)) {
    throw new FulfillmentError('VALIDATION', 'bookingId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.bookingItemId)) {
    throw new FulfillmentError('VALIDATION', 'bookingItemId doit être un UUID valide.');
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
  if (!isConditionReportPhase(input.phase)) {
    throw new FulfillmentError('VALIDATION', `phase invalide: ${String(input.phase)}.`);
  }
  if (!isInventoryCondition(input.condition)) {
    throw new FulfillmentError(
      'INVALID_CONDITION',
      `condition invalide: ${String(input.condition)}.`,
    );
  }
  let notes: string | null = null;
  if (input.notes !== undefined && input.notes !== null) {
    const trimmed = input.notes.trim();
    if (trimmed.length > MAX_NOTES_LENGTH) {
      throw new FulfillmentError(
        'VALIDATION',
        `notes ne doit pas dépasser ${MAX_NOTES_LENGTH} caractères.`,
      );
    }
    notes = trimmed.length === 0 ? null : trimmed;
  }
  return { phase: input.phase, condition: input.condition, notes, idempotencyKey };
}

/**
 * Rejoue un enregistrement idempotent terminal (COMPLETED ou FAILED).
 *
 * - COMPLETED : retourne le ConditionReportResult persisté.
 * - FAILED : reconstruit et lance une FulfillmentError avec le même code, message
 *   et fromStatus/toStatus que l'erreur originale persistée.
 * - Statut inattendu (PENDING) ou responseBody malformé : lance
 *   FulfillmentError('IDEMPOTENCY_REPLAY_INVALID').
 *
 * Ne tente jamais de re-réserver ou de re-exécuter la transaction.
 * @throws FulfillmentError si l'enregistrement est FAILED ou malformé.
 */
function replayPersistedConditionReport(
  record: IdempotencyRecordRow,
  bookingId: string,
  bookingItemId: string,
  expectedPhase: ConditionReportPhase,
  expectedCondition: InventoryCondition,
): ConditionReportResult {
  if (record.status === 'COMPLETED') {
    return replayCompletedConditionReport(
      record,
      bookingId,
      bookingItemId,
      expectedPhase,
      expectedCondition,
    );
  }
  if (record.status === 'FAILED') {
    throw decodePersistedFulfillmentError(record);
  }
  throw new FulfillmentError(
    'IDEMPOTENCY_REPLAY_INVALID',
    `Statut idempotency inattendu lors du replay: ${record.status}.`,
  );
}

/**
 * Rejoue une réponse COMPLETED (APPLIED).
 * Valide tous les champs du responseBody persisté pour éviter tout cast non vérifié.
 * Vérifie également la cohérence avec l'enregistrement idempotent (resourceId,
 * responseStatusCode) et avec les valeurs attendues de la requête (phase, condition).
 * @throws FulfillmentError('IDEMPOTENCY_REPLAY_INVALID') si le responseBody est malformé,
 *         si un champ est invalide, ou si l'enregistrement est incohérent.
 */
function replayCompletedConditionReport(
  record: IdempotencyRecordRow,
  bookingId: string,
  bookingItemId: string,
  expectedPhase: ConditionReportPhase,
  expectedCondition: InventoryCondition,
): ConditionReportResult {
  const body = record.responseBody;
  if (body === null || typeof body !== 'object' || !('kind' in body)) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse COMPLETED malformée.');
  }
  const raw = body as Record<string, unknown>;
  if (raw.kind !== 'APPLIED') {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `Kind COMPLETED inattendu: ${String(raw.kind)}.`,
    );
  }
  if (typeof raw.reportId !== 'string' || !UUID_REGEX.test(raw.reportId)) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'reportId rejoué invalide (non-UUID).',
    );
  }
  if (record.resourceId !== raw.reportId) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'Le resourceId idempotent ne correspond pas au reportId de la réponse.',
    );
  }
  if (record.responseStatusCode !== 201) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      `responseStatusCode idempotent inattendu: ${String(record.responseStatusCode)}, attendu 201.`,
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
  if (typeof raw.bookingItemId !== 'string' || !UUID_REGEX.test(raw.bookingItemId)) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'bookingItemId rejoué invalide (non-UUID).',
    );
  }
  if (raw.bookingItemId !== bookingItemId) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'Le bookingItemId rejoué ne correspond pas.',
    );
  }
  if (typeof raw.inventoryItemId !== 'string' || !UUID_REGEX.test(raw.inventoryItemId)) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'inventoryItemId rejoué invalide (non-UUID).',
    );
  }
  if (!isConditionReportPhase(raw.phase)) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'phase rejouée invalide.');
  }
  if (raw.phase !== expectedPhase) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'La phase rejouée ne correspond pas à la phase attendue de la requête.',
    );
  }
  if (!isInventoryCondition(raw.condition)) {
    throw new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'condition rejouée invalide.');
  }
  if (raw.condition !== expectedCondition) {
    throw new FulfillmentError(
      'IDEMPOTENCY_REPLAY_INVALID',
      'La condition rejouée ne correspond pas à la condition attendue de la requête.',
    );
  }
  return {
    kind: 'APPLIED',
    reportId: raw.reportId,
    bookingId: raw.bookingId,
    bookingItemId: raw.bookingItemId,
    inventoryItemId: raw.inventoryItemId,
    phase: raw.phase,
    condition: raw.condition,
  };
}
