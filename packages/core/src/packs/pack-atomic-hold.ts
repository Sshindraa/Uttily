import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems } from '@uttily/database';

export class PackAllocationError extends Error {
  constructor(
    public readonly code: 'VALIDATION' | 'CONCURRENCY_CONFLICT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PackAllocationError';
  }
}

export interface CreateAtomicPackHoldInput {
  readonly organizationId: string;
  readonly inventoryItemIds: readonly string[];
  readonly draftId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly expiresAt: Date;
}

export interface AtomicPackHoldResult {
  readonly holdBlockIds: readonly string[];
  readonly allocatedItemIds: readonly string[];
  readonly blocks: readonly { blockId: string; inventoryItemId: string }[];
  readonly expiresAt: Date;
}

/**
 * Crée un hold atomique sur l'ensemble des équipements d'un pack (ADR-041).
 *
 * Invariant transactionnel :
 * Un pack n'est JAMAIS partiellement réservé.
 * Soit 100% des exemplaires physiques sont verrouillés et bloqués,
 * soit la transaction échoue intégralement (ROLLBACK).
 */
export async function createAtomicPackHold(
  db: DatabaseClient,
  input: CreateAtomicPackHoldInput,
): Promise<AtomicPackHoldResult> {
  const { organizationId, inventoryItemIds, draftId, startAt, endAt, expiresAt } = input;

  if (inventoryItemIds.length === 0) {
    throw new PackAllocationError('VALIDATION', 'Le pack doit contenir au moins un équipement.');
  }

  if (endAt <= startAt) {
    throw new PackAllocationError(
      'VALIDATION',
      'La période de réservation est invalide (fin <= début).',
    );
  }

  return await db.transaction(async (tx) => {
    // 1. Verrouillage FOR UPDATE de tous les exemplaires physiques (ordre déterministe anti-deadlock)
    const sortedItemIds = [...inventoryItemIds].sort();
    const items = await tx
      .select({
        id: inventoryItems.id,
        organizationId: inventoryItems.organizationId,
        status: inventoryItems.status,
        condition: inventoryItems.condition,
      })
      .from(inventoryItems)
      .where(
        and(
          inArray(inventoryItems.id, sortedItemIds),
          eq(inventoryItems.organizationId, organizationId),
          isNull(inventoryItems.deletedAt),
        ),
      )
      .orderBy(inventoryItems.id)
      .for('update');

    if (items.length !== inventoryItemIds.length) {
      throw new PackAllocationError(
        'NOT_FOUND',
        'Certains exemplaires du pack sont introuvables ou n’appartiennent pas à l’organisation.',
      );
    }

    // Vérifier l'état opérationnel des exemplaires
    for (const item of items) {
      if (item.status !== 'ACTIVE' || item.condition === 'BROKEN') {
        throw new PackAllocationError(
          'CONCURRENCY_CONFLICT',
          `L’exemplaire ${item.id} n’est pas disponible à la location.`,
        );
      }
    }

    // 2. Vérification d'absence de chevauchement sur la période demandée
    const conflictingBlocks = await tx
      .select({
        inventoryItemId: inventoryBlocks.inventoryItemId,
      })
      .from(inventoryBlocks)
      .where(
        and(
          inArray(inventoryBlocks.inventoryItemId, [...inventoryItemIds]),
          isNull(inventoryBlocks.deletedAt),
          sql`${inventoryBlocks.status} IN ('ACTIVE', 'PAYMENT_PROCESSING')`,
          sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)`,
        ),
      );

    if (conflictingBlocks.length > 0) {
      throw new PackAllocationError(
        'CONCURRENCY_CONFLICT',
        'Un ou plusieurs équipements du pack viennent d’être réservés sur ce créneau.',
      );
    }

    // 3. Insertion atomique des blocs de hold
    const blocksToInsert = inventoryItemIds.map((itemId) => ({
      organizationId,
      inventoryItemId: itemId,
      type: 'HOLD' as const,
      status: 'ACTIVE' as const,
      customerStartAt: startAt,
      customerEndAt: endAt,
      blockedStartAt: startAt,
      blockedEndAt: endAt,
      expiresAt,
      sourceId: draftId,
    }));

    const inserted = await tx
      .insert(inventoryBlocks)
      .values(blocksToInsert)
      .returning({ id: inventoryBlocks.id, itemId: inventoryBlocks.inventoryItemId });

    return {
      holdBlockIds: inserted.map((b) => b.id),
      allocatedItemIds: inserted.map((b) => b.itemId),
      blocks: inserted.map((b) => ({ blockId: b.id, inventoryItemId: b.itemId })),
      expiresAt,
    };
  });
}
