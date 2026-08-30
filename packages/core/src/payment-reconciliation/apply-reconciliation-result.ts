/**
 * @uttily/core — Application d'un résultat de réconciliation (Phase 7A, ADR-010 §12).
 *
 * Ouvre une nouvelle transaction, verrouille les lignes métier, vérifie le
 * lease (fencing token atomique), mappe le résultat provider vers PaymentIntentEventData,
 * et dispatche vers la transition métier appropriée.
 *
 * Aucun appel Stripe n'est effectué dans cette transaction.
 */

import { eq, sql } from 'drizzle-orm';
import {
  paymentAttempts,
  payments,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import type { PaymentIntentResult, StripeEnvironment } from '../payments/types';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { TERMINAL_ATTEMPT_STATUSES } from '../webhook-handler/types';
import { projectAttemptStatus } from '../webhook-handler/project-status';
import {
  lockFullBusinessRows,
  lockPaymentAttemptRows,
  applyBookingConfirmation,
  applyCancellation,
  applyProcessingProjection,
  applyLateCompensation,
} from '../payment-transitions';
import { isDraftTerminalForConversion } from '../webhook-handler/confirm-booking';
import { PAYMENT_PROTOCOL_VERSION } from '../payment-initiation/types';
import { ReconciliationError } from './errors';
import { RECONCILIATION_BACKOFF_INTERVAL } from './scheduling';
import type { ClaimedAttempt, ReconciliationOutcome } from './types';

/**
 * Construit un ResolvedAttempt depuis un ClaimedAttempt.
 */
function toResolvedAttempt(claimed: ClaimedAttempt): ResolvedAttempt {
  return {
    attemptId: claimed.attemptId,
    paymentId: claimed.paymentId,
    draftId: claimed.draftId,
    organizationId: claimed.organizationId,
    attemptNumber: claimed.attemptNumber,
    attemptStatus: claimed.attemptStatus,
    paymentStatus: '',
    draftStatus: '',
    providerPaymentIntentId: claimed.providerPaymentIntentId,
  };
}

/**
 * Mappe un PaymentIntentResult vers PaymentIntentEventData en utilisant le
 * snapshot ClaimedAttempt pour les metadata.
 */
function mapProviderResultToEventData(
  providerResult: PaymentIntentResult,
  claimed: ClaimedAttempt,
): PaymentIntentEventData {
  const data: PaymentIntentEventData = {
    id: providerResult.id,
    status: providerResult.status,
    amount: providerResult.amountMinor,
    currency: providerResult.currency,
    metadata: {
      payment_id: claimed.paymentId,
      payment_attempt_id: claimed.attemptId,
      draft_id: claimed.draftId,
      organization_id: claimed.organizationId,
      protocol_version: PAYMENT_PROTOCOL_VERSION,
    },
    applicationFeeAmount: providerResult.applicationFeeAmountMinor,
    onBehalfOfAccountId: providerResult.onBehalfOfAccountId,
  };
  if (providerResult.connectedAccountId !== null) {
    data.destination = providerResult.connectedAccountId;
  }
  return data;
}

/**
 * Vérifie que le résultat provider est compatible avec le snapshot claimed.
 *
 * P1-5 : valide TOUTES les autorités financières (montant, devise, PI ID,
 * environnement, compte connecté, commission, on_behalf_of) avant toute
 * mutation ou appel provider destructif.
 */
export function validateProviderResultCompatibility(
  providerResult: PaymentIntentResult,
  claimed: ClaimedAttempt,
): void {
  if (providerResult.amountMinor !== claimed.amountMinor) {
    throw new ReconciliationError(
      'PROVIDER_RESULT_INCOMPATIBLE',
      `PROVIDER_RESULT_INCOMPATIBLE: Le montant du provider (${providerResult.amountMinor}) ne correspond pas au snapshot (${claimed.amountMinor}).`,
    );
  }
  if (providerResult.currency.toUpperCase() !== claimed.currency.toUpperCase()) {
    throw new ReconciliationError(
      'PROVIDER_RESULT_INCOMPATIBLE',
      `PROVIDER_RESULT_INCOMPATIBLE: La devise du provider (${providerResult.currency}) ne correspond pas au snapshot (${claimed.currency}).`,
    );
  }
  if (
    claimed.providerPaymentIntentId !== null &&
    providerResult.id !== claimed.providerPaymentIntentId
  ) {
    throw new ReconciliationError(
      'PROVIDER_RESULT_INCOMPATIBLE',
      `PROVIDER_RESULT_INCOMPATIBLE: L'ID du PaymentIntent du provider (${providerResult.id}) ne correspond pas au snapshot (${claimed.providerPaymentIntentId}).`,
    );
  }
  // P1-5 : validation des autorités financières complètes.
  if (providerResult.environment !== claimed.environment) {
    throw new ReconciliationError(
      'PROVIDER_AUTHORITY_MISMATCH',
      `PROVIDER_AUTHORITY_MISMATCH: L'environnement du provider (${providerResult.environment}) ne correspond pas au snapshot (${claimed.environment}).`,
    );
  }
  if (providerResult.connectedAccountId !== claimed.connectedAccountId) {
    throw new ReconciliationError(
      'PROVIDER_AUTHORITY_MISMATCH',
      `PROVIDER_AUTHORITY_MISMATCH: Le connected_account_id du provider (${providerResult.connectedAccountId}) ne correspond pas au snapshot (${claimed.connectedAccountId}).`,
    );
  }
  const expectedFeeAmountMinor = claimed.marketplaceFeeSnapshot
    ? claimed.marketplaceFeeSnapshot.platformApplicationFeeAmountMinor
    : claimed.commissionAmountMinor;
  const expectedFee = expectedFeeAmountMinor === 0 ? null : expectedFeeAmountMinor;
  if (providerResult.applicationFeeAmountMinor !== expectedFee) {
    throw new ReconciliationError(
      'PROVIDER_AUTHORITY_MISMATCH',
      `PROVIDER_AUTHORITY_MISMATCH: L'application_fee du provider (${providerResult.applicationFeeAmountMinor}) ne correspond pas au snapshot (${expectedFee}).`,
    );
  }
  if (providerResult.onBehalfOfAccountId !== claimed.onBehalfOfAccountId) {
    throw new ReconciliationError(
      'PROVIDER_AUTHORITY_MISMATCH',
      `PROVIDER_AUTHORITY_MISMATCH: Le on_behalf_of du provider (${providerResult.onBehalfOfAccountId}) ne correspond pas au snapshot (${claimed.onBehalfOfAccountId}).`,
    );
  }
}

/**
 * Vérifie et maintient le lease de manière atomique (P1-2, P1-4).
 *
 * UPDATE conditionnel : seul le worker avec le bon token peut modifier.
 * Si 0 ligne modifiée → LEASE_LOST (un autre worker a pris la lease).
 */
async function verifyAndHoldLease(tx: DatabaseTransaction, claimed: ClaimedAttempt): Promise<void> {
  const result = await tx.execute(sql`
    UPDATE "payment_attempts"
    SET "updated_at" = transaction_timestamp()
    WHERE "id" = ${claimed.attemptId}
      AND "reconcile_lease_token" = ${claimed.leaseToken}::uuid
    RETURNING "id"
  `);
  if ((result as unknown as Array<{ id: string }>).length === 0) {
    throw new ReconciliationError(
      'LEASE_LOST',
      'LEASE_LOST: Le lease ne correspond plus — un autre worker a pris la lease.',
    );
  }
}

/**
 * Libère le lease (reconcile_lease_until = NULL, reconcile_lease_token = NULL).
 * Conditionné sur reconcile_lease_token : si 0 ligne, le lease a été pris
 * par un autre worker — ne rien faire (P1-2).
 */
async function releaseLease(tx: DatabaseTransaction, claimed: ClaimedAttempt): Promise<void> {
  await tx
    .update(paymentAttempts)
    .set({
      reconcileLeaseUntil: null,
      reconcileLeaseToken: null,
      reconcileAfter: null,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      sql`${paymentAttempts.id} = ${claimed.attemptId} AND ${paymentAttempts.reconcileLeaseToken} = ${claimed.leaseToken}::uuid`,
    );
}

/**
 * Replanifie (reconcile_after = now() + 5 min) et libère le lease.
 * Conditionné sur reconcile_lease_token (P1-2, P1-4).
 */
async function rescheduleAndReleaseLease(
  tx: DatabaseTransaction,
  claimed: ClaimedAttempt,
): Promise<void> {
  await tx
    .update(paymentAttempts)
    .set({
      reconcileAfter: sql`transaction_timestamp() + ${RECONCILIATION_BACKOFF_INTERVAL}`,
      reconcileLeaseUntil: null,
      reconcileLeaseToken: null,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      sql`${paymentAttempts.id} = ${claimed.attemptId} AND ${paymentAttempts.reconcileLeaseToken} = ${claimed.leaseToken}::uuid`,
    );
}

/**
 * Applique un résultat de réconciliation dans une nouvelle transaction.
 *
 * Étapes :
 * 1. lockOrganization (via lockFullBusinessRows ou lockPaymentAttemptRows).
 * 2. Vérifier le lease atomiquement (fencing token).
 * 3. Mapper providerResult → PaymentIntentEventData.
 * 4. Dispatcher par providerResult.status.
 * 5. Sur succès : release lease, et si replanifié, set reconcile_after.
 *
 * @param db Client base de données.
 * @param claimed Tentative revendiquée avec snapshot.
 * @param providerResult Résultat du provider (retrieve ou create).
 * @param environment Environnement Stripe.
 * @returns ReconciliationOutcome.
 */
export async function applyReconciliationResult(
  db: DatabaseClient,
  claimed: ClaimedAttempt,
  providerResult: PaymentIntentResult,
  environment: StripeEnvironment,
): Promise<ReconciliationOutcome> {
  // Valider la compatibilité du résultat provider avec le snapshot (P1-5).
  validateProviderResultCompatibility(providerResult, claimed);

  const attempt = toResolvedAttempt(claimed);
  const piData = mapProviderResultToEventData(providerResult, claimed);

  switch (providerResult.status) {
    case 'succeeded': {
      return await db.transaction(async (tx) => {
        // Verrouiller les lignes métier complètes (draft → blocks → allocs → payment → attempt).
        const lockedRows = await lockFullBusinessRows(tx, attempt);

        // Vérifier le lease atomiquement (fencing token, P1-4).
        await verifyAndHoldLease(tx, claimed);

        // Vérifier si le draft est terminal → compensation.
        if (isDraftTerminalForConversion(lockedRows.draft.status)) {
          await applyLateCompensation(tx, attempt, piData, environment, {
            payment: lockedRows.payment,
            attemptRow: lockedRows.attemptRow,
          });
          await releaseLease(tx, claimed);
          return { kind: 'compensated' };
        }

        // Confirmation de réservation.
        const result = await applyBookingConfirmation(tx, attempt, piData, environment, lockedRows);
        await releaseLease(tx, claimed);
        return { kind: 'confirmed', bookingId: result.bookingId };
      });
    }

    case 'canceled': {
      return await db.transaction(async (tx) => {
        const lockedRows = await lockFullBusinessRows(tx, attempt);
        await verifyAndHoldLease(tx, claimed);
        await applyCancellation(tx, attempt, piData, environment, lockedRows);
        await releaseLease(tx, claimed);
        return { kind: 'cancelled' };
      });
    }

    case 'processing': {
      return await db.transaction(async (tx) => {
        const lockedRows = await lockPaymentAttemptRows(tx, attempt);
        await verifyAndHoldLease(tx, claimed);
        await applyProcessingProjection(tx, attempt, piData, environment, lockedRows);
        // Reschedule: reconcile_after = now() + 5 min, release lease.
        await rescheduleAndReleaseLease(tx, claimed);
        return { kind: 'rescheduled' };
      });
    }

    case 'requires_payment_method':
    case 'requires_action': {
      return await db.transaction(async (tx) => {
        // P1-2 : verrouiller payment + attempt pour recouper l'état courant.
        const { payment, attemptRow } = await lockPaymentAttemptRows(tx, attempt);

        // Vérifier le lease atomiquement (fencing token, P1-4).
        await verifyAndHoldLease(tx, claimed);

        // P1-2 : recouper l'ID courant — si un webhook a persisté un autre
        // identifiant entre le claim et l'apply, lever une erreur.
        if (
          attemptRow.providerPaymentIntentId !== null &&
          attemptRow.providerPaymentIntentId !== piData.id
        ) {
          throw new ReconciliationError(
            'PROVIDER_RESULT_INCOMPATIBLE',
            `PROVIDER_RESULT_INCOMPATIBLE: L'ID courant (${attemptRow.providerPaymentIntentId}) ne correspond pas à l'ID du provider (${piData.id}).`,
          );
        }

        // Comparer dans la transaction avec transaction_timestamp() pour éviter
        // une fenêtre de race (P2-2 : la décision now() hors transaction pouvait
        // être obsolète au moment de la mutation).
        const rows = await tx.execute(sql`
          SELECT transaction_timestamp() > ${claimed.processingDeadlineAt.toISOString()}::timestamptz AS is_past_deadline
        `);
        const isPastDeadline = (rows[0] as unknown as { is_past_deadline: boolean })
          .is_past_deadline;

        if (!isPastDeadline) {
          // Avant échéance : projection locale (P1-3) + persister le PI ID (P1-2)
          // et replanifier à processing_deadline_at, release lease.
          const now = sql`transaction_timestamp()`;

          // P1-3 : projection monotone du statut de tentative.
          // requires_payment_method → payment_intent.payment_failed → REQUIRES_PAYMENT_METHOD.
          // requires_action → payment_intent.requires_action → REQUIRES_ACTION.
          const eventType =
            providerResult.status === 'requires_payment_method'
              ? 'payment_intent.payment_failed'
              : 'payment_intent.requires_action';
          const projection = projectAttemptStatus(eventType, attemptRow.status);
          const newAttemptStatus = projection.newStatus;

          // P1-2 : inverser le COALESCE — utiliser l'ID existant s'il est
          // présent, sinon utiliser l'ID du provider.
          await tx
            .update(paymentAttempts)
            .set({
              ...(newAttemptStatus !== null
                ? {
                    status: newAttemptStatus as 'REQUIRES_PAYMENT_METHOD' | 'REQUIRES_ACTION',
                  }
                : {}),
              providerPaymentIntentId: sql`COALESCE("provider_payment_intent_id", ${piData.id})`,
              providerStatus: providerResult.status,
              reconcileAfter: claimed.processingDeadlineAt,
              reconcileLeaseUntil: null,
              reconcileLeaseToken: null,
              updatedAt: now,
            })
            .where(
              sql`${paymentAttempts.id} = ${claimed.attemptId} AND ${paymentAttempts.reconcileLeaseToken} = ${claimed.leaseToken}::uuid`,
            );

          // P1-3 : projection du statut de paiement (si pas déjà terminal).
          if (newAttemptStatus !== null) {
            const paymentTerminal = (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(
              payment.status,
            );
            if (!paymentTerminal) {
              await tx
                .update(payments)
                .set({
                  status: newAttemptStatus as 'REQUIRES_PAYMENT_METHOD' | 'REQUIRES_ACTION',
                  updatedAt: now,
                })
                .where(eq(payments.id, claimed.paymentId));
            }
          }

          return { kind: 'rescheduled' };
        }

        // Après échéance : nécessite une annulation hors transaction.
        // Aucune mutation n'a été faite dans cette tx — le commit est sûr.
        return { kind: 'needs_cancellation' };
      });
    }

    default:
      throw new ReconciliationError(
        'PROVIDER_STATE_UNKNOWN',
        `Statut provider inconnu: ${providerResult.status}`,
      );
  }
}
