/**
 * @uttily/core — Compensation tardive (Lot 5, ADR-010 §13).
 *
 * Si payment_intent.succeeded mais le brouillon est déjà terminal (EXPIRED/
 * CANCELLED/CONVERTED) OU les invariants empêchent la conversion :
 *
 * 1. Enregistrer le succès externe sur payment/attempt (SUCCEEDED) SANS créer de réservation.
 * 2. Créer une seule ligne refunds avec reason=LATE_PAYMENT_NO_BOOKING, amount_minor=payment.amount_minor,
 *    currency=EUR, status=PENDING, reverse_transfer=true, refund_application_fee=true,
 *    provider_idempotency_key stable (`refund_late_${payment.id}`), requested_at=now().
 *    L'unicité (payment_id, reason) empêche la double compensation.
 * 3. Écrire PAYMENT_COMPENSATION_REQUESTED.v1 dans outbox.
 * 4. Marquer l'événement webhook PROCESSED.
 *
 * Ne JAMAIS appeler Stripe (refund) sous verrou ou dans la transaction —
 * le worker le fera hors transaction (phase ultérieure). Ne jamais réallocationner.
 *
 * Ordre de verrouillage (ADR-010 §10) : payment → payment_attempt → webhook_event.
 * Le brouillon est terminal, donc pas de verrou sur draft/blocks/allocations.
 */

import { eq, sql } from 'drizzle-orm';
import { paymentWebhookEvents, type DatabaseTransaction } from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt, HandlerOutcome } from './types';
import { WebhookHandlerError } from './errors';
import { lockWebhookEvent } from './dedupe-event';
import { withInvariantHandling } from './with-invariant-handling';
import { lockPaymentAttemptRows, applyLateCompensation } from '../payment-transitions';

/**
 * Exécute la compensation tardive dans une transaction.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent extraites du webhook.
 * @param webhookEventId ID de la ligne payment_webhook_events.
 */
export async function compensateLatePayment(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  webhookEventId: string,
  environment: 'TEST' | 'LIVE',
): Promise<HandlerOutcome> {
  // P1-2 : withInvariantHandling wrap TOUT le corps du handler.
  return withInvariantHandling(tx, webhookEventId, async (tx) => {
    // Verrouiller le paiement et la tentative (ordre global).
    const lockedRows = await lockPaymentAttemptRows(tx, attempt);

    // Verrouiller l'événement webhook EN DERNIER (ordre ADR-010 §10).
    const webhookRow = await lockWebhookEvent(tx, webhookEventId);
    if (webhookRow.status === 'MISSING') {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Événement webhook introuvable lors du verrouillage final (compensation).',
        { statusCode: 500 },
      );
    }
    if (
      webhookRow.status === 'PROCESSED' ||
      webhookRow.status === 'IGNORED' ||
      webhookRow.status === 'FAILED'
    ) {
      // Un worker concurrent a traité cet événement entre l'ingestion et maintenant.
      throw new WebhookHandlerError(
        'WEBHOOK_ALREADY_PROCESSED',
        'Événement webhook déjà traité par un worker concurrent.',
        { statusCode: 200 },
      );
    }

    // Appliquer la compensation tardive (validations + check bookings + mutations).
    const compensated = await applyLateCompensation(tx, attempt, piData, environment, lockedRows);

    const now = sql`transaction_timestamp()`;

    if (!compensated) {
      // Une réservation existe déjà — ne pas créer de refund spurieux.
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'IGNORED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

    // 4. Marquer l'événement webhook PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));
  }); // withInvariantHandling
}
