import { NextResponse } from 'next/server';
import { executeRefundRequestBatch } from '@uttily/core';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { resolveStripeEnvironment } from '@/lib/payment-config';

export const dynamic = 'force-dynamic';

/**
 * Codes emitted by the refund batch that are safe to expose to alerting.
 * Keep this allow-list local to the route: the provider/Core payload is not a
 * logging contract and must never be copied into an alert verbatim.
 */
const REFUND_ALERT_CODES = new Set([
  'PAYLOAD_MALFORMED',
  'LEASE_LOST',
  'OUTBOX_METADATA_MISMATCH',
  'REFUND_NOT_FOUND',
  'REFUND_ALREADY_RESOLVED',
  'REFUND_STATUS_INVALID',
  'REFUND_REASON_MISMATCH',
  'REFUND_ORGANIZATION_MISMATCH',
  'REFUND_PAYMENT_ORIGIN_INVALID',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_NOT_SUCCEEDED',
  'PAYMENT_ORGANIZATION_MISMATCH',
  'PAYMENT_CURRENCY_MISMATCH',
  'AMOUNT_INVALID',
  'REFUND_FLAGS_INVALID',
  'IDEMPOTENCY_KEY_MISMATCH',
  'AMENDMENT_NOT_FOUND',
  'AMENDMENT_MISMATCH',
  'ATTEMPT_NOT_SUCCEEDED',
  'ENVIRONMENT_MISMATCH',
  'PROVIDER_RESULT_INVALID',
  'PROVIDER_REFUND_ID_CONFLICT',
  'MAX_ATTEMPTS_EXCEEDED',
  'PROVIDER_REFUSAL',
  'WORKER_ERROR',
  'card_declined',
  'rate_limit',
  'authentication_error',
  'invalid_request_error',
  'api_connection_error',
  'permission_error',
  'idempotency_error',
  'api_error',
  'resource_missing',
  'invalid_status_transition',
  'invalid_metadata',
  'unsupported_state',
  'unknown',
  'timeout',
  'UNKNOWN_ANOMALY',
]);

function toSafeAlertCode(code: unknown): string {
  return typeof code === 'string' && REFUND_ALERT_CODES.has(code) ? code : 'UNKNOWN_ANOMALY';
}

function verifyCronSecret(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get('Authorization');

  if (!cronSecret || !authorization?.startsWith('Bearer ')) return false;

  const token = authorization.slice('Bearer '.length);
  if (token.length !== cronSecret.length) return false;

  let difference = 0;
  for (let index = 0; index < token.length; index += 1) {
    difference |= token.charCodeAt(index) ^ cronSecret.charCodeAt(index);
  }
  return difference === 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    console.warn(
      JSON.stringify({
        event: 'cron.process-refund-requests.unauthorized',
        reason: 'UNAUTHORIZED',
      }),
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let environment;
  try {
    environment = resolveStripeEnvironment();
  } catch {
    console.error(
      JSON.stringify({
        event: 'cron.process-refund-requests.error',
        errorCode: 'INVALID_STRIPE_ENVIRONMENT',
      }),
    );
    return NextResponse.json({ error: 'Configuration Error' }, { status: 500 });
  }

  const startTime = Date.now();
  try {
    const result = await executeRefundRequestBatch(
      { db: getDb(), provider: getStripeAdapter() },
      { environment },
    );
    const durationMs = Date.now() - startTime;
    const anomalyCount = result.anomalies.length;
    const counters = {
      claimedCount: result.claimedCount,
      submittedCount: result.submittedCount,
      alreadyResolvedCount: result.alreadyResolvedCount,
      failedCount: result.failedCount,
      rescheduledCount: result.rescheduledCount,
      leaseLostCount: result.leaseLostCount,
      anomalyCount,
    };

    console.log(
      JSON.stringify({
        event: 'cron.process-refund-requests',
        durationMs,
        environment,
        ...counters,
      }),
    );

    if (result.failedCount > 0 || result.leaseLostCount > 0 || anomalyCount > 0) {
      console.warn(
        JSON.stringify({
          event: 'cron.process-refund-requests.alert',
          durationMs,
          environment,
          failedCount: result.failedCount,
          leaseLostCount: result.leaseLostCount,
          anomalyCount,
          codes: result.anomalies.map((anomaly) => toSafeAlertCode(anomaly.code)),
        }),
      );
    }

    return NextResponse.json({
      ok: true,
      environment,
      ...counters,
    });
  } catch {
    const durationMs = Date.now() - startTime;
    console.error(
      JSON.stringify({
        event: 'cron.process-refund-requests.error',
        durationMs,
        environment,
        errorCode: 'INTERNAL_ERROR',
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
