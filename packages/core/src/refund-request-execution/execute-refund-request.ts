import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookingCancellations,
  bookings,
  paymentAttempts,
  payments,
  refunds,
  type DatabaseClient,
} from '@uttily/database';
import { parseRefundRequestedEvent, type RefundRequestedEvent } from '@uttily/contracts';
import type { PaymentProviderAdapter, StripeEnvironment } from '../payments/types';
import { RefundRequestError } from './errors';
import type {
  ClaimedRefundRequest,
  RefundRequestExecutionResult,
  RefundRequestVerification,
} from './types';

const TERMINAL_REFUND_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED_REQUIRES_MANUAL_ACTION',
  'SETTLED_OFF_PLATFORM',
]);

function parseClaimedEvent(claimed: ClaimedRefundRequest): RefundRequestedEvent {
  if (!claimed.payloadValid) {
    throw new RefundRequestError('PAYLOAD_MALFORMED', 'Payload REFUND_REQUESTED invalide');
  }
  try {
    return parseRefundRequestedEvent({
      aggregateType: claimed.aggregateType,
      eventType: claimed.eventType,
      eventVersion: claimed.eventVersion,
      aggregateId: claimed.aggregateId,
      payload: claimed.payload,
    });
  } catch {
    throw new RefundRequestError('PAYLOAD_MALFORMED', 'Payload REFUND_REQUESTED invalide');
  }
}

function assertLeaseRows(rows: unknown[], code: 'LEASE_LOST') {
  if (rows.length === 0) {
    throw new RefundRequestError(code, 'Événement outbox non détenu');
  }
}

function assertNoMarketplaceFeeSnapshot(snapshot: unknown, context: string): void {
  if (snapshot !== null && snapshot !== undefined) {
    throw new RefundRequestError(
      'SPLIT_REFUND_UNRESOLVED',
      `Remboursement split refusé : snapshot marketplace présent sur ${context}`,
    );
  }
}

function containsMarketplaceFeeSnapshot(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'marketplaceFeeSnapshot' in value &&
    (value as { marketplaceFeeSnapshot?: unknown }).marketplaceFeeSnapshot !== null &&
    (value as { marketplaceFeeSnapshot?: unknown }).marketplaceFeeSnapshot !== undefined
  );
}

