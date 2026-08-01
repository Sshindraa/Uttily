/**
 * @uttily/core — Confirmation atomique de réservation (Lot 5, ADR-010 §10).
 *
 * Transaction unique sur `payment_intent.succeeded` :
 * 1. Verrouiller le brouillon racine FOR UPDATE.
 * 2. Verrouiller tous ses holds par id (ORDER BY inventory_blocks.id).
 * 3. Verrouiller toutes ses allocations par id (ORDER BY allocations.id).
 * 4. Verrouiller le paiement et la tentative (FOR UPDATE).
 * 5. Verrouiller l'événement webhook FOR UPDATE EN DERNIER (ordre ADR-010 §10).
 * 6. Vérifier montant, devise, destination (transfer_data.destination),
 *    commission (application_fee_amount), on_behalf_of, environnement (via
 *    organization_payment_accounts), organisation, PaymentIntent ID et intégrité
 *    complète des lignes/allocations.
 * 7. Créer bookings, booking_lines, booking_items.
 * 8. Marquer les holds CONVERTED et créer un nouveau bloc BOOKING/ACTIVE par exemplaire.
 * 9. Marquer les allocations CONVERTED, le brouillon CONVERTED, paiement et tentative SUCCEEDED.
 * 10. Insérer BOOKING_CONFIRMED.v1 dans outbox_events.
 * 11. Marquer l'événement webhook PROCESSED.
 * 12. Commit.
 *
 * Si un invariant échoue : rollback total, aucune réservation partielle.
 *
 * Ordre de verrouillage global (ADR-010 §10) :
 * booking_draft → inventory_blocks (id) → allocations (id)
 * → payment → payment_attempt → webhook_event
 */

import { eq, sql } from 'drizzle-orm';
import { paymentWebhookEvents, type DatabaseTransaction } from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt, HandlerOutcome } from './types';
import { WebhookHandlerError } from './errors';
import { lockWebhookEvent } from './dedupe-event';
import { withInvariantHandling } from './with-invariant-handling';
import { lockFullBusinessRows, applyBookingConfirmation } from '../payment-transitions';

/** Résultat interne de la confirmation. */
export interface ConfirmBookingResult {
  bookingId: string;
}

/**
 * Exécute la confirmation atomique de réservation dans une transaction.
 *
 * @param tx Transaction active (déjà commencée par l'orchestrateur).
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent extraites du webhook.
 * @param webhookEventId ID de la ligne payment_webhook_events.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @param providerEventId ID d'événement Stripe (pour logs).
 */
export async function confirmBooking(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  webhookEventId: string,
  environment: 'TEST' | 'LIVE',
  _providerEventId: string,
): Promise<ConfirmBookingResult | HandlerOutcome> {
  // P1-2 : withInvariantHandling wrap TOUT le corps du handler. Une erreur
  // irréconciliable (statusCode > 200) marque FAILED + failureCode et retourne
  // l'erreur (pas de re-throw) pour que la transaction commit avec FAILED. Les
  // erreurs de control flow (WEBHOOK_LATE_PAYMENT, WEBHOOK_ALREADY_PROCESSED)
  // sont re-lancées. Les erreurs techniques transitoires sont re-lancées →
  // rollback + 5xx (Stripe retry).
  return withInvariantHandling(tx, webhookEventId, async (tx): Promise<ConfirmBookingResult> => {
    // 1-4. Verrouiller les lignes métier (draft → blocks → allocs → payment → attempt).
    const lockedRows = await lockFullBusinessRows(tx, attempt);

    // 5. Verrouiller l'événement webhook EN DERNIER (ordre ADR-010 §10).
    const webhookRow = await lockWebhookEvent(tx, webhookEventId);
    if (webhookRow.status === 'MISSING') {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Événement webhook introuvable lors du verrouillage final.',
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

    // 6-10. Validations + transitions (création booking, conversion, outbox).
    const result = await applyBookingConfirmation(tx, attempt, piData, environment, lockedRows);

    // 11. Marquer l'événement webhook PROCESSED.
    const now = sql`transaction_timestamp()`;
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));

    return result;
  }); // withInvariantHandling
}

/**
 * Détermine si le brouillon est dans un statut terminal qui empêche la
 * conversion (EXPIRED, CANCELLED, CONVERTED).
 */
export function isDraftTerminalForConversion(draftStatus: string): boolean {
  return draftStatus === 'EXPIRED' || draftStatus === 'CANCELLED' || draftStatus === 'CONVERTED';
}
