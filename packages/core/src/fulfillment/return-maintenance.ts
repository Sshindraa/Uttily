import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '@uttily/database';
import {
  bookingItems,
  bookings,
  damageReports,
  inventoryBlocks,
  inventoryItems,
  maintenanceCases,
  outboxEvents,
} from '@uttily/database';
import { writeAuditEntry } from '../identity/audit';
import { FulfillmentError } from './fulfillment-errors';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Durée opérationnelle par défaut affichée et appliquée au comptoir. */
export const RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES = 24 * 60;
export const RETURN_MAINTENANCE_MIN_DURATION_MINUTES = 15;
export const RETURN_MAINTENANCE_MAX_DURATION_MINUTES = 7 * 24 * 60;

const DEFAULT_MAINTENANCE_REASON = 'Maintenance immédiate requise après restitution.';

export interface ReturnMaintenanceInput {
  /** Booking item dont l'exemplaire doit être protégé. */
  bookingItemId: string;
  /** Durée estimée en minutes ; 24 h par défaut. */
  durationMinutes?: number | undefined;
  /** Rapport de dommage déjà créé par le flow de retour, s'il existe. */
  sourceDamageReportId?: string | null | undefined;
}

export interface NormalizedReturnMaintenanceInput {
  bookingItemId: string;
  durationMinutes: number;
  sourceDamageReportId: string | null;
}

export interface ReturnMaintenanceContext {
  tx: DatabaseTransaction;
  booking: typeof bookings.$inferSelect;
  organizationId: string;
  actorUserId: string;
  fulfillmentEventId: string;
  request: NormalizedReturnMaintenanceInput | null;
}

/**
 * Normalise la commande de maintenance avant de réserver la clé idempotente.
 * Les bornes évitent à la fois un bloc quasi nul et un oubli qui immobiliserait
 * le stock pendant une durée illimitée. La résolution de maintenance peut
 * toujours libérer le bloc avant son échéance.
 */
export function normalizeReturnMaintenanceInput(
  input: ReturnMaintenanceInput,
): NormalizedReturnMaintenanceInput {
  assertUuid(input.bookingItemId, 'bookingItemId');

  const durationMinutes = input.durationMinutes ?? RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES;
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < RETURN_MAINTENANCE_MIN_DURATION_MINUTES ||
    durationMinutes > RETURN_MAINTENANCE_MAX_DURATION_MINUTES
  ) {
    throw new FulfillmentError(
      'VALIDATION',
      `durationMinutes doit être un entier entre ${RETURN_MAINTENANCE_MIN_DURATION_MINUTES} et ${RETURN_MAINTENANCE_MAX_DURATION_MINUTES}.`,
    );
  }

  const sourceDamageReportId = input.sourceDamageReportId ?? null;
  if (sourceDamageReportId !== null) {
    assertUuid(sourceDamageReportId, 'sourceDamageReportId');
  }

  return { bookingItemId: input.bookingItemId, durationMinutes, sourceDamageReportId };
}

/**
 * Pose les protections liées au retour dans la transaction de transition.
 *
 * - Un retour marqué BROKEN déclenche la protection même sans case UI.
 * - Une demande explicite de maintenance bascule l'exemplaire en BROKEN.
 * - Le bloc BOOKING courant est libéré juste avant la pose du bloc MAINTENANCE.
 * - Une réservation ferme qui occupe la fenêtre provoque une alerte durable,
 *   sans annuler le retour ni toucher aux snapshots financiers.
 */
