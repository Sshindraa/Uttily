import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { writeAuditEntry } from '../identity/audit';
import { CatalogError } from '../catalog/errors';
import type { ResolveMaintenanceInput, ResolveMaintenanceResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveMaintenanceCase(
  db: DatabaseClient,
  input: ResolveMaintenanceInput,
): Promise<ResolveMaintenanceResult> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.maintenanceBlockId)) {
    throw new CatalogError('VALIDATION', 'maintenanceBlockId doit être un UUID valide.');
  }

  return await db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);

    // 1. Verrouiller le bloc de maintenance
    const blockRows = await tx
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.id, input.maintenanceBlockId))
      .for('update')
      .limit(1);

    if (blockRows.length === 0 || blockRows[0]!.organizationId !== input.organizationId) {
      throw new CatalogError('NOT_FOUND', 'Bloc de maintenance introuvable.');
    }

    const block = blockRows[0]!;

    // 2. Libérer le bloc de maintenance (RELEASED + date de fin actuelle)
    await tx
      .update(inventoryBlocks)
      .set({
        status: 'RELEASED',
        blockedEndAt: sql`now()`,
        customerEndAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(inventoryBlocks.id, block.id));

    // 3. Remettre en service l'exemplaire (condition mise à jour, ex: GOOD ou FAIR)
    await tx
      .update(inventoryItems)
      .set({
        condition: input.targetCondition,
        notes: input.notes ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(inventoryItems.id, block.inventoryItemId));

    // 4. Audit
    await writeAuditEntry(tx, {
      actorUserId: input.actorUserId,
      action: 'MAINTENANCE_RESOLVED',
      targetType: 'INVENTORY_ITEM',
      targetId: block.inventoryItemId,
      metadata: {
        organizationId: input.organizationId,
        maintenanceBlockId: block.id,
        targetCondition: input.targetCondition,
        notes: input.notes ?? null,
      },
    });

    // 5. Outbox
    await tx.insert(outboxEvents).values({
      organizationId: input.organizationId,
      aggregateType: 'MAINTENANCE',
      aggregateId: block.id,
      eventType: 'MAINTENANCE_RESOLVED',
      eventVersion: 'v1',
      payload: {
        maintenanceBlockId: block.id,
        inventoryItemId: block.inventoryItemId,
        organizationId: input.organizationId,
        releasedCondition: input.targetCondition,
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: sql`now()`,
      idempotencyKey: `maintenance_resolved_${block.id}`,
    });

    return {
      kind: 'APPLIED',
      maintenanceBlockId: block.id,
      inventoryItemId: block.inventoryItemId,
      releasedCondition: input.targetCondition,
    };
  });
}
