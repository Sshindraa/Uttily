/**
 * @uttily/core — Annulation atomique source-agnostique (Phase 7A, ADR-010 §12).
 *
 * Contient les validations et transitions d'annulation (draft CANCELLED,
 * holds RELEASED, allocations RELEASED, payment/attempt CANCELLED) partagées
 * entre les handlers webhook et le moteur de réconciliation.
 *
 * NE touche PAS payment_webhook_events — le marquage webhook reste la
 * responsabilité de l'appelant.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import {
  allocations,
  bookingDrafts,
  inventoryBlocks,
  paymentAttempts,
  payments,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { validateWebhookAuthority } from '../webhook-handler/validate-authority';
import { projectAttemptStatus } from '../webhook-handler/project-status';
import { isDraftTerminalForConversion } from '../webhook-handler/confirm-booking';
import type { LockedBusinessRows } from './types';

/**
 * Applique l'annulation atomique (validations + transitions).
 *
 * Étapes (ADR-010 §12) :
 * 1. Valider l'autorité (validateWebhookAuthority).
 * 2. Si draft terminal : projeter payment/attempt en cohérence seulement.
 * 3. Sinon : projection monotone, puis draft CANCELLED, holds RELEASED,
 *    allocations RELEASED, payment/attempt CANCELLED.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @param lockedRows Lignes métier déjà verrouillées par lockFullBusinessRows.
 * @throws WebhookHandlerError sur invariant failure.
 */
export async function applyCancellation(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  lockedRows: LockedBusinessRows,
): Promise<void> {
  const { draft, blocks, allocs, payment, attemptRow } = lockedRows;
  const blockIds = blocks.map((b) => b.id);

  // Valider l'autorité du webhook (montant, devise, PI ID, etc.).
  await validateWebhookAuthority(
    tx,
    attempt,
    piData,
    { payment, attempt: attemptRow },
    environment,
  );

  const now = sql`transaction_timestamp()`;

  // Si déjà terminal (CONVERTED/CANCELLED/EXPIRED), projeter quand même payment/attempt
  // en cohérence (projection monotone) sans libérer les holds.
  if (isDraftTerminalForConversion(draft.status)) {
    const projection = projectAttemptStatus('payment_intent.canceled', attemptRow.status);
    if (!projection.ignored && projection.newStatus !== null) {
      if (projection.newStatus === 'CANCELLED') {
        if (payment.status !== 'CANCELLED') {
          await tx
            .update(payments)
            .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
            .where(eq(payments.id, attempt.paymentId));
        }
        if (attemptRow.status !== 'CANCELLED') {
          await tx
            .update(paymentAttempts)
            .set({
              status: 'CANCELLED',
              providerPaymentIntentId: piData.id,
              providerStatus: 'canceled',
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, attempt.attemptId));
        }
      }
    }
    return;
  }

  // Projection monotone : ne pas régresser si déjà terminal.
  const projection = projectAttemptStatus('payment_intent.canceled', attemptRow.status);
  if (projection.ignored) {
    return;
  }

  // Passer brouillon CANCELLED.
  await tx
    .update(bookingDrafts)
    .set({ status: 'CANCELLED', updatedAt: now })
    .where(eq(bookingDrafts.id, draft.id));

  // Passer holds RELEASED.
  if (blockIds.length > 0) {
    await tx
      .update(inventoryBlocks)
      .set({ status: 'RELEASED', updatedAt: now })
      .where(inArray(inventoryBlocks.id, blockIds));
  }

  // Passer allocations RELEASED.
  const allocIds = allocs.map((a) => a.id);
  if (allocIds.length > 0) {
    await tx
      .update(allocations)
      .set({ status: 'RELEASED' })
      .where(inArray(allocations.id, allocIds));
  }

  // Passer paiement et tentative CANCELLED (avec cancelled_at=now()).
  await tx
    .update(payments)
    .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
    .where(eq(payments.id, attempt.paymentId));

  await tx
    .update(paymentAttempts)
    .set({
      status: 'CANCELLED',
      providerPaymentIntentId: piData.id,
      providerStatus: 'canceled',
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attempt.attemptId));
}
