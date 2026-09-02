import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryItems, inventoryMovements, locations, lockOrganization } from '@uttily/database';
import {
  isActionErrorCode,
  MAX_BULK_INVENTORY_ITEMS,
  type ActionErrorCode,
} from '@uttily/contracts';
import { AuthorizationError } from '../identity/permissions';
import type { IdempotencyRecordRow } from '../idempotency';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import { CatalogError } from './errors';

export const TRANSFER_INVENTORY_ITEMS_BATCH_OPERATION = 'TRANSFER_INVENTORY_ITEMS_BATCH';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

export interface TransferInventoryItemsBatchInput {
  organizationId: string;
  inventoryItemIds: string[];
  toLocationId: string;
  idempotencyKey: string;
  reason?: string;
  createdBy?: string;
}

export interface TransferInventoryItemsBatchResult {
  inventoryItemIds: string[];
  movementIds: string[];
  transferredCount: number;
  noOpCount: number;
}

type NormalizedTransferInventoryItemsBatchInput = {
  organizationId: string;
  inventoryItemIds: string[];
  toLocationId: string;
  idempotencyKey: string;
  reason: string;
  createdBy?: string;
};

type PersistedBatchFailure = {
  code: ActionErrorCode;
  message: string;
};

/**
 * Transfère plusieurs exemplaires dans une seule transaction métier.
 *
 * L'organisation est verrouillée avant les lignes d'inventaire, puis les
 * exemplaires sont verrouillés dans un ordre déterministe. La cible et tous
 * les exemplaires sont validés avant toute modification. L'UPDATE des
 * localisations et l'INSERT des mouvements sont atomiques ; les réservations,
 * maintenances, statuts, conditions et règles de disponibilité ne sont pas
 * touchés.
 */
