/**
 * G7M-C4-A — réconciliation des amendment_payment_attempts.
 *
 * Le claim et la projection sont transactionnels, mais tous les appels
 * provider sont effectués entre les deux transactions, sans verrou métier.
 * Juste avant chaque appel provider, une courte phase PostgreSQL vérifie que
 * le lease token est toujours valide, capture une horloge fraîche et vérifie
 * la deadline pour createPaymentIntent.
 * Un succès provider n'est jamais transformé en succès local ici : le webhook
 * C3 reste l'autorité de l'application financière.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookings,
  lockOrganization,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import type {
  CreatePaymentIntentParams,
  PaymentIntentResult,
  PaymentProviderAdapter,
  StripeEnvironment,
} from '../payments/types';
import { calculateSupplementCommission } from './supplement-commission';
import { parseMarketplaceFeeDeltaSnapshot } from '../marketplace-fees';
import type { MarketplaceFeeDeltaSnapshot } from '../marketplace-fees';
import { projectSupplementPaymentStatus } from './apply-supplement-amendment';

const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 100;

export type SupplementReconciliationAnomalyCode =
  | 'LEASE_LOST'
  | 'PROVIDER_ENVIRONMENT_MISMATCH'
  | 'PROVIDER_RESULT_INVALID'
  | 'PROVIDER_ID_MISMATCH'
  | 'TENANT_INVARIANT_VIOLATION'
  | 'PROVIDER_CALL_FAILED'
  | 'INVARIANT_BROKEN';

const SAFE_ANOMALY_CODES = new Set<SupplementReconciliationAnomalyCode>([
  'LEASE_LOST',
  'PROVIDER_ENVIRONMENT_MISMATCH',
  'PROVIDER_RESULT_INVALID',
  'PROVIDER_ID_MISMATCH',
  'TENANT_INVARIANT_VIOLATION',
  'PROVIDER_CALL_FAILED',
  'INVARIANT_BROKEN',
]);

function toSafeAnomalyCode(error: unknown): SupplementReconciliationAnomalyCode {
  if (
    error instanceof Error &&
    SAFE_ANOMALY_CODES.has(error.message as SupplementReconciliationAnomalyCode)
  ) {
    return error.message as SupplementReconciliationAnomalyCode;
  }
  return 'INVARIANT_BROKEN';
}

export interface ClaimedSupplementPaymentAttempt {
  readonly attemptId: string;
  readonly amendmentPaymentId: string;
  readonly organizationId: string;
  readonly bookingId: string;
  readonly amendmentId: string;
  readonly attemptNumber: number;
  readonly attemptStatus: string;
  readonly paymentStatus: string;
  readonly providerPaymentIntentId: string | null;
  readonly providerIdempotencyKey: string;
  readonly amountMinor: number;
  readonly originalTotalAmountMinor: number;
  readonly originalCommissionAmountMinor: number;
  readonly marketplaceFeeDeltaSnapshot?: MarketplaceFeeDeltaSnapshot | null;
  readonly currency: string;
  readonly connectedAccountId: string;
  readonly onBehalfOfAccountId: string | null;
  readonly environment: StripeEnvironment;
  readonly holdDeadline: Date;
  readonly processingDeadlineAt: Date | null;
  readonly leaseToken: string;
  readonly claimAsOf: Date;
}

export interface SupplementReconciliationDependencies {
  readonly db: DatabaseClient;
  readonly provider: PaymentProviderAdapter;
}

export interface SupplementReconciliationOptions {
  readonly batchLimit?: number;
  readonly environment: StripeEnvironment;
}

export interface SupplementReconciliationBatchResult {
  readonly claimedCount: number;
  readonly reconciledCount: number;
  readonly projectedCount: number;
  readonly ignoredLateSuccessCount: number;
  readonly skippedExpiredCount: number;
  readonly anomalyCount: number;
  readonly anomalies: readonly {
    readonly attemptId: string;
    readonly code: SupplementReconciliationAnomalyCode;
  }[];
}

function validateBatchLimit(batchLimit: number): void {
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new Error(`batchLimit doit être un entier entre 1 et ${MAX_BATCH_LIMIT}.`);
  }
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Date PostgreSQL invalide.');
  return date;
}

function randomLeaseToken(): string {
  return crypto.randomUUID();
}

function buildCreateParams(claimed: ClaimedSupplementPaymentAttempt): CreatePaymentIntentParams {
  if (
    claimed.marketplaceFeeDeltaSnapshot &&
    claimed.marketplaceFeeDeltaSnapshot.customerTotalDeltaAmountMinor !== claimed.amountMinor
  ) {
    throw new Error('INVARIANT_BROKEN');
  }
  const applicationFee =
    claimed.marketplaceFeeDeltaSnapshot?.platformApplicationFeeDeltaAmountMinor ??
    calculateSupplementCommission(
      claimed.amountMinor,
      claimed.originalTotalAmountMinor,
      claimed.originalCommissionAmountMinor,
    );
  return {
    amountMinor: claimed.amountMinor,
    currency: 'EUR',
    connectedAccountId: claimed.connectedAccountId,
    applicationFeeAmountMinor: applicationFee === 0 ? null : applicationFee,
    onBehalfOfAccountId: claimed.onBehalfOfAccountId,
    idempotencyKey: claimed.providerIdempotencyKey,
    metadata: {
      payment_type: 'AMENDMENT',
      amendment_payment_attempt_id: claimed.attemptId,
      amendment_id: claimed.amendmentId,
      organization_id: claimed.organizationId,
      environment: claimed.environment,
      protocol_version: 'booking-amendment-payment-v1',
    },
  };
}

/**
 * Claim borné avec lease et fencing.
 */
