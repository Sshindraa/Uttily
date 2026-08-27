import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { PaymentProviderError } from '../payments/errors';
import { claimRefundRequestBatch } from './claim-refund-request-batch';
import { RefundRequestError } from './errors';
import {
  DEFAULT_BATCH_LIMIT,
  MAX_ATTEMPTS,
  getBackoffIntervalSeconds,
  validateBatchLimit,
} from './scheduling';
import { executeRefundRequest } from './execute-refund-request';
import type {
  ClaimedRefundRequest,
  RefundRequestBatchResult,
  RefundRequestDependencies,
  RefundRequestOptions,
} from './types';

const TRANSIENT_PROVIDER_CODES = new Set([
  'rate_limit',
  'api_connection_error',
  'timeout',
  'api_error',
]);

function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof PaymentProviderError &&
    TRANSIENT_PROVIDER_CODES.has(error.providerErrorCode ?? '')
  );
}

async function reschedule(db: DatabaseClient, claimed: ClaimedRefundRequest): Promise<boolean> {
  const backoff = getBackoffIntervalSeconds(claimed.attemptCount);
  const rows = await db.transaction((tx) =>
    tx.execute(sql`
      UPDATE "outbox_events"
      SET status = 'PENDING', attempt_count = attempt_count + 1,
          available_at = transaction_timestamp() + make_interval(secs => ${backoff}),
          lease_token = NULL, lease_until = NULL
      WHERE id = ${claimed.outboxEventId}::uuid
        AND lease_token = ${claimed.leaseToken}::uuid
        AND lease_until > transaction_timestamp()
      RETURNING id
    `),
  );
  return (rows as unknown as Array<{ id: string }>).length > 0;
}

async function fail(
  db: DatabaseClient,
  claimed: ClaimedRefundRequest,
  failureCode: string,
): Promise<'failed' | 'lease_lost' | 'processed'> {
  return await db.transaction(async (tx) => {
    const lockedOutbox = await tx.execute(sql`
      SELECT id FROM "outbox_events"
      WHERE id = ${claimed.outboxEventId}::uuid
        AND lease_token = ${claimed.leaseToken}::uuid
        AND lease_until > transaction_timestamp()
      FOR UPDATE
    `);
    if ((lockedOutbox as unknown as Array<{ id: string }>).length === 0) return 'lease_lost';

    let refundId: string | null = null;
    if (claimed.payloadValid) {
      try {
        const payload = (claimed.payload ?? {}) as Record<string, unknown>;
        if (typeof payload.refundId === 'string') refundId = payload.refundId;
      } catch {
        refundId = null;
      }
    }

    const refundRows = refundId
      ? await tx.execute(sql`
          SELECT id, status FROM "refunds"
          WHERE id = ${refundId}::uuid
            AND organization_id = ${claimed.organizationId}::uuid
          FOR UPDATE
        `)
      : [];
    const refund = (refundRows as unknown as Array<{ id: string; status: string }>)[0];

    if (
      refund !== undefined &&
      (refund.status === 'SUCCEEDED' ||
        refund.status === 'SUBMITTED' ||
        refund.status === 'FAILED_REQUIRES_MANUAL_ACTION' ||
        refund.status === 'SETTLED_OFF_PLATFORM')
    ) {
      await tx.execute(sql`
        UPDATE "outbox_events"
        SET status = 'PROCESSED', processed_at = transaction_timestamp(), lease_token = NULL, lease_until = NULL
        WHERE id = ${claimed.outboxEventId}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND lease_until > transaction_timestamp()
      `);
      return 'processed';
    }

    await tx.execute(sql`
      UPDATE "outbox_events"
      SET status = 'FAILED', lease_token = NULL, lease_until = NULL
      WHERE id = ${claimed.outboxEventId}::uuid
        AND lease_token = ${claimed.leaseToken}::uuid
        AND lease_until > transaction_timestamp()
    `);
    if (refund !== undefined && !['SUCCEEDED', 'SETTLED_OFF_PLATFORM'].includes(refund.status)) {
      await tx.execute(sql`
        UPDATE "refunds"
        SET status = 'FAILED_REQUIRES_MANUAL_ACTION'::refund_status,
            failed_at = transaction_timestamp(), failure_code = ${failureCode}, updated_at = transaction_timestamp()
        WHERE id = ${refund.id}::uuid
          AND organization_id = ${claimed.organizationId}::uuid
          AND status NOT IN ('SUCCEEDED', 'FAILED_REQUIRES_MANUAL_ACTION', 'SETTLED_OFF_PLATFORM')
      `);
    }
    return 'failed';
  });
}

export async function executeRefundRequestBatch(
  deps: RefundRequestDependencies,
  options: RefundRequestOptions,
): Promise<RefundRequestBatchResult> {
  const batchLimit = validateBatchLimit(options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  if (deps.provider.environment !== options.environment) {
    throw new RefundRequestError('ENVIRONMENT_MISMATCH', 'Provider et environnement incompatibles');
  }

  const claimed = await claimRefundRequestBatch(deps.db, batchLimit, options.environment);
  const result: RefundRequestBatchResult = {
    claimedCount: claimed.length,
    submittedCount: 0,
    alreadyResolvedCount: 0,
    failedCount: 0,
    rescheduledCount: 0,
    leaseLostCount: 0,
    anomalies: [],
  };

  for (const event of claimed) {
    try {
      if (!event.payloadValid) {
        const outcome = await fail(deps.db, event, 'PAYLOAD_MALFORMED');
        if (outcome === 'failed') result.failedCount++;
        else if (outcome === 'processed') result.alreadyResolvedCount++;
        else result.leaseLostCount++;
        result.anomalies.push({ outboxEventId: event.outboxEventId, code: 'PAYLOAD_MALFORMED' });
        continue;
      }

      const execution = await executeRefundRequest(deps, event, options.environment);
      if (execution.outcome === 'submitted') result.submittedCount++;
      else result.alreadyResolvedCount++;
    } catch (error) {
      if (error instanceof RefundRequestError && error.code === 'LEASE_LOST') {
        result.leaseLostCount++;
        continue;
      }

      const transient =
        error instanceof PaymentProviderError
          ? isTransientProviderError(error)
          : !(error instanceof RefundRequestError);
      if (transient && event.attemptCount + 1 < MAX_ATTEMPTS) {
        if (await reschedule(deps.db, event)) result.rescheduledCount++;
        else result.leaseLostCount++;
        continue;
      }

      const code =
        error instanceof PaymentProviderError
          ? (error.providerErrorCode ?? 'PROVIDER_REFUSAL')
          : error instanceof RefundRequestError
            ? error.code
            : 'WORKER_ERROR';
      const outcome = await fail(deps.db, event, transient ? 'MAX_ATTEMPTS_EXCEEDED' : code);
      if (outcome === 'failed') result.failedCount++;
      else if (outcome === 'processed') result.alreadyResolvedCount++;
      else result.leaseLostCount++;
      result.anomalies.push({ outboxEventId: event.outboxEventId, code });
    }
  }

  return result;
}
