import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { parseRefundRequestedV1Event } from '@uttily/contracts';
import type { StripeEnvironment } from '../payments/types';
import { poseLease } from '../outbox-claim/claim-outbox-batch';
import { REFUND_REQUEST_SELECTION } from '../outbox-claim/handler-selection';
import { DEFAULT_BATCH_LIMIT, MAX_ATTEMPTS, validateBatchLimit } from './scheduling';
import type { ClaimedRefundRequest } from './types';

/**
 * Claims only REFUND_REQUESTED.v1/REFUND events whose authoritative payment is
 * in the requested Stripe environment. Malformed payloads are claimed as
 * quarantinable work so they cannot remain invisible forever.
 */
export async function claimRefundRequestBatch(
  db: DatabaseClient,
  batchLimit: number = DEFAULT_BATCH_LIMIT,
  environment: StripeEnvironment = 'TEST',
): Promise<ClaimedRefundRequest[]> {
  const limit = validateBatchLimit(batchLimit);

  return await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        oe.id AS outbox_event_id,
        oe.organization_id,
        oe.aggregate_type,
        oe.aggregate_id,
        oe.event_type,
        oe.event_version,
        oe.payload,
        oe.attempt_count,
        oe.lease_until AS current_lease_until
      FROM "outbox_events" oe
      LEFT JOIN "refunds" r ON r.id = CASE
        WHEN (oe.payload->>'refundId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (oe.payload->>'refundId')::uuid
        ELSE NULL
      END
      LEFT JOIN "payments" p ON p.id = r.payment_id
      WHERE oe.event_type = ${REFUND_REQUEST_SELECTION.eventType}
        AND oe.event_version = ${REFUND_REQUEST_SELECTION.eventVersion}
        AND oe.aggregate_type = ${REFUND_REQUEST_SELECTION.aggregateType}
        AND oe.status IN ('PENDING', 'PROCESSING')
        AND oe.available_at <= now()
        AND (oe.lease_until IS NULL OR oe.lease_until <= now())
        AND oe.attempt_count < ${MAX_ATTEMPTS}
        AND (r.id IS NULL OR p.id IS NULL OR p.environment = ${environment}::payment_environment)
      ORDER BY oe.available_at ASC, oe.id ASC
      LIMIT ${limit}
      FOR UPDATE OF oe SKIP LOCKED
    `);

    const rawRows = rows as unknown as Array<{
      outbox_event_id: string;
      organization_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      event_version: string;
      payload: unknown;
      attempt_count: number;
      current_lease_until: Date | null;
    }>;

    const leases = await poseLease(
      tx,
      rawRows.map((row) => row.outbox_event_id),
      'reclaim_only',
    );
    const claimed: ClaimedRefundRequest[] = [];

    for (const row of rawRows) {
      const lease = leases.get(row.outbox_event_id);
      if (lease === undefined) continue;

      let payloadValid = false;
      try {
        parseRefundRequestedV1Event({
          aggregateType: row.aggregate_type,
          eventType: row.event_type,
          eventVersion: row.event_version,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        });
        payloadValid = true;
      } catch {
        payloadValid = false;
      }

      claimed.push({
        outboxEventId: row.outbox_event_id,
        organizationId: row.organization_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        eventVersion: row.event_version,
        payload: row.payload,
        payloadValid,
        leaseToken: lease.leaseToken,
        leaseUntil: lease.leaseUntil,
        attemptCount: lease.attemptCount,
      });
    }

    return claimed;
  });
}
