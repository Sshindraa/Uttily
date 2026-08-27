import { eq, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import { maintenanceCases, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { writeAuditEntry } from '../identity/audit';
import { CatalogError } from '../catalog/errors';
import type { StartMaintenanceInput, StartMaintenanceResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computeStartMaintenanceFingerprint(input: StartMaintenanceInput): string {
  const payload = JSON.stringify({
    org: input.organizationId,
    caseId: input.maintenanceCaseId,
    actor: input.actorUserId,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function startMaintenanceCase(
  db: DatabaseClient,
  input: StartMaintenanceInput,
): Promise<StartMaintenanceResult> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.maintenanceCaseId)) {
    throw new CatalogError('VALIDATION', 'maintenanceCaseId doit être un UUID valide.');
  }

  const fingerprint = computeStartMaintenanceFingerprint(input);
  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'START_MAINTENANCE',
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return reservation.record.responseBody as StartMaintenanceResult;
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

      const caseRows = await tx
        .select()
        .from(maintenanceCases)
        .where(
          or(
            eq(maintenanceCases.id, input.maintenanceCaseId),
            eq(maintenanceCases.maintenanceBlockId, input.maintenanceCaseId),
          ),
        )
        .for('update')
        .limit(1);

      if (caseRows.length === 0 || caseRows[0]!.organizationId !== input.organizationId) {
        throw new CatalogError('NOT_FOUND', 'Dossier de maintenance introuvable.');
      }

      const mCase = caseRows[0]!;

      if (mCase.status === 'RESOLVED') {
        throw new CatalogError('VALIDATION', 'Ce dossier de maintenance est déjà résolu.');
      }

      await tx
        .update(maintenanceCases)
        .set({
          status: 'IN_PROGRESS',
          startedBy: input.actorUserId,
          startedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(maintenanceCases.id, mCase.id));

      // Audit
      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'MAINTENANCE_STARTED',
        targetType: 'INVENTORY_ITEM',
        targetId: mCase.inventoryItemId,
        metadata: {
          organizationId: input.organizationId,
          maintenanceCaseId: mCase.id,
        },
      });

      // Outbox
      await tx.insert(outboxEvents).values({
        organizationId: input.organizationId,
        aggregateType: 'MAINTENANCE',
        aggregateId: mCase.id,
        eventType: 'MAINTENANCE_STARTED',
        eventVersion: 'v1',
        payload: {
          maintenanceCaseId: mCase.id,
          inventoryItemId: mCase.inventoryItemId,
          organizationId: input.organizationId,
        },
        status: 'PENDING',
        attemptCount: 0,
        availableAt: sql`now()`,
        idempotencyKey: `maintenance_started_${mCase.id}`,
      });

      const appliedResult: StartMaintenanceResult = {
        kind: 'APPLIED',
        maintenanceCaseId: mCase.id,
        status: 'IN_PROGRESS',
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: mCase.id,
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
