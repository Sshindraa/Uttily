/**
 * @uttily/core — Exécution d'une compensation individuelle (Phase 8, ADR-010 §13).
 *
 * Exécute une compensation revendiquée en trois phases :
 * 1. Transaction de chargement et vérification (vérification précoce du lease,
 *    SELECT FOR UPDATE sur refund, payment, payment_attempt ; recoupement
 *    complet des autorités : métadonnées outbox, reason, montant/devise vs
 *    paiement, statut SUCCEEDED paiement + tentative, sélection déterministe
 *    de la tentative réussie). Commit.
 * 2. Appel Stripe `createRefund` HORS transaction avec la clé stable du
 *    refund (`refund.providerIdempotencyKey`), `reverse_transfer = true`,
 *    `refund_application_fee = true`. Validation fail-closed du résultat.
 * 3. Transaction de persistance : transition monotone (jamais de régression
 *    depuis un statut terminal projeté par le webhook), `provider_refund_id`,
 *    `status = SUBMITTED` (depuis PENDING uniquement), `submitted_at = now()`
 *    (si NULL). Marquer outbox `PROCESSED`.
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
    // P1-6 (fencing précoce) : vérifier le lease AVANT tout appel provider.
    // Si la lease a été perdue/reprise, ne jamais atteindre la Phase 2.
    // P2-1 : le contrôle inclut l'EXPIRATION — une lease expirée (reclaimable
    // par un autre worker à tout moment) est traitée comme LEASE_LOST, même
    // avec le bon token.
    const earlyLeaseRows = await tx.execute(sql`
      SELECT "id" FROM "outbox_events"
      WHERE "id" = ${claimed.outboxEventId}::uuid
        AND "lease_token" = ${claimed.leaseToken}::uuid
        AND "lease_until" > transaction_timestamp()
    `);
    if ((earlyLeaseRows as unknown as Array<{ id: string }>).length === 0) {
      throw new CompensationError(
        'LEASE_LOST',
        `Le lease ne correspond plus pour l'événement ${claimed.outboxEventId} — un autre worker a pris la lease.`,
      );
    }

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

    // P1-4 : Distinguer explicitement les statuts non-PENDING — un refund déjà
    // SUBMITTED/SUCCEEDED est un replay traité (outbox PROCESSED), un refund
    // déjà FAILED est un remboursement non abouti (échec durable + alerte).
    switch (refund.status) {
      case 'PENDING':
        break; // Seul statut éligible à la soumission.
      case 'SUBMITTED':
      case 'SUCCEEDED':
        throw new CompensationError(
          'REFUND_ALREADY_SUBMITTED',
          `Le refund ${refund.id} est déjà ${refund.status} — remboursement déjà soumis`,
        );
      case 'FAILED':
        throw new CompensationError(
          'REFUND_ALREADY_FAILED',
          `Le refund ${refund.id} est déjà FAILED — remboursement non abouti`,
        );
      default: {
        // Invariant explicite : l'union TypeScript refund_status est fermée
        // (PENDING/SUBMITTED/SUCCEEDED/FAILED) — tout autre statut est une
        // anomalie d'intégrité, jamais un cas à traiter silencieusement.
        const unexpected: never = refund.status;
        throw new Error(`Statut refund inattendu (invariant violé): ${String(unexpected)}`);
      }
    }

    // P2 : guard clause — reverse_transfer et refund_application_fee doivent
    // toujours être true pour LATE_PAYMENT_NO_BOOKING (ADR-010 §13). Un bug de
    // création ne doit pas propager des flags incorrects au retry.
    // Vérifié avant tout recoupement pour signaler durablement l'anomalie.
    if (!refund.reverseTransfer || !refund.refundApplicationFee) {
      throw new CompensationError(
        'REFUND_FLAGS_INVALID',
        `reverse_transfer ou refund_application_fee est false pour le refund ${refund.id}`,
      );
    }

    // P1-4 : Recouper les métadonnées de l'événement outbox contre le refund.
    if (
      claimed.aggregateType !== 'PAYMENT' ||
      claimed.aggregateId !== refund.paymentId ||
      claimed.eventVersion !== 'v1'
    ) {
      throw new CompensationError(
        'OUTBOX_METADATA_MISMATCH',
        `Métadonnées outbox incohérentes (aggregate_type=${claimed.aggregateType}, aggregate_id=${claimed.aggregateId}, event_version=${claimed.eventVersion}) pour le refund ${refund.id}`,
      );
    }

    // P1-4 : Le paymentId du payload outbox doit correspondre à celui du refund.
    if (claimed.paymentId !== refund.paymentId) {
      throw new CompensationError(
        'PAYMENT_ID_MISMATCH',
        `paymentId payload outbox (${claimed.paymentId}) ≠ refund (${refund.paymentId})`,
      );
    }

    // P1-4 : Seul un remboursement LATE_PAYMENT_NO_BOOKING est compensable.
    if (refund.reason !== 'LATE_PAYMENT_NO_BOOKING') {
      throw new CompensationError(
        'REFUND_REASON_MISMATCH',
        `Raison refund (${refund.reason}) ≠ LATE_PAYMENT_NO_BOOKING pour le refund ${refund.id}`,
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

    // P1-4 : On ne rembourse qu'un paiement réellement réussi.
    if (payment.status !== 'SUCCEEDED') {
      throw new CompensationError(
        'PAYMENT_NOT_SUCCEEDED',
        `Le paiement ${payment.id} n'est pas SUCCEEDED (statut: ${payment.status})`,
      );
    }

    // P1-4 : Sélection déterministe de la tentative réussie — statut SUCCEEDED,
    // provider_payment_intent_id non nul, ordre (created_at DESC, id DESC).
    const attemptRows = await tx
      .select({
        id: paymentAttempts.id,
        status: paymentAttempts.status,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
      })
      .from(paymentAttempts)
      .where(
        sql`${paymentAttempts.paymentId} = ${refund.paymentId} AND ${paymentAttempts.status} = 'SUCCEEDED' AND ${paymentAttempts.providerPaymentIntentId} IS NOT NULL`,
      )
      .orderBy(sql`${paymentAttempts.createdAt} DESC, ${paymentAttempts.id} DESC`)
      .limit(1);

    if (attemptRows.length === 0 || attemptRows[0]!.providerPaymentIntentId === null) {
      throw new CompensationError(
        'ATTEMPT_NOT_SUCCEEDED',
        `Aucun payment_attempt SUCCEEDED avec provider_payment_intent_id pour le paiement ${refund.paymentId}`,
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

    // P1-4 : Recouper le montant et la devise du refund contre le total du paiement.
    if (refund.amountMinor !== payment.amountMinor) {
      throw new CompensationError(
        'AMOUNT_MISMATCH',
        `Montant refund (${refund.amountMinor}) ≠ montant paiement (${payment.amountMinor})`,
      );
    }

    if (refund.currency !== payment.currency) {
      throw new CompensationError(
        'CURRENCY_MISMATCH',
        `Devise refund (${refund.currency}) ≠ devise paiement (${payment.currency})`,
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

  // ─── Phase 2 : Appel Stripe HORS transaction ───
  const result = await provider.createRefund({
    paymentIntentId: verification.paymentIntentId,
    amountMinor: verification.amountMinor,
    idempotencyKey: verification.idempotencyKey,
    reverseTransfer: verification.reverseTransfer,
    refundApplicationFee: verification.refundApplicationFee,
  });

  // P1-5 : Validation fail-closed du résultat fournisseur avant toute persistance.
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new CompensationError('PROVIDER_RESULT_INVALID', `provider_refund_id vide ou invalide`);
  }
  if (result.amountMinor !== verification.amountMinor) {
    throw new CompensationError(
      'PROVIDER_RESULT_INVALID',
      `Montant fournisseur (${result.amountMinor}) ≠ attendu (${verification.amountMinor})`,
    );
  }
  if (result.currency !== 'EUR') {
    throw new CompensationError(
      'PROVIDER_RESULT_INVALID',
      `Devise fournisseur (${result.currency}) ≠ EUR`,
    );
  }
  // P1-2 : requires_action est admissible — statut NON terminal, visible et
  // actionnable côté Stripe (RefundStatus le reconnaît, la projection webhook
  // le projette PENDING localement). Le refund a bien été soumis : il est
  // persisté SUBMITTED + provider_refund_id, et la projection webhook fait foi
  // pour le statut final (SUCCEEDED/FAILED).
  if (
    result.status !== 'pending' &&
    result.status !== 'succeeded' &&
    result.status !== 'requires_action'
  ) {
    throw new CompensationError(
      'PROVIDER_RESULT_INVALID',
      `Statut fournisseur inadmissible: ${result.status}`,
    );
  }

  // ─── Phase 3 : Transaction de persistance ───
  await db.transaction(async (tx) => {
    // Vérifier le lease : token + expiration (P2-1 — une lease expirée est
    // reclaimable par un autre worker, elle ne protège plus rien).
    const leaseRows = await tx.execute(sql`
      SELECT "id" FROM "outbox_events"
      WHERE "id" = ${claimed.outboxEventId}::uuid
        AND "lease_token" = ${claimed.leaseToken}::uuid
        AND "lease_until" > transaction_timestamp()
      FOR UPDATE
    `);

    if ((leaseRows as unknown as Array<{ id: string }>).length === 0) {
      throw new CompensationError(
        'LEASE_LOST',
        `Le lease ne correspond plus pour l'événement ${claimed.outboxEventId} — un autre worker a pris la lease.`,
      );
    }

    // P1-2 : Re-verrouiller le refund — le webhook a pu le projeter entre
    // createRefund et cette transaction (rattachement P1-1 du webhook).
    const lockedRefundRows = await tx.execute(sql`
      SELECT "id", "status", "provider_refund_id", "submitted_at"
      FROM "refunds"
      WHERE "id" = ${verification.refundId}::uuid
      FOR UPDATE
    `);
    const lockedRefund = (
      lockedRefundRows as unknown as Array<{
        id: string;
        status: string;
        provider_refund_id: string | null;
        submitted_at: Date | null;
      }>
    )[0];

    if (!lockedRefund) {
      throw new CompensationError(
        'REFUND_NOT_FOUND',
        `Refund ${verification.refundId} introuvable en Phase 3`,
      );
    }

    // P1-2 : Conflit d'attribution — un autre provider_refund_id a déjà été
    // persisté pour ce remboursement (anomalie durable).
    if (lockedRefund.provider_refund_id !== null && lockedRefund.provider_refund_id !== result.id) {
      throw new CompensationError(
        'PROVIDER_REFUND_ID_CONFLICT',
        `provider_refund_id existant (${lockedRefund.provider_refund_id}) ≠ résultat fournisseur (${result.id}) pour le refund ${verification.refundId}`,
      );
    }

    // P1-2 : Transition monotone — jamais de régression depuis un statut terminal.
    // Si le webhook a déjà projeté SUCCEEDED/FAILED, ne pas écraser le statut ;
    // persister seulement provider_refund_id s'il est encore NULL.
    // Ne jamais toucher submitted_at s'il est déjà set.
    const TERMINAL_REFUND_STATUSES = new Set(['SUCCEEDED', 'FAILED']);
    if (TERMINAL_REFUND_STATUSES.has(lockedRefund.status)) {
      if (lockedRefund.provider_refund_id === null) {
        await tx.execute(sql`
          UPDATE "refunds"
          SET "provider_refund_id" = ${result.id},
              "updated_at" = transaction_timestamp()
          WHERE "id" = ${verification.refundId}::uuid
        `);
      }
      // Statut terminal déjà projeté : rien d'autre à persister sur le refund.
      // Ne pas déclarer SUCCEEDED — c'est le webhook qui l'a fait.
    } else {
      // PENDING ou SUBMITTED : transition monotone vers SUBMITTED.
      // - provider_refund_id : seulement si encore NULL (COALESCE).
      // - status : PENDING → SUBMITTED ; un SUBMITTED reste SUBMITTED.
      // - submitted_at : seulement si NULL (COALESCE).
      await tx.execute(sql`
        UPDATE "refunds"
        SET "provider_refund_id" = COALESCE("provider_refund_id", ${result.id}),
            "status" = CASE
              WHEN "status" = 'PENDING' THEN 'SUBMITTED'::refund_status
              ELSE "status"
            END,
            "submitted_at" = COALESCE("submitted_at", transaction_timestamp()),
            "updated_at" = transaction_timestamp()
        WHERE "id" = ${verification.refundId}::uuid
          AND "status" NOT IN ('SUCCEEDED', 'FAILED')
      `);
    }

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
