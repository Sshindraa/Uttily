/**
 * @uttily/core — Orchestrateur de réconciliation par batch (Phase 7A, ADR-010 §12).
 *
 * Orchestre la réconciliation d'un batch de tentatives de paiement :
 * 1. Valide batchLimit.
 * 2. Revendique un batch (claimReconciliationBatch).
 * 3. Pour chaque tentative revendiquée :
 *    a. Si providerPaymentIntentId existe → retrievePaymentIntent.
 *    b. Si providerPaymentIntentId est null ET statut PENDING_PROVIDER → replay createPaymentIntent.
 *    c. applyReconciliationResult.
 *    d. Si outcome = needs_cancellation → cancelPaymentIntent HORS transaction,
 *       puis applyCancellation dans une nouvelle transaction.
 * 4. Sur erreur technique ou invariant : tx rollback, ouvrir tx de récupération,
 *    release + reschedule, enregistrer anomaly.
 *
 * Aucun appel Stripe n'est effectué sous transaction PostgreSQL.
 */

import { sql } from 'drizzle-orm';
import { paymentAttempts, type DatabaseClient } from '@uttily/database';
import type {
  PaymentProviderAdapter,
  PaymentIntentResult,
  CreatePaymentIntentParams,
} from '../payments/types';
import { PaymentProviderError } from '../payments/errors';
import { PAYMENT_PROTOCOL_VERSION } from '../payment-initiation/types';
import type { PaymentIntentEventData } from '../webhook-handler/types';
import { lockFullBusinessRows, applyCancellation } from '../payment-transitions';
import { ReconciliationError } from './errors';
import {
  validateBatchLimit,
  DEFAULT_BATCH_LIMIT,
  RECONCILIATION_BACKOFF_INTERVAL,
} from './scheduling';
import { claimReconciliationBatch } from './claim-reconciliation-batch';
import { applyReconciliationResult } from './apply-reconciliation-result';
import type {
  ReconciliationDependencies,
  ReconciliationOptions,
  ReconciliationBatchResult,
  ClaimedAttempt,
  ReconciliationOutcome,
} from './types';

/**
 * Reconstruit les paramètres de création de PaymentIntent depuis le snapshot.
 */
function rebuildCreateParams(claimed: ClaimedAttempt): CreatePaymentIntentParams {
  return {
    amountMinor: claimed.amountMinor,
    currency: 'EUR',
    connectedAccountId: claimed.connectedAccountId,
    applicationFeeAmountMinor:
      claimed.commissionAmountMinor === 0 ? null : claimed.commissionAmountMinor,
    onBehalfOfAccountId: claimed.onBehalfOfAccountId,
    idempotencyKey: claimed.providerIdempotencyKey,
    metadata: {
      payment_id: claimed.paymentId,
      payment_attempt_id: claimed.attemptId,
      draft_id: claimed.draftId,
      organization_id: claimed.organizationId,
      protocol_version: PAYMENT_PROTOCOL_VERSION,
    },
  };
}

/**
 * Libère le lease et replanifie dans une transaction de récupération.
 * P1-2 : conditionne l'UPDATE sur reconcile_lease_token pour ne pas effacer
 * le lease d'un autre worker.
 */
async function releaseAndReschedule(db: DatabaseClient, claimed: ClaimedAttempt): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(paymentAttempts)
        .set({
          reconcileLeaseUntil: null,
          reconcileLeaseToken: null,
          reconcileAfter: sql`transaction_timestamp() + ${RECONCILIATION_BACKOFF_INTERVAL}`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          sql`${paymentAttempts.id} = ${claimed.attemptId} AND ${paymentAttempts.reconcileLeaseToken} = ${claimed.leaseToken}::uuid`,
        );
    });
  } catch {
    // Best-effort : si la tx de récupération échoue, le lease expirera naturellement.
  }
}

/**
 * Orchestre la réconciliation d'un batch de tentatives de paiement.
 *
 * @param deps Dépendances (db + provider).
 * @param options Options (batchLimit + environment).
 * @returns Résultat agrégé du batch.
 */
