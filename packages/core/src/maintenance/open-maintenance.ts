import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems, maintenanceCases, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { writeAuditEntry } from '../identity/audit';
import { CatalogError } from '../catalog/errors';
import type { OpenMaintenanceInput, OpenMaintenanceResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computeOpenMaintenanceFingerprint(input: OpenMaintenanceInput): string {
  const payload = JSON.stringify({
    org: input.organizationId,
    item: input.inventoryItemId,
    actor: input.actorUserId,
    reason: input.reason,
    notes: input.notes ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function openMaintenanceCase(
  db: DatabaseClient,
  input: OpenMaintenanceInput,
): Promise<OpenMaintenanceResult> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.inventoryItemId)) {
    throw new CatalogError('VALIDATION', 'inventoryItemId doit être un UUID valide.');
  }
  if (!input.reason || input.reason.trim().length < 2) {
    throw new CatalogError('VALIDATION', 'Le motif doit faire au moins 2 caractères.');
  }

  const fingerprint = computeOpenMaintenanceFingerprint(input);
  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'OPEN_MAINTENANCE',
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return reservation.record.responseBody as OpenMaintenanceResult;
  }

  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec des paramètres différents.",
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      await lockKey(tx, reservation.record.id);
      await lockOrganization(tx, input.organizationId);

      const itemRows = await tx
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, input.inventoryItemId))
        .for('update')
        .limit(1);

      if (itemRows.length === 0 || itemRows[0]!.organizationId !== input.organizationId) {
        throw new CatalogError('NOT_FOUND', 'Exemplaire introuvable dans cette organisation.');
      }

      const item = itemRows[0]!;

      // 1. Basculer l'état physique en BROKEN
      await tx
        .update(inventoryItems)
        .set({
          condition: 'BROKEN',
          updatedAt: sql`now()`,
        })
        .where(eq(inventoryItems.id, item.id));

      // 2. Créer un inventoryBlock de type MAINTENANCE indéfini
      const blockRows = await tx
        .insert(inventoryBlocks)
        .values({
          organizationId: input.organizationId,
          inventoryItemId: item.id,
          type: 'MAINTENANCE',
          status: 'ACTIVE',
          customerStartAt: sql`now()`,
          customerEndAt: new Date('9999-12-31T23:59:59.999Z'),
          blockedStartAt: sql`now()`,
          blockedEndAt: new Date('9999-12-31T23:59:59.999Z'),
          createdBy: input.actorUserId,
        })
        .returning({ id: inventoryBlocks.id });

      const maintenanceBlockId = blockRows[0]!.id;

      // 3. Créer l'enregistrement persistant dans maintenance_cases (Chantier 9.1)
      const caseRows = await tx
        .insert(maintenanceCases)
        .values({
          organizationId: input.organizationId,
          inventoryItemId: item.id,
          maintenanceBlockId,
          status: 'OPEN',
          reason: input.reason.trim(),
          openedNotes: input.notes?.trim() ?? null,
          openedBy: input.actorUserId,
        })
        .returning({ id: maintenanceCases.id });

      const maintenanceCaseId = caseRows[0]!.id;

      // 4. Audit
      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'MAINTENANCE_OPENED',
        targetType: 'INVENTORY_ITEM',
        targetId: item.id,
        metadata: {
          organizationId: input.organizationId,
          maintenanceCaseId,
          maintenanceBlockId,
          reason: input.reason,
          notes: input.notes ?? null,
        },
      });

      // 5. Outbox
      await tx.insert(outboxEvents).values({
        organizationId: input.organizationId,
        aggregateType: 'MAINTENANCE',
        aggregateId: maintenanceCaseId,
        eventType: 'MAINTENANCE_OPENED',
        eventVersion: 'v1',
        payload: {
          maintenanceCaseId,
          maintenanceBlockId,
          inventoryItemId: item.id,
          organizationId: input.organizationId,
          reason: input.reason,
        },
        status: 'PENDING',
        attemptCount: 0,
        availableAt: sql`now()`,
        idempotencyKey: `maintenance_opened_${maintenanceCaseId}`,
      });

      const appliedResult: OpenMaintenanceResult = {
        kind: 'APPLIED',
        maintenanceCaseId,
        maintenanceBlockId,
        inventoryItemId: item.id,
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: maintenanceCaseId,
        responseBody: appliedResult,
        responseStatusCode: 200,
      });

      return appliedResult;
    });

    return result;
  } catch (error) {
    await db
      .transaction(async (tx) => {
        await failKey(tx, reservation.record.id, {
          responseBody: {
            error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
          },
          responseStatusCode: 500,
        });
      })
      .catch(() => undefined);
    throw error;
  }
}