export async function applyReturnMaintenance(context: ReturnMaintenanceContext): Promise<void> {
  const { tx, booking, organizationId, actorUserId, fulfillmentEventId, request } = context;

  const itemRows = await tx
    .select()
    .from(bookingItems)
    .where(
      request
        ? and(eq(bookingItems.id, request.bookingItemId), eq(bookingItems.bookingId, booking.id))
        : eq(bookingItems.bookingId, booking.id),
    )
    .orderBy(bookingItems.id)
    .for('update');

  if (request && itemRows.length === 0) {
    throw new FulfillmentError(
      'BOOKING_ITEM_NOT_FOUND',
      `Booking item ${request.bookingItemId} introuvable.`,
    );
  }

  const targetItemRows = request
    ? itemRows
    : itemRows.filter((item) => item.inventoryItemId !== null);
  if (targetItemRows.length === 0) return;

  // Les lignes sont déjà triées par UUID ; les exemplaires sont verrouillés
  // dans le même ordre pour éviter les deadlocks sur un retour multi-articles.
  const inventoryItemIds = [...new Set(targetItemRows.map((item) => item.inventoryItemId))].sort();
  const lockedInventoryItems = await tx
    .select()
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, inventoryItemIds))
    .orderBy(inventoryItems.id)
    .for('update');

  for (const bookingItem of targetItemRows) {
    const inventoryItem = lockedInventoryItems.find(
      (item) => item.id === bookingItem.inventoryItemId,
    );
    if (!inventoryItem) {
      throw new FulfillmentError(
        'CONCURRENT_MODIFICATION',
        "L'exemplaire associé au retour est introuvable.",
      );
    }
    if (inventoryItem.organizationId !== organizationId) {
      throw new FulfillmentError(
        'ORGANIZATION_MISMATCH',
        "L'exemplaire n'appartient pas à l'organisation.",
      );
    }

    // Avec une commande explicite, l'action est toujours opérante. Sans
    // commande, seuls les exemplaires déjà BROKEN déclenchent l'automatisme.
    const needsMaintenance = request !== null || inventoryItem.condition === 'BROKEN';
    if (!needsMaintenance) continue;

    const source = await resolveSourceDamageReport(tx, {
      organizationId,
      bookingId: booking.id,
      bookingItemId: bookingItem.id,
      inventoryItemId: inventoryItem.id,
      sourceDamageReportId: request?.sourceDamageReportId ?? null,
    });

    const blockRows = await tx
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.id, bookingItem.bookingBlockId))
      .for('update')
      .limit(1);
    if (blockRows.length === 0) {
      throw new FulfillmentError(
        'CONCURRENT_MODIFICATION',
        "Le bloc d'inventaire associé au retour est introuvable.",
      );
    }

    const bookingBlock = blockRows[0]!;
    if (
      bookingBlock.organizationId !== organizationId ||
      bookingBlock.inventoryItemId !== inventoryItem.id ||
      bookingBlock.type !== 'BOOKING' ||
      bookingBlock.status !== 'ACTIVE' ||
      bookingBlock.deletedAt !== null
    ) {
      throw new FulfillmentError(
        'CONCURRENT_MODIFICATION',
        "Le bloc d'inventaire associé au retour n'est plus cohérent.",
      );
    }

    // Le bloc courant couvre le créneau de location complet. Le libérer est
    // nécessaire avant de pouvoir créer la protection qui commence maintenant.
    await tx
      .update(inventoryBlocks)
      .set({ status: 'RELEASED', updatedAt: sql`now()` })
      .where(eq(inventoryBlocks.id, bookingBlock.id));

    if (inventoryItem.condition !== 'BROKEN') {
      await tx
        .update(inventoryItems)
        .set({ condition: 'BROKEN', updatedAt: sql`now()` })
        .where(eq(inventoryItems.id, inventoryItem.id));
    }

    const durationMinutes = request?.durationMinutes ?? RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES;
    const conflicts = await tx
      .select({ id: inventoryBlocks.id })
      .from(inventoryBlocks)
      .where(
        and(
          eq(inventoryBlocks.organizationId, organizationId),
          eq(inventoryBlocks.inventoryItemId, inventoryItem.id),
          eq(inventoryBlocks.type, 'BOOKING'),
          eq(inventoryBlocks.status, 'ACTIVE'),
          isNull(inventoryBlocks.deletedAt),
          ne(inventoryBlocks.id, bookingBlock.id),
          sql`${inventoryBlocks.blockedStartAt} < now() + ${durationMinutes} * interval '1 minute'`,
          sql`${inventoryBlocks.blockedEndAt} > now()`,
        ),
      )
      .orderBy(inventoryBlocks.id);

    let maintenanceBlockId: string | null = null;
    let conflictDetected = conflicts.length > 0;
    if (!conflictDetected) {
      try {
        maintenanceBlockId = await tx.transaction(async (savepoint) => {
          const inserted = await savepoint
            .insert(inventoryBlocks)
            .values({
              organizationId,
              inventoryItemId: inventoryItem.id,
              type: 'MAINTENANCE',
              status: 'ACTIVE',
              customerStartAt: sql`now()`,
              customerEndAt: sql`now() + ${durationMinutes} * interval '1 minute'`,
              blockedStartAt: sql`now()`,
              blockedEndAt: sql`now() + ${durationMinutes} * interval '1 minute'`,
              createdBy: actorUserId,
              sourceId: source.sourceDamageReportId ?? booking.id,
            })
            .returning({ id: inventoryBlocks.id });
          if (inserted.length === 0) {
            throw new FulfillmentError('UNKNOWN', 'Échec de la création du bloc de maintenance.');
          }
          return inserted[0]!.id;
        });
      } catch (error) {
        if (!isInventoryExclusionViolation(error)) throw error;
        conflictDetected = true;
        maintenanceBlockId = null;
      }
    }

    if (conflictDetected) {
      await writeConflictSignal(tx, {
        organizationId,
        actorUserId,
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        inventoryItemId: inventoryItem.id,
        fulfillmentEventId,
        durationMinutes,
        futureBookingBlockCount: Math.max(conflicts.length, 1),
      });
      continue;
    }

    if (!maintenanceBlockId) {
      throw new FulfillmentError('UNKNOWN', "Le bloc de maintenance n'a pas été créé.");
    }

    const caseRows = await tx
      .insert(maintenanceCases)
      .values({
        organizationId,
        inventoryItemId: inventoryItem.id,
        maintenanceBlockId,
        sourceDamageReportId: source.sourceDamageReportId,
        status: 'OPEN',
        reason: source.reason,
        openedBy: actorUserId,
      })
      .returning({ id: maintenanceCases.id });
    if (caseRows.length === 0) {
      throw new FulfillmentError('UNKNOWN', 'Échec de la création du dossier de maintenance.');
    }
    const maintenanceCaseId = caseRows[0]!.id;

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'RETURN_MAINTENANCE_BLOCKED',
      targetType: 'INVENTORY_ITEM',
      targetId: inventoryItem.id,
      metadata: {
        organizationId,
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        inventoryItemId: inventoryItem.id,
        maintenanceCaseId,
        maintenanceBlockId,
        durationMinutes,
        sourceDamageReportId: source.sourceDamageReportId,
        financialSnapshotUntouched: true,
      },
    });

    await tx.insert(outboxEvents).values({
      organizationId,
      aggregateType: 'MAINTENANCE',
      aggregateId: maintenanceCaseId,
      eventType: 'MAINTENANCE_OPENED',
      eventVersion: 'v1',
      payload: {
        organizationId,
        bookingId: booking.id,
        bookingItemId: bookingItem.id,
        inventoryItemId: inventoryItem.id,
        maintenanceCaseId,
        maintenanceBlockId,
        durationMinutes,
        sourceDamageReportId: source.sourceDamageReportId,
        origin: 'RETURN_COUNTER',
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: sql`now()`,
      idempotencyKey: `return_maintenance_opened_${booking.id}_${bookingItem.id}_${fulfillmentEventId}`,
    });
  }
}

