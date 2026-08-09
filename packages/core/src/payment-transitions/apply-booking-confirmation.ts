/**
 * @uttily/core — Confirmation atomique de réservation source-agnostique
 * (Phase 7A, ADR-010 §10).
 *
 * Contient les validations et transitions de confirmation (création booking,
 * conversion holds/allocations, snapshot immuable, outbox BOOKING_CONFIRMED.v1)
 * partagées entre les handlers webhook et le moteur de réconciliation.
 *
 * NE touche PAS payment_webhook_events — le marquage webhook reste la
 * responsabilité de l'appelant.
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
  outboxEvents,
  paymentAttempts,
  payments,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { WebhookHandlerError } from '../webhook-handler/errors';
import { validateWebhookAuthority } from '../webhook-handler/validate-authority';
import { isDraftTerminalForConversion } from '../webhook-handler/confirm-booking';
import type { LockedBusinessRows } from './types';

/** Résultat de la confirmation. */
export interface ApplyBookingConfirmationResult {
  bookingId: string;
}

/**
 * Applique la confirmation atomique de réservation (validations + transitions).
 *
 * Étapes (ADR-010 §10) :
 * 1. Valider le statut du brouillon (PAYMENT_PROCESSING).
 * 2. Valider les blocs (HOLD, non supprimés, PAYMENT_PROCESSING).
 * 3. Valider les allocations (ALLOCATED).
 * 4. Valider les invariants quantité (lines ↔ blocks ↔ allocs).
 * 5. Valider l'autorité (validateWebhookAuthority).
 * 6. Vérifier l'idempotence (attempt non déjà SUCCEEDED).
 * 7. Créer booking, booking_lines, booking_items.
 * 8. Convertir holds → CONVERTED, créer blocs BOOKING/ACTIVE.
 * 9. Convertir allocations → CONVERTED, draft → CONVERTED.
 * 10. Marquer payment/attempt SUCCEEDED.
 * 11. Insérer BOOKING_CONFIRMED.v1 dans outbox.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @param lockedRows Lignes métier déjà verrouillées par lockFullBusinessRows.
 * @returns { bookingId }.
 * @throws WebhookHandlerError sur invariant failure.
 */
