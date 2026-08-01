/**
 * @uttily/core — Compensation tardive source-agnostique (Phase 7A, ADR-010 §13).
 *
 * Contient les validations et la compensation tardive (succès externe sans
 * réservation, refund LATE_PAYMENT_NO_BOOKING, outbox
 * PAYMENT_COMPENSATION_REQUESTED.v1) partagées entre les handlers webhook et
 * le moteur de réconciliation.
 *
 * NE touche PAS payment_webhook_events — le marquage webhook reste la
 * responsabilité de l'appelant.
 */

import { eq, sql } from 'drizzle-orm';
import {
  bookings,
  outboxEvents,
  paymentAttempts,
  payments,
  refunds,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { validateWebhookAuthority } from '../webhook-handler/validate-authority';
import type { LockedPaymentRows } from './types';

/**
 * Applique la compensation tardive (validations + transitions).
 *
 * Étapes (ADR-010 §13) :
 * 1. Valider l'autorité (validateWebhookAuthority).
 * 2. Vérifier qu'aucune réservation n'existe pour ce payment.
 * 3. Enregistrer le succès externe sur payment/attempt (SUCCEEDED) SANS créer de réservation.
 * 4. Créer une seule ligne refunds (LATE_PAYMENT_NO_BOOKING, idempotente).
 * 5. Écrire PAYMENT_COMPENSATION_REQUESTED.v1 dans outbox (idempotent).
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @param lockedRows Lignes paiement déjà verrouillées par lockPaymentAttemptRows.
 * @returns true si la compensation a été appliquée, false si une réservation
 *   existait déjà (ignoré).
 * @throws WebhookHandlerError sur invariant failure (via validateWebhookAuthority).
 */
export async function applyLateCompensation(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  lockedRows: LockedPaymentRows,
): Promise<boolean> {
  const { payment, attemptRow } = lockedRows;

  // Valider l'autorité du webhook avant toute mutation.
  await validateWebhookAuthority(
    tx,
    attempt,
    piData,
    { payment, attempt: attemptRow },
    environment,
  );

  // Vérifier qu'aucune réservation n'existe pour ce payment.
  const existingBookings = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.paymentId, payment.id))
    .limit(1);

  if (existingBookings.length > 0) {
    return false;
  }

  const now = sql`transaction_timestamp()`;

  // 1. Enregistrer le succès externe sur payment/attempt (SUCCEEDED) SANS créer de réservation.
  if (payment.status !== 'SUCCEEDED') {
    await tx
      .update(payments)
      .set({ status: 'SUCCEEDED', succeededAt: now, updatedAt: now })
      .where(eq(payments.id, payment.id));
  }

  if (attemptRow.status !== 'SUCCEEDED') {
    await tx
      .update(paymentAttempts)
      .set({
        status: 'SUCCEEDED',
        providerPaymentIntentId: piData.id,
        providerStatus: 'succeeded',
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, attempt.attemptId));
  }

  // 2. Créer une seule ligne refunds (idempotente via ON CONFLICT sur provider_idempotency_key).
  const refundIdempotencyKey = `refund_late_${payment.id}`;
  await tx
    .insert(refunds)
    .values({
      organizationId: attempt.organizationId,
      paymentId: payment.id,
      reason: 'LATE_PAYMENT_NO_BOOKING',
      status: 'PENDING',
      amountMinor: payment.amountMinor,
      currency: 'EUR',
      providerIdempotencyKey: refundIdempotencyKey,
      reverseTransfer: true,
      refundApplicationFee: true,
      requestedAt: now,
    })
    .onConflictDoNothing({
      target: [refunds.providerIdempotencyKey],
    });

  // 3. Écrire PAYMENT_COMPENSATION_REQUESTED.v1 dans outbox (idempotent).
  await tx
    .insert(outboxEvents)
    .values({
      organizationId: attempt.organizationId,
      aggregateType: 'PAYMENT',
      aggregateId: payment.id,
      eventType: 'PAYMENT_COMPENSATION_REQUESTED',
      eventVersion: 'v1',
      payload: {
        paymentId: payment.id,
        refundIdempotencyKey,
        amountMinor: payment.amountMinor,
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      idempotencyKey: `payment_compensation_${payment.id}`,
    })
    .onConflictDoNothing({
      target: [outboxEvents.idempotencyKey],
    });

  return true;
}
