/**
 * @uttily/core — Verrouillage des lignes métier (Phase 7A, ADR-010 §10).
 *
 * Fonctions de verrouillage source-agnostiques partagées entre les handlers
 * webhook et le moteur de réconciliation. L'ordre de verrouillage respecte
 * ADR-010 §10 : booking_draft → inventory_blocks (id) → allocations (id)
 * → payment → payment_attempt.
 *
 * Le verrou webhook_event n'est PAS pris ici — il reste la responsabilité de
 * l'appelant (handler webhook uniquement, EN DERNIER).
 */

import { eq, inArray } from 'drizzle-orm';
import {
  allocations,
  bookingDrafts,
  inventoryBlocks,
  lockOrganization,
  paymentAttempts,
  payments,
  type DatabaseTransaction,
} from '@uttily/database';
import type { ResolvedAttempt } from '../webhook-handler/types';
import { WebhookHandlerError } from '../webhook-handler/errors';
import type { LockedBusinessRows, LockedPaymentRows } from './types';

/**
 * Verrouille toutes les lignes métier dans l'ordre ADR-010 §10 :
 * organization (advisory) → draft → blocks (ORDER BY id) → allocs (ORDER BY id)
 * → payment → attempt.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @returns Les lignes verrouillées.
 * @throws WebhookHandlerError si une ligne est introuvable.
 */
export async function lockFullBusinessRows(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
): Promise<LockedBusinessRows> {
  const orgId = attempt.organizationId;

  await lockOrganization(tx, orgId);

  const draftRows = await tx
    .select()
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, attempt.draftId))
    .for('update')
    .limit(1);

  if (draftRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Brouillon introuvable lors du verrouillage.',
      { statusCode: 500 },
    );
  }
  const draft = draftRows[0]!;

  if (draft.organizationId !== orgId) {
    throw new WebhookHandlerError(
      'WEBHOOK_ORGANIZATION_MISMATCH',
      "L'organisation du brouillon ne correspond pas à la tentative.",
      { statusCode: 403 },
    );
  }

  const blocks = await tx
    .select()
    .from(inventoryBlocks)
    .where(eq(inventoryBlocks.sourceId, attempt.draftId))
    .orderBy(inventoryBlocks.id)
    .for('update');

  if (blocks.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      'Aucun bloc de hold trouvé pour ce brouillon.',
      { statusCode: 500 },
    );
  }

  const blockIds = blocks.map((b) => b.id);
  const allocs = await tx
    .select()
    .from(allocations)
    .where(inArray(allocations.inventoryBlockId, blockIds))
    .orderBy(allocations.id)
    .for('update');

  const paymentRows = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, attempt.paymentId))
    .for('update')
    .limit(1);

  if (paymentRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Paiement introuvable lors du verrouillage.',
      { statusCode: 500 },
    );
  }
  const payment = paymentRows[0]!;

  const attemptRows = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attempt.attemptId))
    .for('update')
    .limit(1);

  if (attemptRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Tentative de paiement introuvable lors du verrouillage.',
      { statusCode: 500 },
    );
  }
  const attemptRow = attemptRows[0]!;

  return { draft, blocks, allocs, payment, attemptRow };
}

/**
 * Verrouille uniquement les lignes paiement (payment + attempt) dans l'ordre
 * ADR-010 §10 : organization (advisory) → payment → attempt.
 *
 * NOTE : Ceci est une sous-séquence valide de l'ordre complet car
 * le brouillon est terminal (compensation tardive) ou non concerné (processing).
 * Aucun deadlock possible avec lockFullBusinessRows car l'ordre relatif
 * payment → attempt est préservé dans les deux fonctions.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @returns Les lignes verrouillées.
 * @throws WebhookHandlerError si une ligne est introuvable.
 */
export async function lockPaymentAttemptRows(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
): Promise<LockedPaymentRows> {
  await lockOrganization(tx, attempt.organizationId);

  const paymentRows = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, attempt.paymentId))
    .for('update')
    .limit(1);

  if (paymentRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Paiement introuvable lors du verrouillage.',
      { statusCode: 500 },
    );
  }
  const payment = paymentRows[0]!;

  const attemptRows = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attempt.attemptId))
    .for('update')
    .limit(1);

  if (attemptRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Tentative de paiement introuvable lors du verrouillage.',
      { statusCode: 500 },
    );
  }
  const attemptRow = attemptRows[0]!;

  return { payment, attemptRow };
}