export async function transferInventoryItemsBatch(
  db: DatabaseClient,
  input: TransferInventoryItemsBatchInput,
): Promise<TransferInventoryItemsBatchResult> {
  const normalized = normalizeInput(input);
  const requestFingerprint = computeFingerprint(normalized);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: TRANSFER_INVENTORY_ITEMS_BATCH_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayResult(reservation.record);
  }
  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec des paramètres différents.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return replayResult(lock.record);
      }

      await lockOrganization(tx, normalized.organizationId);

      const [targetLocation] = await tx
        .select({
          id: locations.id,
          organizationId: locations.organizationId,
          deletedAt: locations.deletedAt,
        })
        .from(locations)
        .where(eq(locations.id, normalized.toLocationId))
        .for('update')
        .limit(1);

      if (
        !targetLocation ||
        targetLocation.organizationId !== normalized.organizationId ||
        targetLocation.deletedAt !== null
      ) {
        throw new AuthorizationError('Établissement de destination introuvable.');
      }

      const items = await tx
        .select()
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

      // Une clé issue d'une autre opération de transfert sur l'un des items
      // doit produire un conflit explicite, jamais un INSERT partiellement
      // compatible avec la contrainte d'idempotence par exemplaire.
      const [existingMovement] = await tx
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(
          and(
            inArray(inventoryMovements.inventoryItemId, normalized.inventoryItemIds),
            eq(inventoryMovements.idempotencyKey, normalized.idempotencyKey),
          ),
        )
        .limit(1);
      if (existingMovement) {
        throw new CatalogError(
          'CONFLICT_IDEMPOTENCY',
          "La clé d'idempotence est déjà utilisée par un mouvement d'inventaire.",
        );
      }

      const toTransfer = items.filter((item) => item.currentLocationId !== normalized.toLocationId);
      const noOpCount = items.length - toTransfer.length;

      if (toTransfer.length === 0) {
        const result: TransferInventoryItemsBatchResult = {
          inventoryItemIds: items.map((item) => item.id),
          movementIds: [],
          transferredCount: 0,
          noOpCount,
        };
        await completeKey(tx, reservation.record.id, {
          resourceId: result.inventoryItemIds[0]!,
          responseStatusCode: 200,
          responseBody: result,
        });
        return result;
      }

      const transferredIds = toTransfer.map((item) => item.id);
      const updatedItems = await tx
        .update(inventoryItems)
        .set({ currentLocationId: normalized.toLocationId, updatedAt: new Date() })
        .where(
          and(
            eq(inventoryItems.organizationId, normalized.organizationId),
            inArray(inventoryItems.id, transferredIds),
            isNull(inventoryItems.deletedAt),
          ),
        )
        .returning({ id: inventoryItems.id });

      if (updatedItems.length !== toTransfer.length) {
        throw new CatalogError('UNKNOWN', 'Le transfert des exemplaires est incomplet.');
      }

      let movements: Array<{ id: string }>;
      try {
        movements = await tx
          .insert(inventoryMovements)
          .values(
            toTransfer.map((item) => ({
              inventoryItemId: item.id,
              fromLocationId: item.currentLocationId,
              toLocationId: normalized.toLocationId,
              reason: normalized.reason,
              createdBy: normalized.createdBy ?? null,
              idempotencyKey: normalized.idempotencyKey,
            })),
          )
          .returning({ id: inventoryMovements.id });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('inventory_movements_item_idempotency')
        ) {
          throw new CatalogError(
            'CONFLICT_IDEMPOTENCY',
            "La clé d'idempotence est déjà utilisée par un mouvement d'inventaire.",
          );
        }
        throw error;
      }

      if (movements.length !== toTransfer.length) {
        throw new CatalogError('UNKNOWN', "L'enregistrement des mouvements est incomplet.");
      }

      const result: TransferInventoryItemsBatchResult = {
        inventoryItemIds: items.map((item) => item.id),
        movementIds: movements.map((movement) => movement.id),
        transferredCount: toTransfer.length,
        noOpCount,
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
  input: TransferInventoryItemsBatchInput,
): NormalizedTransferInventoryItemsBatchInput {
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

  const itemIds = input.inventoryItemIds.map((itemId) => String(itemId));
  if (new Set(itemIds).size !== itemIds.length) {
    throw new CatalogError('VALIDATION', 'Un exemplaire ne peut être sélectionné qu’une fois.', {
      inventoryItemIds: 'La sélection contient un doublon.',
    });
  }
  if (itemIds.some((itemId) => !UUID_REGEX.test(itemId))) {
    throw new CatalogError('VALIDATION', 'Un ou plusieurs exemplaires sont invalides.', {
      inventoryItemIds: 'Un ou plusieurs exemplaires sont invalides.',
    });
  }
  if (!UUID_REGEX.test(input.toLocationId)) {
    throw new CatalogError('VALIDATION', 'Établissement de destination invalide.', {
      toLocationId: 'Établissement de destination invalide.',
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

  const reason = input.reason?.trim() || 'Transfert groupé';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `Le motif ne doit pas dépasser ${MAX_REASON_LENGTH} caractères.`,
      { reason: `Le motif ne doit pas dépasser ${MAX_REASON_LENGTH} caractères.` },
    );
  }

  const createdBy = input.createdBy?.trim() || undefined;
  if (createdBy !== undefined && !UUID_REGEX.test(createdBy)) {
    throw new CatalogError('VALIDATION', 'createdBy doit être un UUID valide.');
  }

  return {
    organizationId: input.organizationId,
    inventoryItemIds: [...itemIds].sort(),
    toLocationId: input.toLocationId,
    idempotencyKey,
    reason,
    ...(createdBy === undefined ? {} : { createdBy }),
  };
}

function computeFingerprint(input: NormalizedTransferInventoryItemsBatchInput): string {
  const canonical = JSON.stringify({
    inventory_item_ids: input.inventoryItemIds,
    organization_id: input.organizationId,
    reason: input.reason,
    to_location_id: input.toLocationId,
    v: 'transfer-inventory-items-batch-v1',
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
  return { code: 'UNKNOWN', message: 'Le transfert des exemplaires n’a pas pu être effectué.' };
}

function replayResult(record: IdempotencyRecordRow): TransferInventoryItemsBatchResult {
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
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de transfert invalide.');
  }
  const body = record.responseBody;
  if (!isTransferResult(body) || body.inventoryItemIds[0] !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de transfert invalide.');
  }
  return body;
}

function isTransferResult(value: unknown): value is TransferInventoryItemsBatchResult {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.inventoryItemIds) || !Array.isArray(raw.movementIds)) return false;
  if (
    !raw.inventoryItemIds.every((id) => typeof id === 'string') ||
    !raw.movementIds.every((id) => typeof id === 'string')
  ) {
    return false;
  }
  if (
    typeof raw.transferredCount !== 'number' ||
    !Number.isSafeInteger(raw.transferredCount) ||
    raw.transferredCount < 0 ||
    typeof raw.noOpCount !== 'number' ||
    !Number.isSafeInteger(raw.noOpCount) ||
    raw.noOpCount < 0
  ) {
    return false;
  }
  return (
    raw.inventoryItemIds.length > 0 &&
    raw.movementIds.length === raw.transferredCount &&
    raw.inventoryItemIds.length === raw.transferredCount + raw.noOpCount
  );
}
