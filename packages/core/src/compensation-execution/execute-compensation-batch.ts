/**
 * @uttily/core — Orchestrateur d'exécution des compensations par batch
 * (Phase 8, ADR-010 §13).
 *
 * Orchestre l'exécution d'un batch d'événements de compensation :
 * 1. Valide batchLimit et l'environnement du provider.
 * 2. Revendique un batch (claimCompensationBatch).
 * 3. Pour chaque événement revendiqué :
 *    a. executeCompensation (vérification + appel Stripe hors tx + persistance).
 *    b. En cas de succès : submittedCount++.
 *    c. En cas de REFUND_ALREADY_SUBMITTED : marquer outbox PROCESSED.
 *    d. En cas d'erreur transitoire (provider transitoire ou technique) :
 *       rescheduler avec backoff exponentiel.
 *       Si attempt_count >= MAX_ATTEMPTS : marquer FAILED.
 *    e. En cas d'erreur provider durable (refus solde Connect, conflit
 *       d'idempotence, tout code non transitoire — fail-closed) : marquer
 *       FAILED immédiat, pas de retry, alerte humaine.
 *    f. En cas de LEASE_LOST : ignorer (un autre worker s'en occupe).
 *
 * Aucun appel Stripe n'est effectué sous transaction PostgreSQL.
 */

import { sql } from 'drizzle-orm';
import { type DatabaseClient } from '@uttily/database';
import { PaymentProviderError } from '../payments/errors';
import { CompensationError } from './errors';
import {
  validateBatchLimit,
  DEFAULT_BATCH_LIMIT,
  MAX_ATTEMPTS,
  getBackoffInterval,
} from './scheduling';
import { claimCompensationBatch } from './claim-compensation-batch';
import { executeCompensation } from './execute-compensation';
import type {
  CompensationDependencies,
  CompensationOptions,
  CompensationBatchResult,
  ClaimedCompensation,
} from './types';

/**
 * Marque un événement outbox comme PROCESSED (refund déjà soumis, replay).
 * Conditionné sur lease_token pour ne pas effacer le lease d'un autre worker.
 */
async function markOutboxProcessed(
  db: DatabaseClient,
  claimed: ClaimedCompensation,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // P1-3 : RETURNING-gated — si 0 ligne, la lease n'appartient plus à ce
      // worker : no-op silencieux acceptable (le successeur s'en occupe).
      const updatedRows = await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'PROCESSED',
            "processed_at" = transaction_timestamp(),
            "lease_token" = NULL,
            "lease_until" = NULL
        WHERE "id" = ${claimed.outboxEventId}::uuid
          AND "lease_token" = ${claimed.leaseToken}::uuid
        RETURNING "id"
      `);
      if ((updatedRows as unknown as Array<{ id: string }>).length === 0) {
        return;
      }
    });
  } catch {
    // Best-effort : si la tx échoue, le lease expirera naturellement.
  }
}

/**
 * Reschedule un événement outbox avec backoff exponentiel.
 * Incrémente attempt_count, available_at = now() + backoff, remet PENDING,
 * lease_token = NULL, lease_until = NULL.
 * Conditionné sur lease_token (P1-2).
 */
async function rescheduleOutbox(db: DatabaseClient, claimed: ClaimedCompensation): Promise<void> {
  try {
    const backoff = getBackoffInterval(claimed.attemptCount);
    await db.transaction(async (tx) => {
      // P1-3 : RETURNING-gated — si 0 ligne, la lease n'appartient plus à ce
      // worker : no-op silencieux acceptable (le successeur s'en occupe).
      const updatedRows = await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING',
            "attempt_count" = "attempt_count" + 1,
            "available_at" = transaction_timestamp() + ${sql.raw(backoff)},
            "lease_token" = NULL,
            "lease_until" = NULL
        WHERE "id" = ${claimed.outboxEventId}::uuid
          AND "lease_token" = ${claimed.leaseToken}::uuid
        RETURNING "id"
      `);
      if ((updatedRows as unknown as Array<{ id: string }>).length === 0) {
        return;
      }
    });
  } catch {
    // Best-effort : si la tx échoue, le lease expirera naturellement.
  }
}

