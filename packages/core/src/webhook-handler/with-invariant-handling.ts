/**
 * @uttily/core — Helper de gestion des invariants irréconciliables (P1-2, ADR-010 §D).
 *
 * Wrap une fonction handler pour capturer les invariants irréconciliables.
 * - WebhookHandlerError avec statusCode > 200 : ROLLBACK TO SAVEPOINT des
 *   écritures métier, puis marque FAILED dans la transaction extérieure (qui
 *   commit) et retourne l'erreur.
 * - WebhookHandlerError avec statusCode 200 (soft errors comme LATE_PAYMENT,
 *   ALREADY_PROCESSED) : re-lance pour que l'appelant gère le flux normal.
 * - Autres erreurs (techniques transitoires) : re-lance → rollback + 5xx.
 *
 * P1-1 (atomicité) : Le handler métier s'exécute dans un SAVEPOINT (transaction
 * imbriquée Drizzle via `tx.transaction()`). Si un invariant irréconciliable
 * est levé APRÈS des écritures métier (bookings, booking_lines, holds
 * CONVERTED), le ROLLBACK TO SAVEPOINT annule toutes ces écritures, puis on
 * persiste le statut FAILED dans la transaction extérieure (qui commit). Sans
 * savepoint, les écritures partielles seraient committées avec un événement
 * FAILED, laissant l'agrégat dans un état incohérent.
 */

import type { DatabaseTransaction } from '@uttily/database';
import { WebhookHandlerError, isIrreconcilable } from './errors';
import { markWebhookFailed } from './dedupe-event';
import type { HandlerOutcome } from './types';

/**
 * Wrap une fonction handler pour capturer les invariants irréconciliables.
 *
 * Le handler s'exécute dans un SAVEPOINT (transaction imbriquée Drizzle). En
 * cas d'invariant irréconciliable, le savepoint est automatiquement annulé par
 * le driver (postgres.js), puis le statut FAILED est persisté dans la
 * transaction extérieure (qui commit). Les écritures métier partielles sont
 * ainsi annulées tout en persistant l'échec.
 *
 * @param tx Transaction active (extérieure).
 * @param webhookEventId ID de la ligne payment_webhook_events.
 * @param fn Fonction handler à exécuter dans le savepoint. Reçoit la
 *   transaction du savepoint (`sp`) — toutes les écritures métier doivent
 *   utiliser cette transaction pour être couvertes par le ROLLBACK TO SAVEPOINT.
 * @returns Le résultat de `fn`, ou `WebhookHandlerError` si un invariant
 *   irréconciliable a été capturé (l'événement est marqué FAILED dans la
 *   transaction extérieure).
 */
export async function withInvariantHandling<T>(
  tx: DatabaseTransaction,
  webhookEventId: string,
  fn: (sp: DatabaseTransaction) => Promise<T>,
): Promise<T | WebhookHandlerError> {
  try {
    // Le handler métier s'exécute dans un SAVEPOINT (transaction imbriquée
    // Drizzle). Si une erreur est levée, le driver annule automatiquement le
    // savepoint (ROLLBACK TO SAVEPOINT) et la transaction extérieure (tx)
    // reste utilisable pour persister le statut FAILED.
    return await tx.transaction(async (sp) => {
      return await fn(sp);
    });
  } catch (error) {
    if (error instanceof WebhookHandlerError) {
      if (isIrreconcilable(error)) {
        // Le savepoint a été automatiquement annulé par le driver.
        // La transaction extérieure (tx) est intacte : persister FAILED
        // + failureCode, puis retourner l'erreur (pas de re-throw) pour
        // que la transaction extérieure commit avec le statut FAILED.
        const marked = await markWebhookFailed(tx, webhookEventId, error.code);
        if (!marked) {
          // L'événement n'était plus RECEIVED — un worker concurrent l'a traité.
          console.warn(
            JSON.stringify({
              event: 'webhook.stripe',
              result: 'mark_failed_concurrent',
              webhookEventId,
              errorCode: error.code,
            }),
          );
        }
        return error;
      }
      // Control flow (WEBHOOK_LATE_PAYMENT, WEBHOOK_ALREADY_PROCESSED) → re-throw.
      // Le savepoint a été annulé (aucune écriture métier à conserver).
      throw error;
    }
    // Erreur technique transitoire → re-throw → rollback global + 5xx (Stripe retry).
    // Le savepoint a été annulé, et la transaction extérieure sera rollbackée.
    throw error;
  }
}

/**
 * Type guard pour vérifier si un résultat de handler est une erreur d'invariant.
 */
export function isHandlerError<T>(result: T | WebhookHandlerError): result is WebhookHandlerError {
  return result instanceof WebhookHandlerError;
}

/** Type utilitaire pour les handlers wrappés. */
export type InvariantHandledResult<T> = T | WebhookHandlerError;

// Re-export HandlerOutcome pour commodité.
export type { HandlerOutcome };
