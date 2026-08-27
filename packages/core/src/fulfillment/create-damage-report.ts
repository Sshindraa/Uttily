import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingItems,
  damageReports,
  inventoryBlocks,
  inventoryItems,
  outboxEvents,
} from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey } from '../idempotency/idempotency';
import type { IdempotencyRecordRow } from '../idempotency/types';
import { writeAuditEntry } from '../identity/audit';
import { FulfillmentError } from './fulfillment-errors';
import type { BookingStatus } from './types';
import type { DamageReportInput, DamageReportResult } from './report-types';
import { computeDamageReportFingerprint } from './report-fingerprints';
import {
  decodePersistedFulfillmentError,
  persistFulfillmentFailureSafely,
  verifyFulfillmentMembership,
} from './fulfillment-shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const ALLOWED_DAMAGE_STATUSES: readonly BookingStatus[] = ['ACTIVE', 'RETURNED'];

/**
 * @uttily/core — Use case transactionnel de déclaration de dommage (G3B / Chantier 8D).
 *
 * Règles métier MVP :
 * - booking.status doit être ACTIVE ou RETURNED
 * - booking_item doit appartenir au booking
 * - inventoryItemId est DÉRIVÉ du booking_item verrouillé (jamais accepté du client)
 * - actor doit avoir une membership ACTIVE dans FULFILLMENT_OPERATORS
 * - Si input.blocksInventory est true : l'exemplaire est marqué BROKEN et un bloc MAINTENANCE est créé
 *
 * Ordre des verrous :
 * 1. lockKey(tx, idempotencyRecordId)
 * 2. lockOrganization(tx, organizationId)
 * 3. booking FOR UPDATE
 * 4. booking_item FOR UPDATE
 *
 * Atomicité : damage_reports + inventory_items (optionnel) + inventory_blocks (optionnel)
 * + audit_log + outbox_events + completeKey dans une seule transaction.
 */
