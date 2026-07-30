import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  allocations,
  bookingDrafts,
  inventoryBlocks,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import { BookingDraftError } from './errors';
import type {
  BatchExpirationAnomaly,
  BatchExpirationExpired,
  ExpireBookingDraftsBatchResult,
} from './types';

/**
 * @uttily/core — Expiration atomique et batch des brouillons de réservation
 * mono-loueur expirés (Lot 4, étape 5, ADR-009 §15).
 *
 * `expireBookingDraftsBatch` est un worker d'expiration qui libère les
 * brouillons `HELD` dont l'échéance (`expires_at`) est dépassée. Le batch
 * sélectionne les brouillons expirables (pas les holds individuels), les
 * verrouille, valide les invariants, puis applique les transitions
 * `EXPIRED`/`RELEASED` atomiquement dans UNE SEULE transaction PostgreSQL.
 *
 * Caractéristiques :
 * - Transaction unique pour l'ensemble du batch.
 * - `FOR UPDATE OF bd SKIP LOCKED` pour la sélection concurrente.
 * - Batch borné (défaut 10, max 100).
 * - Exclusion des brouillons dont un bloc est `PAYMENT_PROCESSING`.
 * - Validation d'invariants après verrouillage, avant toute mutation.
 * - Une anomalie sur un brouillon n'interrompt pas le batch : le brouillon
 *   est skippé et enregistré comme anomalie, les autres continuent.
 * - Idempotent et répétable.
 */

/** Limite maximale absolue du batch. */
const MAX_BATCH_LIMIT = 100;

/** Limite par défaut du batch. */
const DEFAULT_BATCH_LIMIT = 10;

/**
 * Expire atomiquement un batch de brouillons `HELD` dont l'échéance est
 * dépassée. Sélectionne, verrouille, valide les invariants et applique les
 * transitions dans une seule transaction PostgreSQL.
 *
 * @param db client base de données (DatabaseClient)
 * @param batchLimit nombre maximum de brouillons à traiter (défaut 10, max 100)
 * @returns résultat structuré : brouillons expirés, anomalies, compteurs
 */
export async function expireBookingDraftsBatch(
  db: DatabaseClient,
  batchLimit: number = DEFAULT_BATCH_LIMIT,
): Promise<ExpireBookingDraftsBatchResult> {
  if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0 || batchLimit > MAX_BATCH_LIMIT) {
    throw new BookingDraftError(
      'VALIDATION',
      `batchLimit doit être un entier entre 1 et ${MAX_BATCH_LIMIT}.`,
    );
  }

  return await db.transaction(async (tx) => {
    // 1. Sélectionner les brouillons HELD expirés avec FOR UPDATE SKIP LOCKED.
    //    Raw SQL car Drizzle ne supporte pas `FOR UPDATE OF <alias>` avec
    //    `SKIP LOCKED` sur une requête complexe avec sous-requête NOT EXISTS.
    const rows = await tx.execute(sql`
      SELECT bd.id, bd.expires_at
      FROM booking_drafts bd
      WHERE bd.status = 'HELD'
        AND bd.expires_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM inventory_blocks ib
          WHERE ib.source_id = bd.id
            AND ib.type = 'HOLD'
            AND ib.status = 'PAYMENT_PROCESSING'
            AND ib.deleted_at IS NULL
        )
      ORDER BY bd.expires_at
      LIMIT ${batchLimit}
      FOR UPDATE OF bd SKIP LOCKED
    `);
    const rawCandidates = rows as unknown as Array<{ id: string; expires_at: Date | string }>;
    const candidates = rawCandidates.map((c) => ({
      id: c.id,
      expires_at: c.expires_at instanceof Date ? c.expires_at : new Date(c.expires_at),
    }));

    const expired: BatchExpirationExpired[] = [];
    const anomalies: BatchExpirationAnomaly[] = [];

    // 2. Pour chaque brouillon sélectionné : verrouiller, valider, muter.
    for (const candidate of candidates) {
      const draftId = candidate.id;
      const draftExpiresAt = candidate.expires_at;

      // a. Verrouiller tous les blocs du brouillon.
      const lockedBlocks = await tx
        .select()
        .from(inventoryBlocks)
        .where(and(eq(inventoryBlocks.sourceId, draftId), isNull(inventoryBlocks.deletedAt)))
        .for('update');

      // b. Verrouiller toutes les allocations associées aux blocs.
      const blockIds = lockedBlocks.map((b) => b.id);
      let lockedAllocations: Array<typeof allocations.$inferSelect> = [];
      if (blockIds.length > 0) {
        lockedAllocations = await tx
          .select()
          .from(allocations)
          .where(inArray(allocations.inventoryBlockId, blockIds))
          .for('update');
      }

      // c. Validation d'invariants (après verrouillage, avant mutation).
      const anomaly = await validateInvariants(
        draftId,
        draftExpiresAt,
        lockedBlocks,
        lockedAllocations,
        tx,
      );

      if (anomaly !== null) {
        anomalies.push(anomaly);
        continue;
      }

      // d. Transitions : blocs → EXPIRED, allocations → RELEASED, draft → EXPIRED.
      const allocationIds = lockedAllocations.map((a) => a.id);

      await tx
        .update(inventoryBlocks)
        .set({ status: 'EXPIRED' })
        .where(inArray(inventoryBlocks.id, blockIds));

      if (allocationIds.length > 0) {
        await tx
          .update(allocations)
          .set({ status: 'RELEASED' })
          .where(inArray(allocations.id, allocationIds));
      }

      // Récupérer l'horodatage d'expiration depuis PostgreSQL.
      const nowResult = await tx.execute(sql`SELECT now() AS now`);
      const nowValue = (nowResult[0] as unknown as { now: Date | string }).now;
      const expiredAt = nowValue instanceof Date ? nowValue : new Date(nowValue);

      await tx
        .update(bookingDrafts)
        .set({ status: 'EXPIRED' })
        .where(eq(bookingDrafts.id, draftId));

      expired.push({
        draftId,
        expiredAt: expiredAt.toISOString(),
        blockIds,
        allocationIds,
      });
    }

    // 3. Retourner le résultat structuré.
    return {
      expired,
      anomalies,
      processedCount: candidates.length,
      expiredCount: expired.length,
      anomalyCount: anomalies.length,
      batchLimit,
    };
  });
}

