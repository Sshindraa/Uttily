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

import { eq, inArray, sql } from 'drizzle-orm';
import {
  allocations,
  bookingDraftLines,
  bookingDrafts,
  bookingItems,
  bookingLines,
  bookings,
  inventoryBlocks,
  lockOrganization,
  outboxEvents,
  paymentAttempts,
  paymentWebhookEvents,
  payments,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt, HandlerOutcome } from './types';
import { WebhookHandlerError } from './errors';
import { validateWebhookAuthority } from './validate-authority';
import { lockWebhookEvent } from './dedupe-event';
import { withInvariantHandling } from './with-invariant-handling';

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
    const orgId = attempt.organizationId;

    // 0. Verrou advisory sur l'organisation (ordre global ADR-010).
    await lockOrganization(tx, orgId);

    // 1. Verrouiller le brouillon racine FOR UPDATE.
    const draftRows = await tx
      .select()
      .from(bookingDrafts)
      .where(eq(bookingDrafts.id, attempt.draftId))
      .for('update')
      .limit(1);

    if (draftRows.length === 0) {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Brouillon introuvable lors de la confirmation.',
        { statusCode: 500 },
      );
    }
    const draft = draftRows[0]!;

    // Vérifier l'organisation du brouillon.
    if (draft.organizationId !== orgId) {
      throw new WebhookHandlerError(
        'WEBHOOK_ORGANIZATION_MISMATCH',
        "L'organisation du brouillon ne correspond pas à la tentative.",
        { statusCode: 403 },
      );
    }

    // 2. Verrouiller tous les holds par id (ORDER BY inventory_blocks.id).
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

    // 3. Verrouiller toutes les allocations par id (ORDER BY allocations.id).
    const blockIds = blocks.map((b) => b.id);
    const allocs = await tx
      .select()
      .from(allocations)
      .where(inArray(allocations.inventoryBlockId, blockIds))
      .orderBy(allocations.id)
      .for('update');

    // 4. Verrouiller le paiement et la tentative (FOR UPDATE).
    const paymentRows = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, attempt.paymentId))
      .for('update')
      .limit(1);

    if (paymentRows.length === 0) {
      throw new WebhookHandlerError(
        'WEBHOOK_AGGREGATE_INCONSISTENT',
        'Paiement introuvable lors de la confirmation.',
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
        'Tentative de paiement introuvable lors de la confirmation.',
        { statusCode: 500 },
      );
    }
    const attemptRow = attemptRows[0]!;

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

    // ── 6. Vérifications complètes ─────────────────────────────────────────────
    // 6a. Statut du brouillon : doit être strictement PAYMENT_PROCESSING (ADR-010 §10).
    // La Transaction A doit avoir atomiquement passé draft + holds à PAYMENT_PROCESSING
    // avant la création du PaymentIntent. HELD/ACTIVE ne sont pas acceptés.
    if (draft.status !== 'PAYMENT_PROCESSING') {
      if (
        draft.status === 'EXPIRED' ||
        draft.status === 'CANCELLED' ||
        draft.status === 'CONVERTED'
      ) {
        // Brouillon terminal → compensation tardive (gérée par l'orchestrateur).
        throw new WebhookHandlerError(
          'WEBHOOK_LATE_PAYMENT',
          `Le brouillon est dans un statut terminal (${draft.status}) — compensation requise.`,
          { statusCode: 200 },
        );
      }
      // Statut inattendu (HELD, etc.) → invariant brisé.
      throw new WebhookHandlerError(
        'WEBHOOK_DRAFT_NOT_PROCESSING',
        `Le brouillon n'est pas PAYMENT_PROCESSING (reçu : ${draft.status}). La Transaction A doit avoir atomiquement passé le draft en PAYMENT_PROCESSING.`,
        { statusCode: 500 },
      );
    }

    // 6b. Vérifier que tous les blocs sont type HOLD, non supprimés, et PAYMENT_PROCESSING.
    for (const block of blocks) {
      if (block.type !== 'HOLD') {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Le bloc ${block.id} n'est pas de type HOLD (reçu : ${block.type}).`,
          { statusCode: 500 },
        );
      }
      if (block.deletedAt !== null) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Le bloc ${block.id} est supprimé (soft delete).`,
          { statusCode: 500 },
        );
      }
      if (block.status !== 'PAYMENT_PROCESSING') {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Le bloc ${block.id} n'est pas PAYMENT_PROCESSING (reçu : ${block.status}).`,
          { statusCode: 500 },
        );
      }
    }

    // 6c. Vérifier que toutes les allocations sont ALLOCATED.
    for (const alloc of allocs) {
      if (alloc.status !== 'ALLOCATED') {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `L'allocation ${alloc.id} n'est pas ALLOCATED (reçu : ${alloc.status}).`,
          { statusCode: 500 },
        );
      }
    }

    // 6d. Charger les booking_draft_lines et vérifier la devise EUR.
    const lines = await tx
      .select()
      .from(bookingDraftLines)
      .where(eq(bookingDraftLines.draftId, attempt.draftId));

    if (lines.length === 0) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        'Aucune ligne de brouillon trouvée.',
        { statusCode: 500 },
      );
    }
    for (const line of lines) {
      if (line.currency !== 'EUR') {
        throw new WebhookHandlerError(
          'WEBHOOK_CURRENCY_MISMATCH',
          `La ligne ${line.id} n'est pas en EUR (reçu : ${line.currency}).`,
          { statusCode: 500 },
        );
      }
    }
    if (draft.currency !== 'EUR') {
      throw new WebhookHandlerError(
        'WEBHOOK_CURRENCY_MISMATCH',
        `Le brouillon n'est pas en EUR (reçu : ${draft.currency}).`,
        { statusCode: 500 },
      );
    }

    // 6e. Invariants complets draft/holds/allocations (reprend initiate-payment.ts).
    // SUM(lines.quantity) == blocks.length == allocs.length
    const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
    if (totalQuantity !== blocks.length) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `La quantité totale des lignes (${totalQuantity}) ne correspond pas au nombre de blocs (${blocks.length}).`,
        { statusCode: 500 },
      );
    }
    if (blocks.length !== allocs.length) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `Le nombre de blocs (${blocks.length}) ne correspond pas au nombre d'allocations (${allocs.length}).`,
        { statusCode: 500 },
      );
    }

    // Exactement une allocation par bloc.
    const blockIdsWithAlloc = new Set(allocs.map((a) => a.inventoryBlockId));
    for (const block of blocks) {
      if (!blockIdsWithAlloc.has(block.id)) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Le bloc ${block.id} n'a pas d'allocation associée.`,
          { statusCode: 500 },
        );
      }
    }
    const allocCounts = new Map<string, number>();
    for (const alloc of allocs) {
      allocCounts.set(alloc.inventoryBlockId, (allocCounts.get(alloc.inventoryBlockId) ?? 0) + 1);
    }
    for (const [blockId, count] of allocCounts) {
      if (count !== 1) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Le bloc ${blockId} a ${count} allocations (attendu : exactement 1).`,
          { statusCode: 500 },
        );
      }
    }

    // Répartition par ligne : chaque ligne a exactement line.quantity allocations.
    for (const line of lines) {
      const lineAllocCount = allocs.filter((a) => a.draftLineId === line.id).length;
      if (lineAllocCount !== line.quantity) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `La ligne ${line.id} a ${lineAllocCount} allocations (attendu : ${line.quantity}).`,
          { statusCode: 500 },
        );
      }
    }

    // Échéances cohérentes entre blocs.
    const customerStartTimes = new Set(blocks.map((b) => b.customerStartAt.getTime()));
    if (customerStartTimes.size > 1) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        'Les blocs de hold ont des customer_start_at différents.',
        { statusCode: 500 },
      );
    }
    const customerEndTimes = new Set(blocks.map((b) => b.customerEndAt.getTime()));
    if (customerEndTimes.size > 1) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        'Les blocs de hold ont des customer_end_at différents.',
        { statusCode: 500 },
      );
    }

    // 6f. Vérifications webhook vs données locales (autorité + cohérence bidirectionnelle).
    // P1-2 : Les erreurs irréconciliables sont catchées par withInvariantHandling
    // (marque FAILED + failureCode, retourne l'erreur sans re-throw).
    await validateWebhookAuthority(
      tx,
      attempt,
      piData,
      { payment, attempt: attemptRow },
      environment,
    );

    // 6g. Vérifier que la tentative n'est pas déjà terminale (idempotence).
    if (attemptRow.status === 'SUCCEEDED') {
      // Doublon — déjà confirmé. Pas d'erreur, l'orchestrateur gère.
      throw new WebhookHandlerError(
        'WEBHOOK_ALREADY_PROCESSED',
        'La tentative est déjà SUCCEEDED — doublon.',
        { statusCode: 200 },
      );
    }

    // ── 7. Créer bookings, booking_lines, booking_items ────────────────────────

    const now = sql`transaction_timestamp()`;

    const [booking] = await tx
      .insert(bookings)
      .values({
        organizationId: draft.organizationId,
        locationId: draft.locationId,
        customerUserId: draft.customerUserId,
        draftId: draft.id,
        paymentId: payment.id,
        status: 'CONFIRMED',
        customerStartAt: draft.customerStartAt,
        customerEndAt: draft.customerEndAt,
        blockedStartAt: draft.blockedStartAt,
        blockedEndAt: draft.blockedEndAt,
        prepBufferMinutes: draft.prepBufferMinutes,
        cleanupBufferMinutes: draft.cleanupBufferMinutes,
        currency: 'EUR',
        subtotalAmountMinor: draft.subtotalAmountMinor,
        mandatoryFeesAmountMinor: draft.mandatoryFeesAmountMinor,
        taxStatus: payment.taxStatus,
        taxAmountMinor: payment.taxAmountMinor,
        taxRateBps: payment.taxRateBps,
        taxRuleSnapshot: payment.taxRuleSnapshot,
        commissionAmountMinor: payment.commissionAmountMinor,
        commissionRuleSnapshot: payment.commissionRuleSnapshot,
        totalAmountMinor: draft.totalAmountMinor,
        cancellationPolicySnapshot: draft.cancellationPolicySnapshot,
        termsAcceptanceSnapshot: payment.termsAcceptanceSnapshot,
        confirmedAt: now,
      })
      .returning({ id: bookings.id });

    const bookingId = booking!.id;

    // Créer booking_lines (copie des booking_draft_lines avec variant_snapshot).
    const lineIdMap = new Map<string, string>(); // draftLineId → bookingLineId
    for (const line of lines) {
      const [bl] = await tx
        .insert(bookingLines)
        .values({
          bookingId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPriceAmountMinor: line.unitPriceAmountMinor,
          billableUnitCount: line.billableUnitCount,
          lineTotalAmountMinor: line.lineTotalAmountMinor,
          currency: line.currency,
          variantSnapshot: line.variantSnapshot,
        })
        .returning({ id: bookingLines.id });
      lineIdMap.set(line.id, bl!.id);
    }

    // 8. Marquer les holds CONVERTED et créer un nouveau bloc BOOKING/ACTIVE par exemplaire.
    // + 9. Marquer les allocations CONVERTED.
    // + Créer booking_items (un par allocation).

    // Mettre à jour tous les holds en CONVERTED.
    await tx
      .update(inventoryBlocks)
      .set({ status: 'CONVERTED', updatedAt: now })
      .where(inArray(inventoryBlocks.id, blockIds));

    // Pour chaque allocation (exemplaire), créer un bloc BOOKING + booking_item.
    for (const alloc of allocs) {
      const sourceBlock = blocks.find((b) => b.id === alloc.inventoryBlockId);
      if (!sourceBlock) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Bloc source introuvable pour l'allocation ${alloc.id}.`,
          { statusCode: 500 },
        );
      }

      // Créer le nouveau bloc BOOKING/ACTIVE avec source_id=booking.id.
      const [newBlock] = await tx
        .insert(inventoryBlocks)
        .values({
          organizationId: draft.organizationId,
          inventoryItemId: sourceBlock.inventoryItemId,
          type: 'BOOKING',
          status: 'ACTIVE',
          customerStartAt: sourceBlock.customerStartAt,
          customerEndAt: sourceBlock.customerEndAt,
          blockedStartAt: sourceBlock.blockedStartAt,
          blockedEndAt: sourceBlock.blockedEndAt,
          expiresAt: null,
          sourceId: bookingId,
        })
        .returning({ id: inventoryBlocks.id });

      const newBlockId = newBlock!.id;
      const bookingLineId = lineIdMap.get(alloc.draftLineId);
      if (!bookingLineId) {
        throw new WebhookHandlerError(
          'WEBHOOK_INVARIANT_BROKEN',
          `Booking line introuvable pour l'allocation ${alloc.id} (draftLineId=${alloc.draftLineId}).`,
          { statusCode: 500 },
        );
      }

      // Créer le booking_item.
      await tx.insert(bookingItems).values({
        bookingId,
        bookingLineId,
        inventoryItemId: sourceBlock.inventoryItemId,
        sourceHoldBlockId: sourceBlock.id,
        bookingBlockId: newBlockId,
      });
    }

    // Marquer les allocations CONVERTED.
    const allocIds = allocs.map((a) => a.id);
    await tx
      .update(allocations)
      .set({ status: 'CONVERTED' })
      .where(inArray(allocations.id, allocIds));

    // 9. Marquer le brouillon CONVERTED.
    await tx
      .update(bookingDrafts)
      .set({ status: 'CONVERTED', updatedAt: now })
      .where(eq(bookingDrafts.id, draft.id));

    // 9b. Marquer le paiement et la tentative SUCCEEDED (avec succeeded_at=now()).
    await tx
      .update(payments)
      .set({ status: 'SUCCEEDED', succeededAt: now, updatedAt: now })
      .where(eq(payments.id, payment.id));

    await tx
      .update(paymentAttempts)
      .set({
        status: 'SUCCEEDED',
        providerPaymentIntentId: piData.id,
        providerStatus: 'succeeded',
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, attemptRow.id));

    // 10. Insérer BOOKING_CONFIRMED.v1 dans outbox_events.
    await tx.insert(outboxEvents).values({
      organizationId: draft.organizationId,
      aggregateType: 'BOOKING',
      aggregateId: bookingId,
      eventType: 'BOOKING_CONFIRMED',
      eventVersion: 'v1',
      payload: {
        bookingId,
        paymentId: payment.id,
        draftId: draft.id,
        organizationId: draft.organizationId,
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      idempotencyKey: `booking_confirmed_${bookingId}`,
    });

    // 11. Marquer l'événement webhook PROCESSED.
    await tx
      .update(paymentWebhookEvents)
      .set({ status: 'PROCESSED', processedAt: now })
      .where(eq(paymentWebhookEvents.id, webhookEventId));

    return { bookingId };
  }); // withInvariantHandling
}

/**
 * Détermine si le brouillon est dans un statut terminal qui empêche la
 * conversion (EXPIRED, CANCELLED, CONVERTED).
 */
export function isDraftTerminalForConversion(draftStatus: string): boolean {
  return draftStatus === 'EXPIRED' || draftStatus === 'CANCELLED' || draftStatus === 'CONVERTED';
}
