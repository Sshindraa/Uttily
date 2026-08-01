/**
 * @uttily/core — Gestion des événements non-succès (Lot 5, ADR-010 §11).
 *
 * Gère payment_intent.payment_failed, payment_intent.canceled et
 * payment_intent.processing dans des transactions séparées selon le type.
 *
 * Règles :
 * - payment_failed → REQUIRES_PAYMENT_METHOD (monotone, pas de régression si terminal).
 *   Ne pas libérer les holds (le client peut réessayer).
 * - canceled → sous verrous : brouillon CANCELLED, holds RELEASED, allocations RELEASED,
 *   paiement et tentative CANCELLED (avec cancelled_at=now()).
 * - processing → projection monotone : PROCESSING si non terminal, sinon ignoré.
 *
 * Ordre de verrouillage global (ADR-010 §10) :
 * - payment_failed : payment → payment_attempt → webhook_event
 * - canceled : draft → blocks → allocations → payment → attempt → webhook_event
 * - processing : payment → payment_attempt → webhook_event
 *
 * Tolérance au désordre (ADR-010 §15) : isStaleEvent() est vérifié après
 * verrouillage de la tentative + webhook_event. Un événement ancien (created <
 * dernier PROCESSED pour le même PaymentIntent) est marqué IGNORED.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  paymentAttempts,
  paymentWebhookEvents,
  payments,
  type DatabaseTransaction,
} from '@uttily/database';
import type {
  PaymentIntentEventData,
  ResolvedAttempt,
  WebhookEventRow,
  HandlerOutcome,
} from './types';
import type { VerifiedWebhookEvent } from '../payments/types';
import { projectAttemptStatus, isStaleEvent } from './project-status';
import { WebhookHandlerError } from './errors';
import { validateWebhookAuthority } from './validate-authority';
import { lockWebhookEvent } from './dedupe-event';
import { withInvariantHandling } from './with-invariant-handling';
import {
  lockFullBusinessRows,
  lockPaymentAttemptRows,
  applyCancellation,
  applyProcessingProjection,
} from '../payment-transitions';

/**
 * Vérifie si l'événement est ancien (désordre de livraison) en comparant
 * `event.created` avec le `provider_event_created_at` du dernier événement
 * PROCESSED pour le même PaymentIntent (provider_object_id), en filtrant
 * aussi par provider, environment et organization_id.
 *
 * @returns true si l'événement est ancien (doit être marqué IGNORED).
 */
async function checkStaleEvent(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  attempt: ResolvedAttempt,
  environment: 'TEST' | 'LIVE',
): Promise<boolean> {
  const lastProcessed = await tx
    .select({ createdAt: paymentWebhookEvents.providerEventCreatedAt })
    .from(paymentWebhookEvents)
    .where(
      and(
        eq(paymentWebhookEvents.providerObjectId, event.objectId),
        eq(paymentWebhookEvents.status, 'PROCESSED'),
        eq(paymentWebhookEvents.provider, 'STRIPE'),
        eq(paymentWebhookEvents.environment, environment),
        eq(paymentWebhookEvents.organizationId, attempt.organizationId),
      ),
    )
    .orderBy(desc(paymentWebhookEvents.providerEventCreatedAt))
    .limit(1);

  if (lastProcessed.length > 0) {
    return isStaleEvent(event.created, lastProcessed[0]!.createdAt);
  }
  return false;
}

/**
 * Gère payment_intent.payment_failed : projection monotone vers
 * REQUIRES_PAYMENT_METHOD. Ne libère pas les holds.
 */
