/**
 * @uttily/core — Use case principal de traitement des webhooks Stripe (Lot 5, ADR-010 §9, §10, §11, §13, §14).
 *
 * Orchestration : verify → extract PaymentIntentEventData → ingest (transaction 1, courte)
 * → dispatch par type → confirm/compensate/non-success (transaction 2, métier)
 * → log. Aucun appel Stripe dans une transaction.
 *
 * Contraintes critiques (ADR-010 §1, §14) :
 * - La vérification de signature se fait HORS transaction, avant toute écriture.
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - Le corps brut et les données de carte ne sont JAMAIS persistés.
 * - Le `client_secret` n'est JAMAIS persisté, loggé ou inclus dans une réponse.
 * - Fail-closed : signature absente/invalide → 4xx, aucune écriture métier.
 * - Erreur technique récupérable → 5xx (Stripe retry).
 * - Anomalie métier irréconciliable → persistance + observabilité, pas de boucle aveugle.
 *
 * Ordre de verrouillage global (ADR-010 §10) :
 * booking_draft → inventory_blocks (id) → allocations (id) → payment → payment_attempt → webhook_event
 * Le verrou sur payment_webhook_events est pris EN DERNIER dans la transaction métier,
 * après tous les autres verrous. La transaction 1 (ingestion) ne prend aucun verrou FOR UPDATE.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  bookings,
  connectedAccountPayouts,
  organizationPaymentAccounts,
  paymentAttempts,
  paymentWebhookEvents,
  payments,
  refunds,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import type { VerifiedWebhookEvent } from '../payments/types';
import type {
  WebhookHandlerDeps,
  WebhookHandlerInput,
  WebhookHandlerResult,
  HandledEventType,
} from './types';
import { WebhookHandlerError, normalizeWebhookError, isIrreconcilable } from './errors';
import { extractPaymentIntentEventData } from './extract-event';
import { resolveAttempt } from './resolve-attempt';
import { ingestEvent, markWebhookFailed, resolveOrgFromConnectedAccount } from './dedupe-event';
import {
  confirmBooking,
  isDraftTerminalForConversion,
  type ConfirmBookingResult,
} from './confirm-booking';
import {
  handlePaymentFailed,
  handleCanceled,
  handleProcessing,
  handleRequiresAction,
} from './handle-non-success';
import { compensateLatePayment } from './compensate-late';
import {
  resolveAmendmentAttempt,
  resolveAmendmentOrganizationForFailure,
} from './resolve-amendment-attempt';
import { handleSupplementPaymentWebhook } from '../booking-amendments/apply-supplement-amendment';
import {
  scheduleRefundConfirmedNotification,
  scheduleRefundActionRequiredNotification,
} from '../notifications/scheduling';

/** Types d'événements de refund (journalisés et projetés, pas de worker en Phase 6). */
const REFUND_EVENT_TYPES = new Set<string>([
  'charge.refunded',
  'refund.updated',
  'refund.created',
  'refund.failed',
]);

/**
 * Codes d'échec fermés pour la projection des refunds (P2-1).
 * Une faute de frappe dans un code serait détectée à la compilation.
 */
export type RefundProjectionFailureCode =
  | 'REFUND_PI_MISSING'
  | 'REFUND_PI_MISMATCH'
  | 'REFUND_INVALID_AMOUNT'
  | 'REFUND_AMOUNT_MISMATCH'
  | 'REFUND_CURRENCY_MISSING'
  | 'REFUND_CURRENCY_MISMATCH'
  | 'REFUND_ORG_MISMATCH'
  | 'REFUND_TERMINAL_STATE_CONFLICT'
  | 'REFUND_INVARIANT_BROKEN'
  | 'REFUND_OBJECTS_MISSING'
  | 'REFUND_OBJECT_INVALID'
  | 'REFUND_ID_MISSING'
  | 'REFUND_STATUS_MISSING'
  | 'REFUND_PROVIDER_STATE_UNSUPPORTED'
  | 'REFUND_ACCOUNT_MISMATCH'
  | 'REFUND_METADATA_INVALID'
  | 'REFUND_METADATA_NOT_FOUND'
  | 'REFUND_REASON_MISMATCH';

/**
 * Erreur de projection de refund (P1-1). Levée à l'intérieur d'un savepoint
 * pour déclencher un ROLLBACK TO SAVEPOINT (annule toutes les projections
 * partielles) puis être capturée par la transaction extérieure qui marque
 * l'événement FAILED avec le code fermé.
 */
class RefundProjectionError extends Error {
  constructor(readonly code: RefundProjectionFailureCode) {
    super(`Refund projection failed: ${code}`);
    this.name = 'RefundProjectionError';
  }
}

/**
 * Use case principal : traite un webhook Stripe signé de manière idempotente
 * et transactionnelle.
 *
 * @param deps Dépendances (db + provider).
 * @param input Entrée (rawBody, signature, endpoint, environment).
 * @returns WebhookHandlerResult (SUCCESS 200 ou FAILURE avec statusCode).
 */
