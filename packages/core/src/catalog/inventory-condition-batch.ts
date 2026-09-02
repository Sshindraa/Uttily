import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryItems, lockOrganization } from '@uttily/database';
import {
  isActionErrorCode,
  INVENTORY_CONDITIONS as CONTRACT_INVENTORY_CONDITIONS,
  MAX_BULK_INVENTORY_ITEMS,
  type ActionErrorCode,
} from '@uttily/contracts';
import { AuthorizationError } from '../identity/permissions';
import type { IdempotencyRecordRow } from '../idempotency';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import { CatalogError } from './errors';
import type { InventoryCondition } from './types';

export const UPDATE_INVENTORY_ITEMS_CONDITION_BATCH_OPERATION =
  'UPDATE_INVENTORY_ITEMS_CONDITION_BATCH';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface UpdateInventoryItemsConditionBatchInput {
  organizationId: string;
  inventoryItemIds: string[];
  condition: InventoryCondition;
  idempotencyKey: string;
}

export interface UpdateInventoryItemsConditionBatchResult {
  inventoryItemIds: string[];
  condition: InventoryCondition;
  updatedCount: number;
  noOpCount: number;
}

type NormalizedUpdateInventoryItemsConditionBatchInput = {
  organizationId: string;
  inventoryItemIds: string[];
  condition: InventoryCondition;
  idempotencyKey: string;
};

type PersistedBatchFailure = {
  code: ActionErrorCode;
  message: string;
};

/**
 * Met à jour l'état physique de plusieurs exemplaires dans une transaction
 * unique. La mutation ne touche ni au statut de parc, ni à l'établissement,
 * ni aux réservations, maintenances ou mouvements. L'éligibilité future à la
 * réservation continue d'appliquer les règles existantes : POOR et BROKEN
 * sont exclus par le moteur de disponibilité.
 */
export async function updateInventoryItemsConditionBatch(
  db: DatabaseClient,
  input: UpdateInventoryItemsConditionBatchInput,
): Promise<UpdateInventoryItemsConditionBatchResult> {
  const normalized = normalizeInput(input);
  const requestFingerprint = computeFingerprint(normalized);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: UPDATE_INVENTORY_ITEMS_CONDITION_BATCH_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayResult(reservation.record);
  }
  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec une sélection ou un état différent.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return replayResult(lock.record);
      }

      await lockOrganization(tx, normalized.organizationId);

      const items = await tx
        .select({ id: inventoryItems.id, condition: inventoryItems.condition })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.organizationId, normalized.organizationId),
            inArray(inventoryItems.id, normalized.inventoryItemIds),
            isNull(inventoryItems.deletedAt),
          ),
        )
        .orderBy(asc(inventoryItems.id))
        .for('update');

      if (items.length !== normalized.inventoryItemIds.length) {
        throw new AuthorizationError('Un ou plusieurs exemplaires sont introuvables.');
      }

      const toUpdate = items.filter((item) => item.condition !== normalized.condition);
      if (toUpdate.length > 0) {
        const updated = await tx
          .update(inventoryItems)
          .set({ condition: normalized.condition, updatedAt: new Date() })
          .where(
            and(
              eq(inventoryItems.organizationId, normalized.organizationId),
              inArray(
                inventoryItems.id,
                toUpdate.map((item) => item.id),
              ),
              isNull(inventoryItems.deletedAt),
            ),
          )
          .returning({ id: inventoryItems.id });

        if (updated.length !== toUpdate.length) {
          throw new CatalogError('UNKNOWN', 'La mise à jour des états est incomplète.');
        }
      }

      const result: UpdateInventoryItemsConditionBatchResult = {
        inventoryItemIds: items.map((item) => item.id),
        condition: normalized.condition,
        updatedCount: toUpdate.length,
        noOpCount: items.length - toUpdate.length,
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: result.inventoryItemIds[0]!,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    const failure = toPersistedFailure(error);
    await db
      .transaction(async (tx) => {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: failure.code === 'UNKNOWN' ? 500 : 400,
          responseBody: failure,
        });
      })
      .catch(() => undefined);
    throw error;
  }
}