export async function handlePaymentFailed(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  webhookEventId: string,
  event: VerifiedWebhookEvent,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
): Promise<HandlerOutcome> {
  // P1-2 : withInvariantHandling wrap TOUT le corps du handler.
  return withInvariantHandling(tx, webhookEventId, async (tx) => {
    // Verrouiller le paiement et la tentative (ordre global).
    const { payment, attemptRow } = await lockPaymentAttemptRows(tx, attempt);

    // Verrouiller l'événement webhook EN DERNIER (ordre ADR-010 §10).
    const webhookRow = await lockWebhookEvent(tx, webhookEventId);
    if (webhookRow.status === 'MISSING') {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Événement webhook introuvable lors du verrouillage final (payment_failed).',
        { statusCode: 500 },
      );
    }
    if (
      webhookRow.status === 'PROCESSED' ||
      webhookRow.status === 'IGNORED' ||
      webhookRow.status === 'FAILED'
    ) {
      throw new WebhookHandlerError(
        'WEBHOOK_ALREADY_PROCESSED',
        'Événement webhook déjà traité par un worker concurrent.',
        { statusCode: 200 },
      );
    }

    const now = sql`transaction_timestamp()`;

    // Vérifier si l'événement est ancien (désordre de livraison).
    if (await checkStaleEvent(tx, event, attempt, environment)) {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'IGNORED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

    // Valider l'autorité du webhook (montant, devise, PI ID, etc.).
    await validateWebhookAuthority(
      tx,
      attempt,
      piData,
      { payment, attempt: attemptRow },
      environment,
    );

    // Projection monotone : ne pas régresser si déjà terminal.
    const projection = projectAttemptStatus('payment_intent.payment_failed', attemptRow.status);
    if (projection.ignored) {
      // Déjà terminal ou déjà REQUIRES_PAYMENT_METHOD — marquer l'événement PROCESSED.
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'PROCESSED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

    // Mettre à jour la tentative et le paiement en REQUIRES_PAYMENT_METHOD.
    await tx
      .update(paymentAttempts)
      .set({ status: 'REQUIRES_PAYMENT_METHOD', updatedAt: now })
      .where(eq(paymentAttempts.id, attempt.attemptId));

    await tx
      .update(payments)
      .set({ status: 'REQUIRES_PAYMENT_METHOD', updatedAt: now })
      .where(eq(payments.id, attempt.paymentId));

    // Marquer l'événement PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));
  }); // withInvariantHandling
}

/**
 * Gère payment_intent.canceled : sous verrous, passer brouillon CANCELLED,
 * holds RELEASED, allocations RELEASED, paiement et tentative CANCELLED.
 * Ne pas appeler Stripe (l'annulation est constatée via le webhook).
 */
export async function handleCanceled(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  webhookEventId: string,
  event: VerifiedWebhookEvent,
  environment: 'TEST' | 'LIVE',
): Promise<HandlerOutcome> {
  // P1-2 : withInvariantHandling wrap TOUT le corps du handler.
  return withInvariantHandling(tx, webhookEventId, async (tx) => {
    // Ordre de verrouillage global : brouillon → holds → allocations → payment → attempt.
    const lockedRows = await lockFullBusinessRows(tx, attempt);

    // Verrouiller l'événement webhook EN DERNIER (ordre ADR-010 §10).
    const webhookRow = await lockWebhookEvent(tx, webhookEventId);
    if (webhookRow.status === 'MISSING') {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Événement webhook introuvable lors du verrouillage final (canceled).',
        { statusCode: 500 },
      );
    }
    if (
      webhookRow.status === 'PROCESSED' ||
      webhookRow.status === 'IGNORED' ||
      webhookRow.status === 'FAILED'
    ) {
      throw new WebhookHandlerError(
        'WEBHOOK_ALREADY_PROCESSED',
        'Événement webhook déjà traité par un worker concurrent.',
        { statusCode: 200 },
      );
    }

    const now = sql`transaction_timestamp()`;

    // Vérifier si l'événement est ancien (désordre de livraison).
    if (await checkStaleEvent(tx, event, attempt, environment)) {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'IGNORED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

    // Appliquer l'annulation atomique (validations + transitions).
    await applyCancellation(tx, attempt, piData, environment, lockedRows);

    // Marquer l'événement PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));
  }); // withInvariantHandling
}

/**
 * Gère payment_intent.processing : projection monotone vers PROCESSING.
 * Si déjà terminal, ignorer (ne pas régresser).
 */
export async function handleProcessing(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  webhookEventId: string,
  event: VerifiedWebhookEvent,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
): Promise<HandlerOutcome> {
  // P1-2 : withInvariantHandling wrap TOUT le corps du handler.
  return withInvariantHandling(tx, webhookEventId, async (tx) => {
    // Verrouiller le paiement et la tentative.
    const lockedRows = await lockPaymentAttemptRows(tx, attempt);

    // Verrouiller l'événement webhook EN DERNIER (ordre ADR-010 §10).
    const webhookRow = await lockWebhookEvent(tx, webhookEventId);
    if (webhookRow.status === 'MISSING') {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Événement webhook introuvable lors du verrouillage final (processing).',
        { statusCode: 500 },
      );
    }
    if (
      webhookRow.status === 'PROCESSED' ||
      webhookRow.status === 'IGNORED' ||
      webhookRow.status === 'FAILED'
    ) {
      throw new WebhookHandlerError(
        'WEBHOOK_ALREADY_PROCESSED',
        'Événement webhook déjà traité par un worker concurrent.',
        { statusCode: 200 },
      );
    }

    const now = sql`transaction_timestamp()`;

    // Vérifier si l'événement est ancien (désordre de livraison).
    if (await checkStaleEvent(tx, event, attempt, environment)) {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: 'IGNORED', processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
      return;
    }

    // Appliquer la projection PROCESSING (validations + projection monotone).
    await applyProcessingProjection(tx, attempt, piData, environment, lockedRows);

    // Marquer l'événement PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));
  }); // withInvariantHandling
}

// Re-export pour compat (WebhookEventRow utilisé dans les signatures internes).
export type { WebhookEventRow };