export async function handleWebhook(
  deps: WebhookHandlerDeps,
  input: WebhookHandlerInput,
): Promise<WebhookHandlerResult> {
  const startTime = Date.now();
  const { db, provider } = deps;
  const { rawBody, signature, endpoint, environment } = input;

  // ── 1. Vérification de signature (HORS transaction, avant toute écriture) ──
  const verification = await provider.verifyWebhook({
    rawBody,
    signature,
    endpoint,
    environment,
  });

  if (!verification.valid) {
    const code =
      verification.reason === 'INVALID_SIGNATURE'
        ? 'WEBHOOK_SIGNATURE_INVALID'
        : verification.reason === 'INVALID_TIMESTAMP'
          ? 'WEBHOOK_TIMESTAMP_INVALID'
          : 'WEBHOOK_PAYLOAD_INVALID';
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint,
        environment,
        result: 'signature_invalid',
        reason: verification.reason,
        durationMs: Date.now() - startTime,
      }),
    );
    return {
      kind: 'FAILURE',
      statusCode: 400,
      error: code,
      message: 'Signature ou payload invalide',
    };
  }

  const event = verification.event;

  // Log de réception (pas de corps brut, pas de secret).
  console.log(
    JSON.stringify({
      event: 'webhook.stripe',
      endpoint,
      environment,
      providerEventId: event.id,
      eventType: event.type,
      result: 'received',
      durationMs: Date.now() - startTime,
    }),
  );

  try {
    // ── 2. Dispatch par type d'événement ──────────────────────────────────────

    // Événements de refund — journaliser et projeter le statut, QUEL QUE SOIT
    // l'endpoint (P1-1 : un refund Connect précoce avec event.accountId non
    // null doit être projeté SUCCEEDED/FAILED, pas seulement consommé).
    if (REFUND_EVENT_TYPES.has(event.type)) {
      return await handleRefundEvent(db, event, rawBody, environment, endpoint, startTime);
    }

    // Événements Connect (account.updated, payout.*) — journaliser, projeter et marquer PROCESSED/IGNORED.
    if (endpoint === 'connect' || event.type.startsWith('payout.')) {
      return await handleConnectEvent(db, event, rawBody, environment, startTime);
    }

    // Événements PaymentIntent gérés.
    const handledTypes: readonly string[] = [
      'payment_intent.succeeded',
      'payment_intent.requires_action',
      'payment_intent.processing',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
    ];

    if (!handledTypes.includes(event.type)) {
      // Événement non géré — journaliser et retourner 200 (éviter les retries inutiles).
      console.log(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'unhandled',
          durationMs: Date.now() - startTime,
        }),
      );
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    // ── 3. Extraire PaymentIntentEventData ────────────────────────────────────
    let piData;
    try {
      piData = extractPaymentIntentEventData(event);
    } catch (extractError) {
      console.warn(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'extract_failed',
          error: extractError instanceof Error ? extractError.message : String(extractError),
          durationMs: Date.now() - startTime,
        }),
      );
      return {
        kind: 'FAILURE',
        statusCode: 400,
        error: 'WEBHOOK_PAYLOAD_INVALID',
        message: 'Données PaymentIntent invalides dans le webhook',
      };
    }

    // G7M-C3 : tenter d'abord la résolution dans l'agrégat SUPPLEMENT. Cette
    // résolution couvre à la fois le provider PaymentIntent déjà persisté et
    // la metadata amendment_payment_attempt_id lorsque C2 n'a pas encore
    // terminé sa Transaction B. Un PaymentIntent AMENDMENT non rattachable ne
    // doit jamais retomber dans le chemin legacy payment/payment_attempts.
    let amendmentAttempt;
    try {
      amendmentAttempt = await resolveAmendmentAttempt(db, piData, environment, event.accountId);
    } catch (error) {
      // La résolution d'un amendement vérifie l'environnement avant
      // l'ingestion. Journaliser explicitement l'échec permet d'acquitter
      // l'événement sans retraiter un paiement d'un autre environnement.
      if (
        error instanceof WebhookHandlerError &&
        error.code === 'WEBHOOK_ENVIRONMENT_MISMATCH' &&
        piData.metadata?.payment_type === 'AMENDMENT'
      ) {
        const organizationId = await resolveAmendmentOrganizationForFailure(db, piData);
        const ingestResult = await db.transaction(async (tx) => {
          return ingestEvent(tx, event, rawBody, environment, organizationId);
        });
        if (!ingestResult.isDuplicate) {
          await db.transaction(async (tx) => {
            await markWebhookFailed(tx, ingestResult.row.id, error.code);
          });
        }
        return { kind: 'SUCCESS', statusCode: 200 };
      }
      throw error;
    }

    if (amendmentAttempt !== null || piData.metadata?.payment_type === 'AMENDMENT') {
      if (amendmentAttempt === null) {
        console.warn(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            eventType: event.type,
            result: 'amendment_attempt_not_found',
            durationMs: Date.now() - startTime,
          }),
        );
        try {
          await logUnattachedEvent(db, event, rawBody, environment, startTime);
        } catch {
          return {
            kind: 'FAILURE',
            statusCode: 500,
            error: 'UNKNOWN',
            message: 'Erreur technique lors de la journalisation du webhook non rattaché',
          };
        }
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      const ingestResult = await db.transaction(async (tx) => {
        return await ingestEvent(tx, event, rawBody, environment, amendmentAttempt.organizationId);
      });
      if (ingestResult.organizationId === null || ingestResult.isDuplicate) {
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      try {
        const outcome = await db.transaction(async (tx) => {
          return await handleSupplementPaymentWebhook(
            tx,
            amendmentAttempt,
            event,
            piData,
            ingestResult.row.id,
            environment,
            deps.clock?.(),
          );
        });
        if (outcome instanceof WebhookHandlerError) {
          if (isIrreconcilable(outcome)) return { kind: 'SUCCESS', statusCode: 200 };
          return {
            kind: 'FAILURE',
            statusCode: outcome.statusCode,
            error: outcome.code,
            message: outcome.message,
          };
        }
        return { kind: 'SUCCESS', statusCode: 200 };
      } catch (supplementError) {
        if (
          supplementError instanceof WebhookHandlerError &&
          supplementError.code === 'WEBHOOK_ALREADY_PROCESSED'
        ) {
          return { kind: 'SUCCESS', statusCode: 200 };
        }
        throw supplementError;
      }
    }

    // ── 4. Résoudre la tentative (HORS transaction) ───────────────────────────
    const attempt = await resolveAttempt(db, piData, environment, event.accountId);

    if (attempt === null) {
      // Aucune tentative trouvée — anomalie plateforme.
      // Journaliser et retourner 200 (éviter les retries sur un événement non rattachable).
      console.warn(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          providerObjectId: event.objectId,
          result: 'attempt_not_found',
          durationMs: Date.now() - startTime,
        }),
      );
      // Insérer quand même l'événement avec organization_id résolu depuis le compte connecté
      // (si possible), sinon avec organization_id = NULL et marquer IGNORED.
      try {
        await logUnattachedEvent(db, event, rawBody, environment, startTime);
      } catch {
        // Erreur technique de journalisation → 500 (Stripe retry).
        return {
          kind: 'FAILURE',
          statusCode: 500,
          error: 'UNKNOWN',
          message: 'Erreur technique lors de la journalisation du webhook non rattaché',
        };
      }
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    // ── 5. Transaction 1 : ingestion (courte, sans verrou FOR UPDATE) ────────
    const ingestResult = await db.transaction(async (tx) => {
      return await ingestEvent(tx, event, rawBody, environment, attempt.organizationId);
    });

    // Si organization_id non résolu (ne devrait pas arriver ici car attempt trouvé).
    if (ingestResult.organizationId === null) {
      console.warn(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          result: 'no_tenant',
          durationMs: Date.now() - startTime,
        }),
      );
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    // Doublon : déjà PROCESSED ou IGNORED → retourner 200 sans rejouer.
    if (ingestResult.isDuplicate) {
      console.log(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'duplicate',
          durationMs: Date.now() - startTime,
        }),
      );
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    const webhookEventId = ingestResult.row.id;

    // ── 6. Transaction 2 : business (dispatch + verrous métier + webhook_event en dernier) ──
    return await db.transaction(async (tx) => {
      const eventType = event.type as HandledEventType;

      if (eventType === 'payment_intent.succeeded') {
        // P1-2 : Vérifier si une réservation existe déjà pour ce payment (doublon distinct).
        const existingBookings = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.paymentId, attempt.paymentId))
          .limit(1);

        if (existingBookings.length > 0) {
          // Une réservation existe déjà → l'effet a été produit par un autre événement.
          // Marquer IGNORED (pas PROCESSED) et retourner 200.
          await tx
            .update(paymentWebhookEvents)
            .set({ status: 'IGNORED', processedAt: sql`transaction_timestamp()` })
            .where(eq(paymentWebhookEvents.id, webhookEventId));
          console.log(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint,
              environment,
              providerEventId: event.id,
              eventType: event.type,
              result: 'duplicate_distinct_pi',
              durationMs: Date.now() - startTime,
            }),
          );
          return { kind: 'SUCCESS', statusCode: 200 };
        }

        // Vérifier si la tentative est déjà SUCCEEDED (doublon distinct sans réservation).
        const attemptRows = await tx
          .select({ status: paymentAttempts.status })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.attemptId))
          .limit(1);

        if (attemptRows.length > 0 && attemptRows[0]!.status === 'SUCCEEDED') {
          // Tentative déjà SUCCEEDED mais aucune réservation → marquer IGNORED.
          await tx
            .update(paymentWebhookEvents)
            .set({ status: 'IGNORED', processedAt: sql`transaction_timestamp()` })
            .where(eq(paymentWebhookEvents.id, webhookEventId));
          console.log(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint,
              environment,
              providerEventId: event.id,
              eventType: event.type,
              result: 'duplicate_succeeded_no_booking',
              durationMs: Date.now() - startTime,
            }),
          );
          return { kind: 'SUCCESS', statusCode: 200 };
        }

        // Vérifier si le brouillon est terminal → compensation tardive.
        if (isDraftTerminalForConversion(attempt.draftStatus)) {
          const compOutcome = await compensateLatePayment(
            tx,
            attempt,
            piData,
            webhookEventId,
            environment,
          );
          if (compOutcome instanceof WebhookHandlerError) {
            if (isIrreconcilable(compOutcome)) {
              // P1-2 : Irreconciliable → SUCCESS 200 (arrête les retries Stripe).
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  environment,
                  providerEventId: event.id,
                  eventType: event.type,
                  result: 'invariant_failed_terminated',
                  errorCode: compOutcome.code,
                  durationMs: Date.now() - startTime,
                }),
              );
              return { kind: 'SUCCESS', statusCode: 200 };
            }
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                environment,
                providerEventId: event.id,
                eventType: event.type,
                result: 'invariant_failed_compensate',
                errorCode: compOutcome.code,
                durationMs: Date.now() - startTime,
              }),
            );
            return {
              kind: 'FAILURE',
              statusCode: compOutcome.statusCode,
              error: compOutcome.code,
              message: compOutcome.message,
            };
          }
          console.log(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint,
              environment,
              providerEventId: event.id,
              eventType: event.type,
              result: 'compensated',
              paymentId: attempt.paymentId,
              durationMs: Date.now() - startTime,
            }),
          );
          return { kind: 'SUCCESS', statusCode: 200 };
        }

        // Confirmation atomique (§10 étapes 2-12).
        try {
          const result = await confirmBooking(
            tx,
            attempt,
            piData,
            webhookEventId,
            environment,
            event.id,
          );
          // Si confirmBooking retourne une erreur d'invariant (FAILED marqué),
          // P1-2 : une erreur irréconciliable retourne SUCCESS 200 (pas 500) pour
          // arrêter les retries Stripe. L'événement est déjà marqué FAILED dans la
          // transaction.
          if (result instanceof WebhookHandlerError) {
            if (isIrreconcilable(result)) {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  environment,
                  providerEventId: event.id,
                  eventType: event.type,
                  result: 'invariant_failed_terminated',
                  errorCode: result.code,
                  durationMs: Date.now() - startTime,
                }),
              );
              return { kind: 'SUCCESS', statusCode: 200 };
            }
            // Control flow (WEBHOOK_ALREADY_PROCESSED, etc.) → comportement existant.
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                environment,
                providerEventId: event.id,
                eventType: event.type,
                result: 'invariant_failed',
                errorCode: result.code,
                durationMs: Date.now() - startTime,
              }),
            );
            return {
              kind: 'FAILURE',
              statusCode: result.statusCode,
              error: result.code,
              message: result.message,
            };
          }
          // confirmBooking retourne ConfirmBookingResult sinon (jamais void).
          const confirmResult = result as ConfirmBookingResult;
          console.log(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint,
              environment,
              providerEventId: event.id,
              eventType: event.type,
              result: 'confirmed',
              bookingId: confirmResult.bookingId,
              paymentId: attempt.paymentId,
              durationMs: Date.now() - startTime,
            }),
          );
          return { kind: 'SUCCESS', statusCode: 200 };
        } catch (confirmError) {
          // Si WEBHOOK_LATE_PAYMENT : le brouillon est devenu terminal sous verrou.
          // → compensation tardive dans la même transaction.
          if (
            confirmError instanceof WebhookHandlerError &&
            confirmError.code === 'WEBHOOK_LATE_PAYMENT'
          ) {
            const compOutcome = await compensateLatePayment(
              tx,
              attempt,
              piData,
              webhookEventId,
              environment,
            );
            if (compOutcome instanceof WebhookHandlerError) {
              if (isIrreconcilable(compOutcome)) {
                // P1-2 : Irreconciliable → SUCCESS 200 (arrête les retries Stripe).
                console.warn(
                  JSON.stringify({
                    event: 'webhook.stripe',
                    endpoint,
                    environment,
                    providerEventId: event.id,
                    eventType: event.type,
                    result: 'invariant_failed_terminated',
                    errorCode: compOutcome.code,
                    durationMs: Date.now() - startTime,
                  }),
                );
                return { kind: 'SUCCESS', statusCode: 200 };
              }
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  environment,
                  providerEventId: event.id,
                  eventType: event.type,
                  result: 'invariant_failed_late',
                  errorCode: compOutcome.code,
                  durationMs: Date.now() - startTime,
                }),
              );
              return {
                kind: 'FAILURE',
                statusCode: compOutcome.statusCode,
                error: compOutcome.code,
                message: compOutcome.message,
              };
            }
            console.log(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                environment,
                providerEventId: event.id,
                eventType: event.type,
                result: 'compensated_late_under_lock',
                paymentId: attempt.paymentId,
                durationMs: Date.now() - startTime,
              }),
            );
            return { kind: 'SUCCESS', statusCode: 200 };
          }
          // Si WEBHOOK_ALREADY_PROCESSED : doublon sous verrou.
          if (
            confirmError instanceof WebhookHandlerError &&
            confirmError.code === 'WEBHOOK_ALREADY_PROCESSED'
          ) {
            // P1-3 : Marquer l'événement courant IGNORED (un autre événement a
            // déjà produit l'effet) avant de retourner 200.
            await tx
              .update(paymentWebhookEvents)
              .set({ status: 'IGNORED', processedAt: sql`transaction_timestamp()` })
              .where(eq(paymentWebhookEvents.id, webhookEventId));
            console.log(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                environment,
                providerEventId: event.id,
                eventType: event.type,
                result: 'duplicate_under_lock',
                durationMs: Date.now() - startTime,
              }),
            );
            return { kind: 'SUCCESS', statusCode: 200 };
          }
          throw confirmError;
        }
      }

      if (eventType === 'payment_intent.payment_failed') {
        const outcome = await handlePaymentFailed(
          tx,
          attempt,
          webhookEventId,
          event,
          piData,
          environment,
        );
        if (outcome instanceof WebhookHandlerError) {
          return buildHandlerOutcomeResult(
            outcome,
            endpoint,
            environment,
            event.id,
            event.type,
            startTime,
          );
        }
        console.log(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            providerEventId: event.id,
            eventType: event.type,
            result: 'failed',
            paymentId: attempt.paymentId,
            durationMs: Date.now() - startTime,
          }),
        );
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      if (eventType === 'payment_intent.canceled') {
        const outcome = await handleCanceled(
          tx,
          attempt,
          piData,
          webhookEventId,
          event,
          environment,
        );
        if (outcome instanceof WebhookHandlerError) {
          return buildHandlerOutcomeResult(
            outcome,
            endpoint,
            environment,
            event.id,
            event.type,
            startTime,
          );
        }
        console.log(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            providerEventId: event.id,
            eventType: event.type,
            result: 'canceled',
            paymentId: attempt.paymentId,
            durationMs: Date.now() - startTime,
          }),
        );
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      if (eventType === 'payment_intent.processing') {
        const outcome = await handleProcessing(
          tx,
          attempt,
          webhookEventId,
          event,
          piData,
          environment,
        );
        if (outcome instanceof WebhookHandlerError) {
          return buildHandlerOutcomeResult(
            outcome,
            endpoint,
            environment,
            event.id,
            event.type,
            startTime,
          );
        }
        console.log(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            providerEventId: event.id,
            eventType: event.type,
            result: 'processing',
            paymentId: attempt.paymentId,
            durationMs: Date.now() - startTime,
          }),
        );
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      if (eventType === 'payment_intent.requires_action') {
        const outcome = await handleRequiresAction(
          tx,
          attempt,
          webhookEventId,
          event,
          piData,
          environment,
        );
        if (outcome instanceof WebhookHandlerError) {
          return buildHandlerOutcomeResult(
            outcome,
            endpoint,
            environment,
            event.id,
            event.type,
            startTime,
          );
        }
        return { kind: 'SUCCESS', statusCode: 200 };
      }

      // Type non géré (ne devrait pas arriver ici car filtré plus haut).
      return { kind: 'SUCCESS', statusCode: 200 };
    });
  } catch (error) {
    // Erreur métier reconnue → log + retourner le statusCode approprié.
    const normalized = normalizeWebhookError(error);
    if (normalized) {
      console.warn(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'business_error',
          errorCode: normalized.code,
          durationMs: Date.now() - startTime,
        }),
      );
      return {
        kind: 'FAILURE',
        statusCode: normalized.statusCode,
        error: normalized.code,
        message: normalized.message,
      };
    }

    // Erreur technique inattendue → 500 (Stripe retry).
    console.error(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint,
        environment,
        eventType: event.type,
        result: 'error',
        errorCode: 'TECHNICAL_FAILURE',
        durationMs: Date.now() - startTime,
      }),
    );
    return {
      kind: 'FAILURE',
      statusCode: 500,
      error: 'UNKNOWN',
      message: 'Erreur technique lors du traitement du webhook',
    };
  }
}

