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
import {
  bookings,
  lockOrganization,
  outboxEvents,
  paymentAttempts,
  paymentWebhookEvents,
  payments,
  refunds,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt, HandlerOutcome } from './types';
import { WebhookHandlerError } from './errors';
import { lockWebhookEvent } from './dedupe-event';
import { validateWebhookAuthority } from './validate-authority';
import { withInvariantHandling } from './with-invariant-handling';

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
    await lockOrganization(tx, attempt.organizationId);

    // Verrouiller le paiement et la tentative (ordre global).
    const paymentRows = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, attempt.paymentId))
      .for('update')
      .limit(1);

    if (paymentRows.length === 0) {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Paiement introuvable lors de la compensation tardive.',
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
        'Tentative introuvable lors de la compensation tardive.',
        { statusCode: 500 },
      );
    }
    const attemptRow = attemptRows[0]!;

    // Valider l'autorité du webhook avant toute mutation (ADR-010 §10 étape 6).
    // La compensation est une mutation financière (refund + outbox) : elle doit
    // recouper montant, devise, destination, commission, on_behalf_of,
    // environnement, organisation et PaymentIntent ID, comme les autres handlers.
    await validateWebhookAuthority(
      tx,
      attempt,
      piData,
      { payment, attempt: attemptRow },
      environment,
    );

    // Vérifier qu'aucune réservation n'existe pour ce payment (P1-2).
    // Si une réservation existe déjà, l'effet a été produit par un autre événement
    // → marquer IGNORED, ne pas compenser.
    const existingBookings = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.paymentId, payment.id))
      .limit(1);

    if (existingBookings.length > 0) {
      // Une réservation existe déjà — ne pas créer de refund spurieux.
      const now = sql`transaction_timestamp()`;
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'IGNORED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

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

    const now = sql`transaction_timestamp()`;

    // 1. Enregistrer le succès externe sur payment/attempt (SUCCEEDED) SANS créer de réservation.
    // Ne pas régresser si déjà SUCCEEDED.
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

    // 4. Marquer l'événement webhook PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));
  }); // withInvariantHandling
}