export async function claimSupplementPaymentBatch(
  db: DatabaseClient,
  batchLimit = DEFAULT_BATCH_LIMIT,
  environment: StripeEnvironment = 'TEST',
): Promise<ClaimedSupplementPaymentAttempt[]> {
  validateBatchLimit(batchLimit);
  return await db.transaction(async (tx) => {
    const clockRows = await tx.execute(sql`SELECT transaction_timestamp() AS claim_as_of`);
    const claimAsOf = toDate(
      (clockRows[0] as unknown as { claim_as_of: Date | string }).claim_as_of,
    );
    const rows = await tx.execute(sql`
      SELECT
        apa.id AS attempt_id,
        apa.amendment_payment_id,
        apa.organization_id,
        apa.attempt_number,
        apa.status AS attempt_status,
        apa.provider_payment_intent_id,
        apa.provider_idempotency_key,
        apa.reconcile_lease_until,
        ap.booking_id,
        ap.amount_minor,
        ap.marketplace_fee_delta_snapshot,
        b.total_amount_minor AS original_total_amount_minor,
        b.commission_amount_minor AS original_commission_amount_minor,
        ap.currency,
        ap.connected_account_id,
        ap.on_behalf_of_account_id,
        ap.environment,
        ap.status AS payment_status,
        ap.processing_deadline_at,
        ba.id AS amendment_id,
        ba.hold_deadline
      FROM amendment_payment_attempts apa
      JOIN amendment_payments ap
        ON ap.id = apa.amendment_payment_id
       AND ap.organization_id = apa.organization_id
      JOIN booking_amendments ba
        ON ba.id = ap.amendment_id
       AND ba.organization_id = apa.organization_id
      JOIN bookings b
        ON b.id = ap.booking_id
       AND b.organization_id = apa.organization_id
      WHERE apa.status IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')
        AND apa.reconcile_after IS NOT NULL
        AND apa.reconcile_after <= ${claimAsOf.toISOString()}
        AND (apa.reconcile_lease_until IS NULL OR apa.reconcile_lease_until <= ${claimAsOf.toISOString()})
        AND ap.environment = ${environment}
        AND ba.type = 'SUPPLEMENT'
        AND ba.status IN ('HOLD_PENDING', 'READY_TO_APPLY', 'EXPIRED')
        AND ba.hold_deadline IS NOT NULL
      ORDER BY apa.reconcile_after ASC, apa.id ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF apa SKIP LOCKED
    `);
    const rawRows = rows as unknown as Array<{
      attempt_id: string;
      amendment_payment_id: string;
      organization_id: string;
      attempt_number: number | string;
      attempt_status: string;
      provider_payment_intent_id: string | null;
      provider_idempotency_key: string;
      booking_id: string;
      amount_minor: number | string;
      marketplace_fee_delta_snapshot: unknown;
      original_total_amount_minor: number | string;
      original_commission_amount_minor: number | string | null;
      currency: string;
      connected_account_id: string;
      on_behalf_of_account_id: string | null;
      environment: StripeEnvironment;
      payment_status: string;
      processing_deadline_at: Date | string | null;
      amendment_id: string;
      hold_deadline: Date | string;
    }>;
    const claimed: ClaimedSupplementPaymentAttempt[] = [];
    for (const row of rawRows) {
      const leaseToken = randomLeaseToken();
      const leaseRows = await tx
        .update(amendmentPaymentAttempts)
        .set({
          reconcileLeaseUntil: sql`transaction_timestamp() + interval '2 minutes'`,
          reconcileLeaseToken: leaseToken,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(amendmentPaymentAttempts.id, row.attempt_id),
            sql`(${amendmentPaymentAttempts.reconcileLeaseUntil} IS NULL OR ${amendmentPaymentAttempts.reconcileLeaseUntil} <= ${claimAsOf.toISOString()})`,
          ),
        )
        .returning({ leaseUntil: amendmentPaymentAttempts.reconcileLeaseUntil });
      const leaseUntil = leaseRows[0]?.leaseUntil;
      if (leaseUntil === undefined || leaseUntil === null) continue;
      claimed.push({
        attemptId: row.attempt_id,
        amendmentPaymentId: row.amendment_payment_id,
        organizationId: row.organization_id,
        bookingId: row.booking_id,
        amendmentId: row.amendment_id,
        attemptNumber: Number(row.attempt_number),
        attemptStatus: row.attempt_status,
        paymentStatus: row.payment_status,
        providerPaymentIntentId: row.provider_payment_intent_id,
        providerIdempotencyKey: row.provider_idempotency_key,
        amountMinor: Number(row.amount_minor),
        marketplaceFeeDeltaSnapshot:
          row.marketplace_fee_delta_snapshot === null
            ? null
            : parseMarketplaceFeeDeltaSnapshot(row.marketplace_fee_delta_snapshot),
        originalTotalAmountMinor: Number(row.original_total_amount_minor),
        originalCommissionAmountMinor: Number(row.original_commission_amount_minor ?? 0),
        currency: row.currency,
        connectedAccountId: row.connected_account_id,
        onBehalfOfAccountId: row.on_behalf_of_account_id,
        environment: row.environment,
        holdDeadline: toDate(row.hold_deadline),
        processingDeadlineAt:
          row.processing_deadline_at === null ? null : toDate(row.processing_deadline_at),
        leaseToken,
        claimAsOf,
      });
    }
    return claimed;
  });
}