/**
 * P1-2 : Construit le résultat HTTP pour un HandlerOutcome (erreur retournée
 * par un handler métier). Une erreur irréconciliable retourne SUCCESS 200
 * (arrête les retries Stripe, l'événement est déjà marqué FAILED). Une erreur
 * de control flow retourne FAILURE avec le statusCode d'origine.
 */
function buildHandlerOutcomeResult(
  outcome: WebhookHandlerError,
  endpoint: string,
  environment: 'TEST' | 'LIVE',
  providerEventId: string,
  eventType: string,
  startTime: number,
): WebhookHandlerResult {
  if (isIrreconcilable(outcome)) {
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint,
        environment,
        providerEventId,
        eventType,
        result: 'invariant_failed_terminated',
        errorCode: outcome.code,
        durationMs: Date.now() - startTime,
      }),
    );
    return { kind: 'SUCCESS', statusCode: 200 };
  }
  console.warn(
    JSON.stringify({
      event: 'webhook.stripe',
      endpoint,
      environment,
      providerEventId,
      eventType,
      result: 'invariant_failed',
      errorCode: outcome.code,
      durationMs: Date.now() - startTime,
    }),
  );
  return {
    kind: 'FAILURE',
    statusCode: outcome.statusCode,
    error: outcome.code,
    message: outcome.message,
  };
}

/**
 * Gère un événement Connect (account.updated) : déduplication + projection
 * dans organization_payment_accounts + marquer PROCESSED/IGNORED.
 */
async function handleConnectEvent(
  db: DatabaseClient,
  event: VerifiedWebhookEvent,
  rawBody: string,
  environment: 'TEST' | 'LIVE',
  startTime: number,
): Promise<WebhookHandlerResult> {
  // Résoudre organization_id depuis le compte connecté (event.accountId).
  let orgId: string | null = null;
  if (event.accountId) {
    orgId = await resolveOrgFromConnectedAccount(db, event.accountId, environment);
  }

  if (orgId === null) {
    // Événement non rattachable — persister avec organization_id = NULL + IGNORED.
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        environment,
        providerEventId: event.id,
        eventType: event.type,
        providerAccountId: event.accountId,
        result: 'connect_no_tenant',
        durationMs: Date.now() - startTime,
      }),
    );
  }

  return await db.transaction(async (tx) => {
    const ingest = await ingestEvent(tx, event, rawBody, environment, orgId);

    if (ingest.isDuplicate) {
      console.log(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint: 'connect',
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'duplicate',
          durationMs: Date.now() - startTime,
        }),
      );
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    const webhookEventId = ingest.row.id;
    const now = sql`transaction_timestamp()`;

    // P1-3/P1-6 : Projeter account.updated ou payout.* dans la projection locale.
    // projectAccountUpdated / projectPayoutFromWebhook retourne 'PROCESSED', 'IGNORED' ou 'FAILED'.
    let finalStatus: 'PROCESSED' | 'IGNORED' | 'FAILED' = orgId === null ? 'IGNORED' : 'PROCESSED';
    if (event.type === 'account.updated' && event.accountId && orgId !== null) {
      const projectionStatus = await projectAccountUpdated(tx, event, environment, orgId);
      finalStatus = projectionStatus;
    } else if (event.type.startsWith('payout.') && orgId !== null) {
      const projectionStatus = await projectPayoutFromWebhook(tx, event, environment, orgId);
      finalStatus = projectionStatus;
    }

    // P1-3 : Si FAILED (mismatch event.accountId/data.id), marquer FAILED + failureCode.
    if (finalStatus === 'FAILED') {
      await tx
        .update(paymentWebhookEvents)
        .set({
          status: 'FAILED',
          failureCode: 'WEBHOOK_AGGREGATE_INCONSISTENT',
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
    } else {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: finalStatus, processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
    }

    console.log(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        environment,
        providerEventId: event.id,
        eventType: event.type,
        result:
          finalStatus === 'IGNORED'
            ? 'ignored_connect'
            : finalStatus === 'FAILED'
              ? 'invariant_failed_terminated'
              : 'processed_connect',
        organizationId: orgId,
        durationMs: Date.now() - startTime,
      }),
    );
    // P1-3 : FAILED retourne 200 (pas 500) pour arrêter les retries Stripe.
    return { kind: 'SUCCESS', statusCode: 200 };
  });
}

/**
 * Projette un événement payout.* (payout.created, payout.updated, payout.paid, payout.failed)
 * dans la table connected_account_payouts de manière idempotente (Chantier 11.1).
 */
