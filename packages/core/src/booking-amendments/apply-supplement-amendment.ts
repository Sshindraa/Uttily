/**
 * G7M-C3 — application atomique d'un supplément après confirmation Stripe.
 *
 * Cette fonction ne vérifie pas la signature et n'appelle jamais Stripe. Elle
 * est appelée par le webhook handler après résolution et verrouillage de la
 * tentative. Tous les blocks, allocations, segments, paiements et l'outbox
 * sont mutés dans la même transaction PostgreSQL.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendmentAllocations,
  bookingAmendmentSegments,
  bookingAmendments,
  bookings,
  inventoryBlocks,
  outboxEvents,
  paymentWebhookEvents,
  type DatabaseTransaction,
} from '@uttily/database';
import {
  BOOKING_AMENDED_AGGREGATE_TYPE,
  BOOKING_AMENDED_EVENT_TYPE,
  BOOKING_AMENDED_EVENT_VERSION,
} from '@uttily/contracts';
import type { PaymentIntentEventData, ResolvedAmendmentAttempt } from '../webhook-handler/types';
import type { VerifiedWebhookEvent } from '../payments/types';
import { WebhookHandlerError } from '../webhook-handler/errors';
import { lockWebhookEvent } from '../webhook-handler/dedupe-event';
import { withInvariantHandling } from '../webhook-handler/with-invariant-handling';
import { lockOrganization } from '@uttily/database';
import { calculateSupplementCommission } from './supplement-commission';
import { parseMarketplaceFeeDeltaSnapshot } from '../marketplace-fees';
import { compensateAmendmentPayment } from './compensate-amendment-payment';
import { rescheduleBookingReminders } from '../notifications/scheduling';

interface LockedSupplementRows {
  booking: typeof bookings.$inferSelect;
  amendment: typeof bookingAmendments.$inferSelect;
  payment: typeof amendmentPayments.$inferSelect;
  attempt: typeof amendmentPaymentAttempts.$inferSelect;
  allocations: Array<typeof bookingAmendmentAllocations.$inferSelect>;
  segments: Array<typeof bookingAmendmentSegments.$inferSelect>;
  blocks: Array<typeof inventoryBlocks.$inferSelect>;
}

/** Résultat interne d'un webhook SUPPLEMENT déjà acquitté. */
export interface SupplementLateSuccessOutcome {
  readonly kind: 'LATE_SUCCESS_REQUIRES_COMPENSATION';
  readonly amendmentId: string;
  readonly amendmentPaymentId: string;
  readonly bookingId: string;
  readonly holdDeadline: Date | null;
}

export type SupplementWebhookOutcome = void | SupplementLateSuccessOutcome | WebhookHandlerError;

function invariant(message: string): WebhookHandlerError {
  return new WebhookHandlerError('WEBHOOK_INVARIANT_BROKEN', message, { statusCode: 500 });
}

function isBookingAmendedPayload(
  payload: unknown,
  expected: { organizationId: string; bookingId: string; amendmentId: string },
): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const actual = payload as Record<string, unknown>;
  return (
    Object.keys(actual).length === 3 &&
    actual.organizationId === expected.organizationId &&
    actual.bookingId === expected.bookingId &&
    actual.amendmentId === expected.amendmentId
  );
}

