import { eq, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems, maintenanceCases, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { writeAuditEntry } from '../identity/audit';
import { CatalogError } from '../catalog/errors';
import type { ResolveMaintenanceInput, ResolveMaintenanceResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computeResolveMaintenanceFingerprint(input: ResolveMaintenanceInput): string {
  const payload = JSON.stringify({
    org: input.organizationId,
    caseId: input.maintenanceCaseId,
    actor: input.actorUserId,
    cond: input.targetCondition,
    notes: input.notes ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function resolveMaintenanceCase(
  db: DatabaseClient,
  input: ResolveMaintenanceInput,
): Promise<ResolveMaintenanceResult> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.maintenanceCaseId)) {
    throw new CatalogError('VALIDATION', 'maintenanceCaseId doit être un UUID valide.');
  }

  const fingerprint = computeResolveMaintenanceFingerprint(input);
  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'RESOLVE_MAINTENANCE',
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return reservation.record.responseBody as ResolveMaintenanceResult;
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

      // 1. Chercher et verrouiller le dossier de maintenance
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

      let maintenanceCaseId = input.maintenanceCaseId;
      let maintenanceBlockId = input.maintenanceCaseId;
      let inventoryItemId: string;

      if (caseRows.length > 0) {
        const mCase = caseRows[0]!;
        if (mCase.organizationId !== input.organizationId) {
          throw new CatalogError('NOT_FOUND', 'Dossier de maintenance introuvable.');
        }
        if (mCase.status === 'RESOLVED') {
          throw new CatalogError('VALIDATION', 'Ce dossier de maintenance est déjà résolu.');
        }
        maintenanceCaseId = mCase.id;
        maintenanceBlockId = mCase.maintenanceBlockId;
        inventoryItemId = mCase.inventoryItemId;
      }

      // 2. Verrouiller et valider le bloc de maintenance de façon fail-closed (Chantier 9.1)
      const blockRows = await tx
        .select()
        .from(inventoryBlocks)
        .where(eq(inventoryBlocks.id, maintenanceBlockId))
        .for('update')
        .limit(1);

      if (blockRows.length === 0 || blockRows[0]!.organizationId !== input.organizationId) {
        throw new CatalogError('NOT_FOUND', 'Bloc de maintenance introuvable.');
      }

      const block = blockRows[0]!;
      inventoryItemId = block.inventoryItemId;

      if (block.type !== 'MAINTENANCE') {
        throw new CatalogError(
          'VALIDATION',
          "Le bloc spécifié n'est pas un bloc de type MAINTENANCE.",
        );
      }
      if (block.status !== 'ACTIVE') {
        throw new CatalogError('VALIDATION', "Le bloc de maintenance n'est pas actif.");
      }

      // 3. Libérer le bloc de maintenance
      await tx
        .update(inventoryBlocks)
        .set({
          status: 'RELEASED',
          blockedEndAt: sql`now()`,
          customerEndAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(inventoryBlocks.id, block.id));

      // 4. Mettre à jour le dossier de maintenance
      if (caseRows.length > 0) {
        await tx
          .update(maintenanceCases)
          .set({
            status: 'RESOLVED',
            resolvedBy: input.actorUserId,
            resolvedAt: sql`now()`,
            resolutionNotes: input.notes?.trim() ?? null,
            updatedAt: sql`now()`,
          })
          .where(eq(maintenanceCases.id, maintenanceCaseId));
      }

      // 5. Remettre en service l'exemplaire physique
      await tx
        .update(inventoryItems)
        .set({
          condition: input.targetCondition,
          notes: input.notes ? input.notes.trim() : null,
          updatedAt: sql`now()`,
        })
        .where(eq(inventoryItems.id, inventoryItemId));

      // 6. Audit
      await writeAuditEntry(tx, {
        actorUserId: input.actorUserId,
        action: 'MAINTENANCE_RESOLVED',
        targetType: 'INVENTORY_ITEM',
        targetId: inventoryItemId,
        metadata: {
          organizationId: input.organizationId,
          maintenanceCaseId,
          maintenanceBlockId: block.id,
          targetCondition: input.targetCondition,
          notes: input.notes ?? null,
        },
      });

      // 7. Outbox
      await tx.insert(outboxEvents).values({
        organizationId: input.organizationId,
        aggregateType: 'MAINTENANCE',
        aggregateId: maintenanceCaseId,
        eventType: 'MAINTENANCE_RESOLVED',
        eventVersion: 'v1',
        payload: {
          maintenanceCaseId,
          maintenanceBlockId: block.id,
          inventoryItemId,
          organizationId: input.organizationId,
          releasedCondition: input.targetCondition,
        },
        status: 'PENDING',
        attemptCount: 0,
        availableAt: sql`now()`,
        idempotencyKey: `maintenance_resolved_${maintenanceCaseId}`,
      });

      const appliedResult: ResolveMaintenanceResult = {
        kind: 'APPLIED',
        maintenanceCaseId,
        maintenanceBlockId: block.id,
        inventoryItemId,
        releasedCondition: input.targetCondition,
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
