/**
 * @uttily/core — Exécution d'une compensation individuelle (Phase 8, ADR-010 §13).
 *
 * Exécute une compensation revendiquée en trois phases :
 * 1. Transaction de chargement et vérification (SELECT FOR UPDATE sur refund,
 *    payment, payment_attempt). Commit.
 * 2. Appel Stripe `createRefund` HORS transaction avec la clé stable du
 *    refund (`refund.providerIdempotencyKey`), `reverse_transfer = true`,
 *    `refund_application_fee = true`.
 * 3. Transaction de persistance : `provider_refund_id`, `status = SUBMITTED`,
 *    `submitted_at = now()`. Marquer outbox `PROCESSED`.
 *
 * Ne déclare JAMAIS le refund `SUCCEEDED` — c'est le webhook qui le fait.
 * Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL.
 */

import { eq, sql } from 'drizzle-orm';
import { refunds, payments, paymentAttempts } from '@uttily/database';
import type { StripeEnvironment } from '../payments/types';
import { CompensationError } from './errors';
import type { CompensationDependencies, ClaimedCompensation } from './types';

/**
 * Exécute une compensation individuelle.
 *
 * @param deps Dépendances (db + provider).
 * @param claimed Événement revendiqué avec lease.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @throws CompensationError sur incohérence ou lease perdue.
 */
export async function executeCompensation(
  deps: CompensationDependencies,
  claimed: ClaimedCompensation,
  environment: StripeEnvironment,
): Promise<void> {
  const { db, provider } = deps;

  // ─── Phase 1 : Transaction de chargement et vérification ───
  const verification = await db.transaction(async (tx) => {
    // Charger et verrouiller le refund par provider_idempotency_key.
    const refundRows = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.providerIdempotencyKey, claimed.refundIdempotencyKey))
      .for('update');

    if (refundRows.length === 0) {
      throw new CompensationError(
        'REFUND_NOT_FOUND',
        `Refund introuvable pour la clé d'idempotence ${claimed.refundIdempotencyKey}`,
      );
    }

    const refund = refundRows[0]!;

    // Si le refund n'est plus PENDING, il a déjà été soumis (replay).
    if (refund.status !== 'PENDING') {
      throw new CompensationError(
        'REFUND_ALREADY_SUBMITTED',
        `Le refund ${refund.id} n'est plus PENDING (statut: ${refund.status})`,
      );
    }

    // Charger et verrouiller le paiement.
    const paymentRows = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, refund.paymentId))
      .for('update');

    if (paymentRows.length === 0) {
      throw new CompensationError('PAYMENT_NOT_FOUND', `Paiement ${refund.paymentId} introuvable`);
    }

    const payment = paymentRows[0]!;

    // Récupérer le payment_attempt pour provider_payment_intent_id.
    const attemptRows = await tx
      .select({
        id: paymentAttempts.id,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
      })
      .from(paymentAttempts)
      .where(
        sql`${paymentAttempts.paymentId} = ${refund.paymentId} AND ${paymentAttempts.providerPaymentIntentId} IS NOT NULL`,
      )
      .limit(1);

    if (attemptRows.length === 0 || attemptRows[0]!.providerPaymentIntentId === null) {
      throw new CompensationError(
        'PAYMENT_INTENT_MISSING',
        `Aucun payment_attempt avec provider_payment_intent_id pour le paiement ${refund.paymentId}`,
      );
    }

    const paymentIntentId = attemptRows[0]!.providerPaymentIntentId;

    // Vérifications de cohérence.
    if (refund.amountMinor !== claimed.amountMinor) {
      throw new CompensationError(
        'AMOUNT_MISMATCH',
        `Montant refund (${refund.amountMinor}) ≠ payload outbox (${claimed.amountMinor})`,
      );
    }

    if (refund.currency !== claimed.currency) {
      throw new CompensationError(
        'CURRENCY_MISMATCH',
        `Devise refund (${refund.currency}) ≠ payload outbox (${claimed.currency})`,
      );
    }

    if (payment.organizationId !== claimed.organizationId) {
      throw new CompensationError(
        'ORGANIZATION_MISMATCH',
        `Organisation paiement (${payment.organizationId}) ≠ payload outbox (${claimed.organizationId})`,
      );
    }

    if (payment.environment !== environment) {
      throw new CompensationError(
        'ENVIRONMENT_MISMATCH',
        `Environnement paiement (${payment.environment}) ≠ attendu (${environment})`,
      );
    }

    return {
      refundId: refund.id,
      paymentIntentId,
      amountMinor: refund.amountMinor,
      idempotencyKey: refund.providerIdempotencyKey,
      reverseTransfer: refund.reverseTransfer,
      refundApplicationFee: refund.refundApplicationFee,
    };
  });

  // P2 : guard clause — reverse_transfer et refund_application_fee doivent
  // toujours être true pour LATE_PAYMENT_NO_BOOKING (ADR-010 §13). Un bug de
  // création ne doit pas propager des flags incorrects au retry.
  if (!verification.reverseTransfer || !verification.refundApplicationFee) {
    throw new CompensationError(
      'REFUND_FLAGS_INVALID',
      `reverse_transfer ou refund_application_fee est false pour le refund ${verification.refundId}`,
    );
  }

  // ─── Phase 2 : Appel Stripe HORS transaction ───
  const result = await provider.createRefund({
    paymentIntentId: verification.paymentIntentId,
    amountMinor: verification.amountMinor,
    idempotencyKey: verification.idempotencyKey,
    reverseTransfer: verification.reverseTransfer,
    refundApplicationFee: verification.refundApplicationFee,
  });

  // ─── Phase 3 : Transaction de persistance ───
  await db.transaction(async (tx) => {
    // Vérifier le lease : UPDATE conditionnel sur lease_token.
    const leaseRows = await tx.execute(sql`
      SELECT "id" FROM "outbox_events"
      WHERE "id" = ${claimed.outboxEventId}::uuid
        AND "lease_token" = ${claimed.leaseToken}::uuid
      FOR UPDATE
    `);

    if ((leaseRows as unknown as Array<{ id: string }>).length === 0) {
      throw new CompensationError(
        'LEASE_LOST',
        `Le lease ne correspond plus pour l'événement ${claimed.outboxEventId} — un autre worker a pris la lease.`,
      );
    }

    // Persister le refund : provider_refund_id, status = SUBMITTED, submitted_at.
    // Ne pas déclarer SUCCEEDED — c'est le webhook qui le fera.
    await tx
      .update(refunds)
      .set({
        providerRefundId: result.id,
        status: 'SUBMITTED',
        submittedAt: sql`transaction_timestamp()`,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(eq(refunds.id, verification.refundId));

    // Marquer l'outbox PROCESSED : processed_at, lease_token = NULL, lease_until = NULL.
    await tx.execute(sql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSED',
          "processed_at" = transaction_timestamp(),
          "lease_token" = NULL,
          "lease_until" = NULL
      WHERE "id" = ${claimed.outboxEventId}::uuid
    `);
  });
}
