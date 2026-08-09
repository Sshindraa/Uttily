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
 *       P2 (metrics) : si le refund est déjà SUCCEEDED (webhook), l'outbox
 *       devient PROCESSED — alreadySucceededCount++ (pas submittedCount).
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
  getBackoffIntervalSeconds,
} from './scheduling';
import { claimCompensationBatch } from './claim-compensation-batch';
import { executeCompensation } from './execute-compensation';
import type {
  CompensationDependencies,
  CompensationOptions,
  CompensationBatchResult,
  ClaimedCompensation,
} from './types';

type MarkOutboxProcessedOutcome = 'processed' | 'lease_lost' | 'error';

/**
 * Marque un événement outbox comme PROCESSED (refund déjà soumis, replay).
 * Conditionné sur lease_token pour ne pas effacer le lease d'un autre worker.
 *
 * P2-5 : retourne un statut pour que l'appelant n'incrémente le compteur que
 * si l'opération a réellement réussi.
 */
async function markOutboxProcessed(
  db: DatabaseClient,
  claimed: ClaimedCompensation,
): Promise<MarkOutboxProcessedOutcome> {
  try {
    return await db.transaction(async (tx): Promise<MarkOutboxProcessedOutcome> => {
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
        return 'lease_lost';
      }
      return 'processed';
    });
  } catch (error) {
    // P2-4 : Best-effort — si la tx échoue, le lease expirera naturellement.
    console.warn(
      JSON.stringify({
        event: 'compensation.mark_outbox_processed_error',
        outboxEventId: claimed.outboxEventId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'error';
  }
}

type RescheduleOutboxOutcome = 'rescheduled' | 'lease_lost' | 'error';

/**
 * Reschedule un événement outbox avec backoff exponentiel.
 * Incrémente attempt_count, available_at = now() + backoff, remet PENDING,
 * lease_token = NULL, lease_until = NULL.
 * Conditionné sur lease_token (P1-2).
 *
 * P2-5 : retourne un statut pour que l'appelant n'incrémente le compteur que
 * si l'opération a réellement réussi.
 */
async function rescheduleOutbox(
  db: DatabaseClient,
  claimed: ClaimedCompensation,
): Promise<RescheduleOutboxOutcome> {
  try {
    const backoffSeconds = getBackoffIntervalSeconds(claimed.attemptCount);
    return await db.transaction(async (tx): Promise<RescheduleOutboxOutcome> => {
      // P1-3 : RETURNING-gated — si 0 ligne, la lease n'appartient plus à ce
      // worker : no-op silencieux acceptable (le successeur s'en occupe).
      // P2-1 : backoff en paramètre bindé (pas de sql.raw).
      const updatedRows = await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING',
            "attempt_count" = "attempt_count" + 1,
            "available_at" = transaction_timestamp() + make_interval(secs => ${backoffSeconds}),
            "lease_token" = NULL,
            "lease_until" = NULL
        WHERE "id" = ${claimed.outboxEventId}::uuid
          AND "lease_token" = ${claimed.leaseToken}::uuid
        RETURNING "id"
      `);
      if ((updatedRows as unknown as Array<{ id: string }>).length === 0) {
        return 'lease_lost';
      }
      return 'rescheduled';
    });
  } catch (error) {
    // P2-4 : Best-effort — si la tx échoue, le lease expirera naturellement.
    console.warn(
      JSON.stringify({
        event: 'compensation.reschedule_outbox_error',
        outboxEventId: claimed.outboxEventId,
        attemptCount: claimed.attemptCount,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'error';
  }
}

/** Issue d'un markOutboxFailed : l'appelant compte et alerte en conséquence. */
type MarkOutboxFailedOutcome = 'processed' | 'failed' | 'lease_lost';

/**
 * Marque un événement outbox comme FAILED avec failure_code.
 * Pas de retry. Conditionné sur lease_token (P1-2).
 *
 * P1-3 (lock-order) : l'outbox est verrouillé D'ABORD (SELECT FOR UPDATE avec
 * contrôle de lease), puis le refund (SELECT FOR UPDATE par
 * provider_idempotency_key). Cet ordre outbox_events → refunds est cohérent
 * avec la Phase 3 du worker (execute-compensation.ts) et l'ADR-010 §10 —
 * l'ordre inverse (refunds → outbox_events) créait un deadlock potentiel.
 *
 * Si le refund est déjà SUCCEEDED ou SUBMITTED (projeté par le webhook ou
 * soumis par le worker malgré une erreur provider durable ou ambiguë),
 * l'outbox devient PROCESSED — JAMAIS FAILED — et aucune alerte d'échec n'est
 * émise (log informatif à la place). Sinon, comportement habituel : outbox
 * FAILED + refund FAILED monotone (uniquement quand terminalRefund est true).
 *
 * P1-1 : un échec interne outbox (payload malformé, métadonnées incohérentes,
 * max attempts) ne doit PAS terminaliser le refund FAILED — le refund a pu
 * être soumis à Stripe et le webhook doit pouvoir projeter le statut final.
 * Seuls les refus Stripe durables (createRefund a échoué) justifient de
 * terminaliser le refund (terminalRefund: true).
 */
async function markOutboxFailed(
  db: DatabaseClient,
  claimed: ClaimedCompensation,
  failureCode: string,
  options: { terminalRefund: boolean },
): Promise<MarkOutboxFailedOutcome> {
  try {
    return await db.transaction(async (tx): Promise<MarkOutboxFailedOutcome> => {
      // P1-3 (lock-order) : Verrouiller l'outbox D'ABORD (ordre cohérent avec
      // la Phase 3 et ADR-010 §10). Le SELECT FOR UPDATE avec contrôle de lease
      // empêche tout autre worker de modifier la lease pendant la transaction.
      // Si 0 ligne → la lease n'appartient plus à ce worker (perdue/reprise).
      const outboxLockRows = await tx.execute(sql`
        SELECT "id" FROM "outbox_events"
        WHERE "id" = ${claimed.outboxEventId}::uuid
          AND "lease_token" = ${claimed.leaseToken}::uuid
          AND "lease_until" > transaction_timestamp()
        FOR UPDATE
      `);
      if ((outboxLockRows as unknown as Array<{ id: string }>).length === 0) {
        return 'lease_lost';
      }

      // P1-3 (lock-order) : Verrouiller le refund ENSUITE. Pour un payload mal
      // formé, la clé peut être absente/invalide — 0 ligne est tolérée (le
      // refund est alors introuvable et l'UPDATE monotone ci-dessous est un
      // no-op).
      const refundRows = await tx.execute(sql`
        SELECT "id", "status" FROM "refunds"
        WHERE "provider_idempotency_key" = ${claimed.refundIdempotencyKey}
        FOR UPDATE
      `);
      const lockedRefund = (refundRows as unknown as Array<{ id: string; status: string }>)[0];

      // P1-2 : Refund SUCCEEDED ou SUBMITTED — le remboursement a abouti ou a
      // été accepté côté provider (createRefund a réussi) et projeté/persisté.
      // L'outbox est PROCESSED, jamais FAILED ; pas d'UPDATE refund, pas
      // d'alerte d'échec. L'outbox est déjà verrouillé par le FOR UPDATE
      // ci-dessus — pas besoin de RETURNING pour le fencing.
      if (
        lockedRefund !== undefined &&
        (lockedRefund.status === 'SUCCEEDED' || lockedRefund.status === 'SUBMITTED')
      ) {
        console.info(
          JSON.stringify({
            event: 'compensation.refund_already_submitted_or_succeeded',
            outboxEventId: claimed.outboxEventId,
            refundId: lockedRefund.id,
          }),
        );
        await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'PROCESSED',
              "processed_at" = transaction_timestamp(),
              "lease_token" = NULL,
              "lease_until" = NULL
          WHERE "id" = ${claimed.outboxEventId}::uuid
        `);
        return 'processed';
      }

      // P1-3 (lock-order) : L'outbox est déjà verrouillé par le FOR UPDATE
      // ci-dessus — l'UPDATE s'exécute sur la ligne verrouillée, pas besoin de
      // RETURNING pour le fencing.
      await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'FAILED',
            "lease_token" = NULL,
            "lease_until" = NULL
        WHERE "id" = ${claimed.outboxEventId}::uuid
      `);

      // P1-1 : Marquer le refund FAILED avec failure_code uniquement pour les
      // refus Stripe durables (terminalRefund: true). Un échec interne outbox
      // (payload malformé, métadonnées incohérentes, max attempts) ne doit pas
      // terminaliser le refund — il a pu être soumis à Stripe et le webhook
      // doit pouvoir projeter le statut final.
      // P1-3 : UPDATE monotone — ne jamais régresser un statut terminal
      // (SUCCEEDED/FAILED projeté par le webhook ou un successeur).
      if (options.terminalRefund) {
        await tx.execute(sql`
          UPDATE "refunds"
          SET "status" = 'FAILED',
              "failed_at" = transaction_timestamp(),
              "failure_code" = ${failureCode},
              "updated_at" = transaction_timestamp()
          WHERE "provider_idempotency_key" = ${claimed.refundIdempotencyKey}
            AND "status" NOT IN ('SUCCEEDED', 'FAILED')
        `);
      }
      return 'failed';
    });
  } catch (error) {
    // P2-3 : Best-effort — si la tx échoue, le lease expirera naturellement.
    console.warn(
      JSON.stringify({
        event: 'compensation.mark_outbox_failed_error',
        outboxEventId: claimed.outboxEventId,
        failureCode,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'lease_lost';
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
    alreadySucceededCount: 0,
    failedCount: 0,
    rescheduledCount: 0,
    anomalies: [],
  };

  // 2. Traiter chaque événement revendiqué.
  for (const claimed of claimedEvents) {
    // P2-2 : Isoler les payloads mal formés — le safe-cast SQL les a revendiqués
    // sans faire échouer le batch ; ils sont intraitables (FAILED durable +
    // anomalie) mais ne bloquent JAMAIS les autres événements.
    if (!claimed.payloadValid) {
      console.warn(
        JSON.stringify({
          event: 'compensation.payload_malformed',
          outboxEventId: claimed.outboxEventId,
        }),
      );
      const malformedOutcome = await markOutboxFailed(db, claimed, 'PAYLOAD_MALFORMED', {
        terminalRefund: false,
      });
      if (malformedOutcome === 'failed') {
        result.failedCount++;
        result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: 'PAYLOAD_MALFORMED' });
      } else if (malformedOutcome === 'processed') {
        // P2 (metrics) : refund déjà SUCCEEDED par le webhook — pas une soumission.
        result.alreadySucceededCount++;
      }
      continue;
    }

    try {
      await executeCompensation(deps, claimed, environment);
      result.submittedCount++;
    } catch (error) {
      if (error instanceof CompensationError) {
        switch (error.code) {
          case 'REFUND_ALREADY_SUBMITTED':
            // Le refund a déjà été soumis (replay). Marquer outbox PROCESSED.
            {
              const processedOutcome = await markOutboxProcessed(db, claimed);
              if (processedOutcome === 'processed') {
                result.submittedCount++;
              }
            }
            break;
          case 'REFUND_ALREADY_FAILED': {
            // P1-4 : Le refund est déjà FAILED — remboursement non abouti.
            // Échec durable avec alerte, JAMAIS compté comme soumis.
            console.warn(
              JSON.stringify({
                event: 'compensation.refund_failed',
                outboxEventId: claimed.outboxEventId,
                code: error.code,
              }),
            );
            const alreadyFailedOutcome = await markOutboxFailed(db, claimed, error.code, {
              terminalRefund: false,
            });
            if (alreadyFailedOutcome === 'failed') {
              result.failedCount++;
              result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: error.code });
            } else if (alreadyFailedOutcome === 'processed') {
              // P2 (metrics) : refund déjà SUCCEEDED par le webhook — pas une soumission.
              result.alreadySucceededCount++;
            }
            break;
          }
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
            // P1-3 : si le refund est déjà SUCCEEDED (projeté par le webhook),
            // markOutboxFailed résout en PROCESSED — compter alreadySucceeded, pas failed.
            const anomalyOutcome = await markOutboxFailed(db, claimed, error.code, {
              terminalRefund: false,
            });
            if (anomalyOutcome === 'failed') {
              console.warn(
                JSON.stringify({
                  event: 'compensation.anomaly',
                  outboxEventId: claimed.outboxEventId,
                  code: error.code,
                }),
              );
              result.failedCount++;
              result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: error.code });
            } else if (anomalyOutcome === 'processed') {
              // P2 (metrics) : refund déjà SUCCEEDED par le webhook — pas une soumission.
              result.alreadySucceededCount++;
            }
            break;
          }
        }
      } else if (error instanceof PaymentProviderError && !isTransientProviderError(error)) {
        // P1-6 : Erreur provider DURABLE — refus Stripe (solde Connect
        // insuffisant), conflit d'idempotence sur même clé (ne disparaît JAMAIS
        // au retry) ou tout code non listé comme transitoire (fail-closed) :
        // marquer FAILED immédiat, pas de retry, alerte humaine.
        // P1-3 : si le refund est déjà SUCCEEDED (projeté par le webhook malgré
        // l'erreur), l'outbox devient PROCESSED — jamais FAILED, pas d'anomalie.
        const failureCode = error.providerErrorCode ?? 'STRIPE_REFUSAL';
        const refusalOutcome = await markOutboxFailed(db, claimed, failureCode, {
          terminalRefund: true,
        });
        if (refusalOutcome === 'failed') {
          console.warn(
            JSON.stringify({
              event: 'compensation.stripe_refusal',
              outboxEventId: claimed.outboxEventId,
              code: failureCode,
            }),
          );
          result.failedCount++;
          result.anomalies.push({ outboxEventId: claimed.outboxEventId, code: failureCode });
        } else if (refusalOutcome === 'processed') {
          // P2 (metrics) : refund déjà SUCCEEDED par le webhook — pas une soumission.
          result.alreadySucceededCount++;
        }
      } else {
        // P1-6 : Erreur TRANSITOIRE — provider transitoire (rate_limit,
        // api_connection_error, timeout, api_error) ou erreur technique
        // générique : rescheduler avec backoff.
        if (claimed.attemptCount + 1 >= MAX_ATTEMPTS) {
          const maxAttemptsOutcome = await markOutboxFailed(db, claimed, 'MAX_ATTEMPTS_EXCEEDED', {
            terminalRefund: false,
          });
          if (maxAttemptsOutcome === 'failed') {
            console.warn(
              JSON.stringify({
                event: 'compensation.max_attempts_exceeded',
                outboxEventId: claimed.outboxEventId,
                attemptCount: claimed.attemptCount + 1,
              }),
            );
            result.failedCount++;
            result.anomalies.push({
              outboxEventId: claimed.outboxEventId,
              code: 'MAX_ATTEMPTS_EXCEEDED',
            });
          } else if (maxAttemptsOutcome === 'processed') {
            // P2 (metrics) : refund déjà SUCCEEDED par le webhook — pas une soumission.
            result.alreadySucceededCount++;
          }
        } else {
          const rescheduleOutcome = await rescheduleOutbox(db, claimed);
          if (rescheduleOutcome === 'rescheduled') {
            result.rescheduledCount++;
          }
        }
      }
    }
  }

  return result;
}