function normalizeInput(
  input: UpdateInventoryItemsConditionBatchInput,
): NormalizedUpdateInventoryItemsConditionBatchInput {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!Array.isArray(input.inventoryItemIds) || input.inventoryItemIds.length < 1) {
    throw new CatalogError('VALIDATION', 'Au moins un exemplaire doit être sélectionné.', {
      inventoryItemIds: 'Sélectionnez au moins un exemplaire.',
    });
  }
  if (input.inventoryItemIds.length > MAX_BULK_INVENTORY_ITEMS) {
    throw new CatalogError(
      'VALIDATION',
      `Le nombre d’exemplaires doit être compris entre 1 et ${MAX_BULK_INVENTORY_ITEMS}.`,
      { inventoryItemIds: `La sélection est limitée à ${MAX_BULK_INVENTORY_ITEMS} exemplaires.` },
    );
  }

  const inventoryItemIds = input.inventoryItemIds.map((itemId) => String(itemId));
  if (new Set(inventoryItemIds).size !== inventoryItemIds.length) {
    throw new CatalogError('VALIDATION', 'Un exemplaire ne peut être sélectionné qu’une fois.', {
      inventoryItemIds: 'La sélection contient un doublon.',
    });
  }
  if (inventoryItemIds.some((itemId) => !UUID_REGEX.test(itemId))) {
    throw new CatalogError('VALIDATION', 'Un ou plusieurs exemplaires sont invalides.', {
      inventoryItemIds: 'Un ou plusieurs exemplaires sont invalides.',
    });
  }
  if (!isInventoryCondition(input.condition)) {
    throw new CatalogError('VALIDATION', 'État invalide.', {
      condition: 'État invalide.',
    });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.", {
      idempotencyKey: "La clé d'idempotence est requise.",
    });
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      { idempotencyKey: `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.` },
    );
  }

  return {
    organizationId: input.organizationId,
    inventoryItemIds: [...inventoryItemIds].sort(),
    condition: input.condition,
    idempotencyKey,
  };
}

function isInventoryCondition(value: unknown): value is InventoryCondition {
  return (
    typeof value === 'string' &&
    (CONTRACT_INVENTORY_CONDITIONS as readonly string[]).includes(value)
  );
}

function computeFingerprint(input: NormalizedUpdateInventoryItemsConditionBatchInput): string {
  const canonical = JSON.stringify({
    condition: input.condition,
    inventory_item_ids: input.inventoryItemIds,
    organization_id: input.organizationId,
    v: 'update-inventory-items-condition-batch-v1',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toPersistedFailure(error: unknown): PersistedBatchFailure {
  if (error instanceof CatalogError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AuthorizationError) {
    return { code: 'NOT_FOUND', message: error.message };
  }
  return { code: 'UNKNOWN', message: 'La mise à jour des états a échoué.' };
}

function replayResult(record: IdempotencyRecordRow): UpdateInventoryItemsConditionBatchResult {
  if (record.status === 'FAILED') {
    const body = record.responseBody;
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      isActionErrorCode(body.code) &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      throw new CatalogError(body.code, body.message);
    }
    throw new CatalogError('UNKNOWN', 'Réponse idempotente d’échec invalide.');
  }

  if (record.status !== 'COMPLETED' || record.responseStatusCode !== 200 || !record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de mise à jour d’état invalide.');
  }

  const body = record.responseBody;
  if (!isConditionBatchResult(body) || body.inventoryItemIds[0] !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de mise à jour d’état invalide.');
  }
  return body;
}

function isConditionBatchResult(value: unknown): value is UpdateInventoryItemsConditionBatchResult {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.inventoryItemIds) ||
    !raw.inventoryItemIds.every((id) => typeof id === 'string')
  ) {
    return false;
  }
  if (!isInventoryCondition(raw.condition)) return false;
  if (
    typeof raw.updatedCount !== 'number' ||
    !Number.isSafeInteger(raw.updatedCount) ||
    raw.updatedCount < 0 ||
    typeof raw.noOpCount !== 'number' ||
    !Number.isSafeInteger(raw.noOpCount) ||
    raw.noOpCount < 0
  ) {
    return false;
  }
  return (
    raw.inventoryItemIds.length > 0 &&
    raw.inventoryItemIds.length === raw.updatedCount + raw.noOpCount
  );
}
