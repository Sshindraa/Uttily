/**
 * @uttily/core — Résolution de la tentative depuis un webhook (Lot 5, ADR-010 §10.1).
 *
 * Retrouve la tentative de paiement par `provider_payment_intent_id` ou, si le
 * webhook précède la transaction B, par `payment_attempt_id` dans les metadata
 * du PaymentIntent reçu dans le webhook signé. Vérifie la cohérence du compte
 * connecté et de l'environnement.
 */

import { and, eq } from 'drizzle-orm';
import {
  bookingDrafts,
  organizationPaymentAccounts,
  paymentAttempts,
  payments,
  type DatabaseClient,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from './types';
import { WebhookHandlerError } from './errors';

/**
 * Retrouve la tentative de paiement associée à un PaymentIntent Stripe.
 *
 * Stratégie de lookup (ADR-010 §10.1) :
 * 1. Par `provider_payment_intent_id` (cas nominal : transaction B a persisté l'ID).
 * 2. Si non trouvé, par `metadata.payment_attempt_id` (cas où le webhook
 *    précède la transaction B — l'ID de tentative est dans les metadata Stripe).
 *
 * Après résolution, vérifie la cohérence du compte connecté (si event.accountId
 * est non null) et de l'environnement (via organization_payment_accounts).
 *
 * @param db Client base de données.
 * @param piData Données du PaymentIntent extraites du webhook.
 * @param environment Environnement Stripe (TEST/LIVE) pour filtrage.
 * @returns ResolvedAttempt ou null si aucune tentative trouvée.
 */
export async function resolveAttempt(
  db: DatabaseClient,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  accountId: string | null,
): Promise<ResolvedAttempt | null> {
  // 1. Lookup par provider_payment_intent_id.
  if (piData.id && piData.id.length > 0) {
    const rows = await db
      .select({
        attemptId: paymentAttempts.id,
        attemptNumber: paymentAttempts.attemptNumber,
        attemptStatus: paymentAttempts.status,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        paymentId: payments.id,
        paymentStatus: payments.status,
        paymentOrganizationId: payments.organizationId,
        paymentConnectedAccountId: payments.connectedAccountId,
        draftId: payments.draftId,
        draftStatus: bookingDrafts.status,
      })
      .from(paymentAttempts)
      .innerJoin(payments, eq(payments.id, paymentAttempts.paymentId))
      .innerJoin(bookingDrafts, eq(bookingDrafts.id, payments.draftId))
      .where(
        and(
          eq(paymentAttempts.providerPaymentIntentId, piData.id),
          eq(payments.organizationId, paymentAttempts.organizationId),
        ),
      )
      .limit(1);

    if (rows.length > 0) {
      const r = rows[0]!;
      await validateConnectedAccountAndEnvironment(
        db,
        r.paymentConnectedAccountId,
        accountId,
        environment,
      );
      return {
        attemptId: r.attemptId,
        paymentId: r.paymentId,
        draftId: r.draftId,
        organizationId: r.paymentOrganizationId,
        attemptNumber: r.attemptNumber,
        attemptStatus: r.attemptStatus,
        paymentStatus: r.paymentStatus,
        draftStatus: r.draftStatus,
        providerPaymentIntentId: r.providerPaymentIntentId,
      };
    }
  }

  // 2. Lookup par metadata.payment_attempt_id (webhook avant transaction B).
  const attemptIdFromMeta = piData.metadata?.payment_attempt_id;
  if (attemptIdFromMeta && attemptIdFromMeta.length > 0) {
    const rows = await db
      .select({
        attemptId: paymentAttempts.id,
        attemptNumber: paymentAttempts.attemptNumber,
        attemptStatus: paymentAttempts.status,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        paymentId: payments.id,
        paymentStatus: payments.status,
        paymentOrganizationId: payments.organizationId,
        paymentConnectedAccountId: payments.connectedAccountId,
        draftId: payments.draftId,
        draftStatus: bookingDrafts.status,
      })
      .from(paymentAttempts)
      .innerJoin(payments, eq(payments.id, paymentAttempts.paymentId))
      .innerJoin(bookingDrafts, eq(bookingDrafts.id, payments.draftId))
      .where(eq(paymentAttempts.id, attemptIdFromMeta))
      .limit(1);

    if (rows.length > 0) {
      const r = rows[0]!;
      await validateConnectedAccountAndEnvironment(
        db,
        r.paymentConnectedAccountId,
        accountId,
        environment,
      );
      return {
        attemptId: r.attemptId,
        paymentId: r.paymentId,
        draftId: r.draftId,
        organizationId: r.paymentOrganizationId,
        attemptNumber: r.attemptNumber,
        attemptStatus: r.attemptStatus,
        paymentStatus: r.paymentStatus,
        draftStatus: r.draftStatus,
        providerPaymentIntentId: r.providerPaymentIntentId,
      };
    }
  }

  // Aucune tentative trouvée.
  return null;
}

/**
 * Valide la cohérence du compte connecté et de l'environnement après résolution
 * de la tentative.
 *
 * - Si `accountId` (compte connecté du webhook, non null pour les événements
 *   Connect) est présent, vérifie qu'il correspond au connectedAccountId du
 *   paiement. Pour les événements platform des destination charges,
 *   `accountId` est souvent null — la vérification ne s'applique pas.
 * - Vérifie via `organization_payment_accounts` que le compte connecté du
 *   paiement existe pour l'environnement du contexte.
 */
async function validateConnectedAccountAndEnvironment(
  db: DatabaseClient,
  paymentConnectedAccountId: string,
  accountId: string | null,
  environment: 'TEST' | 'LIVE',
): Promise<void> {
  // Vérifier la cohérence du compte connecté (uniquement si accountId est non null).
  if (accountId !== null && accountId !== paymentConnectedAccountId) {
    throw new WebhookHandlerError(
      'WEBHOOK_DESTINATION_MISMATCH',
      `Le compte connecté du webhook (${accountId}) ne correspond pas au paiement (${paymentConnectedAccountId}).`,
      { statusCode: 500 },
    );
  }

  // Vérifier que le compte connecté existe pour l'environnement du contexte.
  const accountRows = await db
    .select({ id: organizationPaymentAccounts.id })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, paymentConnectedAccountId),
        eq(organizationPaymentAccounts.environment, environment),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
      ),
    )
    .limit(1);

  if (accountRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      `Le compte connecté ${paymentConnectedAccountId} n'existe pas pour l'environnement ${environment}.`,
      { statusCode: 500 },
    );
  }
}