/**
 * Valide les invariants d'un brouillon après verrouillage de ses blocs et
 * allocations, avant toute mutation.
 *
 * Invariants (ADR-009 §15) :
 * - Le brouillon est `HELD`.
 * - Tous les holds attendus sont présents et `ACTIVE` (type `HOLD`, statut `ACTIVE`).
 * - Toutes les allocations sont `ALLOCATED`.
 * - L'échéance de chaque bloc est identique à `booking_drafts.expires_at`.
 * - Aucun bloc n'est `PAYMENT_PROCESSING`, `CONVERTED`, `RELEASED` ou `EXPIRED`.
 *
 * @returns une anomalie si un invariant est rompu, `null` si tout est valide.
 */
async function validateInvariants(
  draftId: string,
  draftExpiresAt: Date,
  blocks: Array<typeof inventoryBlocks.$inferSelect>,
  allocs: Array<typeof allocations.$inferSelect>,
  tx: DatabaseTransaction,
): Promise<BatchExpirationAnomaly | null> {
  // Re-lire le statut du brouillon (verrouillé par FOR UPDATE sur la sélection).
  const draftRows = await tx
    .select({ status: bookingDrafts.status })
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, draftId))
    .limit(1);

  if (draftRows.length === 0) {
    return {
      draftId,
      reason: 'DRAFT_NOT_FOUND',
      details: { draftId },
    };
  }

  const draftStatus = draftRows[0]!.status;
  if (draftStatus !== 'HELD') {
    return {
      draftId,
      reason: 'DRAFT_NOT_HELD',
      details: { draftId, actualStatus: draftStatus },
    };
  }

  // Vérifier qu'il y a au moins un bloc.
  if (blocks.length === 0) {
    return {
      draftId,
      reason: 'NO_BLOCKS',
      details: { draftId },
    };
  }

  // Vérifier chaque bloc.
  for (const block of blocks) {
    // Type doit être HOLD.
    if (block.type !== 'HOLD') {
      return {
        draftId,
        reason: 'BLOCK_NOT_HOLD',
        details: { draftId, blockId: block.id, actualType: block.type },
      };
    }

    // Statut doit être ACTIVE.
    if (block.status !== 'ACTIVE') {
      return {
        draftId,
        reason: 'BLOCK_NOT_ACTIVE',
        details: { draftId, blockId: block.id, actualStatus: block.status },
      };
    }

    // L'échéance du bloc doit correspondre à celle du brouillon.
    if (block.expiresAt === null) {
      return {
        draftId,
        reason: 'BLOCK_EXPIRES_AT_NULL',
        details: { draftId, blockId: block.id },
      };
    }

    const blockExpiresMs = block.expiresAt.getTime();
    const draftExpiresMs = draftExpiresAt.getTime();
    if (blockExpiresMs !== draftExpiresMs) {
      return {
        draftId,
        reason: 'BLOCK_EXPIRES_AT_MISMATCH',
        details: {
          draftId,
          blockId: block.id,
          blockExpiresAt: block.expiresAt.toISOString(),
          draftExpiresAt: draftExpiresAt.toISOString(),
        },
      };
    }
  }

  // Vérifier chaque allocation.
  for (const alloc of allocs) {
    if (alloc.status !== 'ALLOCATED') {
      return {
        draftId,
        reason: 'ALLOCATION_NOT_ALLOCATED',
        details: { draftId, allocationId: alloc.id, actualStatus: alloc.status },
      };
    }
  }

  // Tous les invariants sont satisfaits.
  return null;
}