async function projectPayoutFromWebhook(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  environment: 'TEST' | 'LIVE',
  orgId: string,
): Promise<'PROCESSED' | 'IGNORED' | 'FAILED'> {
  const obj = event.data;
  if (!obj || typeof obj !== 'object') return 'IGNORED';

  const providerPayoutId = typeof obj.id === 'string' ? obj.id : null;
  if (!providerPayoutId) return 'FAILED';

  const amount = typeof obj.amount === 'number' ? obj.amount : 0;
  const currency = typeof obj.currency === 'string' ? obj.currency.toUpperCase() : 'EUR';
  const rawStatus = typeof obj.status === 'string' ? obj.status : '';

  let status: 'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELLED' = 'PENDING';
  if (rawStatus === 'paid') status = 'PAID';
  else if (rawStatus === 'in_transit') status = 'IN_TRANSIT';
  else if (rawStatus === 'failed') status = 'FAILED';
  else if (rawStatus === 'canceled') status = 'CANCELLED';

  const arrivalTimestamp = typeof obj.arrival_date === 'number' ? obj.arrival_date : null;
  const arrivalDate = arrivalTimestamp ? new Date(arrivalTimestamp * 1000) : null;
  const paidAt =
    status === 'PAID' ? (event.created ? new Date(event.created * 1000) : new Date()) : null;
  const failedAt =
    status === 'FAILED' ? (event.created ? new Date(event.created * 1000) : new Date()) : null;
  const failureCode = typeof obj.failure_code === 'string' ? obj.failure_code : null;
  const failureMessage = typeof obj.failure_message === 'string' ? obj.failure_message : null;

  await tx
    .insert(connectedAccountPayouts)
    .values({
      organizationId: orgId,
      provider: 'STRIPE',
      environment,
      providerPayoutId,
      providerAccountId: event.accountId ?? '',
      amountMinor: amount,
      currency,
      status,
      arrivalDate,
      paidAt,
      failedAt,
      failureCode,
      failureMessage,
      providerCreatedAt: typeof obj.created === 'number' ? obj.created : null,
      lastProviderEventAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [
        connectedAccountPayouts.provider,
        connectedAccountPayouts.environment,
        connectedAccountPayouts.providerPayoutId,
      ],
      set: {
        status,
        arrivalDate: arrivalDate ?? sql`${connectedAccountPayouts.arrivalDate}`,
        paidAt: paidAt ?? sql`${connectedAccountPayouts.paidAt}`,
        failedAt: failedAt ?? sql`${connectedAccountPayouts.failedAt}`,
        failureCode: failureCode ?? sql`${connectedAccountPayouts.failureCode}`,
        failureMessage: failureMessage ?? sql`${connectedAccountPayouts.failureMessage}`,
        lastProviderEventAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });

  return 'PROCESSED';
}

/**
 * Projette un événement account.updated dans organization_payment_accounts.
 * Extrait les champs avec une allow-list stricte depuis event.data.object.
 *
 * P1-3 : Garde monotone, validation event.accountId === data.id, fail-closed
 * pour statut inconnu, check row count, SELECT FOR UPDATE de la ligne existante.
 *
 * @returns 'PROCESSED' si la projection a modifié une ligne, 'IGNORED' si
 * l'événement est ancien ou aucune ligne à mettre à jour, 'FAILED' si
 * incohérence irréconciliable (event.accountId !== data.id).
 */
async function projectAccountUpdated(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  environment: 'TEST' | 'LIVE',
  orgId: string,
): Promise<'PROCESSED' | 'IGNORED' | 'FAILED'> {
  const obj = event.data;
  if (!obj || typeof obj !== 'object') return 'IGNORED';

  const accountId = obj.id;
  if (typeof accountId !== 'string' || accountId.length === 0) return 'IGNORED';

  // P1-3 : Valider event.accountId === obj.id.
  if (event.accountId !== accountId) {
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'connect_account_id_mismatch',
        eventAccountId: event.accountId,
        dataAccountId: accountId,
      }),
    );
    return 'FAILED';
  }

  // P1-3 : SELECT FOR UPDATE la ligne existante (filtrée par organization_id).
  const existing = await tx
    .select({
      id: organizationPaymentAccounts.id,
      lastProviderEventAt: organizationPaymentAccounts.lastProviderEventAt,
    })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, accountId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.environment, environment),
        eq(organizationPaymentAccounts.organizationId, orgId),
      ),
    )
    .for('update')
    .limit(1);

  if (existing.length === 0) {
    // Aucune ligne → ne pas projeter.
    return 'IGNORED';
  }

  // P1-3 : Garde monotone — comparer event.created (Unix secondes) avec
  // existing.lastProviderEventAt (timestamp). Si l'événement est antérieur ou
  // de même timestamp, ne pas projeter (éviter la régression).
  const existingRow = existing[0]!;
  if (existingRow.lastProviderEventAt !== null) {
    const existingUnix = Math.floor(existingRow.lastProviderEventAt.getTime() / 1000);
    if (event.created <= existingUnix) {
      // Événement ancien ou de même timestamp — ignorer pour éviter la régression.
      return 'IGNORED';
    }
  }

  // Allow-list stricte des champs à projeter.
  const updates: Record<string, unknown> = {};
  if (typeof obj.charges_enabled === 'boolean') {
    updates.chargesEnabled = obj.charges_enabled;
  }
  if (typeof obj.payouts_enabled === 'boolean') {
    updates.payoutsEnabled = obj.payouts_enabled;
  }
  // P1-6 : Stripe expose la capacité via account.capabilities.transfers
  // (valeurs : active, inactive, pending, unrequested).
  const capabilities = obj.capabilities as Record<string, unknown> | undefined;
  if (capabilities && typeof capabilities === 'object') {
    const transfers = capabilities.transfers;
    if (typeof transfers === 'string') {
      // P1-3 : Fail-closed pour statut inconnu — retourner FAILED au lieu de
      // continuer avec mapped = null (qui permettrait à d'autres champs d'être
      // projetés, lastProviderEventAt d'avancer, et l'événement d'être PROCESSED).
      let mapped: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'UNREQUESTED';
      switch (transfers) {
        case 'active':
          mapped = 'ACTIVE';
          break;
        case 'inactive':
          mapped = 'INACTIVE';
          break;
        case 'pending':
          mapped = 'PENDING';
          break;
        case 'unrequested':
          mapped = 'UNREQUESTED';
          break;
        default:
          // Statut inconnu → FAILED, pas de projection partielle.
          console.warn(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint: 'connect',
              result: 'connect_unknown_capability',
              capability: 'transfers',
              value: transfers,
            }),
          );
          return 'FAILED';
      }
      updates.transfersCapabilityStatus = mapped;

      // Stripe ne fournit pas un statut local `onboarding_status`. Une fois
      // les trois capacités nécessaires aux destination charges actives, le
      // compte est suffisamment vérifié pour passer de SUBMITTED à ENABLED.
      // Le statut ne devient jamais ENABLED sur la seule base du retour
      // navigateur ou d'un champ isolé.
      if (obj.charges_enabled === true && obj.payouts_enabled === true && mapped === 'ACTIVE') {
        updates.onboardingStatus = 'ENABLED';
      }
    }
  }
  // requirements et controller sont des objets complexes.
  // P2-2 : Appliquer la même allow-list que normalizeEventData.
  if (obj.requirements !== undefined && typeof obj.requirements === 'object') {
    const rawRequirements = obj.requirements as Record<string, unknown>;
    const filteredRequirements: Record<string, unknown> = {};
    if (Array.isArray(rawRequirements.currently_due)) {
      filteredRequirements.currently_due = rawRequirements.currently_due;
    }
    if (Array.isArray(rawRequirements.past_due)) {
      filteredRequirements.past_due = rawRequirements.past_due;
    }
    if (Object.keys(filteredRequirements).length > 0) {
      updates.requirementsSnapshot = filteredRequirements;
    }
  }
  if (obj.controller !== undefined && typeof obj.controller === 'object') {
    const rawController = obj.controller as Record<string, unknown>;
    const filteredController: Record<string, unknown> = {};
    if (typeof rawController.fees_collector === 'string') {
      filteredController.fees_collector = rawController.fees_collector;
    }
    if (typeof rawController.is_controller === 'boolean') {
      filteredController.is_controller = rawController.is_controller;
    }
    if (Object.keys(filteredController).length > 0) {
      updates.controllerConfigurationSnapshot = filteredController;
    }
  }

  if (Object.keys(updates).length === 0) return 'IGNORED';

  updates.updatedAt = sql`transaction_timestamp()`;
  // P1-3 : lastProviderEventAt reçoit event.created (Unix timestamp) au lieu
  // de transaction_timestamp().
  updates.lastProviderEventAt = sql`to_timestamp(${event.created})`;

  // P1-3 : Mettre à jour organization_payment_accounts pour ce compte connecté
  // + environnement + organization_id, et vérifier le row count.
  const updated = await tx
    .update(organizationPaymentAccounts)
    .set(updates)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, accountId),
        eq(organizationPaymentAccounts.environment, environment),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.organizationId, orgId),
      ),
    )
    .returning({ id: organizationPaymentAccounts.id });

  // P1-3 : Si 0 ligne modifiée → IGNORED au lieu de PROCESSED.
  if (updated.length === 0) {
    return 'IGNORED';
  }

  return 'PROCESSED';
}

/**
 * Gère un événement de refund : journaliser et projeter le statut.
 * Phase 6 : pas de worker de refund, juste persister l'événement + projeter le statut.
 */