/** Pre-call validation transaction; acquires row locks on outbox, refund, payment, attempt. */
export async function verifyRefundRequest(
  db: DatabaseClient,
  claimed: ClaimedRefundRequest,
  environment: StripeEnvironment,
): Promise<RefundRequestVerification | { alreadyResolved: true }> {
  const event = parseClaimedEvent(claimed);

  return await db.transaction(async (tx) => {
    const outboxRows = await tx.execute(sql`
      SELECT id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload
      FROM "outbox_events"
      WHERE id = ${claimed.outboxEventId}::uuid
        AND lease_token = ${claimed.leaseToken}::uuid
        AND lease_until > transaction_timestamp()
      FOR UPDATE
    `);
    const outbox = (
      outboxRows as unknown as Array<{
        id: string;
        organization_id: string;
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        event_version: string;
        payload: unknown;
      }>
    )[0];
    assertLeaseRows(outboxRows as unknown as unknown[], 'LEASE_LOST');
    if (outbox === undefined) {
      throw new RefundRequestError('LEASE_LOST', 'Événement outbox non détenu');
    }

    let authoritativeEvent: RefundRequestedEvent;
    try {
      authoritativeEvent = parseRefundRequestedEvent({
        aggregateType: outbox.aggregate_type,
        eventType: outbox.event_type,
        eventVersion: outbox.event_version,
        aggregateId: outbox.aggregate_id,
        payload: outbox.payload,
      });
    } catch {
      throw new RefundRequestError('PAYLOAD_MALFORMED', 'Payload outbox invalide');
    }

    if (
      outbox.id !== claimed.outboxEventId ||
      outbox.organization_id !== event.payload.organizationId ||
      outbox.organization_id !== authoritativeEvent.payload.organizationId ||
      authoritativeEvent.aggregateId !== event.payload.refundId ||
      authoritativeEvent.payload.bookingId !== event.payload.bookingId ||
      authoritativeEvent.payload.refundId !== event.payload.refundId
    ) {
      throw new RefundRequestError('OUTBOX_METADATA_MISMATCH', 'Métadonnées outbox incohérentes');
    }

    const refundRows = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.id, authoritativeEvent.payload.refundId))
      .for('update');
    const refund = refundRows[0];
    if (refund === undefined) {
      throw new RefundRequestError('REFUND_NOT_FOUND', 'Refund introuvable');
    }
    if (refund.organizationId !== outbox.organization_id) {
      throw new RefundRequestError(
        'REFUND_ORGANIZATION_MISMATCH',
        'Organisation refund incohérente',
      );
    }

    if (refund.status !== 'PENDING') {
      if (
        refund.status === 'SUBMITTED' ||
        refund.status === 'SUCCEEDED' ||
        refund.status === 'FAILED_REQUIRES_MANUAL_ACTION' ||
        refund.status === 'SETTLED_OFF_PLATFORM'
      ) {
        await tx.execute(sql`
          UPDATE "outbox_events"
          SET status = 'PROCESSED', processed_at = transaction_timestamp(), lease_token = NULL, lease_until = NULL
          WHERE id = ${claimed.outboxEventId}::uuid AND lease_token = ${claimed.leaseToken}::uuid
        `);
        return { alreadyResolved: true as const };
      }
      throw new RefundRequestError('REFUND_STATUS_INVALID', 'Refund non éligible');
    }

    if (!Number.isSafeInteger(refund.amountMinor) || refund.amountMinor <= 0) {
      throw new RefundRequestError('AMOUNT_INVALID', 'Montant refund invalide');
    }
    if (refund.currency !== 'EUR') {
      throw new RefundRequestError('PAYMENT_CURRENCY_MISMATCH', 'Devise refund non supportée');
    }
    if (!refund.reverseTransfer || !refund.refundApplicationFee) {
      throw new RefundRequestError(
        'REFUND_FLAGS_INVALID',
        'reverseTransfer et refundApplicationFee doivent être à true',
      );
    }

    // Standardisation de la clé d'idempotence : accepte refund_<id> ou legacy refund_amendment_<id>
    const expectedStandardKey = `refund_${refund.id}`;
    const expectedLegacyKey = `refund_amendment_${refund.id}`;
    if (
      refund.providerIdempotencyKey !== expectedStandardKey &&
      refund.providerIdempotencyKey !== expectedLegacyKey
    ) {
      throw new RefundRequestError('IDEMPOTENCY_KEY_MISMATCH', 'Clé refund incohérente');
    }

    let origin: 'BOOKING_AMENDMENT' | 'AMENDMENT_COMPENSATION' | 'BOOKING_CANCELLATION';
    if (authoritativeEvent.eventVersion === 'v1') {
      if (refund.reason === 'AMENDMENT_COMPENSATION') {
        origin = 'AMENDMENT_COMPENSATION';
      } else {
        origin = 'BOOKING_AMENDMENT';
      }
    } else {
      origin = authoritativeEvent.payload.origin;
    }

    let providerPaymentIntentId: string;

    if (origin === 'BOOKING_CANCELLATION') {
      const cancellationPayload = authoritativeEvent.payload as {
        cancellationId: string;
      };

      if (
        refund.reason !== 'CUSTOMER_CANCELLATION' &&
        refund.reason !== 'MERCHANT_CANCELLATION' &&
        refund.reason !== 'PLATFORM_CANCELLATION'
      ) {
        throw new RefundRequestError(
          'REFUND_REASON_MISMATCH',
          'Raison refund non éligible pour annulation',
        );
      }

      if (refund.paymentId === null || refund.amendmentPaymentId !== null) {
        throw new RefundRequestError(
          'REFUND_PAYMENT_ORIGIN_INVALID',
          'Origine paiement refund incohérente',
        );
      }

      const paymentRows = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, refund.paymentId))
        .for('update');
      const payment = paymentRows[0];
      if (payment === undefined) {
        throw new RefundRequestError('PAYMENT_NOT_FOUND', 'Paiement introuvable');
      }
      if (payment.organizationId !== refund.organizationId) {
        throw new RefundRequestError(
          'PAYMENT_ORGANIZATION_MISMATCH',
          'Organisation paiement incohérente',
        );
      }
      if (payment.status !== 'SUCCEEDED') {
        throw new RefundRequestError('PAYMENT_NOT_SUCCEEDED', 'Paiement initial non réussi');
      }
      if (payment.currency !== 'EUR') {
        throw new RefundRequestError('PAYMENT_CURRENCY_MISMATCH', 'Devise paiement non supportée');
      }
      if (payment.environment !== environment) {
        throw new RefundRequestError('ENVIRONMENT_MISMATCH', 'Environnement paiement incohérent');
      }

      // Vérification de la réservation annulée
      const bookingRows = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, authoritativeEvent.payload.bookingId))
        .for('update');
      const booking = bookingRows[0];
      if (booking === undefined) {
        throw new RefundRequestError('BOOKING_NOT_FOUND', 'Réservation introuvable');
      }
      if (booking.status !== 'CANCELLED') {
        throw new RefundRequestError(
          'REFUND_STATUS_INVALID',
          'La réservation doit être au statut CANCELLED pour exécuter le remboursement d’annulation',
        );
      }

      // Vérification de la trace d'annulation
      const cancellationRows = await tx
        .select()
        .from(bookingCancellations)
        .where(eq(bookingCancellations.id, cancellationPayload.cancellationId))
        .for('update');
      const cancellation = cancellationRows[0];
      if (cancellation === undefined) {
        throw new RefundRequestError('CANCELLATION_NOT_FOUND', 'Trace d’annulation introuvable');
      }
      if (
        cancellation.organizationId !== refund.organizationId ||
        cancellation.bookingId !== authoritativeEvent.payload.bookingId ||
        cancellation.refundId !== refund.id
      ) {
        throw new RefundRequestError(
          'OUTBOX_METADATA_MISMATCH',
          'Incohérence trace d’annulation / remboursement',
        );
      }

      const hasSplitSnapshot =
        payment.marketplaceFeeSnapshot !== null && payment.marketplaceFeeSnapshot !== undefined;
      if (hasSplitSnapshot) {
        // ADR-030: Seul le remboursement intégral d'annulation (100%) est exécutable directement par Stripe
        // avec reverseTransfer=true et refundApplicationFee=true (destination charge).
        // Un remboursement partiel split reste en FAILED_REQUIRES_MANUAL_ACTION (ADR-030 §3.2).
        const isFullRefund = refund.amountMinor === cancellation.grossPaidMinor;
        if (!isFullRefund) {
          throw new RefundRequestError(
            'SPLIT_REFUND_UNRESOLVED',
            'Remboursement partiel split requiert une résolution manuelle (ADR-030 §3.2)',
          );
        }
      }

      const attemptRows = await tx
        .select({
          id: paymentAttempts.id,
          providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.paymentId, payment.id),
            eq(paymentAttempts.organizationId, payment.organizationId),
            eq(paymentAttempts.status, 'SUCCEEDED'),
            isNotNull(paymentAttempts.providerPaymentIntentId),
          ),
        )
        .orderBy(sql`${paymentAttempts.createdAt} DESC, ${paymentAttempts.id} DESC`)
        .limit(1)
        .for('update');
      const attempt = attemptRows[0];
      if (attempt === undefined || attempt.providerPaymentIntentId === null) {
        throw new RefundRequestError(
          'ATTEMPT_NOT_SUCCEEDED',
          'Tentative paiement réussie introuvable',
        );
      }
      providerPaymentIntentId = attempt.providerPaymentIntentId;
    } else if (origin === 'BOOKING_AMENDMENT') {
      const amendmentPayload = authoritativeEvent.payload as {
        amendmentId: string;
      };

      if (refund.reason !== 'BOOKING_MODIFICATION') {
        throw new RefundRequestError('REFUND_REASON_MISMATCH', 'Raison refund non éligible');
      }

      if (refund.paymentId === null || refund.amendmentPaymentId !== null) {
        throw new RefundRequestError(
          'REFUND_PAYMENT_ORIGIN_INVALID',
          'Origine paiement refund incohérente',
        );
      }

      const paymentRows = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, refund.paymentId))
        .for('update');
      const payment = paymentRows[0];
      if (payment === undefined)
        throw new RefundRequestError('PAYMENT_NOT_FOUND', 'Paiement introuvable');
      if (payment.organizationId !== refund.organizationId) {
        throw new RefundRequestError(
          'PAYMENT_ORGANIZATION_MISMATCH',
          'Organisation paiement incohérente',
        );
      }
      if (payment.status !== 'SUCCEEDED') {
        throw new RefundRequestError('PAYMENT_NOT_SUCCEEDED', 'Paiement initial non réussi');
      }
      if (payment.currency !== 'EUR') {
        throw new RefundRequestError('PAYMENT_CURRENCY_MISMATCH', 'Devise paiement non supportée');
      }
      if (payment.environment !== environment) {
        throw new RefundRequestError('ENVIRONMENT_MISMATCH', 'Environnement paiement incohérent');
      }
      assertNoMarketplaceFeeSnapshot(payment.marketplaceFeeSnapshot, 'le paiement');

      const amendmentRows = await tx
        .select()
        .from(bookingAmendments)
        .where(eq(bookingAmendments.id, amendmentPayload.amendmentId))
        .for('update');
      const amendment = amendmentRows[0];
      if (amendment === undefined) {
        throw new RefundRequestError('AMENDMENT_NOT_FOUND', 'Amendment introuvable');
      }
      if (
        amendment.organizationId !== refund.organizationId ||
        amendment.bookingId !== authoritativeEvent.payload.bookingId ||
        amendment.type !== 'REFUND' ||
        amendment.status !== 'APPLIED'
      ) {
        throw new RefundRequestError('AMENDMENT_MISMATCH', 'Amendment incohérent');
      }
      if (
        containsMarketplaceFeeSnapshot(amendment.financialSnapshotBefore) ||
        containsMarketplaceFeeSnapshot(amendment.financialSnapshotAfter)
      ) {
        throw new RefundRequestError(
          'SPLIT_REFUND_UNRESOLVED',
          'Remboursement split refusé : snapshot marketplace présent sur l’amendement',
        );
      }

      const attemptRows = await tx
        .select({
          id: paymentAttempts.id,
          providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.paymentId, payment.id),
            eq(paymentAttempts.organizationId, payment.organizationId),
            eq(paymentAttempts.status, 'SUCCEEDED'),
            isNotNull(paymentAttempts.providerPaymentIntentId),
          ),
        )
        .orderBy(sql`${paymentAttempts.createdAt} DESC, ${paymentAttempts.id} DESC`)
        .limit(1)
        .for('update');
      const attempt = attemptRows[0];
      if (attempt === undefined || attempt.providerPaymentIntentId === null) {
        throw new RefundRequestError(
          'ATTEMPT_NOT_SUCCEEDED',
          'Tentative paiement réussie introuvable',
        );
      }
      providerPaymentIntentId = attempt.providerPaymentIntentId;
    } else {
      // AMENDMENT_COMPENSATION
      const compensationPayload = authoritativeEvent.payload as {
        amendmentId: string;
      };

      if (refund.reason !== 'AMENDMENT_COMPENSATION') {
        throw new RefundRequestError('REFUND_REASON_MISMATCH', 'Raison refund non éligible');
      }

      if (refund.paymentId !== null || refund.amendmentPaymentId === null) {
        throw new RefundRequestError(
          'REFUND_PAYMENT_ORIGIN_INVALID',
          'Origine paiement refund incohérente',
        );
      }

      const amendmentPaymentRows = await tx
        .select()
        .from(amendmentPayments)
        .where(eq(amendmentPayments.id, refund.amendmentPaymentId))
        .for('update');
      const amendmentPayment = amendmentPaymentRows[0];
      if (amendmentPayment === undefined)
        throw new RefundRequestError('PAYMENT_NOT_FOUND', 'Paiement d’amendement introuvable');
      if (amendmentPayment.organizationId !== refund.organizationId) {
        throw new RefundRequestError(
          'PAYMENT_ORGANIZATION_MISMATCH',
          'Organisation paiement incohérente',
        );
      }
      if (
        amendmentPayment.amendmentId !== compensationPayload.amendmentId ||
        amendmentPayment.bookingId !== authoritativeEvent.payload.bookingId
      ) {
        throw new RefundRequestError(
          'AMENDMENT_MISMATCH',
          'Liaison amendement/réservation du paiement incohérente avec le payload',
        );
      }
      if (amendmentPayment.status !== 'SUCCEEDED') {
        throw new RefundRequestError('PAYMENT_NOT_SUCCEEDED', 'Paiement d’amendement non réussi');
      }
      if (amendmentPayment.currency !== refund.currency || amendmentPayment.currency !== 'EUR') {
        throw new RefundRequestError(
          'PAYMENT_CURRENCY_MISMATCH',
          'Devise paiement non supportée ou mismatch refund',
        );
      }
      if (amendmentPayment.amountMinor !== refund.amountMinor) {
        throw new RefundRequestError('AMOUNT_INVALID', 'Montant du refund différent du paiement');
      }
      if (amendmentPayment.environment !== environment) {
        throw new RefundRequestError('ENVIRONMENT_MISMATCH', 'Environnement paiement incohérent');
      }
      assertNoMarketplaceFeeSnapshot(
        amendmentPayment.marketplaceFeeDeltaSnapshot,
        'le paiement d’amendement',
      );

      const amendmentRows = await tx
        .select()
        .from(bookingAmendments)
        .where(eq(bookingAmendments.id, compensationPayload.amendmentId))
        .for('update');
      const amendment = amendmentRows[0];
      if (amendment === undefined) {
        throw new RefundRequestError('AMENDMENT_NOT_FOUND', 'Amendment introuvable');
      }
      if (
        amendment.organizationId !== refund.organizationId ||
        amendment.bookingId !== authoritativeEvent.payload.bookingId ||
        amendment.type !== 'SUPPLEMENT'
      ) {
        throw new RefundRequestError('AMENDMENT_MISMATCH', 'Amendment incohérent');
      }

      if (amendment.status === 'APPLIED') {
        throw new RefundRequestError(
          'AMENDMENT_MISMATCH',
          'Amendement déjà appliqué, compensation refusée',
        );
      }

      const asOfRows = await tx.execute(sql`SELECT transaction_timestamp() AS as_of`);
      const asOf = new Date((asOfRows[0] as unknown as { as_of: Date | string }).as_of);
      const isExpiredOrCancelled =
        amendment.status === 'EXPIRED' || amendment.status === 'CANCELLED';
      const isPastHoldDeadline =
        amendment.holdDeadline !== null && asOf.getTime() >= amendment.holdDeadline.getTime();

      if (!isExpiredOrCancelled && !isPastHoldDeadline) {
        throw new RefundRequestError(
          'AMENDMENT_MISMATCH',
          'Amendement actif avant sa deadline non éligible pour compensation',
        );
      }

      const attemptRows = await tx
        .select({
          id: amendmentPaymentAttempts.id,
          providerPaymentIntentId: amendmentPaymentAttempts.providerPaymentIntentId,
        })
        .from(amendmentPaymentAttempts)
        .where(
          and(
            eq(amendmentPaymentAttempts.amendmentPaymentId, amendmentPayment.id),
            eq(amendmentPaymentAttempts.organizationId, amendmentPayment.organizationId),
            eq(amendmentPaymentAttempts.status, 'SUCCEEDED'),
            isNotNull(amendmentPaymentAttempts.providerPaymentIntentId),
          ),
        )
        .orderBy(
          sql`${amendmentPaymentAttempts.createdAt} DESC, ${amendmentPaymentAttempts.id} DESC`,
        )
        .limit(1)
        .for('update');
      const attempt = attemptRows[0];
      if (
        attempt === undefined ||
        attempt.providerPaymentIntentId === null ||
        attempt.providerPaymentIntentId.trim() === ''
      ) {
        throw new RefundRequestError(
          'ATTEMPT_NOT_SUCCEEDED',
          'Tentative paiement d’amendement réussie introuvable',
        );
      }
      providerPaymentIntentId = attempt.providerPaymentIntentId;
    }

    return {
      refundId: refund.id,
      paymentIntentId: providerPaymentIntentId,
      amountMinor: refund.amountMinor,
      idempotencyKey: refund.providerIdempotencyKey,
      organizationId: refund.organizationId,
      reverseTransfer: refund.reverseTransfer,
      refundApplicationFee: refund.refundApplicationFee,
    };
  });
}