/**
 * Marque un événement outbox comme FAILED avec failure_code.
 * Pas de retry. Conditionné sur lease_token (P1-2).
 */
async function markOutboxFailed(
  db: DatabaseClient,
  claimed: ClaimedCompensation,
  failureCode: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // P1-3 : L'UPDATE outbox est RETURNING-gated — si 0 ligne retournée, la
      // lease n'appartient plus à ce worker : ne PAS toucher au refund (un
      // successeur ou un webhook a pu le traiter entre-temps).
      const outboxRows = await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'FAILED',
            "lease_token" = NULL,
            "lease_until" = NULL
        WHERE "id" = ${claimed.outboxEventId}::uuid
          AND "lease_token" = ${claimed.leaseToken}::uuid
        RETURNING "id"
      `);

      if ((outboxRows as unknown as Array<{ id: string }>).length === 0) {
        // Fencing : l'outbox n'a pas été acquis → early-return, refund inchangé.
        return;
      }

      // Marquer le refund FAILED avec failure_code.
      // P1-3 : UPDATE monotone — ne jamais régresser un statut terminal
      // (SUCCEEDED/FAILED projeté par le webhook ou un successeur).
      await tx.execute(sql`
        UPDATE "refunds"
        SET "status" = 'FAILED',
            "failed_at" = transaction_timestamp(),
            "failure_code" = ${failureCode},
            "updated_at" = transaction_timestamp()
        WHERE "provider_idempotency_key" = ${claimed.refundIdempotencyKey}
          AND "status" NOT IN ('SUCCEEDED', 'FAILED')
      `);
    });
  } catch {
    // Best-effort : si la tx échoue, le lease expirera naturellement.
  }
}

/**
 * Classification fermée des erreurs provider (ADR-010 §13).
 *
 * TRANSIENT : erreurs réseau/plateforme pouvant disparaître au retry → reschedule avec backoff.
 * DURABLE : refus ou conflit qui ne disparaîtra JAMAIS au retry → FAILED immédiat, alerte humaine.
 * Tout code non listé est DURABLE par défaut (fail-closed : mieux vaut alerter qu'une boucle silencieuse).
 */
const TRANSIENT_PROVIDER_CODES = new Set([
  'rate_limit', // 429 — disparaît avec backoff
  'api_connection_error', // réseau — disparaît au retry
  'timeout', // timeout réseau — disparaît au retry
  'api_error', // 5xx plateforme — classé UNKNOWN par l'adapter, transitoire
]);

// Codes durables connus (documentés, non exhaustifs — le défaut est durable) :
// 'card_declined', 'invalid_request_error', 'resource_missing', 'authentication_error',
// 'permission_error', 'idempotency_error' (conflit de paramètres sur même clé —
// ne disparaît JAMAIS au retry), 'unknown'.

function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof PaymentProviderError &&
    TRANSIENT_PROVIDER_CODES.has(error.providerErrorCode ?? '')
  );
}

/**
 * Orchestre l'exécution d'un batch de compensations.
 *
 * @param deps Dépendances (db + provider).
 * @param options Options (batchLimit + environment).
 * @returns Résultat agrégé du batch.
 */
export async function executeCompensationBatch(
  deps: CompensationDependencies,
  options: CompensationOptions,
): Promise<CompensationBatchResult> {
  const batchLimit = validateBatchLimit(options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const { db, provider } = deps;
  const environment = options.environment;

  // Vérifier que l'adapter provider correspond à l'environnement demandé.
  if (provider.environment !== environment) {
    throw new CompensationError(
      'ENVIRONMENT_MISMATCH',
      `L'adapter provider (${provider.environment}) ne correspond pas à l'environnement demandé (${environment}).`,
    );
  }

  // 1. Revendiquer un batch (filtré par environnement).
  const claimedEvents = await claimCompensationBatch(db, batchLimit, environment);

  const result: CompensationBatchResult = {
    claimedCount: claimedEvents.length,
    submittedCount: 0,
    failedCount: 0,
    rescheduledCount: 0,
    anomalies: [],
  };

  // 2. Traiter chaque événement revendiqué.
  for (const claimed of claimedEvents) {
    try {
      await executeCompensation(deps, claimed, environment);
      result.submittedCount++;
    } catch (error) {
      if (error instanceof CompensationError) {
        switch (error.code) {
          case 'REFUND_ALREADY_SUBMITTED':
            // Le refund a déjà été soumis (replay). Marquer outbox PROCESSED.
            await markOutboxProcessed(db, claimed);
            result.submittedCount++;
            break;
          case 'LEASE_LOST':
            // Un autre worker a pris la lease. Ignorer.
            break;
          case 'REFUND_NOT_FOUND':
          case 'PAYMENT_NOT_FOUND':
          case 'PAYMENT_INTENT_MISSING':
          case 'ATTEMPT_NOT_SUCCEEDED':
          case 'AMOUNT_MISMATCH':
          case 'CURRENCY_MISMATCH':
          case 'ORGANIZATION_MISMATCH':
          case 'ENVIRONMENT_MISMATCH':
          case 'OUTBOX_METADATA_MISMATCH':
          case 'PAYMENT_ID_MISMATCH':
          case 'REFUND_REASON_MISMATCH':
          case 'PAYMENT_NOT_SUCCEEDED':
          case 'REFUND_FLAGS_INVALID':
          case 'PROVIDER_REFUND_FAILED':
          case 'PROVIDER_REFUND_ID_CONFLICT':
          case 'PROVIDER_RESULT_INVALID': {
            // Anomalie de cohérence : marquer FAILED, pas de retry.
            console.warn(
              JSON.stringify({
                event: 'compensation.anomaly',
                outboxEventId: claimed.outboxEventId,
                code: error.code,
              }),
            );
            await markOutboxFailed(db, claimed, error.code);
            result.failedCount++;
            result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: error.code });
            break;
          }
        }
      } else if (error instanceof PaymentProviderError && !isTransientProviderError(error)) {
        // P1-6 : Erreur provider DURABLE — refus Stripe (solde Connect
        // insuffisant), conflit d'idempotence sur même clé (ne disparaît JAMAIS
        // au retry) ou tout code non listé comme transitoire (fail-closed) :
        // marquer FAILED immédiat, pas de retry, alerte humaine.
        const failureCode = error.providerErrorCode ?? 'STRIPE_REFUSAL';
        console.warn(
          JSON.stringify({
            event: 'compensation.stripe_refusal',
            outboxEventId: claimed.outboxEventId,
            failureCode,
          }),
        );
        await markOutboxFailed(db, claimed, failureCode);
        result.failedCount++;
        result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: failureCode });
      } else {
        // P1-6 : Erreur TRANSITOIRE — provider transitoire (rate_limit,
        // api_connection_error, timeout, api_error) ou erreur technique
        // générique : rescheduler avec backoff.
        if (claimed.attemptCount + 1 >= MAX_ATTEMPTS) {
          console.warn(
            JSON.stringify({
              event: 'compensation.max_attempts_exceeded',
              outboxEventId: claimed.outboxEventId,
              attemptCount: claimed.attemptCount + 1,
            }),
          );
          await markOutboxFailed(db, claimed, 'MAX_ATTEMPTS_EXCEEDED');
          result.failedCount++;
          result.anomalies.push({
            outboxEventId: claimed.outboxEventId,
            code: 'MAX_ATTEMPTS_EXCEEDED',
          });
        } else {
          await rescheduleOutbox(db, claimed);
          result.rescheduledCount++;
        }
      }
    }
  }

  return result;
}