async function lockSupplementRows(
  tx: DatabaseTransaction,
  resolved: ResolvedAmendmentAttempt,
): Promise<LockedSupplementRows> {
  const bookingRows = await tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.id, resolved.bookingId),
        eq(bookings.organizationId, resolved.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const booking = bookingRows[0];
  if (!booking) throw invariant('Réservation introuvable lors de l’application du supplément.');

  const amendmentRows = await tx
    .select()
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.id, resolved.amendmentId),
        eq(bookingAmendments.organizationId, resolved.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const amendment = amendmentRows[0];
  if (!amendment) throw invariant('Amendement introuvable lors de l’application du supplément.');

  // Lecture sans verrou pour déterminer les IDs nécessaires avant d'acquérir
  // les verrous dans l'ordre global : blocks → allocations → segments.
  const allocationIdsRows = await tx
    .select()
    .from(bookingAmendmentAllocations)
    .where(
      and(
        eq(bookingAmendmentAllocations.amendmentId, amendment.id),
        eq(bookingAmendmentAllocations.organizationId, resolved.organizationId),
      ),
    )
    .orderBy(asc(bookingAmendmentAllocations.id));

  const allocationIds = allocationIdsRows.map((row) => row.id);
  const segmentIdsRows =
    allocationIds.length === 0
      ? []
      : await tx
          .select()
          .from(bookingAmendmentSegments)
          .where(
            and(
              inArray(bookingAmendmentSegments.allocationId, allocationIds),
              eq(bookingAmendmentSegments.organizationId, resolved.organizationId),
            ),
          )
          .orderBy(asc(bookingAmendmentSegments.id));

  const blockIds = [
    ...allocationIdsRows.flatMap((row) =>
      row.sourceBookingBlockId ? [row.sourceBookingBlockId] : [],
    ),
    ...segmentIdsRows.map((row) => row.holdBlockId),
  ];
  const uniqueBlockIds = [...new Set(blockIds)].sort();
  const blockRows =
    uniqueBlockIds.length === 0
      ? []
      : await tx
          .select()
          .from(inventoryBlocks)
          .where(
            and(
              inArray(inventoryBlocks.id, uniqueBlockIds),
              eq(inventoryBlocks.organizationId, resolved.organizationId),
            ),
          )
          .orderBy(asc(inventoryBlocks.id))
          .for('update');
  if (blockRows.length !== uniqueBlockIds.length) {
    throw invariant('Les blocks attendus du supplément ne sont pas tous rattachés au tenant.');
  }

  const allocationRows =
    allocationIds.length === 0
      ? []
      : await tx
          .select()
          .from(bookingAmendmentAllocations)
          .where(
            and(
              inArray(bookingAmendmentAllocations.id, allocationIds),
              eq(bookingAmendmentAllocations.organizationId, resolved.organizationId),
            ),
          )
          .orderBy(asc(bookingAmendmentAllocations.id))
          .for('update');
  if (allocationRows.length !== allocationIds.length) {
    throw invariant('Les allocations attendues du supplément ne sont pas toutes verrouillées.');
  }

  const segmentRows =
    allocationIds.length === 0
      ? []
      : await tx
          .select()
          .from(bookingAmendmentSegments)
          .where(
            and(
              inArray(bookingAmendmentSegments.allocationId, allocationIds),
              eq(bookingAmendmentSegments.organizationId, resolved.organizationId),
            ),
          )
          .orderBy(asc(bookingAmendmentSegments.id))
          .for('update');
  if (segmentRows.length !== segmentIdsRows.length) {
    throw invariant('Les segments attendus du supplément ne sont pas tous verrouillés.');
  }

  const paymentRows = await tx
    .select()
    .from(amendmentPayments)
    .where(
      and(
        eq(amendmentPayments.id, resolved.amendmentPaymentId),
        eq(amendmentPayments.organizationId, resolved.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const payment = paymentRows[0];
  if (!payment) throw invariant('Paiement de supplément introuvable.');

  const attemptRows = await tx
    .select()
    .from(amendmentPaymentAttempts)
    .where(
      and(
        eq(amendmentPaymentAttempts.id, resolved.attemptId),
        eq(amendmentPaymentAttempts.amendmentPaymentId, payment.id),
        eq(amendmentPaymentAttempts.organizationId, resolved.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const attempt = attemptRows[0];
  if (!attempt) throw invariant('Tentative de paiement de supplément introuvable.');

  return {
    booking,
    amendment,
    payment,
    attempt,
    allocations: allocationRows,
    segments: segmentRows,
    blocks: blockRows,
  };
}

function validateResolvedRows(
  resolved: ResolvedAmendmentAttempt,
  rows: LockedSupplementRows,
): void {
  const { booking, amendment, payment, attempt } = rows;
  if (
    booking.status !== 'CONFIRMED' ||
    booking.organizationId !== resolved.organizationId ||
    amendment.organizationId !== resolved.organizationId ||
    amendment.bookingId !== booking.id ||
    amendment.type !== 'SUPPLEMENT' ||
    payment.organizationId !== resolved.organizationId ||
    payment.bookingId !== booking.id ||
    payment.amendmentId !== amendment.id ||
    payment.customerUserId !== booking.customerUserId ||
    attempt.organizationId !== resolved.organizationId ||
    attempt.amendmentPaymentId !== payment.id ||
    resolved.customerUserId !== booking.customerUserId ||
    resolved.connectedAccountId !== payment.connectedAccountId
  ) {
    throw invariant('Les agrégats du paiement de supplément ne sont pas cohérents.');
  }
}

function assertProviderIdentity(
  attempt: typeof amendmentPaymentAttempts.$inferSelect,
  piData: PaymentIntentEventData,
): void {
  if (attempt.providerPaymentIntentId !== null && attempt.providerPaymentIntentId !== piData.id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le PaymentIntent du webhook ne correspond pas à la tentative de supplément.',
      { statusCode: 500 },
    );
  }
}

function assertMetadata(
  resolved: ResolvedAmendmentAttempt,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
): void {
  const metadata = piData.metadata;
  if (
    metadata?.payment_type !== 'AMENDMENT' ||
    metadata.amendment_payment_attempt_id !== resolved.attemptId ||
    metadata.amendment_id !== resolved.amendmentId ||
    metadata.organization_id !== resolved.organizationId ||
    metadata.environment !== environment ||
    metadata.protocol_version !== 'booking-amendment-payment-v1'
  ) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Les metadata du PaymentIntent de supplément sont incohérentes.',
      { statusCode: 500 },
    );
  }
}

function assertProviderAuthority(
  resolved: ResolvedAmendmentAttempt,
  rows: LockedSupplementRows,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
): void {
  const { payment, attempt } = rows;
  if (payment.environment !== environment) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      'L’environnement du paiement de supplément ne correspond pas au webhook.',
      { statusCode: 500 },
    );
  }
  if (piData.amount !== payment.amountMinor) {
    throw new WebhookHandlerError(
      'WEBHOOK_AMOUNT_MISMATCH',
      'Le montant du PaymentIntent de supplément ne correspond pas au snapshot local.',
      { statusCode: 500 },
    );
  }
  if (piData.currency.toUpperCase() !== payment.currency) {
    throw new WebhookHandlerError(
      'WEBHOOK_CURRENCY_MISMATCH',
      'La devise du PaymentIntent de supplément ne correspond pas au snapshot local.',
      { statusCode: 500 },
    );
  }
  assertProviderIdentity(attempt, piData);
  assertMetadata(resolved, piData, environment);
  if (piData.destination !== payment.connectedAccountId) {
    throw new WebhookHandlerError(
      'WEBHOOK_DESTINATION_MISMATCH',
      'La destination du PaymentIntent de supplément ne correspond pas au snapshot local.',
      { statusCode: 500 },
    );
  }
  if (
    piData.applicationFeeAmount !== null &&
    piData.applicationFeeAmount !== undefined &&
    piData.applicationFeeAmount < 0
  ) {
    throw invariant('La commission du PaymentIntent de supplément est négative.');
  }
  let expectedApplicationFee: number;
  try {
    if (
      rows.payment.marketplaceFeeDeltaSnapshot !== null &&
      rows.payment.marketplaceFeeDeltaSnapshot !== undefined
    ) {
      const deltaSnapshot = parseMarketplaceFeeDeltaSnapshot(
        rows.payment.marketplaceFeeDeltaSnapshot,
      );
      if (deltaSnapshot.customerTotalDeltaAmountMinor !== payment.amountMinor) {
        throw new Error('Le montant du paiement ne correspond pas au delta client du snapshot.');
      }
      expectedApplicationFee = deltaSnapshot.platformApplicationFeeDeltaAmountMinor;
    } else {
      expectedApplicationFee = calculateSupplementCommission(
        payment.amountMinor,
        rows.booking.totalAmountMinor,
        rows.booking.commissionAmountMinor,
      );
    }
  } catch {
    throw invariant(
      'Le snapshot marketplace du supplément est incohérent avec les données locales.',
    );
  }
  const expectedFee = expectedApplicationFee === 0 ? null : expectedApplicationFee;
  if (
    piData.applicationFeeAmount !== expectedFee &&
    !(expectedFee === null && piData.applicationFeeAmount === 0)
  ) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      "L'application fee du PaymentIntent de supplément ne correspond pas au snapshot local.",
      { statusCode: 500 },
    );
  }
  if (payment.onBehalfOfAccountId === null) {
    if (piData.onBehalfOfAccountId !== null && piData.onBehalfOfAccountId !== undefined) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        'Le on_behalf_of du PaymentIntent de supplément est inattendu.',
        { statusCode: 500 },
      );
    }
  } else if (piData.onBehalfOfAccountId !== payment.onBehalfOfAccountId) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      'Le on_behalf_of du PaymentIntent de supplément ne correspond pas au snapshot local.',
      { statusCode: 500 },
    );
  }
}