export async function applyBookingConfirmation(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  lockedRows: LockedBusinessRows,
): Promise<ApplyBookingConfirmationResult> {
  const { draft, blocks, allocs, payment, attemptRow } = lockedRows;

  // 6a. Statut du brouillon : doit être strictement PAYMENT_PROCESSING.
  if (draft.status !== 'PAYMENT_PROCESSING') {
    if (isDraftTerminalForConversion(draft.status)) {
      throw new WebhookHandlerError(
        'WEBHOOK_LATE_PAYMENT',
        `Le brouillon est dans un statut terminal (${draft.status}) — compensation requise.`,
        { statusCode: 200 },
      );
    }
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

  // 6e. Invariants complets draft/holds/allocations.
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

  // 6f. Vérifications webhook vs données locales (autorité + cohérence).
  await validateWebhookAuthority(
    tx,
    attempt,
    piData,
    { payment, attempt: attemptRow },
    environment,
  );

  // 6g. Vérifier que la tentative n'est pas déjà terminale (idempotence).
  if (attemptRow.status === 'SUCCEEDED') {
    throw new WebhookHandlerError(
      'WEBHOOK_ALREADY_PROCESSED',
      'La tentative est déjà SUCCEEDED — doublon.',
      { statusCode: 200 },
    );
  }

  // ── 7. Créer bookings, booking_lines, booking_items ────────────────────────
  const now = sql`transaction_timestamp()`;
  const blockIds = blocks.map((b) => b.id);

  // G7P-B2-C Round 3 (P0-2) — Copie du snapshot du brouillon vers la réservation.
  // Le brouillon est l'autorité pour le pricing de location, la période, le
  // fuseau et le snapshot de pricing (ADR-010 §10, ADR-018). Les champs
  // pricing_* et billableUnit sont copiés inconditionnellement : pour les
  // brouillons legacy, ces champs sont NULL/'DAY' et la copie respecte les
  // contraintes CHECK ; pour les brouillons flexibles, la copie satisfait le
  // trigger validate_flexible_booking_aggregates. Les champs tax/commission/
  // termsAcceptance proviennent toujours du payment (autorité ADR-010 §6),
  // résolus à l'initiation du paiement par resolveFinancialTerms.
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
      timezone: draft.timezone,
      prepBufferMinutes: draft.prepBufferMinutes,
      cleanupBufferMinutes: draft.cleanupBufferMinutes,
      currency: 'EUR',
      subtotalAmountMinor: draft.subtotalAmountMinor,
      mandatoryFeesAmountMinor: draft.mandatoryFeesAmountMinor,
      // G7P-B2-C Round 3 (P0-2) — tax/commission/terms ALWAYS come from the
      // payment (authority ADR-010 §6). The financial terms snapshot is resolved
      // at payment initiation by resolveFinancialTerms and persisted on
      // `payments`. The confirmed booking copies this snapshot without
      // recalculation, for both legacy AND flexible drafts. The draft remains
      // the authority for rental pricing, period, timezone, and pricing snapshot.
      taxStatus: payment.taxStatus,
      taxAmountMinor: payment.taxAmountMinor,
      taxRateBps: payment.taxRateBps,
      taxRuleSnapshot: payment.taxRuleSnapshot,
      commissionAmountMinor: payment.commissionAmountMinor,
      commissionRuleSnapshot: payment.commissionRuleSnapshot,
      totalAmountMinor: draft.totalAmountMinor,
      billableUnit: draft.billableUnit,
      billableUnitCount: draft.billableUnitCount,
      cancellationPolicySnapshot: draft.cancellationPolicySnapshot,
      termsAcceptanceSnapshot: payment.termsAcceptanceSnapshot,
      confirmedAt: now,
      pricingSnapshotVersion: draft.pricingSnapshotVersion,
      pricingAlgorithmVersion: draft.pricingAlgorithmVersion,
      pricingRoundingRuleVersion: draft.pricingRoundingRuleVersion,
      pricingIntentType: draft.pricingIntentType,
      pricingIntentSnapshot: draft.pricingIntentSnapshot,
      pricingResolvedLocale: draft.pricingResolvedLocale,
    })
    .returning({ id: bookings.id });

  const bookingId = booking!.id;

  // Créer booking_lines (copie des booking_draft_lines avec variant_snapshot).
  // G7P-B2-C — Copie exacte du snapshot de prix flexible. Les champs pricing_*
  // sont copiés inconditionnellement (NULL pour legacy, valeurs pour flexible).
  // sourceDraftLineId est conditionnel : NULL pour legacy (le trigger
  // enforce_booking_line_pricing_coherence l'exige), non-null pour flexible.
  const lineIdMap = new Map<string, string>();
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
        sourceDraftLineId: draft.pricingSnapshotVersion === 'flexible-pricing-v1' ? line.id : null,
        pricingPlanId: line.pricingPlanId,
        pricingPlanVersion: line.pricingPlanVersion,
        pricingPlanType: line.pricingPlanType,
        pricingPublicLabel: line.pricingPublicLabel,
        pricingRequestedDurationMinutes: line.pricingRequestedDurationMinutes,
        pricingBilledDurationMinutes: line.pricingBilledDurationMinutes,
        pricingCoveredDurationMinutes: line.pricingCoveredDurationMinutes,
        pricingBilledDays: line.pricingBilledDays,
        pricingSelectedWindow: line.pricingSelectedWindow,
        pricingDiscountThresholdDays: line.pricingDiscountThresholdDays,
        pricingDiscountPercent: line.pricingDiscountPercent,
        pricingAmountBeforeDiscountMinor: line.pricingAmountBeforeDiscountMinor,
        pricingAmountAfterDiscountMinor: line.pricingAmountAfterDiscountMinor,
      })
      .returning({ id: bookingLines.id });
    lineIdMap.set(line.id, bl!.id);
  }

  // 8. Marquer les holds CONVERTED et créer un nouveau bloc BOOKING/ACTIVE par exemplaire.
  await tx
    .update(inventoryBlocks)
    .set({ status: 'CONVERTED', updatedAt: now })
    .where(inArray(inventoryBlocks.id, blockIds));

  for (const alloc of allocs) {
    const sourceBlock = blocks.find((b) => b.id === alloc.inventoryBlockId);
    if (!sourceBlock) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `Bloc source introuvable pour l'allocation ${alloc.id}.`,
        { statusCode: 500 },
      );
    }

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

  // 9b. Marquer le paiement et la tentative SUCCEEDED.
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
  await tx
    .insert(outboxEvents)
    .values({
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
    })
    .onConflictDoNothing({
      target: [outboxEvents.idempotencyKey],
    });

  return { bookingId };
}