/** Execute one claimed event; provider call is deliberately outside both transactions. */
export async function executeRefundRequest(
  deps: { db: DatabaseClient; provider: PaymentProviderAdapter },
  claimed: ClaimedRefundRequest,
  environment: StripeEnvironment,
): Promise<RefundRequestExecutionResult> {
  const verification = await verifyRefundRequest(deps.db, claimed, environment);
  if ('alreadyResolved' in verification) return { outcome: 'already_resolved' };

  const result = await deps.provider.createRefund({
    paymentIntentId: verification.paymentIntentId,
    amountMinor: verification.amountMinor,
    idempotencyKey: verification.idempotencyKey,
    reverseTransfer: verification.reverseTransfer,
    refundApplicationFee: verification.refundApplicationFee,
    metadata: {
      refund_id: verification.refundId,
      organization_id: verification.organizationId,
      protocol_version: 'refund-requested-v2',
    },
  });

  if (
    typeof result.id !== 'string' ||
    result.id.length === 0 ||
    result.amountMinor !== verification.amountMinor ||
    typeof result.currency !== 'string' ||
    result.currency.toUpperCase() !== 'EUR' ||
    !['pending', 'requires_action', 'succeeded'].includes(result.status)
  ) {
    throw new RefundRequestError('PROVIDER_RESULT_INVALID', 'Résultat refund provider invalide');
  }

  return await deps.db.transaction(async (tx) => {
    const leaseRows = await tx.execute(sql`
      SELECT id FROM "outbox_events"
      WHERE id = ${claimed.outboxEventId}::uuid
        AND lease_token = ${claimed.leaseToken}::uuid
        AND lease_until > transaction_timestamp()
      FOR UPDATE
    `);
    assertLeaseRows(leaseRows as unknown as unknown[], 'LEASE_LOST');

    const refundRows = await tx
      .select({
        id: refunds.id,
        status: refunds.status,
        providerRefundId: refunds.providerRefundId,
      })
      .from(refunds)
      .where(eq(refunds.id, verification.refundId))
      .for('update');
    const refund = refundRows[0];
    if (refund === undefined)
      throw new RefundRequestError('REFUND_NOT_FOUND', 'Refund introuvable');
    if (refund.providerRefundId !== null && refund.providerRefundId !== result.id) {
      throw new RefundRequestError('PROVIDER_REFUND_ID_CONFLICT', 'Provider refund déjà attribué');
    }

    if (!TERMINAL_REFUND_STATUSES.has(refund.status)) {
      await tx.execute(sql`
        UPDATE "refunds"
        SET provider_refund_id = COALESCE(provider_refund_id, ${result.id}),
            status = CASE WHEN status = 'PENDING' THEN 'SUBMITTED'::refund_status ELSE status END,
            submitted_at = COALESCE(submitted_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
        WHERE id = ${verification.refundId}::uuid
          AND status NOT IN ('SUCCEEDED', 'FAILED_REQUIRES_MANUAL_ACTION', 'SETTLED_OFF_PLATFORM')
      `);
    } else if (refund.providerRefundId === null) {
      await tx.execute(sql`
        UPDATE "refunds"
        SET provider_refund_id = ${result.id}, updated_at = transaction_timestamp()
        WHERE id = ${verification.refundId}::uuid
      `);
    }

    const outboxRows = await tx.execute(sql`
      UPDATE "outbox_events"
      SET status = 'PROCESSED', processed_at = transaction_timestamp(), lease_token = NULL, lease_until = NULL
      WHERE id = ${claimed.outboxEventId}::uuid AND lease_token = ${claimed.leaseToken}::uuid
      RETURNING id
    `);
    assertLeaseRows(outboxRows as unknown as unknown[], 'LEASE_LOST');
    return {
      outcome: TERMINAL_REFUND_STATUSES.has(refund.status) ? 'already_resolved' : 'submitted',
    };
  });
}