export async function createDamageReport(
  db: DatabaseClient,
  input: DamageReportInput,
): Promise<DamageReportResult> {
  const normalized = validateAndNormalize(input);

  const requestFingerprint = computeDamageReportFingerprint({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    bookingItemId: input.bookingItemId,
    actorUserId: input.actorUserId,
    description: normalized.description,
    blocksInventory: input.blocksInventory,
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'create_damage_report',
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayPersistedDamageReport(reservation.record, input.bookingId, input.bookingItemId);
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
        return replayPersistedDamageReport(lock.record, input.bookingId, input.bookingItemId);
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

      // Vérifier le statut autorisé pour les dommages
      if (!ALLOWED_DAMAGE_STATUSES.includes(booking.status)) {
        throw new FulfillmentError(
          'DAMAGE_REPORT_NOT_ALLOWED',
          `Déclaration de dommage refusée : le statut booking est ${booking.status}.`,
        );
      }

      // INSERT damage_reports avec RETURNING (id, createdAt)
      const reportRows = await tx
        .insert(damageReports)
        .values({
          organizationId: input.organizationId,
          bookingId: booking.id,
          bookingItemId: bookingItem.id,
          inventoryItemId,
          description: normalized.description,
          reporterUserId: input.actorUserId,
          idempotencyKey: normalized.idempotencyKey,
        })
        .returning({ id: damageReports.id, createdAt: damageReports.createdAt });
      if (reportRows.length === 0) {
        throw new FulfillmentError('UNKNOWN', "Échec de l'insertion du rapport de dommage.");
      }
      const reportId = reportRows[0]!.id;
      const createdAt = reportRows[0]!.createdAt;

      // Si blocksInventory est activé (Chantiers 8D / 8.1) :
      // 1. Marquer l'exemplaire comme BROKEN
      // 2. Créer un inventoryBlock de type MAINTENANCE indéfini (horizon 9999) jusqu'à résolution explicite
      if (input.blocksInventory) {
        await tx
          .update(inventoryItems)
          .set({ condition: 'BROKEN', updatedAt: sql`now()` })
          .where(eq(inventoryItems.id, inventoryItemId));

        await tx.insert(inventoryBlocks).values({
          organizationId: input.organizationId,
          inventoryItemId,
          type: 'MAINTENANCE',
          status: 'ACTIVE',
          customerStartAt: sql`now()`,
          customerEndAt: new Date('9999-12-31T23:59:59.999Z'),
          blockedStartAt: sql`now()`,
          blockedEndAt: new Date('9999-12-31T23:59:59.999Z'),
          sourceId: reportId,
        });
      }

      // Audit (SANS description)
      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'DAMAGE_REPORTED',
        targetType: 'DAMAGE_REPORT',
        targetId: reportId,
        metadata: {
          organizationId: input.organizationId,
          bookingId: booking.id,
          bookingItemId: bookingItem.id,
          inventoryItemId,
          ...(input.blocksInventory ? { blockedInventory: true } : {}),
        },
      });

      // Outbox (SANS description, avec createdAt PostgreSQL)
      const outboxIdempotencyKey = `damage_reported_${reportId}`;
      const outboxRows = await tx
        .insert(outboxEvents)
        .values({
          organizationId: input.organizationId,
          aggregateType: 'DAMAGE_REPORT',
          aggregateId: reportId,
          eventType: 'DAMAGE_REPORTED',
          eventVersion: 'v1',
          payload: {
            reportId,
            bookingId: booking.id,
            bookingItemId: bookingItem.id,
            inventoryItemId,
            organizationId: input.organizationId,
            createdAt: createdAt.toISOString(),
            ...(input.blocksInventory ? { blockedInventory: true } : {}),
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

      const result: DamageReportResult = {
        kind: 'APPLIED',
        reportId,
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        inventoryItemId,
        ...(input.blocksInventory ? { blockedInventory: true } : {}),
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
      'Erreur inattendue lors de la déclaration de dommage.',
    );
    await persistFulfillmentFailureSafely(db, reservation.record.id, sanitized);
    throw err;
  }
}

/**
 * Validation et normalisation des entrées.
 * @throws FulfillmentError('VALIDATION') pour UUID invalide, idempotencyKey invalide, description invalide.
 */
function validateAndNormalize(input: DamageReportInput): {
  description: string;
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
  const description = input.description.trim();
  if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new FulfillmentError(
      'VALIDATION',
      `La description doit faire entre 1 et ${MAX_DESCRIPTION_LENGTH} caractères.`,
    );
  }
  return { description, idempotencyKey };
}

/**
 * Rejoue un enregistrement idempotent terminal (COMPLETED ou FAILED).
 *
 * - COMPLETED : retourne le DamageReportResult persisté.
 * - FAILED : reconstruit et lance une FulfillmentError avec le même code, message
 *   et fromStatus/toStatus que l'erreur originale persistée.
 * - Statut inattendu (PENDING) ou responseBody malformé : lance
 *   FulfillmentError('IDEMPOTENCY_REPLAY_INVALID').
 *
 * Ne tente jamais de re-réserver ou de re-exécuter la transaction.
 * @throws FulfillmentError si l'enregistrement est FAILED ou malformé.
 */
function replayPersistedDamageReport(
  record: IdempotencyRecordRow,
  bookingId: string,
  bookingItemId: string,
): DamageReportResult {
  if (record.status === 'COMPLETED') {
    return replayCompletedDamageReport(record, bookingId, bookingItemId);
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
 * responseStatusCode).
 * @throws FulfillmentError('IDEMPOTENCY_REPLAY_INVALID') si le responseBody est malformé,
 *         si un champ est invalide, ou si l'enregistrement est incohérent.
 */
function replayCompletedDamageReport(
  record: IdempotencyRecordRow,
  bookingId: string,
  bookingItemId: string,
): DamageReportResult {
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
  return {
    kind: 'APPLIED',
    reportId: raw.reportId,
    bookingId: raw.bookingId,
    bookingItemId: raw.bookingItemId,
    inventoryItemId: raw.inventoryItemId,
  };
}