export async function reconcilePaymentsBatch(
  deps: ReconciliationDependencies,
  options: ReconciliationOptions,
): Promise<ReconciliationBatchResult> {
  const batchLimit = validateBatchLimit(options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const { db, provider } = deps;
  const environment = options.environment;

  // P1-5 : vérifier que l'adapter provider correspond à l'environnement demandé
  // avant tout appel provider. Un adapter LIVE mal câblé ne doit jamais traiter
  // un paiement TEST (et inversement).
  if (provider.environment !== environment) {
    throw new ReconciliationError(
      'PROVIDER_ENVIRONMENT_MISMATCH',
      `L'adapter provider (${provider.environment}) ne correspond pas à l'environnement demandé (${environment}).`,
    );
  }

  // 1. Revendiquer un batch (filtré par environnement, P1-3).
  const claimedAttempts = await claimReconciliationBatch(db, batchLimit, environment);

  const result: ReconciliationBatchResult = {
    claimedCount: claimedAttempts.length,
    reconciledCount: 0,
    confirmedCount: 0,
    cancelledCount: 0,
    rescheduledCount: 0,
    compensationRequestedCount: 0,
    anomalyCount: 0,
    anomalies: [],
  };

  // 2. Traiter chaque tentative revendiquée.
  for (const claimed of claimedAttempts) {
    try {
      // a. Appel provider HORS transaction.
      let providerResult: PaymentIntentResult;
      if (claimed.providerPaymentIntentId !== null) {
        // PI existant → retrieve.
        providerResult = await provider.retrievePaymentIntent(claimed.providerPaymentIntentId);
      } else if (claimed.attemptStatus === 'PENDING_PROVIDER') {
        // PENDING_PROVIDER sans PI → vérifier l'âge de la clé (P1-4).
        // isKeyExpired est calculé côté PostgreSQL avec transaction_timestamp()
        // dans la transaction de claim (23h, marge de sécurité de 1h).
        if (claimed.isKeyExpired) {
          console.warn(
            JSON.stringify({
              event: 'reconciliation.key_expired',
              attemptId: claimed.attemptId,
              code: 'KEY_EXPIRED',
            }),
          );
          await releaseAndReschedule(db, claimed);
          result.anomalyCount++;
          result.anomalies.push({ attemptId: claimed.attemptId, code: 'KEY_EXPIRED' });
          continue;
        }
        // PENDING_PROVIDER → replay create avec même clé.
        const createParams = rebuildCreateParams(claimed);
        providerResult = await provider.createPaymentIntent(createParams);
      } else {
        // P1-5 : attempt sans PI mais pas PENDING_PROVIDER → anomalie.
        // Ne pas appeler le provider.
        console.warn(
          JSON.stringify({
            event: 'reconciliation.missing_pi_anomaly',
            attemptId: claimed.attemptId,
            attemptStatus: claimed.attemptStatus,
            code: 'INVARIANT_BROKEN',
          }),
        );
        await releaseAndReschedule(db, claimed);
        result.anomalyCount++;
        result.anomalies.push({ attemptId: claimed.attemptId, code: 'INVARIANT_BROKEN' });
        continue;
      }

      // c. Appliquer le résultat.
      const outcome = await applyReconciliationResult(db, claimed, providerResult, environment);

      // d. Si needs_cancellation → cancel HORS transaction, puis applyCancellation.
      if (outcome.kind === 'needs_cancellation') {
        await handleCancellationFlow(db, provider, claimed, providerResult, environment, result);
      } else {
        countOutcome(outcome, result);
        result.reconciledCount++;
      }
    } catch (error) {
      // 4. Sur erreur technique ou invariant : la tx apply a rollbacké.
      // Ouvrir une tx de récupération : release + reschedule (P1-2 : conditionnel sur token).
      console.warn(
        JSON.stringify({
          event: 'reconciliation.error',
          attemptId: claimed.attemptId,
          code: error instanceof ReconciliationError ? error.code : 'INVARIANT_BROKEN',
        }),
      );
      await releaseAndReschedule(db, claimed);
      result.anomalyCount++;
      const code = error instanceof ReconciliationError ? error.code : 'INVARIANT_BROKEN';
      result.anomalies.push({ attemptId: claimed.attemptId, code });
    }
  }

  return result;
}

/**
 * Gère le flux d'annulation : cancelPaymentIntent HORS transaction,
 * puis applyCancellation dans une nouvelle transaction.
 *
 * P1-5 : les autorités financières sont validées par applyReconciliationResult
 * (validateProviderResultCompatibility) avant l'appel cancelPaymentIntent.
 */
async function handleCancellationFlow(
  db: DatabaseClient,
  provider: PaymentProviderAdapter,
  claimed: ClaimedAttempt,
  providerResult: PaymentIntentResult,
  environment: 'TEST' | 'LIVE',
  result: ReconciliationBatchResult,
): Promise<void> {
  try {
    // Cancel HORS transaction.
    // Clé d'idempotency stable dérivée de l'attemptId (jamais une nouvelle clé).
    // Si la réconciliation demande l'annulation plusieurs fois pour la même tentative,
    // Stripe retournera le même résultat (idempotent).
    const cancelResult = await provider.cancelPaymentIntent({
      id: providerResult.id,
      idempotencyKey: `cancel_${claimed.attemptId}`,
    });

    if (cancelResult.status === 'canceled') {
      // Appliquer l'annulation dans une nouvelle transaction.
      const piData: PaymentIntentEventData = {
        id: cancelResult.id,
        status: cancelResult.status,
        amount: cancelResult.amountMinor,
        currency: cancelResult.currency,
        metadata: {
          payment_id: claimed.paymentId,
          payment_attempt_id: claimed.attemptId,
          draft_id: claimed.draftId,
          organization_id: claimed.organizationId,
          protocol_version: PAYMENT_PROTOCOL_VERSION,
        },
        applicationFeeAmount: cancelResult.applicationFeeAmountMinor,
        onBehalfOfAccountId: cancelResult.onBehalfOfAccountId,
      };
      if (cancelResult.connectedAccountId !== null) {
        piData.destination = cancelResult.connectedAccountId;
      }

      const attempt = {
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

      try {
        await db.transaction(async (tx) => {
          const lockedRows = await lockFullBusinessRows(tx, attempt);
          // P1-4 : vérification atomique du lease via UPDATE conditionnel.
          const leaseRows = await tx.execute(sql`
            UPDATE "payment_attempts"
            SET "updated_at" = transaction_timestamp()
            WHERE "id" = ${claimed.attemptId}
              AND "reconcile_lease_token" = ${claimed.leaseToken}::uuid
            RETURNING "id"
          `);
          if ((leaseRows as unknown as Array<{ id: string }>).length === 0) {
            throw new ReconciliationError(
              'LEASE_LOST',
              "Le lease ne correspond plus lors de l'annulation.",
            );
          }
          await applyCancellation(tx, attempt, piData, environment, lockedRows);
          // Release lease (conditionnel sur token, P1-2).
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
        });
        result.cancelledCount++;
        result.reconciledCount++;
      } catch (error) {
        // L'annulation Stripe a réussi mais l'apply a échoué.
        await releaseAndReschedule(db, claimed);
        result.anomalyCount++;
        const code = error instanceof ReconciliationError ? error.code : 'INVARIANT_BROKEN';
        result.anomalies.push({ attemptId: claimed.attemptId, code });
      }
    } else {
      // Le cancel n'a pas donné canceled (ex: succeeded entre-temps).
      // Libérer le lease et enregistrer l'anomalie.
      await releaseAndReschedule(db, claimed);
      result.anomalyCount++;
      result.anomalies.push({
        attemptId: claimed.attemptId,
        code: 'PROVIDER_STATE_UNKNOWN',
      });
    }
  } catch (error) {
    // Cancel échoué (réseau ambigu ou erreur provider).
    // Aucun hold libéré, lease libérée, reschedule, anomaly.
    await releaseAndReschedule(db, claimed);
    result.anomalyCount++;
    const code = error instanceof PaymentProviderError ? 'CANCEL_FAILED' : 'CANCEL_FAILED';
    result.anomalies.push({ attemptId: claimed.attemptId, code });
  }
}

/**
 * Compte un outcome dans le résultat agrégé.
 */
function countOutcome(outcome: ReconciliationOutcome, result: ReconciliationBatchResult): void {
  switch (outcome.kind) {
    case 'confirmed':
      result.confirmedCount++;
      break;
    case 'cancelled':
      result.cancelledCount++;
      break;
    case 'rescheduled':
      result.rescheduledCount++;
      break;
    case 'compensated':
      result.compensationRequestedCount++;
      break;
    case 'needs_cancellation':
      // Géré par handleCancellationFlow.
      break;
  }
}