async function handleRefundEvent(
  db: DatabaseClient,
  event: VerifiedWebhookEvent,
  rawBody: string,
  environment: 'TEST' | 'LIVE',
  endpoint: 'platform' | 'connect',
  startTime: number,
): Promise<WebhookHandlerResult> {
  // P1-6 : Même si event.accountId est null, tenter de résoudre le refund via
  // le payment_intent ID présent dans l'événement refund.
  let orgId: string | null = null;
  if (event.accountId) {
    orgId = await resolveOrgFromConnectedAccount(db, event.accountId, environment);
  }

  // P1-1 : Résoudre le paymentId depuis le payment_intent DANS TOUS LES CAS
  // (que orgId vienne déjà de accountId ou non) — sinon, pour un webhook
  // Connect précoce, la branche de rattachement du remboursement LATE orphelin
  // (else if (paymentId) dans projectRefundStatus) n'est jamais exécutée et
  // l'événement est consommé sans projeter SUCCEEDED/FAILED.
  let paymentId: string | null = null;
  // P1-1 : Échec de recoupement des deux sources (accountId ET payment_intent)
  // — l'événement est une anomalie marquée FAILED, jamais acquittée.
  let resolutionFailure: RefundProjectionFailureCode | null = null;
  const piId = extractRefundPaymentIntentId(event);
  if (piId) {
    // P3 : filtrer par environment pour éviter qu'un webhook LIVE résolve
    // un payment TEST (théorique en dev, improbable en prod car les PI IDs
    // sont distincts entre environnements).
    const paymentRow = await db
      .select({
        id: payments.id,
        organizationId: payments.organizationId,
        connectedAccountId: payments.connectedAccountId,
      })
      .from(payments)
      .innerJoin(
        paymentAttempts,
        and(
          eq(paymentAttempts.paymentId, payments.id),
          eq(paymentAttempts.providerPaymentIntentId, piId),
        ),
      )
      .where(eq(payments.environment, environment))
      .limit(1);

    if (paymentRow.length > 0) {
      const resolved = paymentRow[0]!;
      if (event.accountId !== null && orgId !== null && resolved.organizationId !== orgId) {
        // P1-1 : Recoupement — l'organisation du paiement résolu depuis le
        // payment_intent ne concorde pas avec celle résolue depuis accountId.
        console.warn(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            providerEventId: event.id,
            eventType: event.type,
            result: 'refund_org_mismatch',
            expected: resolved.organizationId,
            received: orgId,
            durationMs: Date.now() - startTime,
          }),
        );
        resolutionFailure = 'REFUND_ORG_MISMATCH';
      } else if (event.accountId !== null && resolved.connectedAccountId !== event.accountId) {
        // P1-1 : Recoupement — le compte Connect du paiement ne concorde pas
        // avec event.accountId.
        console.warn(
          JSON.stringify({
            event: 'webhook.stripe',
            endpoint,
            environment,
            providerEventId: event.id,
            eventType: event.type,
            result: 'refund_account_mismatch',
            expected: resolved.connectedAccountId,
            received: event.accountId,
            durationMs: Date.now() - startTime,
          }),
        );
        resolutionFailure = 'REFUND_ACCOUNT_MISMATCH';
      } else {
        if (orgId === null) {
          orgId = resolved.organizationId;
        }
        paymentId = resolved.id;
      }
    }
  }

  // P1-2 : Si toujours non résolu, tenter via le provider_refund_id d'un refund
  // existant. Un refund.updated sans payment_intent peut quand même être rattaché
  // à un paiement local si la ligne refunds existe déjà.
  // P1-1 : Ne pas retenter si un recoupement a déjà échoué (anomalie durable).
  if (orgId === null && resolutionFailure === null) {
    const refundObjects = extractRefundObjects(event);
    for (const refundObj of refundObjects) {
      if (refundObj === null || typeof refundObj !== 'object') continue;
      const refundRecord = refundObj as Record<string, unknown>;
      const refundId = refundRecord.id;
      if (typeof refundId !== 'string' || refundId.length === 0) continue;
      // P3 : filtrer par environment via JOIN payments pour défense en profondeur
      // (les provider_refund_id sont globalement uniques chez Stripe, mais ce filtre
      // empêche tout risque théorique de cross-environment resolution).
      const existingRefund = await db
        .select({
          paymentId: refunds.paymentId,
          organizationId: refunds.organizationId,
        })
        .from(refunds)
        .innerJoin(payments, eq(refunds.paymentId, payments.id))
        .where(and(eq(refunds.providerRefundId, refundId), eq(payments.environment, environment)))
        .limit(1);
      if (existingRefund.length > 0) {
        orgId = existingRefund[0]!.organizationId;
        paymentId = existingRefund[0]!.paymentId;
        break;
      }
    }
  }

  if (orgId === null && resolutionFailure === null) {
    // Non rattachable — persister avec organization_id = NULL + IGNORED.
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint,
        environment,
        providerEventId: event.id,
        eventType: event.type,
        result: 'refund_no_tenant',
        durationMs: Date.now() - startTime,
      }),
    );
  }

  return await db.transaction(async (tx) => {
    const ingest = await ingestEvent(tx, event, rawBody, environment, orgId);

    if (ingest.isDuplicate) {
      console.log(
        JSON.stringify({
          event: 'webhook.stripe',
          endpoint,
          environment,
          providerEventId: event.id,
          eventType: event.type,
          result: 'duplicate',
          durationMs: Date.now() - startTime,
        }),
      );
      return { kind: 'SUCCESS', statusCode: 200 };
    }

    const webhookEventId = ingest.row.id;
    const now = sql`transaction_timestamp()`;

    // P1-4/P1-6 : Projeter le statut du refund dans la table refunds.
    let finalStatus: 'PROCESSED' | 'IGNORED' | 'FAILED' = orgId === null ? 'IGNORED' : 'PROCESSED';
    let failureCode: RefundProjectionFailureCode | undefined;
    if (resolutionFailure !== null) {
      // P1-1 : Recoupement org/compte échoué — anomalie durable, jamais acquittée.
      finalStatus = 'FAILED';
      failureCode = resolutionFailure;
    } else if (orgId !== null) {
      const projection = await projectRefundStatus(
        tx,
        event,
        orgId,
        paymentId,
        endpoint,
        environment,
      );
      finalStatus = projection.result;
      failureCode = projection.failureCode;
    }

    // P1-2/P1-4 : Si FAILED (incohérence), marquer FAILED + failureCode fermé.
    // Retourner 200 (pas 500) pour arrêter les retries Stripe — l'anomalie est
    // persistée et observable, pas récupérable par un retry.
    if (finalStatus === 'FAILED') {
      await tx
        .update(paymentWebhookEvents)
        .set({
          status: 'FAILED',
          failureCode: failureCode ?? 'REFUND_INVARIANT_BROKEN',
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
    } else {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: finalStatus, processedAt: now })
        .where(eq(paymentWebhookEvents.id, webhookEventId));
    }

    console.log(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint,
        environment,
        providerEventId: event.id,
        eventType: event.type,
        result:
          finalStatus === 'FAILED'
            ? 'refund_failed'
            : finalStatus === 'IGNORED'
              ? 'refund_ignored'
              : 'refund_logged',
        failureCode: failureCode,
        organizationId: orgId,
        durationMs: Date.now() - startTime,
      }),
    );
    return { kind: 'SUCCESS', statusCode: 200 };
  });
}

/**
 * Extrait le payment_intent ID depuis un événement de refund.
 * Les événements charge.refunded / refund.created / refund.updated contiennent
 * un objet refund avec un champ `payment_intent`.
 */
