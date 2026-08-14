/**
 * @uttily/core — Use case interne de compensation atomique d'un supplément (G7M-C4-B).
 *
 * Crée atomiquement le remboursement (refunds) et l'événement outbox associé
 * (REFUND_REQUESTED.v1) dans la même transaction que la projection
 * financière du webhook C3 lorsqu'un paiement de supplément réussit après la
 * deadline de hold ou sur un amendement déjà expiré.
 *
 * Invariants :
 * - Aucun appel Stripe dans cette transaction (l'exécution du refund est déléguée
 *   au moteur outbox REFUND_REQUESTED.v1).
 * - Verrouillage conforme à ADR-023 (lockOrganization puis bookings → bookingAmendments → amendmentPayments).
 * - Éligibilité stricte : amendement SUPPLEMENT non appliqué et (EXPIRED/CANCELLED ou holdDeadline <= now).
 * - Insertion idempotente et rejeu strict du refund et de l'outbox REFUND_REQUESTED.v1.
 * - Respect strict de l'invariant financier ADR-023 §11.2 après commit.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  amendmentPayments,
  bookingAmendments,
  bookings,
  lockOrganization,
  outboxEvents,
  refunds,
  type DatabaseTransaction,
} from '@uttily/database';
import {
  REFUND_REQUESTED_AGGREGATE_TYPE,
  REFUND_REQUESTED_EVENT_TYPE,
  REFUND_REQUESTED_EVENT_VERSION,
  parseRefundRequestedV1Event,
} from '@uttily/contracts';

export interface CompensateAmendmentPaymentInput {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
  readonly amendmentPaymentId: string;
  /** Horloge optionnelle (sinon transaction_timestamp() est utilisé). */
  readonly now?: Date;
}

export type CompensateAmendmentPaymentResult =
  | {
      readonly kind: 'COMPENSATION_CREATED';
      readonly refundId: string;
      readonly outboxEventId: string;
      readonly amountMinor: number;
    }
  | {
      readonly kind: 'ALREADY_COMPENSATED';
      readonly refundId: string;
      readonly amountMinor: number;
    };

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Horloge PostgreSQL invalide.');
  return date;
}

async function captureNow(tx: DatabaseTransaction, override: Date | undefined): Promise<Date> {
  if (override !== undefined) {
    if (!Number.isFinite(override.getTime())) throw new Error('now invalide.');
    return new Date(override.getTime());
  }
  const rows = await tx.execute(sql`SELECT transaction_timestamp() AS now`);
  const value = (rows[0] as unknown as { now: Date | string } | undefined)?.now;
  if (value === undefined) throw new Error('Horloge PostgreSQL absente.');
  return toDate(value);
}

/**
 * Crée atomiquement le refund de compensation et l'événement outbox associé.
 * Doit être exécuté à l'intérieur d'une transaction PostgreSQL active.
 */
