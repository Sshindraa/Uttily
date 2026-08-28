/**
 * Résolution des tentatives de paiement SUPPLEMENT depuis un PaymentIntent.
 *
 * Le webhook peut arriver avant la Transaction B de C2. Dans ce cas le
 * provider_payment_intent_id est encore NULL et la metadata
 * amendment_payment_attempt_id devient la seule clé de rattachement.
 */

import { and, eq, or } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookings,
  organizationPaymentAccounts,
  type DatabaseClient,
} from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAmendmentAttempt } from './types';
import { WebhookHandlerError } from './errors';

export async function resolveAmendmentAttempt(
  db: DatabaseClient,
  piData: PaymentIntentEventData,
  environment: 'TEST' | 'LIVE',
  accountId: string | null,
): Promise<ResolvedAmendmentAttempt | null> {
  if (piData.metadata?.environment !== undefined && piData.metadata.environment !== environment) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      "L'environnement des metadata du paiement de supplément ne correspond pas au webhook.",
      { statusCode: 500 },
    );
  }

  const attemptIdFromMetadata = piData.metadata?.amendment_payment_attempt_id;
  const predicates = [];
  if (piData.id.length > 0) {
    predicates.push(eq(amendmentPaymentAttempts.providerPaymentIntentId, piData.id));
  }
  if (attemptIdFromMetadata && attemptIdFromMetadata.length > 0) {
    predicates.push(eq(amendmentPaymentAttempts.id, attemptIdFromMetadata));
  }
  if (predicates.length === 0) return null;

  const rows = await db
    .select({
      attemptId: amendmentPaymentAttempts.id,
      amendmentPaymentId: amendmentPayments.id,
      amendmentId: bookingAmendments.id,
      bookingId: bookings.id,
      organizationId: amendmentPayments.organizationId,
      customerUserId: amendmentPayments.customerUserId,
      attemptStatus: amendmentPaymentAttempts.status,
      paymentStatus: amendmentPayments.status,
      amendmentStatus: bookingAmendments.status,
      providerPaymentIntentId: amendmentPaymentAttempts.providerPaymentIntentId,
      connectedAccountId: amendmentPayments.connectedAccountId,
      paymentEnvironment: amendmentPayments.environment,
    })
    .from(amendmentPaymentAttempts)
    .innerJoin(
      amendmentPayments,
      eq(amendmentPayments.id, amendmentPaymentAttempts.amendmentPaymentId),
    )
    .innerJoin(bookingAmendments, eq(bookingAmendments.id, amendmentPayments.amendmentId))
    .innerJoin(bookings, eq(bookings.id, amendmentPayments.bookingId))
    .where(or(...predicates))
    .limit(2);

  if (rows.length === 0) return null;
  if (rows.length > 1 || (attemptIdFromMetadata && rows[0]!.attemptId !== attemptIdFromMetadata)) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le PaymentIntent référence plusieurs tentatives de supplément.',
      { statusCode: 500 },
    );
  }
  const row = rows[0]!;

  if (row.paymentEnvironment !== environment) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      "L'environnement du paiement de supplément ne correspond pas au webhook.",
      { statusCode: 500 },
    );
  }

  if (accountId !== null && accountId !== row.connectedAccountId) {
    throw new WebhookHandlerError(
      'WEBHOOK_DESTINATION_MISMATCH',
      'Le compte connecté du webhook ne correspond pas au paiement de supplément.',
      { statusCode: 500 },
    );
  }

  const accountRows = await db
    .select({ id: organizationPaymentAccounts.id })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, row.connectedAccountId),
        eq(organizationPaymentAccounts.environment, environment),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.organizationId, row.organizationId),
      ),
    )
    .limit(1);

  if (accountRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      'Le compte connecté du paiement de supplément n’existe pas dans cet environnement.',
      { statusCode: 500 },
    );
  }

  return { kind: 'AMENDMENT', ...row };
}
