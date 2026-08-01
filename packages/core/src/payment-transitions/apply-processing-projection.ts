/**
 * @uttily/core — Projection PROCESSING source-agnostique (Phase 7A, ADR-010 §12).
 *
 * Contient les validations et la projection monotone vers PROCESSING partagées
 * entre les handlers webhook et le moteur de réconciliation.
 *
 * NE touche PAS payment_webhook_events — le marquage webhook reste la
 * responsabilité de l'appelant.
 */

import { eq, sql } from 'drizzle-orm';
import { paymentAttempts, payments, type DatabaseTransaction } from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { validateWebhookAuthority } from '../webhook-handler/validate-authority';
import { projectAttemptStatus } from '../webhook-handler/project-status';
import type { LockedPaymentRows } from './types';

/**
 * Applique la projection monotone vers PROCESSING (validations + projection).
 *
 * Étapes (ADR-010 §12) :
 * 1. Valider l'autorité (validateWebhookAuthority).
 * 2. Projection monotone : PROCESSING si non terminal, sinon ignoré.
 * 3. Mettre à jour payment + attempt en PROCESSING.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @param lockedRows Lignes paiement déjà verrouillées par lockPaymentAttemptRows.
 * @throws WebhookHandlerError sur invariant failure (via validateWebhookAuthority).
 */
export async function applyProcessingProjection(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  lockedRows: LockedPaymentRows,
): Promise<void> {
  const { payment, attemptRow } = lockedRows;

  // Valider l'autorité (montant, devise, PI ID, etc.).
  await validateWebhookAuthority(
    tx,
    attempt,
    piData,
    { payment, attempt: attemptRow },
    environment,
  );

  // Projection monotone : PROCESSING si non terminal, sinon ignoré.
  const projection = projectAttemptStatus('payment_intent.processing', attemptRow.status);
  if (projection.ignored) {
    return;
  }

  const now = sql`transaction_timestamp()`;

  // Mettre à jour la tentative et le paiement en PROCESSING.
  // P1-1 : persister providerPaymentIntentId s'il est présent dans piData
  // et non déjà stocké (COALESCE pour ne pas écraser un ID existant).
  await tx
    .update(paymentAttempts)
    .set({
      status: 'PROCESSING',
      providerStatus: 'processing',
      providerPaymentIntentId: sql`COALESCE("provider_payment_intent_id", ${piData.id})`,
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attempt.attemptId));

  await tx
    .update(payments)
    .set({ status: 'PROCESSING', updatedAt: now })
    .where(eq(payments.id, attempt.paymentId));
}