export async function compensateAmendmentPayment(
  tx: DatabaseTransaction,
  input: CompensateAmendmentPaymentInput,
): Promise<CompensateAmendmentPaymentResult> {
  await lockOrganization(tx, input.organizationId);
  const now = await captureNow(tx, input.now);

  // 1. Verrouiller les lignes dans l'ordre canonique ADR-023
  const bookingRows = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.organizationId, input.organizationId)))
    .for('update')
    .limit(1);
  const booking = bookingRows[0];
  if (!booking) {
    throw new Error('Réservation introuvable pour la compensation du supplément.');
  }

  const amendmentRows = await tx
    .select()
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.id, input.amendmentId),
        eq(bookingAmendments.bookingId, input.bookingId),
        eq(bookingAmendments.organizationId, input.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const amendment = amendmentRows[0];
  if (!amendment) {
    throw new Error('Amendement introuvable pour la compensation du supplément.');
  }

  // Éligibilité stricte : SUPPLEMENT non appliqué et dépassé / expiré
  if (amendment.type !== 'SUPPLEMENT') {
    throw new Error(
      'Seuls les amendements SUPPLEMENT peuvent faire l’objet d’une compensation de supplément.',
    );
  }
  if (amendment.status === 'APPLIED') {
    throw new Error(
      'Un amendement APPLIED ne peut pas faire l’objet d’une compensation de supplément.',
    );
  }

  const isExpiredOrCancelled = amendment.status === 'EXPIRED' || amendment.status === 'CANCELLED';
  const isPastHoldDeadline =
    amendment.holdDeadline !== null && now.getTime() >= amendment.holdDeadline.getTime();

  if (!isExpiredOrCancelled && !isPastHoldDeadline) {
    throw new Error(
      'La compensation de supplément est refusée : l’amendement est actif avant sa deadline.',
    );
  }

  const paymentRows = await tx
    .select()
    .from(amendmentPayments)
    .where(
      and(
        eq(amendmentPayments.id, input.amendmentPaymentId),
        eq(amendmentPayments.amendmentId, input.amendmentId),
        eq(amendmentPayments.bookingId, input.bookingId),
        eq(amendmentPayments.organizationId, input.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  const payment = paymentRows[0];
  if (!payment) {
    throw new Error('Paiement d’amendement introuvable pour la compensation.');
  }
  if (payment.status !== 'SUCCEEDED') {
    throw new Error('Le paiement de supplément doit être SUCCEEDED pour être compensé.');
  }
  if (!Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0) {
    throw new Error('Montant du paiement de supplément invalide pour la compensation.');
  }
  if (payment.currency !== 'EUR') {
    throw new Error('Devise du paiement de supplément non supportée.');
  }

  // 2. Vérifier si un refund AMENDMENT_COMPENSATION existe déjà pour cet amendment_payment
  const existingRefunds = await tx
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.amendmentPaymentId, input.amendmentPaymentId),
        eq(refunds.organizationId, input.organizationId),
        eq(refunds.reason, 'AMENDMENT_COMPENSATION'),
      ),
    )
    .for('update');

  if (existingRefunds.length > 1) {
    throw new Error('Plusieurs refunds de compensation détectés pour cet amendement.');
  }

  if (existingRefunds.length === 1) {
    const existingRefund = existingRefunds[0]!;
    if (
      existingRefund.paymentId !== null ||
      existingRefund.amendmentPaymentId !== input.amendmentPaymentId ||
      existingRefund.organizationId !== input.organizationId ||
      existingRefund.reason !== 'AMENDMENT_COMPENSATION' ||
      existingRefund.amountMinor !== payment.amountMinor ||
      existingRefund.currency !== payment.currency ||
      existingRefund.reverseTransfer !== true ||
      existingRefund.refundApplicationFee !== true ||
      existingRefund.providerIdempotencyKey !== `refund_amendment_${existingRefund.id}`
    ) {
      throw new Error('Incohérence détectée sur le refund de compensation existant.');
    }

    // Vérifier l'outbox associé de manière stricte
    const outboxRows = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, input.organizationId),
          eq(outboxEvents.aggregateType, REFUND_REQUESTED_AGGREGATE_TYPE),
          eq(outboxEvents.aggregateId, existingRefund.id),
        ),
      )
      .for('update');

    if (outboxRows.length !== 1) {
      throw new Error('Outbox event manquant ou multiple pour le refund de compensation existant.');
    }

    const outbox = outboxRows[0]!;
    if (
      outbox.organizationId !== input.organizationId ||
      outbox.aggregateType !== REFUND_REQUESTED_AGGREGATE_TYPE ||
      outbox.aggregateId !== existingRefund.id ||
      outbox.eventType !== REFUND_REQUESTED_EVENT_TYPE ||
      outbox.eventVersion !== REFUND_REQUESTED_EVENT_VERSION ||
      outbox.idempotencyKey !== `refund_requested_${existingRefund.id}`
    ) {
      throw new Error('Métadonnées outbox incohérentes avec le refund de compensation existant.');
    }

    let parsedEvent;
    try {
      parsedEvent = parseRefundRequestedV1Event({
        aggregateType: outbox.aggregateType,
        eventType: outbox.eventType,
        eventVersion: outbox.eventVersion,
        aggregateId: outbox.aggregateId,
        payload: outbox.payload,
      });
    } catch {
      throw new Error('Payload outbox incompatible avec le refund de compensation existant.');
    }

    if (
      parsedEvent.payload.organizationId !== input.organizationId ||
      parsedEvent.payload.bookingId !== input.bookingId ||
      parsedEvent.payload.amendmentId !== input.amendmentId ||
      parsedEvent.payload.refundId !== existingRefund.id ||
      parsedEvent.aggregateId !== existingRefund.id
    ) {
      throw new Error('Payload outbox incompatible avec le refund de compensation existant.');
    }

    return {
      kind: 'ALREADY_COMPENSATED',
      refundId: existingRefund.id,
      amountMinor: existingRefund.amountMinor,
    };
  }

  // 3. Créer le nouveau refund AMENDMENT_COMPENSATION
  const refundId = crypto.randomUUID();
  const providerIdempotencyKey = `refund_amendment_${refundId}`;
  const outboxIdempotencyKey = `refund_requested_${refundId}`;

  await tx.insert(refunds).values({
    id: refundId,
    organizationId: input.organizationId,
    paymentId: null,
    amendmentPaymentId: input.amendmentPaymentId,
    reason: 'AMENDMENT_COMPENSATION',
    status: 'PENDING',
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    reverseTransfer: true,
    refundApplicationFee: true,
    requestedAt: now,
    providerIdempotencyKey,
  });

  // 4. Insérer l'événement outbox REFUND_REQUESTED.v1
  const outboxRows = await tx
    .insert(outboxEvents)
    .values({
      organizationId: input.organizationId,
      aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
      aggregateId: refundId,
      eventType: REFUND_REQUESTED_EVENT_TYPE,
      eventVersion: REFUND_REQUESTED_EVENT_VERSION,
      payload: {
        organizationId: input.organizationId,
        bookingId: input.bookingId,
        amendmentId: input.amendmentId,
        refundId,
      },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      idempotencyKey: outboxIdempotencyKey,
    })
    .returning({ id: outboxEvents.id });

  const outboxEventId = outboxRows[0]?.id;
  if (!outboxEventId) {
    throw new Error('Échec de l’insertion de l’événement outbox de compensation.');
  }

  return {
    kind: 'COMPENSATION_CREATED',
    refundId,
    outboxEventId,
    amountMinor: payment.amountMinor,
  };
}