function extractRefundPaymentIntentId(event: VerifiedWebhookEvent): string | null {
  const obj = event.data;
  if (!obj || typeof obj !== 'object') return null;

  // Pour charge.refunded, l'objet est une charge avec payment_intent.
  // Pour refund.created/refund.updated, l'objet est un refund avec payment_intent.
  const piId = obj.payment_intent;
  if (typeof piId === 'string' && piId.length > 0) {
    return piId;
  }

  // Pour charge.refunded, le refund peut être dans charges.refunds.data (ApiList<Refund>).
  const refundsData = obj.refunds;
  if (refundsData && typeof refundsData === 'object') {
    const refundsList = refundsData as Record<string, unknown>;
    const data = refundsList.data;
    if (Array.isArray(data)) {
      for (const refund of data) {
        if (refund && typeof refund === 'object') {
          const refundPiId = (refund as Record<string, unknown>).payment_intent;
          if (typeof refundPiId === 'string' && refundPiId.length > 0) {
            return refundPiId;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extrait les objets refund depuis un événement Stripe.
 * - Pour charge.refunded : l'objet est une charge avec `refunds.data = Refund[]`.
 * - Pour refund.created / refund.updated / refund.failed : l'objet est le refund lui-même.
 *
 * P1-3 : Ne filtre PAS les éléments non-objets — la validation se fait dans le
 * savepoint pour garantir l'atomicité « tout ou rien ». Un élément non-objet
 * déclenchera REFUND_OBJECT_INVALID et annulera toutes les projections partielles.
 */
function extractRefundObjects(event: VerifiedWebhookEvent): unknown[] {
  const obj = event.data;
  if (!obj || typeof obj !== 'object') return [];

  if (event.type === 'charge.refunded') {
    // Stripe expose charge.refunds = ApiList<Refund> avec charge.refunds.data = Refund[].
    const refundsData = obj.refunds;
    if (refundsData && typeof refundsData === 'object' && refundsData !== null) {
      const refundsList = refundsData as Record<string, unknown>;
      const data = refundsList.data;
      if (Array.isArray(data)) {
        return data; // Ne pas filtrer — valider dans le savepoint
      }
    }
    return [];
  }

  // refund.created / refund.updated / refund.failed : l'objet est le refund lui-même.
  return [obj];
}

/**
 * Projette le statut d'un refund dans la table refunds.
 * Cherche par provider_refund_id ou crée une ligne si non existante.
 * Ne crée une ligne que si on a un paymentId local identifié ET un provider_refund_id.
 * Les refunds externes sans ligne locale sont journalisés (warn) sans invention de raison.
 *
 * P1-4 : Garde monotone (providerEventCreatedAt), recoupement payment_intent,
 * montant, devise, organisation sur ligne existante. SELECT FOR UPDATE.
 *
 * R1-P2-3 : Recoupement explicite du connected_account_id quand l'événement
 * expose un compte Connect (endpoint connect). Sur l'endpoint platform
 * (accountId null), l'organisation est résolue depuis le compte ou le
 * payment_intent et le recoupement orgId existant suffit.
 *
 * P1-1 : Avant tout EXTERNAL_REFUND, rattache atomiquement le remboursement
 * LATE_PAYMENT_NO_BOOKING orphelin du paiement (provider_refund_id encore NULL)
 * — le webhook peut arriver avant que le worker de compensation ne persiste
 * provider_refund_id. Jamais de doublon EXTERNAL_REFUND pour ce remboursement.
 *
 * @returns { result: 'PROCESSED' } si au moins un refund a été projeté,
 * { result: 'IGNORED' } si aucun, { result: 'FAILED', failureCode } si
 * incohérence irréconciliable (refund invalide ou mismatch).
 */
async function projectRefundStatus(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  orgId: string,
  paymentId: string | null,
  endpoint: 'platform' | 'connect',
  environment: 'TEST' | 'LIVE',
): Promise<{
  result: 'PROCESSED' | 'IGNORED' | 'FAILED';
  failureCode?: RefundProjectionFailureCode;
}> {
  const refundObjects = extractRefundObjects(event);
  let anyProjected = false;
  let failure: { code: RefundProjectionFailureCode } | null = null;

  // P1-1 : Wraper toute la projection dans un savepoint. Si un refund est
  // invalide, le savepoint est annulé (ROLLBACK TO SAVEPOINT) — aucune
  // projection partielle n'est commitée.
  try {
    await tx.transaction(async (sp) => {
      // P1 : Si aucun objet refund exploitable n'a pu être extrait, lever une
      // anomalie plutôt que d'acquitter silencieusement l'événement (IGNORED +
      // 200 + déduplication empêcherait tout retraitement ultérieur).
      if (refundObjects.length === 0) {
        throw new RefundProjectionError('REFUND_OBJECTS_MISSING');
      }
      for (const refundObj of refundObjects) {
        // P1-3 : Valider que chaque élément est un objet non-null avant tout
        // traitement. Un élément non-objet déclenche REFUND_OBJECT_INVALID et
        // annule toutes les projections partielles (savepoint).
        if (refundObj === null || typeof refundObj !== 'object') {
          throw new RefundProjectionError('REFUND_OBJECT_INVALID');
        }
        // Maintenant on peut accéder aux propriétés
        const refundRecord = refundObj as Record<string, unknown>;
        const refundId = refundRecord.id;
        // P1 : identifiant de remboursement absent → anomalie (pas de skip).
        if (typeof refundId !== 'string' || refundId.length === 0) {
          throw new RefundProjectionError('REFUND_ID_MISSING');
        }

        const refundMetadata = refundRecord.metadata;
        const metadataKeys =
          refundMetadata !== null && typeof refundMetadata === 'object'
            ? Object.keys(refundMetadata as Record<string, unknown>).sort()
            : [];
        const hasRefundMetadata = metadataKeys.length > 0;
        if (hasRefundMetadata) {
          await projectTaggedBookingModificationRefund(
            sp,
            event,
            environment,
            orgId,
            refundRecord,
            refundMetadata,
          );
          anyProjected = true;
          continue;
        }

        const refundStatus = refundRecord.status;
        // P1 : statut absent → anomalie (pas de skip).
        if (typeof refundStatus !== 'string') {
          throw new RefundProjectionError('REFUND_STATUS_MISSING');
        }

        // Mapper le statut Stripe vers notre enum refund_status.
        // Note : `SUBMITTED` provient uniquement de la soumission locale au
        // fournisseur, pas d'un état webhook Stripe. `processing` n'est pas une
        // valeur valide de Refund.status (c'est une valeur possible de
        // pending_reason) — il déclenchera REFUND_PROVIDER_STATE_UNSUPPORTED.
        let mappedStatus: 'PENDING' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | null = null;
        if (refundStatus === 'succeeded') mappedStatus = 'SUCCEEDED';
        else if (refundStatus === 'failed') mappedStatus = 'FAILED';
        else if (refundStatus === 'canceled') mappedStatus = 'FAILED';
        else if (refundStatus === 'pending' || refundStatus === 'requires_action')
          mappedStatus = 'PENDING';

        // P1 : statut Stripe inconnu → anomalie (pas de skip).
        if (mappedStatus === null) {
          throw new RefundProjectionError('REFUND_PROVIDER_STATE_UNSUPPORTED');
        }

        const now = sql`transaction_timestamp()`;

        // P1-4 : SELECT FOR UPDATE le refund existant par provider_refund_id.
        const existing = await sp
          .select({
            id: refunds.id,
            organizationId: refunds.organizationId,
            paymentId: refunds.paymentId,
            amountMinor: refunds.amountMinor,
            providerEventCreatedAt: refunds.providerEventCreatedAt,
            status: refunds.status,
          })
          .from(refunds)
          .where(eq(refunds.providerRefundId, refundId))
          .for('update')
          .limit(1);

        if (existing.length > 0) {
          const existingRow = existing[0]!;

          // P1-4 : Garde monotone — comparer event.created avec
          // existing.providerEventCreatedAt. Si l'événement est antérieur ou de
          // même timestamp, skip (ne pas régresser le statut).
          if (
            existingRow.providerEventCreatedAt !== null &&
            event.created <= existingRow.providerEventCreatedAt
          ) {
            // Événement ancien ou de même timestamp — ne pas régresser le statut.
            continue;
          }

          // P2-2 : Machine de transitions — un refund terminal (SUCCEEDED/FAILED) est
          // immuable. Toute transition depuis un état terminal vers un état différent
          // est une anomalie de réconciliation : journaliser sans écraser l'état.
          const TERMINAL_REFUND_STATUSES = new Set(['SUCCEEDED', 'FAILED']);
          if (
            TERMINAL_REFUND_STATUSES.has(existingRow.status) &&
            mappedStatus !== existingRow.status
          ) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_terminal_regression',
                providerRefundId: refundId,
                fromStatus: existingRow.status,
                toStatus: mappedStatus,
                providerEventCreatedAt: event.created,
              }),
            );
            // P2-3 : Marquer FAILED au lieu de IGNORED — signal de réconciliation durable.
            throw new RefundProjectionError('REFUND_TERMINAL_STATE_CONFLICT');
          }

          // P1-2 : payment_intent OBLIGATOIRE pour un refund existant.
          const refundPiId = refundRecord.payment_intent;
          if (typeof refundPiId !== 'string' || refundPiId.length === 0) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_pi_missing',
                providerRefundId: refundId,
              }),
            );
            throw new RefundProjectionError('REFUND_PI_MISSING');
          }
          // G7M-A : un refund d'origine amendement (amendment_payment_id) a
          // payment_id NULL. Le projecteur legacy ne sait pas encore résoudre
          // amendment_payment_id — la branche webhook complète pour les origines
          // d'amendement est différée au lot webhook G7M. On fail-closed pour
          // éviter une JOIN incorrecte ou une projection silencieuse.
          if (existingRow.paymentId === null) {
            throw new RefundProjectionError('REFUND_PI_MISSING');
          }
          // Vérifier la correspondance du payment_intent.
          const existingPayment = await sp
            .select({ id: payments.id, connectedAccountId: payments.connectedAccountId })
            .from(payments)
            .innerJoin(paymentAttempts, eq(paymentAttempts.paymentId, existingRow.paymentId))
            .where(eq(paymentAttempts.providerPaymentIntentId, refundPiId))
            .limit(1);
          if (existingPayment.length === 0 || existingPayment[0]!.id !== existingRow.paymentId) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_payment_intent_mismatch',
                providerRefundId: refundId,
                expectedPaymentId: existingRow.paymentId,
              }),
            );
            throw new RefundProjectionError('REFUND_PI_MISMATCH');
          }

          // R1-P2-3 : Recoupement explicite du compte Connect quand l'événement
          // l'expose (endpoint connect, event.accountId non null). Sur l'endpoint
          // platform, accountId est null : l'organisation est résolue depuis le
          // compte ou le payment_intent en amont et le recoupement orgId
          // (REFUND_ORG_MISMATCH ci-dessous) suffit — le paiement et son compte
          // Connect appartiennent à la même organisation.
          if (
            event.accountId !== null &&
            existingPayment[0]!.connectedAccountId !== event.accountId
          ) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_account_mismatch',
                providerRefundId: refundId,
                expected: existingPayment[0]!.connectedAccountId,
                received: event.accountId,
              }),
            );
            throw new RefundProjectionError('REFUND_ACCOUNT_MISMATCH');
          }

          // P1-2 : amount OBLIGATOIRE pour un refund existant. P2-4 : un refund
          // de montant 0 n'a aucun sens métier — aligné avec la contrainte DB
          // stricte (refunds_amount_positive > 0) et le chemin « nouveau refund ».
          const refundAmount = refundRecord.amount;
          if (
            typeof refundAmount !== 'number' ||
            !Number.isSafeInteger(refundAmount) ||
            refundAmount <= 0
          ) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_invalid_amount',
                providerRefundId: refundId,
                amount: refundAmount,
              }),
            );
            throw new RefundProjectionError('REFUND_INVALID_AMOUNT');
          }
          if (refundAmount !== existingRow.amountMinor) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_amount_mismatch',
                providerRefundId: refundId,
                expected: existingRow.amountMinor,
                received: refundAmount,
              }),
            );
            throw new RefundProjectionError('REFUND_AMOUNT_MISMATCH');
          }

          // P1-2 : currency OBLIGATOIRE pour un refund existant.
          const refundCurrency = refundRecord.currency;
          if (typeof refundCurrency !== 'string' || refundCurrency.length === 0) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_currency_missing',
                providerRefundId: refundId,
              }),
            );
            throw new RefundProjectionError('REFUND_CURRENCY_MISSING');
          }
          if (refundCurrency.toLowerCase() !== 'eur') {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_currency_mismatch',
                providerRefundId: refundId,
                received: refundCurrency,
              }),
            );
            throw new RefundProjectionError('REFUND_CURRENCY_MISMATCH');
          }

          // P1-4 : Recouper org.
          if (existingRow.organizationId !== orgId) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_org_mismatch',
                providerRefundId: refundId,
                expected: existingRow.organizationId,
                received: orgId,
              }),
            );
            throw new RefundProjectionError('REFUND_ORG_MISMATCH');
          }

          // P2-2 : Ne pas régresser SUBMITTED → PENDING. SUBMITTED est un état local
          // signifiant "createRefund accepté par Stripe" — un webhook requires_action
          // (projeté PENDING) ne doit pas annuler cette soumission.
          const effectiveStatus =
            existingRow.status === 'SUBMITTED' && mappedStatus === 'PENDING'
              ? 'SUBMITTED'
              : mappedStatus;

          // Mettre à jour le statut du refund existant + providerEventCreatedAt.
          const updateData: Record<string, unknown> = {
            status: effectiveStatus,
            updatedAt: now,
            providerEventCreatedAt: event.created,
          };
          if (effectiveStatus === 'SUCCEEDED') {
            updateData.succeededAt = now;
            await scheduleRefundConfirmedNotification(sp, existingRow.id);
          }
          if (effectiveStatus === 'FAILED') {
            updateData.failedAt = now;
            updateData.failureCode = 'STRIPE_REFUND_FAILED';
            await scheduleRefundActionRequiredNotification(
              sp,
              existingRow.id,
              'STRIPE_REFUND_FAILED',
            );
          }
          await sp.update(refunds).set(updateData).where(eq(refunds.id, existingRow.id));
          anyProjected = true;
        } else if (paymentId) {
          // R1-P2-3 : Recoupement explicite du compte Connect du paiement local
          // quand l'événement expose event.accountId (endpoint connect). Couvre
          // à la fois le rattachement du remboursement LATE orphelin et
          // l'insertion EXTERNAL_REFUND ci-dessous. Sur l'endpoint platform,
          // accountId est null : l'organisation est résolue depuis le compte ou
          // le payment_intent en amont, et le paiement (dont le compte Connect
          // est celui de l'organisation) est déjà recoupé par payment_intent —
          // la vérification existante suffit.
          if (event.accountId !== null) {
            const paymentAccount = await sp
              .select({ connectedAccountId: payments.connectedAccountId })
              .from(payments)
              .where(eq(payments.id, paymentId))
              .limit(1);
            if (
              paymentAccount.length === 0 ||
              paymentAccount[0]!.connectedAccountId !== event.accountId
            ) {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  result: 'refund_account_mismatch',
                  providerRefundId: refundId,
                  paymentId,
                  expected: paymentAccount[0]?.connectedAccountId ?? null,
                  received: event.accountId,
                }),
              );
              throw new RefundProjectionError('REFUND_ACCOUNT_MISMATCH');
            }
          }

          // P1-1 : Avant d'envisager un EXTERNAL_REFUND, rechercher le remboursement
          // LATE_PAYMENT_NO_BOOKING du même paiement encore sans identifiant fournisseur
          // (le worker peut ne pas avoir encore persisté provider_refund_id).
          // SELECT FOR UPDATE pour verrouiller la ligne et empêcher la Phase 3
          // concurrente de créer un conflit.
          const orphanLateRefund = await sp
            .select({
              id: refunds.id,
              organizationId: refunds.organizationId,
              paymentId: refunds.paymentId,
              amountMinor: refunds.amountMinor,
              status: refunds.status,
              providerEventCreatedAt: refunds.providerEventCreatedAt,
            })
            .from(refunds)
            .where(
              and(
                eq(refunds.paymentId, paymentId),
                eq(refunds.reason, 'LATE_PAYMENT_NO_BOOKING'),
                isNull(refunds.providerRefundId),
              ),
            )
            .for('update')
            .limit(1);

          if (orphanLateRefund.length > 0) {
            const orphanRow = orphanLateRefund[0]!;

            // P1-1 : Montant — le remboursement LATE couvre le total du paiement.
            // Tout écart est une anomalie financière irréconciliable.
            const orphanAmount = refundRecord.amount;
            if (
              typeof orphanAmount !== 'number' ||
              !Number.isSafeInteger(orphanAmount) ||
              orphanAmount <= 0
            ) {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  result: 'refund_invalid_amount',
                  providerRefundId: refundId,
                  amount: orphanAmount,
                }),
              );
              throw new RefundProjectionError('REFUND_INVALID_AMOUNT');
            }
            if (orphanAmount !== orphanRow.amountMinor) {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  result: 'refund_amount_mismatch',
                  providerRefundId: refundId,
                  expected: orphanRow.amountMinor,
                  received: orphanAmount,
                }),
              );
              throw new RefundProjectionError('REFUND_AMOUNT_MISMATCH');
            }

            // P1-1 : Devise EUR obligatoire, comme pour le chemin EXTERNAL_REFUND.
            const orphanCurrency =
              typeof refundRecord.currency === 'string'
                ? refundRecord.currency.toUpperCase()
                : null;
            if (orphanCurrency !== 'EUR') {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  result: 'refund_currency_mismatch',
                  providerRefundId: refundId,
                  currency: refundRecord.currency,
                }),
              );
              throw new RefundProjectionError('REFUND_CURRENCY_MISMATCH');
            }

            // P1-1 : Garde monotone — si l'événement est antérieur ou de même
            // timestamp, ne rien rattacher MAIS ne pas créer d'EXTERNAL_REFUND
            // non plus (le remboursement appartient déjà à ce paiement).
            if (
              orphanRow.providerEventCreatedAt !== null &&
              event.created <= orphanRow.providerEventCreatedAt
            ) {
              continue;
            }

            // P1-1 : Machine de transitions terminale — un remboursement LATE
            // déjà terminal ne peut pas régresser vers un statut différent.
            const TERMINAL_ORPHAN_STATUSES = new Set(['SUCCEEDED', 'FAILED']);
            if (
              TERMINAL_ORPHAN_STATUSES.has(orphanRow.status) &&
              mappedStatus !== orphanRow.status
            ) {
              console.warn(
                JSON.stringify({
                  event: 'webhook.stripe',
                  endpoint,
                  result: 'refund_terminal_regression',
                  providerRefundId: refundId,
                  fromStatus: orphanRow.status,
                  toStatus: mappedStatus,
                  providerEventCreatedAt: event.created,
                }),
              );
              throw new RefundProjectionError('REFUND_TERMINAL_STATE_CONFLICT');
            }

            // P1-1 : Rattachement atomique — attribuer provider_refund_id et
            // projeter le statut sur le remboursement LATE, sans JAMAIS insérer
            // d'EXTERNAL_REFUND (sinon la Phase 3 du worker entrerait en conflit
            // unique sur provider_refund_id).
            // P2-2 : Ne pas régresser SUBMITTED → PENDING (cf. chemin existing refund).
            const orphanEffectiveStatus =
              orphanRow.status === 'SUBMITTED' && mappedStatus === 'PENDING'
                ? 'SUBMITTED'
                : mappedStatus;

            const orphanUpdate: Record<string, unknown> = {
              providerRefundId: refundId,
              status: orphanEffectiveStatus,
              updatedAt: now,
              providerEventCreatedAt: event.created,
            };
            if (orphanEffectiveStatus === 'SUCCEEDED') orphanUpdate.succeededAt = now;
            if (orphanEffectiveStatus === 'FAILED') {
              orphanUpdate.failedAt = now;
              orphanUpdate.failureCode = 'STRIPE_REFUND_FAILED';
            }
            await sp.update(refunds).set(orphanUpdate).where(eq(refunds.id, orphanRow.id));
            anyProjected = true;
            continue;
          }

          // Créer une ligne refunds si on a le paymentId local ET le provider_refund_id.
          // P1-2 : Valider l'autorité financière du nouveau refund avant l'insertion.
          // P1-2 : Un refund incohérent rattaché à un paiement est une anomalie
          // financière qui doit être persistée comme FAILED, pas ignorée silencieusement.

          // PaymentIntent : OBLIGATOIRE — un refund sans payment_intent est une
          // anomalie financière (refund non rattachable à un paiement local).
          const refundPiId = refundRecord.payment_intent;
          if (typeof refundPiId !== 'string' || refundPiId.length === 0) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_pi_missing',
                providerRefundId: refundId,
              }),
            );
            throw new RefundProjectionError('REFUND_PI_MISSING');
          }

          const amount = refundRecord.amount;

          // Montant : doit être un entier strictement positif.
          if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_invalid_amount',
                providerRefundId: refundId,
                amount,
              }),
            );
            throw new RefundProjectionError('REFUND_INVALID_AMOUNT');
          }

          // Devise : doit être 'eur' (minuscules chez Stripe) ou 'EUR'.
          const refundCurrency =
            typeof refundRecord.currency === 'string' ? refundRecord.currency.toUpperCase() : null;
          if (refundCurrency !== 'EUR') {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_currency_mismatch',
                providerRefundId: refundId,
                currency: refundRecord.currency,
              }),
            );
            throw new RefundProjectionError('REFUND_CURRENCY_MISMATCH');
          }

          // PaymentIntent : doit correspondre au PI du paiement local (via join sur
          // payment_attempts). Un mismatch est une anomalie financière → FAILED.
          const paymentRow = await sp
            .select({ id: payments.id })
            .from(payments)
            .innerJoin(paymentAttempts, eq(paymentAttempts.paymentId, payments.id))
            .where(
              and(
                eq(payments.id, paymentId),
                eq(paymentAttempts.providerPaymentIntentId, refundPiId),
              ),
            )
            .limit(1);
          if (paymentRow.length === 0) {
            console.warn(
              JSON.stringify({
                event: 'webhook.stripe',
                endpoint,
                result: 'refund_pi_mismatch',
                providerRefundId: refundId,
                paymentIntentId: refundPiId,
              }),
            );
            throw new RefundProjectionError('REFUND_PI_MISMATCH');
          }

          // Insertion avec devise validée (pas hardcodée).
          await sp
            .insert(refunds)
            .values({
              organizationId: orgId,
              paymentId,
              reason: 'EXTERNAL_REFUND',
              status: mappedStatus,
              amountMinor: amount,
              currency: 'EUR', // Validé ci-dessus
              providerRefundId: refundId,
              providerIdempotencyKey: `refund_external_${refundId}`,
              reverseTransfer: true,
              refundApplicationFee: true,
              requestedAt: now,
              providerEventCreatedAt: event.created,
              succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
              failedAt: mappedStatus === 'FAILED' ? now : null,
              failureCode: mappedStatus === 'FAILED' ? 'STRIPE_REFUND_FAILED' : null,
            })
            .onConflictDoNothing({
              target: [refunds.providerIdempotencyKey],
            });
          anyProjected = true;
        } else {
          // Refund externe sans ligne locale correspondante — journaliser sans inventer.
          console.warn(
            JSON.stringify({
              event: 'webhook.stripe',
              endpoint,
              result: 'external_refund_no_local_payment',
              providerRefundId: refundId,
              refundStatus,
            }),
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof RefundProjectionError) {
      failure = { code: error.code };
    } else {
      throw error; // Erreur technique → rollback global
    }
  }

  if (failure) {
    return { result: 'FAILED', failureCode: failure.code };
  }
  return { result: anyProjected ? 'PROCESSED' : 'IGNORED' };
}