async function resolveSourceDamageReport(
  tx: DatabaseTransaction,
  input: {
    organizationId: string;
    bookingId: string;
    bookingItemId: string;
    inventoryItemId: string;
    sourceDamageReportId: string | null;
  },
): Promise<{ sourceDamageReportId: string | null; reason: string }> {
  if (input.sourceDamageReportId === null) {
    return { sourceDamageReportId: null, reason: DEFAULT_MAINTENANCE_REASON };
  }

  const rows = await tx
    .select({
      id: damageReports.id,
      organizationId: damageReports.organizationId,
      bookingId: damageReports.bookingId,
      bookingItemId: damageReports.bookingItemId,
      inventoryItemId: damageReports.inventoryItemId,
      description: damageReports.description,
    })
    .from(damageReports)
    .where(eq(damageReports.id, input.sourceDamageReportId))
    .limit(1);
  const report = rows[0];
  if (
    !report ||
    report.organizationId !== input.organizationId ||
    report.bookingId !== input.bookingId ||
    report.bookingItemId !== input.bookingItemId ||
    report.inventoryItemId !== input.inventoryItemId
  ) {
    throw new FulfillmentError(
      'BOOKING_ITEM_MISMATCH',
      'Le rapport de dommage source ne correspond pas à l’exemplaire restitué.',
    );
  }

  return { sourceDamageReportId: report.id, reason: report.description };
}

async function writeConflictSignal(
  tx: DatabaseTransaction,
  input: {
    organizationId: string;
    actorUserId: string;
    bookingId: string;
    bookingItemId: string;
    inventoryItemId: string;
    fulfillmentEventId: string;
    durationMinutes: number;
    futureBookingBlockCount: number;
  },
): Promise<void> {
  await writeAuditEntry(tx, {
    actorUserId: input.actorUserId,
    action: 'CONFLICT_DETECTED',
    targetType: 'INVENTORY_ITEM',
    targetId: input.inventoryItemId,
    metadata: {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      bookingItemId: input.bookingItemId,
      inventoryItemId: input.inventoryItemId,
      conflictType: 'RETURN_MAINTENANCE_VS_FUTURE_BOOKING',
      futureBookingBlockCount: input.futureBookingBlockCount,
      durationMinutes: input.durationMinutes,
      requiresProactiveSubstitution: true,
      financialSnapshotUntouched: true,
    },
  });

  await tx.insert(outboxEvents).values({
    organizationId: input.organizationId,
    aggregateType: 'INVENTORY_ITEM',
    aggregateId: input.inventoryItemId,
    eventType: 'CONFLICT_DETECTED',
    eventVersion: 'v1',
    payload: {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      bookingItemId: input.bookingItemId,
      inventoryItemId: input.inventoryItemId,
      conflictType: 'RETURN_MAINTENANCE_VS_FUTURE_BOOKING',
      futureBookingBlockCount: input.futureBookingBlockCount,
      durationMinutes: input.durationMinutes,
      requiresProactiveSubstitution: true,
    },
    status: 'PENDING',
    attemptCount: 0,
    availableAt: sql`now()`,
    idempotencyKey: `return_maintenance_conflict_${input.bookingId}_${input.bookingItemId}_${input.fulfillmentEventId}`,
  });
}

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new FulfillmentError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}

function isInventoryExclusionViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
  };
  return (
    candidate.code === '23P01' ||
    candidate.constraint === 'no_overlapping_blocks' ||
    candidate.constraint_name === 'no_overlapping_blocks'
  );
}