function isTerminalStatus(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/** Projection monotone du statut local d'un paiement SUPPLEMENT. */
export function projectSupplementPaymentStatus(
  eventType: string,
  currentStatus: string,
): { newStatus: string | null; ignored: boolean } {
  if (isTerminalStatus(currentStatus)) return { newStatus: null, ignored: true };
  switch (eventType) {
    case 'payment_intent.requires_action':
      return currentStatus === 'PROCESSING' || currentStatus === 'REQUIRES_ACTION'
        ? { newStatus: null, ignored: true }
        : { newStatus: 'REQUIRES_ACTION', ignored: false };
    case 'payment_intent.processing':
      return currentStatus === 'PROCESSING'
        ? { newStatus: null, ignored: true }
        : { newStatus: 'PROCESSING', ignored: false };
    case 'payment_intent.payment_failed':
      return currentStatus === 'FAILED' || currentStatus === 'REQUIRES_PAYMENT_METHOD'
        ? { newStatus: null, ignored: true }
        : { newStatus: 'FAILED', ignored: false };
    case 'payment_intent.canceled':
      return { newStatus: 'CANCELLED', ignored: false };
    default:
      return { newStatus: null, ignored: true };
  }
}

async function markEventProcessed(tx: DatabaseTransaction, webhookEventId: string): Promise<void> {
  await tx
    .update(paymentWebhookEvents)
    .set({ status: 'PROCESSED', processedAt: new Date() })
    .where(eq(paymentWebhookEvents.id, webhookEventId));
}

async function releaseSupplementHoldRows(
  tx: DatabaseTransaction,
  rows: LockedSupplementRows,
  now: Date,
): Promise<void> {
  const holdBlockIds = rows.segments.map((segment) => segment.holdBlockId);
  if (holdBlockIds.length > 0) {
    await tx
      .update(inventoryBlocks)
      .set({ status: 'RELEASED', updatedAt: now })
      .where(inArray(inventoryBlocks.id, holdBlockIds));
    await tx
      .update(bookingAmendmentSegments)
      .set({ status: 'RELEASED' })
      .where(
        inArray(
          bookingAmendmentSegments.id,
          rows.segments.map((segment) => segment.id),
        ),
      );
  }
  if (rows.allocations.length > 0) {
    await tx
      .update(bookingAmendmentAllocations)
      .set({ status: 'RELEASED' })
      .where(
        inArray(
          bookingAmendmentAllocations.id,
          rows.allocations.map((row) => row.id),
        ),
      );
  }
}

async function applySupplement(
  tx: DatabaseTransaction,
  resolved: ResolvedAmendmentAttempt,
  rows: LockedSupplementRows,
  now: Date,
  providerPaymentIntentId: string,
): Promise<SupplementLateSuccessOutcome | void> {
  const { amendment, payment, attempt } = rows;
  const paymentTerminal = isTerminalStatus(payment.status);
  const attemptTerminal = isTerminalStatus(attempt.status);
  if (paymentTerminal !== attemptTerminal) {
    throw invariant('Le paiement et la tentative de supplément ont des terminalités différentes.');
  }
  if (paymentTerminal && payment.status !== 'SUCCEEDED') {
    // La projection locale est monotone : un succeeded tardif ne régresse
    // jamais un échec ou une annulation déjà projetés.
    return;
  }
  const projectFinancialSuccess = async (): Promise<void> => {
    if (payment.status !== 'SUCCEEDED') {
      await tx
        .update(amendmentPayments)
        .set({ status: 'SUCCEEDED', succeededAt: now, updatedAt: now })
        .where(eq(amendmentPayments.id, payment.id));
    }
    if (attempt.status !== 'SUCCEEDED') {
      await tx
        .update(amendmentPaymentAttempts)
        .set({
          status: 'SUCCEEDED',
          providerPaymentIntentId,
          providerStatus: 'succeeded',
          updatedAt: now,
        })
        .where(eq(amendmentPaymentAttempts.id, attempt.id));
    }
  };

  const lateSuccess = (): SupplementLateSuccessOutcome => ({
    kind: 'LATE_SUCCESS_REQUIRES_COMPENSATION',
    amendmentId: resolved.amendmentId,
    amendmentPaymentId: resolved.amendmentPaymentId,
    bookingId: resolved.bookingId,
    holdDeadline: amendment.holdDeadline,
  });

  if (amendment.status !== 'HOLD_PENDING' && amendment.status !== 'READY_TO_APPLY') {
    await projectFinancialSuccess();
    return amendment.status === 'EXPIRED' || amendment.status === 'CANCELLED'
      ? lateSuccess()
      : undefined;
  }

  if (amendment.holdDeadline === null || now.getTime() >= amendment.holdDeadline.getTime()) {
    // C4 fera l'expiration et la compensation. C3 confirme le succès
    // financier, mais n'applique jamais un amendement dont le hold est dépassé.
    await projectFinancialSuccess();
    return lateSuccess();
  }

  if (amendment.status === 'HOLD_PENDING') {
    // La transition métier prévue par ADR-023 est explicite, même si elle est
    // suivie immédiatement par l'application dans cette transaction D.
    await tx
      .update(bookingAmendments)
      .set({ status: 'READY_TO_APPLY', updatedAt: now })
      .where(eq(bookingAmendments.id, amendment.id));
  }

  const sourceBlocks = new Map(rows.blocks.map((block) => [block.id, block]));
  for (const allocation of rows.allocations) {
    if (allocation.status !== 'PROPOSED') {
      throw invariant(`L'allocation ${allocation.id} n'est pas PROPOSED.`);
    }
    if (allocation.sourceBookingBlockId !== null) {
      const source = sourceBlocks.get(allocation.sourceBookingBlockId);
      if (
        !source ||
        source.type !== 'BOOKING' ||
        source.status !== 'ACTIVE' ||
        source.organizationId !== resolved.organizationId ||
        source.inventoryItemId !== allocation.inventoryItemId ||
        source.sourceId !== resolved.bookingId
      ) {
        throw invariant(`Le block source de l'allocation ${allocation.id} est incohérent.`);
      }
      if (allocation.action === 'REPLACE' || allocation.action === 'REMOVE') {
        await tx
          .update(inventoryBlocks)
          .set({ status: 'RELEASED', updatedAt: now })
          .where(eq(inventoryBlocks.id, source.id));
      }
    }
  }

  for (const segment of rows.segments) {
    const hold = sourceBlocks.get(segment.holdBlockId);
    if (
      !hold ||
      hold.type !== 'HOLD' ||
      hold.status !== 'ACTIVE' ||
      hold.organizationId !== resolved.organizationId ||
      hold.inventoryItemId !== segment.inventoryItemId ||
      hold.sourceId !== amendment.id
    ) {
      throw invariant(`Le hold du segment ${segment.id} est incohérent.`);
    }
    await tx
      .update(inventoryBlocks)
      .set({ status: 'CONVERTED', updatedAt: now })
      .where(eq(inventoryBlocks.id, hold.id));
    await tx
      .update(bookingAmendmentSegments)
      .set({ status: 'CONVERTED' })
      .where(eq(bookingAmendmentSegments.id, segment.id));
  }

  for (const allocation of rows.allocations) {
    if (allocation.action === 'REMOVE') {
      await tx
        .update(bookingAmendmentAllocations)
        .set({ status: 'RELEASED' })
        .where(eq(bookingAmendmentAllocations.id, allocation.id));
      continue;
    }

    if (allocation.action === 'RETAIN') {
      if (allocation.sourceBookingBlockId === null) {
        throw invariant(`L'allocation RETAIN ${allocation.id} n'a pas de block source.`);
      }
      await tx
        .update(bookingAmendmentAllocations)
        .set({ status: 'CONVERTED', appliedBookingBlockId: allocation.sourceBookingBlockId })
        .where(eq(bookingAmendmentAllocations.id, allocation.id));
      continue;
    }

    const [newBlock] = await tx
      .insert(inventoryBlocks)
      .values({
        organizationId: resolved.organizationId,
        inventoryItemId: allocation.inventoryItemId,
        type: 'BOOKING',
        status: 'ACTIVE',
        customerStartAt: allocation.effectiveCustomerStartAt,
        customerEndAt: allocation.effectiveCustomerEndAt,
        blockedStartAt: allocation.effectiveBlockedStartAt,
        blockedEndAt: allocation.effectiveBlockedEndAt,
        expiresAt: null,
        sourceId: resolved.bookingId,
      })
      .returning({ id: inventoryBlocks.id });
    if (!newBlock)
      throw invariant(`Impossible de créer le block de l'allocation ${allocation.id}.`);

    await tx
      .update(bookingAmendmentAllocations)
      .set({ status: 'CONVERTED', appliedBookingBlockId: newBlock.id })
      .where(eq(bookingAmendmentAllocations.id, allocation.id));
  }

  await tx
    .update(bookingAmendments)
    .set({ status: 'APPLIED', appliedAt: now, updatedAt: now })
    .where(eq(bookingAmendments.id, amendment.id));

  // Chantier 13.1 — Reprogrammation des rappels de réservation sur amendement
  if (amendment.newCustomerStartAt || amendment.newCustomerEndAt) {
    await rescheduleBookingReminders(
      tx,
      resolved.bookingId,
      amendment.newCustomerStartAt ?? undefined,
      amendment.newCustomerEndAt ?? undefined,
      { now },
    );
  }

  await projectFinancialSuccess();
  const outboxPayload = {
    organizationId: resolved.organizationId,
    bookingId: resolved.bookingId,
    amendmentId: resolved.amendmentId,
  };
  const idempotencyKey = `booking_amended_${resolved.amendmentId}`;
  await tx
    .insert(outboxEvents)
    .values({
      organizationId: resolved.organizationId,
      aggregateType: BOOKING_AMENDED_AGGREGATE_TYPE,
      aggregateId: resolved.bookingId,
      eventType: BOOKING_AMENDED_EVENT_TYPE,
      eventVersion: BOOKING_AMENDED_EVENT_VERSION,
      payload: outboxPayload,
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: [outboxEvents.idempotencyKey] });
  const existingOutbox = await tx
    .select({
      organizationId: outboxEvents.organizationId,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      eventType: outboxEvents.eventType,
      eventVersion: outboxEvents.eventVersion,
      payload: outboxEvents.payload,
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.idempotencyKey, idempotencyKey))
    .limit(1);
  const outboxRow = existingOutbox[0];
  if (
    !outboxRow ||
    outboxRow.organizationId !== resolved.organizationId ||
    outboxRow.aggregateType !== BOOKING_AMENDED_AGGREGATE_TYPE ||
    outboxRow.aggregateId !== resolved.bookingId ||
    outboxRow.eventType !== BOOKING_AMENDED_EVENT_TYPE ||
    outboxRow.eventVersion !== BOOKING_AMENDED_EVENT_VERSION ||
    !isBookingAmendedPayload(outboxRow.payload, outboxPayload)
  ) {
    throw invariant('La clé idempotente BOOKING_AMENDED.v1 référence un payload incompatible.');
  }
}

export async function handleSupplementPaymentWebhook(
  tx: DatabaseTransaction,
  resolved: ResolvedAmendmentAttempt,
  event: VerifiedWebhookEvent,
  piData: PaymentIntentEventData,
  webhookEventId: string,
  environment: 'TEST' | 'LIVE',
  nowOverride?: Date,
): Promise<SupplementWebhookOutcome> {
  return withInvariantHandling(tx, webhookEventId, async (sp) => {
    await lockOrganization(sp, resolved.organizationId);
    const rows = await lockSupplementRows(sp, resolved);
    validateResolvedRows(resolved, rows);

    const webhookRow = await lockWebhookEvent(sp, webhookEventId);
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
    if (webhookRow.status === 'MISSING') {
      throw invariant('Événement webhook introuvable lors du traitement du supplément.');
    }

    assertProviderAuthority(resolved, rows, piData, environment);
    if (rows.payment.status !== rows.attempt.status) {
      throw invariant('Le paiement et la tentative de supplément sont incohérents.');
    }
    const now = nowOverride === undefined ? new Date() : new Date(nowOverride.getTime());
    const expectedStatuses: Record<string, string> = {
      'payment_intent.succeeded': 'succeeded',
      'payment_intent.requires_action': 'requires_action',
      'payment_intent.processing': 'processing',
      'payment_intent.payment_failed': 'requires_payment_method',
      'payment_intent.canceled': 'canceled',
    };
    if (expectedStatuses[event.type] !== piData.status) {
      throw invariant('Le statut du PaymentIntent ne correspond pas au type de webhook.');
    }

    let successOutcome: SupplementLateSuccessOutcome | undefined;
    if (event.type === 'payment_intent.succeeded') {
      const paymentTerminal = isTerminalStatus(rows.payment.status);
      const attemptTerminal = isTerminalStatus(rows.attempt.status);
      if (paymentTerminal !== attemptTerminal) {
        throw invariant(
          'Le paiement et la tentative de supplément ont des terminalités différentes.',
        );
      }
      if (paymentTerminal) {
        // Une projection terminale existante gagne contre un webhook livré en
        // désordre ; aucune transition terminale ne peut régresser.
        if (
          rows.payment.status === 'SUCCEEDED' &&
          (rows.amendment.status === 'EXPIRED' ||
            rows.amendment.status === 'CANCELLED' ||
            (rows.amendment.holdDeadline !== null &&
              now.getTime() >= rows.amendment.holdDeadline.getTime()))
        ) {
          await compensateAmendmentPayment(sp, {
            organizationId: resolved.organizationId,
            bookingId: resolved.bookingId,
            amendmentId: resolved.amendmentId,
            amendmentPaymentId: resolved.amendmentPaymentId,
            now,
          });
        }
      } else {
        const result = await applySupplement(sp, resolved, rows, now, piData.id);
        if (result !== undefined) {
          successOutcome = result;
          await compensateAmendmentPayment(sp, {
            organizationId: resolved.organizationId,
            bookingId: resolved.bookingId,
            amendmentId: resolved.amendmentId,
            amendmentPaymentId: resolved.amendmentPaymentId,
            now,
          });
          console.warn(
            JSON.stringify({
              event: 'webhook.stripe',
              result: successOutcome.kind,
            }),
          );
        }
      }
    } else if (event.type === 'payment_intent.requires_action') {
      const projection = projectSupplementPaymentStatus(event.type, rows.payment.status);
      if (projection.ignored) {
        await markEventProcessed(sp, webhookEventId);
        return;
      }
      await sp
        .update(amendmentPayments)
        .set({ status: 'REQUIRES_ACTION', updatedAt: now })
        .where(eq(amendmentPayments.id, rows.payment.id));
      await sp
        .update(amendmentPaymentAttempts)
        .set({
          status: 'REQUIRES_ACTION',
          providerPaymentIntentId: piData.id,
          providerStatus: piData.status,
          updatedAt: now,
        })
        .where(eq(amendmentPaymentAttempts.id, rows.attempt.id));
    } else if (event.type === 'payment_intent.processing') {
      const projection = projectSupplementPaymentStatus(event.type, rows.payment.status);
      if (projection.ignored) {
        await markEventProcessed(sp, webhookEventId);
        return;
      }
      await sp
        .update(amendmentPayments)
        .set({ status: 'PROCESSING', updatedAt: now })
        .where(eq(amendmentPayments.id, rows.payment.id));
      await sp
        .update(amendmentPaymentAttempts)
        .set({
          status: 'PROCESSING',
          providerPaymentIntentId: piData.id,
          providerStatus: piData.status,
          updatedAt: now,
        })
        .where(eq(amendmentPaymentAttempts.id, rows.attempt.id));
    } else if (event.type === 'payment_intent.payment_failed') {
      const projection = projectSupplementPaymentStatus(event.type, rows.payment.status);
      if (projection.ignored) {
        await markEventProcessed(sp, webhookEventId);
        return;
      }
      await sp
        .update(amendmentPayments)
        .set({ status: 'FAILED', failedAt: now, updatedAt: now })
        .where(eq(amendmentPayments.id, rows.payment.id));
      await sp
        .update(amendmentPaymentAttempts)
        .set({
          status: 'FAILED',
          providerPaymentIntentId: piData.id,
          providerStatus: piData.status,
          updatedAt: now,
        })
        .where(eq(amendmentPaymentAttempts.id, rows.attempt.id));
    } else if (event.type === 'payment_intent.canceled') {
      const projection = projectSupplementPaymentStatus(event.type, rows.payment.status);
      if (projection.ignored) {
        await markEventProcessed(sp, webhookEventId);
        return;
      }
      await releaseSupplementHoldRows(sp, rows, now);
      await sp
        .update(bookingAmendments)
        .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
        .where(eq(bookingAmendments.id, rows.amendment.id));
      await sp
        .update(amendmentPayments)
        .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
        .where(eq(amendmentPayments.id, rows.payment.id));
      await sp
        .update(amendmentPaymentAttempts)
        .set({
          status: 'CANCELLED',
          providerPaymentIntentId: piData.id,
          providerStatus: piData.status,
          updatedAt: now,
        })
        .where(eq(amendmentPaymentAttempts.id, rows.attempt.id));
    }

    await markEventProcessed(sp, webhookEventId);
    return successOutcome;
  });
}