/**
 * Handles the B2-B2A tagged refund path before the legacy provider-id/amount
 * fallbacks. The metadata is the only safe identity when the worker has not
 * persisted provider_refund_id yet.
 */
async function projectTaggedBookingModificationRefund(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  environment: 'TEST' | 'LIVE',
  orgId: string,
  refundRecord: Record<string, unknown>,
  rawMetadata: unknown,
): Promise<void> {
  if (rawMetadata === null || typeof rawMetadata !== 'object') {
    throw new RefundProjectionError('REFUND_METADATA_INVALID');
  }
  const metadata = rawMetadata as Record<string, unknown>;
  const keys = Object.keys(metadata).sort();
  if (keys.join(',') !== 'organization_id,protocol_version,refund_id') {
    throw new RefundProjectionError('REFUND_METADATA_INVALID');
  }
  const refundId = metadata.refund_id;
  const metadataOrganizationId = metadata.organization_id;
  const protocolVersion = metadata.protocol_version;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof refundId !== 'string' ||
    typeof metadataOrganizationId !== 'string' ||
    typeof protocolVersion !== 'string' ||
    !uuidRegex.test(refundId) ||
    !uuidRegex.test(metadataOrganizationId) ||
    protocolVersion !== 'refund-requested-v1'
  ) {
    throw new RefundProjectionError('REFUND_METADATA_INVALID');
  }
  if (metadataOrganizationId !== orgId) {
    throw new RefundProjectionError('REFUND_ORG_MISMATCH');
  }

  const refundRows = await tx
    .select({
      id: refunds.id,
      organizationId: refunds.organizationId,
      paymentId: refunds.paymentId,
      reason: refunds.reason,
      amountMinor: refunds.amountMinor,
      currency: refunds.currency,
      status: refunds.status,
      providerRefundId: refunds.providerRefundId,
      providerEventCreatedAt: refunds.providerEventCreatedAt,
    })
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .for('update')
    .limit(1);
  const localRefund = refundRows[0];
  if (localRefund === undefined) {
    throw new RefundProjectionError('REFUND_METADATA_NOT_FOUND');
  }
  if (localRefund.reason !== 'BOOKING_MODIFICATION') {
    throw new RefundProjectionError('REFUND_REASON_MISMATCH');
  }
  if (
    localRefund.organizationId !== orgId ||
    localRefund.paymentId === null ||
    localRefund.currency !== 'EUR'
  ) {
    throw new RefundProjectionError('REFUND_ORG_MISMATCH');
  }

  const paymentIntentId = refundRecord.payment_intent;
  if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0) {
    throw new RefundProjectionError('REFUND_PI_MISSING');
  }
  const paymentRows = await tx
    .select({
      id: payments.id,
      organizationId: payments.organizationId,
      connectedAccountId: payments.connectedAccountId,
      environment: payments.environment,
      paymentMarketplaceFeeSnapshot: payments.marketplaceFeeSnapshot,
      bookingMarketplaceFeeSnapshot: bookings.marketplaceFeeSnapshot,
    })
    .from(payments)
    .innerJoin(paymentAttempts, eq(paymentAttempts.paymentId, payments.id))
    .innerJoin(bookings, eq(bookings.paymentId, payments.id))
    .where(
      and(
        eq(payments.id, localRefund.paymentId),
        eq(payments.organizationId, orgId),
        eq(payments.status, 'SUCCEEDED'),
        eq(payments.environment, environment),
        eq(paymentAttempts.status, 'SUCCEEDED'),
        eq(paymentAttempts.providerPaymentIntentId, paymentIntentId),
      ),
    )
    .for('update')
    .limit(1);
  if (paymentRows.length === 0) throw new RefundProjectionError('REFUND_PI_MISMATCH');
  if (
    (paymentRows[0]!.paymentMarketplaceFeeSnapshot !== null &&
      paymentRows[0]!.paymentMarketplaceFeeSnapshot !== undefined) ||
    (paymentRows[0]!.bookingMarketplaceFeeSnapshot !== null &&
      paymentRows[0]!.bookingMarketplaceFeeSnapshot !== undefined)
  ) {
    throw new RefundProjectionError('REFUND_INVARIANT_BROKEN');
  }
  if (event.accountId !== null && paymentRows[0]!.connectedAccountId !== event.accountId) {
    throw new RefundProjectionError('REFUND_ACCOUNT_MISMATCH');
  }

  const amount = refundRecord.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new RefundProjectionError('REFUND_INVALID_AMOUNT');
  }
  if (amount !== localRefund.amountMinor) throw new RefundProjectionError('REFUND_AMOUNT_MISMATCH');
  if (typeof refundRecord.currency !== 'string' || refundRecord.currency.toUpperCase() !== 'EUR') {
    throw new RefundProjectionError('REFUND_CURRENCY_MISMATCH');
  }
  if (localRefund.providerRefundId !== null && localRefund.providerRefundId !== refundRecord.id) {
    throw new RefundProjectionError('REFUND_INVARIANT_BROKEN');
  }

  const providerStatus = refundRecord.status;
  let mappedStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED_REQUIRES_MANUAL_ACTION';
  if (providerStatus === 'succeeded') mappedStatus = 'SUCCEEDED';
  else if (providerStatus === 'failed' || providerStatus === 'canceled') {
    mappedStatus = 'FAILED_REQUIRES_MANUAL_ACTION';
  } else if (providerStatus === 'pending' || providerStatus === 'requires_action') {
    mappedStatus = 'PENDING';
  } else {
    throw new RefundProjectionError('REFUND_PROVIDER_STATE_UNSUPPORTED');
  }

  if (
    localRefund.providerEventCreatedAt !== null &&
    event.created <= localRefund.providerEventCreatedAt
  ) {
    return;
  }
  if (
    (localRefund.status === 'SUCCEEDED' ||
      localRefund.status === 'FAILED_REQUIRES_MANUAL_ACTION' ||
      localRefund.status === 'SETTLED_OFF_PLATFORM') &&
    mappedStatus !== localRefund.status
  ) {
    return;
  }
  const effectiveStatus =
    localRefund.status === 'SUBMITTED' && mappedStatus === 'PENDING' ? 'SUBMITTED' : mappedStatus;
  const now = sql`transaction_timestamp()`;
  const updateData: Record<string, unknown> = {
    providerRefundId: refundRecord.id,
    status: effectiveStatus,
    providerEventCreatedAt: event.created,
    updatedAt: now,
  };
  if (effectiveStatus === 'SUCCEEDED') updateData.succeededAt = now;
  if (effectiveStatus === 'FAILED_REQUIRES_MANUAL_ACTION') {
    updateData.failedAt = now;
    updateData.failureCode = 'STRIPE_REFUND_FAILED';
  }
  await tx.update(refunds).set(updateData).where(eq(refunds.id, localRefund.id));
}

