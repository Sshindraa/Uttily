import { NextResponse } from 'next/server';
import { emitOperationalLog, executeRefundRequestBatch } from '@uttily/core';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { resolveStripeEnvironment } from '@/lib/payment-config';

export const dynamic = 'force-dynamic';

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
    emitOperationalLog({
      operation: 'cron_process_refunds',
      outcome: 'failed',
      errorCode: 'UNAUTHORIZED',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let environment;
  try {
    environment = resolveStripeEnvironment();
  } catch {
    emitOperationalLog({
      operation: 'cron_process_refunds',
      outcome: 'failed',
      errorCode: 'CONFIGURATION_INVALID',
    });
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

    emitOperationalLog({
      operation: 'cron_process_refunds',
      outcome:
        result.failedCount > 0 || result.leaseLostCount > 0 || anomalyCount > 0
          ? 'degraded'
          : 'success',
      durationMs,
      counts: {
        claimed: result.claimedCount,
        submitted: result.submittedCount,
        alreadyResolved: result.alreadyResolvedCount,
        failed: result.failedCount,
        rescheduled: result.rescheduledCount,
        expiredLeases: result.leaseLostCount,
        anomalies: anomalyCount,
      },
    });

    if (result.failedCount > 0 || result.leaseLostCount > 0 || anomalyCount > 0) {
      emitOperationalLog({
        operation: 'cron_process_refunds',
        outcome: 'degraded',
        durationMs,
        counts: {
          failed: result.failedCount,
          expiredLeases: result.leaseLostCount,
          anomalies: anomalyCount,
        },
        errorCode: 'ANOMALY_DETECTED',
      });
    }

    return NextResponse.json({
      ok: true,
      environment,
      ...counters,
    });
  } catch {
    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_process_refunds',
      outcome: 'failed',
      durationMs,
      errorCode: 'INTERNAL_ERROR',
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
