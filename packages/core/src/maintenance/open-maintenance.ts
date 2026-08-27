import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems, outboxEvents } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import { writeAuditEntry } from '../identity/audit';
import { CatalogError } from '../catalog/errors';
import type { OpenMaintenanceInput, OpenMaintenanceResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  return await db.transaction(async (tx) => {
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

    // 2. Créer un inventoryBlock de type MAINTENANCE indéfini jusqu'à remise en service explicite
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

    // 3. Audit
    await writeAuditEntry(tx, {
      actorUserId: input.actorUserId,
      action: 'MAINTENANCE_OPENED',
      targetType: 'INVENTORY_ITEM',
      targetId: item.id,
      metadata: {
        organizationId: input.organizationId,
        maintenanceBlockId,
        reason: input.reason,
        notes: input.notes ?? null,
      },
    });

    // 4. Outbox
    await tx.insert(outboxEvents).values({
      organizationId: input.organizationId,
      aggregateType: 'MAINTENANCE',
      aggregateId: maintenanceBlockId,
      eventType: 'MAINTENANCE_OPENED',
      eventVersion: 'v1',
      payload: {
        maintenanceBlockId,
        inventoryItemId: item.id,
        organizationId: input.organizationId,
        reason: input.reason,
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: sql`now()`,
      idempotencyKey: `maintenance_opened_${maintenanceBlockId}`,
    });

    return {
      kind: 'APPLIED',
      maintenanceBlockId,
      inventoryItemId: item.id,
    };
  });
}