/**
 * Journalise un événement non rattachable (aucune tentative trouvée).
 * Tente d'insérer la ligne webhook avec organization_id résolu depuis le
 * compte connecté ou le payment_intent, sinon avec un UUID nil et marque IGNORED.
 * Ne JAMAIS retourner 200 sans persistance.
 */
async function logUnattachedEvent(
  db: DatabaseClient,
  event: VerifiedWebhookEvent,
  rawBody: string,
  environment: 'TEST' | 'LIVE',
  _startTime: number,
): Promise<void> {
  let orgId: string | null = null;
  if (event.accountId) {
    orgId = await resolveOrgFromConnectedAccount(db, event.accountId, environment);
  }

  // Si pas d'org via accountId, tenter via le payment_intent ID dans les metadata.
  if (orgId === null) {
    const piId = event.objectId;
    if (piId && piId.startsWith('pi_')) {
      // P3 : filtrer par environment pour défense en profondeur (empêche tout
      // risque théorique de cross-environment resolution via payment_intent).
      const paymentRow = await db
        .select({ organizationId: payments.organizationId })
        .from(payments)
        .innerJoin(paymentAttempts, eq(paymentAttempts.providerPaymentIntentId, piId))
        .where(
          and(
            eq(paymentAttempts.providerPaymentIntentId, piId),
            eq(payments.environment, environment),
          ),
        )
        .limit(1);

      if (paymentRow.length > 0) {
        orgId = paymentRow[0]!.organizationId;
      }
    }
  }

  // Si vraiment non rattachable, utiliser organization_id = NULL et marquer IGNORED.
  const effectiveOrgId = orgId ?? null;

  try {
    await db.transaction(async (tx) => {
      const ingest = await ingestEvent(tx, event, rawBody, environment, effectiveOrgId);
      if (!ingest.isDuplicate) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: 'IGNORED', processedAt: sql`transaction_timestamp()` })
          .where(eq(paymentWebhookEvents.id, ingest.row.id));
      }
    });
  } catch (error) {
    // Ne pas avaler silencieusement : logger l'erreur technique.
    // Si l'insertion échoue pour une raison autre que la FK (qui ne devrait
    // plus arriver depuis que organization_id est nullable), retourner 500.
    throw error;
  }
}
