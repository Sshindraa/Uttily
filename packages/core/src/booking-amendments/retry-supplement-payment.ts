/**
 * G7M-C4-A — retry métier d'un paiement de supplément échoué.
 *
 * Le retry est une mutation locale uniquement. Il ne contacte jamais Stripe :
 * l'attempt N+1 est ensuite repris par la réconciliation avec sa clé stable.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookings,
  lockOrganization,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';

const ACTIVE_AMENDMENT_STATUSES = ['HOLD_PENDING', 'READY_TO_APPLY'] as const;
const NON_TERMINAL_ATTEMPT_STATUSES = [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
] as const;

export interface RetrySupplementPaymentInput {
  readonly organizationId: string;
  readonly amendmentPaymentId: string;
  /** Horloge de test ; la production utilise transaction_timestamp(). */
  readonly now?: Date;
}

export type RetrySupplementPaymentResult =
  | {
      readonly kind: 'RETRY_CREATED';
      readonly amendmentPaymentId: string;
      readonly amendmentPaymentAttemptId: string;
      readonly attemptNumber: number;
      readonly providerIdempotencyKey: string;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'HOLD_EXPIRED' }
  | { readonly kind: 'NOT_RETRYABLE' };

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Horloge PostgreSQL invalide.');
  return date;
}

async function captureNow(tx: DatabaseTransaction, override: Date | undefined): Promise<Date> {
  if (override !== undefined) {
    if (!Number.isFinite(override.getTime())) throw new Error('now invalide.');
    return new Date(override.getTime());
  }
  const rows = await tx.execute(sql`SELECT transaction_timestamp() AS now`);
  const value = (rows[0] as unknown as { now: Date | string } | undefined)?.now;
  if (value === undefined) throw new Error('Horloge PostgreSQL absente.');
  return toDate(value);
}

/**
 * Réarme un seul paiement FAILED avant sa borne et crée atomiquement N+1.
 * Le verrou du paiement sérialise deux retries concurrents ; le trigger 0036
 * garantit également que le nouveau numéro est exactement max + 1.
 */
export async function retryFailedSupplementPayment(
  db: DatabaseClient,
  input: RetrySupplementPaymentInput,
): Promise<RetrySupplementPaymentResult> {
  return await db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const now = await captureNow(tx, input.now);

    const paymentRows = await tx
      .select({
        id: amendmentPayments.id,
        bookingId: amendmentPayments.bookingId,
        amendmentId: amendmentPayments.amendmentId,
        organizationId: amendmentPayments.organizationId,
        status: amendmentPayments.status,
      })
      .from(amendmentPayments)
      .where(
        and(
          eq(amendmentPayments.id, input.amendmentPaymentId),
          eq(amendmentPayments.organizationId, input.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const payment = paymentRows[0];
    if (!payment) return { kind: 'NOT_FOUND' };

    const bookingRows = await tx
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.id, payment.bookingId), eq(bookings.organizationId, input.organizationId)),
      )
      .for('update')
      .limit(1);
    const booking = bookingRows[0];
    if (!booking) return { kind: 'NOT_FOUND' };

    const amendmentRows = await tx
      .select()
      .from(bookingAmendments)
      .where(
        and(
          eq(bookingAmendments.id, payment.amendmentId),
          eq(bookingAmendments.bookingId, booking.id),
          eq(bookingAmendments.organizationId, input.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const amendment = amendmentRows[0];
    if (!amendment) return { kind: 'NOT_FOUND' };
    if (
      amendment.type !== 'SUPPLEMENT' ||
      !ACTIVE_AMENDMENT_STATUSES.includes(
        amendment.status as (typeof ACTIVE_AMENDMENT_STATUSES)[number],
      )
    ) {
      return { kind: 'NOT_RETRYABLE' };
    }
    if (amendment.holdDeadline === null || now.getTime() >= amendment.holdDeadline.getTime()) {
      return { kind: 'HOLD_EXPIRED' };
    }

    if (payment.status !== 'FAILED') return { kind: 'NOT_RETRYABLE' };

    const attempts = await tx
      .select()
      .from(amendmentPaymentAttempts)
      .where(
        and(
          eq(amendmentPaymentAttempts.amendmentPaymentId, payment.id),
          eq(amendmentPaymentAttempts.organizationId, input.organizationId),
        ),
      )
      .orderBy(asc(amendmentPaymentAttempts.attemptNumber))
      .for('update');
    if (
      attempts.some((attempt) =>
        (NON_TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status),
      )
    ) {
      return { kind: 'NOT_RETRYABLE' };
    }
    const latestAttemptNumber = Math.max(...attempts.map((attempt) => attempt.attemptNumber), 0);
    const attemptNumber = latestAttemptNumber + 1;
    const providerIdempotencyKey = `pi_amendment_${payment.id}_${attemptNumber}`;
    const inserted = await tx
      .insert(amendmentPaymentAttempts)
      .values({
        organizationId: input.organizationId,
        amendmentPaymentId: payment.id,
        attemptNumber,
        status: 'PENDING_PROVIDER',
        providerIdempotencyKey,
        reconcileAfter: now,
      })
      .returning({ id: amendmentPaymentAttempts.id });
    const attempt = inserted[0];
    if (!attempt) throw new Error('Le nouvel attempt de supplément n’a pas été créé.');

    await tx
      .update(amendmentPayments)
      .set({
        status: 'PENDING_PROVIDER',
        succeededAt: null,
        failedAt: null,
        cancelledAt: null,
        processingStartedAt: null,
        processingDeadlineAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(amendmentPayments.id, payment.id),
          eq(amendmentPayments.organizationId, input.organizationId),
        ),
      );

    return {
      kind: 'RETRY_CREATED',
      amendmentPaymentId: payment.id,
      amendmentPaymentAttemptId: attempt.id,
      attemptNumber,
      providerIdempotencyKey,
    };
  });
}