interface ProviderCallAuthorization {
  readonly authorized: boolean;
  readonly reason?: 'EXPIRED' | 'LEASE_LOST';
  readonly providerCallAt: Date;
  readonly holdDeadline: Date;
}

/**
 * Phase courte PostgreSQL séparée juste avant l'appel provider :
 * - vérifie que le lease token est toujours détenu et non expiré ;
 * - capture une horloge PostgreSQL fraîche ;
 * - pour createPaymentIntent, exige strictement providerCallAt < holdDeadline ;
 * - termine sa transaction avant l'appel provider.
 */
async function authorizeProviderCall(
  db: DatabaseClient,
  claimed: ClaimedSupplementPaymentAttempt,
  isCreate: boolean,
): Promise<ProviderCallAuthorization> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        transaction_timestamp() AS provider_call_at,
        ba.hold_deadline
      FROM amendment_payment_attempts apa
      JOIN amendment_payments ap
        ON ap.id = apa.amendment_payment_id
       AND ap.organization_id = apa.organization_id
      JOIN booking_amendments ba
        ON ba.id = ap.amendment_id
       AND ba.organization_id = apa.organization_id
      WHERE apa.id = ${claimed.attemptId}
        AND apa.organization_id = ${claimed.organizationId}
        AND apa.reconcile_lease_token = ${claimed.leaseToken}::uuid
        AND apa.reconcile_lease_until > transaction_timestamp()
      LIMIT 1
    `);
    const row = (
      rows as unknown as Array<{
        provider_call_at: Date | string;
        hold_deadline: Date | string;
      }>
    )[0];
    if (!row) {
      return {
        authorized: false,
        reason: 'LEASE_LOST',
        providerCallAt: new Date(),
        holdDeadline: claimed.holdDeadline,
      };
    }
    const providerCallAt = toDate(row.provider_call_at);
    const holdDeadline = toDate(row.hold_deadline);

    if (isCreate && providerCallAt.getTime() >= holdDeadline.getTime()) {
      return {
        authorized: false,
        reason: 'EXPIRED',
        providerCallAt,
        holdDeadline,
      };
    }

    return {
      authorized: true,
      providerCallAt,
      holdDeadline,
    };
  });
}

async function releaseLease(
  db: DatabaseClient,
  claimed: ClaimedSupplementPaymentAttempt,
  reschedule: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(amendmentPaymentAttempts)
      .set({
        reconcileLeaseUntil: null,
        reconcileLeaseToken: null,
        reconcileAfter: reschedule ? sql`transaction_timestamp() + interval '5 minutes'` : null,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(
        and(
          eq(amendmentPaymentAttempts.id, claimed.attemptId),
          eq(amendmentPaymentAttempts.reconcileLeaseToken, claimed.leaseToken),
        ),
      );
  });
}

function validateProviderResult(
  result: PaymentIntentResult,
  claimed: ClaimedSupplementPaymentAttempt,
): void {
  if (
    claimed.marketplaceFeeDeltaSnapshot &&
    claimed.marketplaceFeeDeltaSnapshot.customerTotalDeltaAmountMinor !== claimed.amountMinor
  ) {
    throw new Error('PROVIDER_RESULT_INVALID');
  }
  const expectedFee =
    claimed.marketplaceFeeDeltaSnapshot?.platformApplicationFeeDeltaAmountMinor ??
    calculateSupplementCommission(
      claimed.amountMinor,
      claimed.originalTotalAmountMinor,
      claimed.originalCommissionAmountMinor,
    );
  if (
    result.id.trim() === '' ||
    result.amountMinor !== claimed.amountMinor ||
    result.currency !== claimed.currency ||
    result.environment !== claimed.environment ||
    result.connectedAccountId !== claimed.connectedAccountId ||
    (expectedFee === 0
      ? result.applicationFeeAmountMinor !== null && result.applicationFeeAmountMinor !== 0
      : result.applicationFeeAmountMinor !== expectedFee) ||
    result.onBehalfOfAccountId !== claimed.onBehalfOfAccountId
  ) {
    throw new Error('PROVIDER_RESULT_INVALID');
  }
}

async function verifyLease(tx: DatabaseTransaction, claimed: ClaimedSupplementPaymentAttempt) {
  const rows = await tx.execute(sql`
    UPDATE amendment_payment_attempts
    SET updated_at = transaction_timestamp()
    WHERE id = ${claimed.attemptId}
      AND organization_id = ${claimed.organizationId}
      AND reconcile_lease_token = ${claimed.leaseToken}::uuid
      AND reconcile_lease_until > transaction_timestamp()
    RETURNING id
  `);
  if ((rows as unknown as Array<{ id: string }>).length === 0) {
    throw new Error('LEASE_LOST');
  }
}

function isTerminal(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

async function applyProviderProjection(
  db: DatabaseClient,
  claimed: ClaimedSupplementPaymentAttempt,
  providerResult: PaymentIntentResult,
): Promise<'PROJECTED' | 'IGNORED_LATE_SUCCESS' | 'STALE'> {
  validateProviderResult(providerResult, claimed);
  return await db.transaction(async (tx) => {
    await lockOrganization(tx, claimed.organizationId);
    const bookingRows = await tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.id, claimed.bookingId),
          eq(bookings.organizationId, claimed.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const booking = bookingRows[0];
    const amendmentRows = await tx
      .select()
      .from(bookingAmendments)
      .where(
        and(
          eq(bookingAmendments.id, claimed.amendmentId),
          eq(bookingAmendments.bookingId, claimed.bookingId),
          eq(bookingAmendments.organizationId, claimed.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const amendment = amendmentRows[0];
    const paymentRows = await tx
      .select()
      .from(amendmentPayments)
      .where(
        and(
          eq(amendmentPayments.id, claimed.amendmentPaymentId),
          eq(amendmentPayments.bookingId, claimed.bookingId),
          eq(amendmentPayments.amendmentId, claimed.amendmentId),
          eq(amendmentPayments.organizationId, claimed.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const payment = paymentRows[0];
    const attemptRows = await tx
      .select()
      .from(amendmentPaymentAttempts)
      .where(
        and(
          eq(amendmentPaymentAttempts.id, claimed.attemptId),
          eq(amendmentPaymentAttempts.amendmentPaymentId, claimed.amendmentPaymentId),
          eq(amendmentPaymentAttempts.organizationId, claimed.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    const attempt = attemptRows[0];
    if (!booking || !amendment || !payment || !attempt)
      throw new Error('TENANT_INVARIANT_VIOLATION');
    await verifyLease(tx, claimed);
    if (isTerminal(attempt.status)) {
      await releaseClaimedLease(tx, claimed, null);
      return 'STALE';
    }
    if (
      attempt.providerPaymentIntentId !== null &&
      attempt.providerPaymentIntentId !== providerResult.id
    ) {
      throw new Error('PROVIDER_ID_MISMATCH');
    }
    const projectionRows = await tx.execute(sql`SELECT transaction_timestamp() AS projection_at`);
    const projectionAt = toDate(
      (projectionRows[0] as unknown as { projection_at: Date | string }).projection_at,
    );
    const expired =
      amendment.holdDeadline === null || projectionAt.getTime() >= amendment.holdDeadline.getTime();

    if (providerResult.status === 'succeeded') {
      await updateProviderFields(tx, claimed, providerResult, null);
      await releaseClaimedLease(tx, claimed, null);
      return expired ? 'IGNORED_LATE_SUCCESS' : 'PROJECTED';
    }

    const eventType =
      providerResult.status === 'requires_payment_method'
        ? 'payment_intent.payment_failed'
        : providerResult.status === 'requires_action'
          ? 'payment_intent.requires_action'
          : providerResult.status === 'processing'
            ? 'payment_intent.processing'
            : 'payment_intent.canceled';
    const projection = projectSupplementPaymentStatus(eventType, payment.status);
    const canCancel = payment.status === 'PROCESSING';
    const nextStatus =
      projection.newStatus === 'CANCELLED' && !canCancel ? null : projection.newStatus;
    if (nextStatus === 'FAILED') {
      await tx
        .update(amendmentPayments)
        .set({
          status: 'FAILED',
          failedAt: projectionAt,
          processingStartedAt: null,
          processingDeadlineAt: null,
          updatedAt: projectionAt,
        })
        .where(eq(amendmentPayments.id, payment.id));
    } else if (nextStatus === 'CANCELLED') {
      await tx
        .update(amendmentPayments)
        .set({
          status: 'CANCELLED',
          cancelledAt: projectionAt,
          processingStartedAt: null,
          processingDeadlineAt: null,
          updatedAt: projectionAt,
        })
        .where(eq(amendmentPayments.id, payment.id));
    } else if (nextStatus === 'PROCESSING') {
      const technicalDeadline = new Date(projectionAt.getTime() + 30 * 60_000);
      const holdDeadline = amendment.holdDeadline ?? technicalDeadline;
      const processingDeadlineAt =
        payment.processingDeadlineAt && payment.processingDeadlineAt <= holdDeadline
          ? payment.processingDeadlineAt
          : technicalDeadline <= holdDeadline
            ? technicalDeadline
            : holdDeadline;
      await tx
        .update(amendmentPayments)
        .set({
          status: 'PROCESSING',
          processingStartedAt: payment.processingStartedAt ?? projectionAt,
          processingDeadlineAt,
          updatedAt: projectionAt,
        })
        .where(eq(amendmentPayments.id, payment.id));
    } else if (nextStatus === 'REQUIRES_ACTION') {
      await tx
        .update(amendmentPayments)
        .set({ status: 'REQUIRES_ACTION', updatedAt: projectionAt })
        .where(eq(amendmentPayments.id, payment.id));
    }

    const nextReconcileAt =
      nextStatus === 'PROCESSING'
        ? (payment.processingDeadlineAt ?? amendment.holdDeadline)
        : nextStatus === 'REQUIRES_ACTION'
          ? amendment.holdDeadline
          : null;
    await updateProviderFields(
      tx,
      claimed,
      providerResult,
      nextStatus,
      nextReconcileAt === null ? undefined : nextReconcileAt,
    );
    await releaseClaimedLease(tx, claimed, nextReconcileAt);
    return nextStatus === null && projection.ignored ? 'STALE' : 'PROJECTED';
  });
}

async function updateProviderFields(
  tx: DatabaseTransaction,
  claimed: ClaimedSupplementPaymentAttempt,
  providerResult: PaymentIntentResult,
  status: string | null,
  reconcileAfter?: Date | null,
): Promise<void> {
  await tx
    .update(amendmentPaymentAttempts)
    .set({
      ...(status === null ? {} : { status: status as 'PENDING_PROVIDER' }),
      providerPaymentIntentId: providerResult.id,
      providerStatus: providerResult.status,
      ...(status === 'FAILED' || status === 'CANCELLED'
        ? {
            reconcileAfter: null,
            reconcileLeaseUntil: null,
            reconcileLeaseToken: null,
          }
        : {}),
      ...(reconcileAfter === undefined ? {} : { reconcileAfter }),
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(amendmentPaymentAttempts.id, claimed.attemptId),
        eq(amendmentPaymentAttempts.organizationId, claimed.organizationId),
      ),
    );
}

async function releaseClaimedLease(
  tx: DatabaseTransaction,
  claimed: ClaimedSupplementPaymentAttempt,
  reconcileAfter: Date | null,
): Promise<void> {
  await tx
    .update(amendmentPaymentAttempts)
    .set({
      reconcileLeaseUntil: null,
      reconcileLeaseToken: null,
      ...(reconcileAfter === null ? { reconcileAfter: null } : {}),
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(amendmentPaymentAttempts.id, claimed.attemptId),
        eq(amendmentPaymentAttempts.organizationId, claimed.organizationId),
        eq(amendmentPaymentAttempts.reconcileLeaseToken, claimed.leaseToken),
      ),
    );
}

export async function reconcileSupplementPaymentsBatch(
  deps: SupplementReconciliationDependencies,
  options: SupplementReconciliationOptions,
): Promise<SupplementReconciliationBatchResult> {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  validateBatchLimit(batchLimit);
  if (deps.provider.environment !== options.environment) {
    throw new Error('PROVIDER_ENVIRONMENT_MISMATCH');
  }
  const claimed = await claimSupplementPaymentBatch(deps.db, batchLimit, options.environment);
  const result = {
    claimedCount: claimed.length,
    reconciledCount: 0,
    projectedCount: 0,
    ignoredLateSuccessCount: 0,
    skippedExpiredCount: 0,
    anomalyCount: 0,
    anomalies: [] as {
      readonly attemptId: string;
      readonly code: SupplementReconciliationAnomalyCode;
    }[],
  };

  for (const item of claimed) {
    const isCreate = item.providerPaymentIntentId === null;
    let auth: ProviderCallAuthorization;
    try {
      auth = await authorizeProviderCall(deps.db, item, isCreate);
    } catch {
      result.anomalyCount++;
      result.anomalies.push({ attemptId: item.attemptId, code: 'INVARIANT_BROKEN' });
      continue;
    }

    if (!auth.authorized) {
      if (auth.reason === 'EXPIRED') {
        try {
          await releaseLease(deps.db, item, false);
        } catch {
          // Le lease expirera naturellement.
        }
        result.skippedExpiredCount++;
        continue;
      }
      if (auth.reason === 'LEASE_LOST') {
        result.anomalyCount++;
        result.anomalies.push({ attemptId: item.attemptId, code: 'LEASE_LOST' });
        continue;
      }
    }

    try {
      let providerResult: PaymentIntentResult;
      try {
        if (isCreate) {
          providerResult = await deps.provider.createPaymentIntent(buildCreateParams(item));
        } else {
          providerResult = await deps.provider.retrievePaymentIntent(item.providerPaymentIntentId!);
        }
      } catch {
        throw new Error('PROVIDER_CALL_FAILED');
      }

      const outcome = await applyProviderProjection(deps.db, item, providerResult);
      result.reconciledCount++;
      if (outcome === 'PROJECTED') result.projectedCount++;
      if (outcome === 'IGNORED_LATE_SUCCESS') result.ignoredLateSuccessCount++;
    } catch (error) {
      const code = toSafeAnomalyCode(error);
      try {
        const canReschedule = auth.providerCallAt.getTime() < auth.holdDeadline.getTime();
        await releaseLease(deps.db, item, canReschedule);
      } catch {
        // Le lease expirera naturellement.
      }
      result.anomalyCount++;
      result.anomalies.push({ attemptId: item.attemptId, code });
    }
  }
  return result;
}
