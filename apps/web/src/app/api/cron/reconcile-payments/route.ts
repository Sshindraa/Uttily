import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { resolveStripeEnvironment } from '@/lib/payment-config';
import {
  emitOperationalLog,
  reconcilePaymentsBatch,
  reconcileSupplementPaymentsBatch,
} from '@uttily/core';

// Désactive l'optimisation statique : cet endpoint doit toujours s'exécuter
// dynamiquement (cron).
export const dynamic = 'force-dynamic';

/**
 * Vérifie le secret partagé CRON_SECRET via le header Authorization.
 * Utilise une comparaison à temps constant pour éviter les timing attacks.
 *
 * @returns true si l'authentification est valide, false sinon.
 */
function verifyCronSecret(request: Request): boolean {
  const authHeader = request.headers.get('Authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Pas de secret configuré → refuser (fail-closed).
  if (!cronSecret) {
    return false;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);

  // Comparaison à temps constant pour éviter les timing attacks.
  if (token.length !== cronSecret.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ cronSecret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Endpoint Cron pour la réconciliation batch des paiements initiaux et des suppléments non-terminaux.
 *
 * Sécurité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Aucune donnée sensible dans la réponse (seulement des compteurs).
 *
 * Observabilité :
 * - Log structuré du résultat de chaque invocation.
 * - Log d'alerte si anomalyCount > 0.
 * - Log d'erreur en cas d'échec technique.
 *
 * @see ADR-010 §12, ADR-023 §10.3
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification.
  if (!verifyCronSecret(request)) {
    emitOperationalLog({
      operation: 'cron_reconcile_payments',
      outcome: 'failed',
      errorCode: 'UNAUTHORIZED',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Déterminer l'environnement. En production, l'absence de configuration
  // est une erreur : aucun traitement ne doit tomber silencieusement en TEST.
  let environment;
  try {
    environment = resolveStripeEnvironment();
  } catch {
    emitOperationalLog({
      operation: 'cron_reconcile_payments',
      outcome: 'failed',
      errorCode: 'CONFIGURATION_INVALID',
    });
    return NextResponse.json({ error: 'Configuration Error' }, { status: 500 });
  }

  // 3. Exécuter les batchs de réconciliation avec le même adapter provider.
  const startTime = Date.now();
  try {
    const db = getDb();
    const provider = getStripeAdapter();

    const initialResult = await reconcilePaymentsBatch({ db, provider }, { environment });
    const supplementResult = await reconcileSupplementPaymentsBatch(
      { db, provider },
      { environment },
    );

    const totalAnomalyCount = initialResult.anomalyCount + supplementResult.anomalyCount;

    // 4. Log structuré avec métriques ADR-010 §12 et C4-A.
    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_reconcile_payments',
      outcome: totalAnomalyCount > 0 ? 'degraded' : 'success',
      durationMs,
      counts: {
        claimed: initialResult.claimedCount + supplementResult.claimedCount,
        reconciled: initialResult.reconciledCount + supplementResult.reconciledCount,
        confirmed: initialResult.confirmedCount,
        cancelled: initialResult.cancelledCount,
        rescheduled: initialResult.rescheduledCount,
        compensated: initialResult.compensationRequestedCount,
        anomalies: totalAnomalyCount,
      },
    });

    // Alerte si anomalies détectées.
    if (totalAnomalyCount > 0) {
      emitOperationalLog({
        operation: 'cron_reconcile_payments',
        outcome: 'degraded',
        durationMs,
        counts: { anomalies: totalAnomalyCount },
        errorCode: 'ANOMALY_DETECTED',
      });
    }

    // 5. Réponse sans données sensibles (compteurs uniquement).
    return NextResponse.json({
      ok: true,
      environment,
      claimedCount: initialResult.claimedCount,
      reconciledCount: initialResult.reconciledCount,
      confirmedCount: initialResult.confirmedCount,
      cancelledCount: initialResult.cancelledCount,
      rescheduledCount: initialResult.rescheduledCount,
      compensationRequestedCount: initialResult.compensationRequestedCount,
      anomalyCount: totalAnomalyCount,
      initialPayments: {
        claimedCount: initialResult.claimedCount,
        reconciledCount: initialResult.reconciledCount,
        confirmedCount: initialResult.confirmedCount,
        cancelledCount: initialResult.cancelledCount,
        rescheduledCount: initialResult.rescheduledCount,
        compensationRequestedCount: initialResult.compensationRequestedCount,
        anomalyCount: initialResult.anomalyCount,
      },
      supplementPayments: {
        claimedCount: supplementResult.claimedCount,
        reconciledCount: supplementResult.reconciledCount,
        projectedCount: supplementResult.projectedCount,
        ignoredLateSuccessCount: supplementResult.ignoredLateSuccessCount,
        skippedExpiredCount: supplementResult.skippedExpiredCount,
        anomalyCount: supplementResult.anomalyCount,
      },
    });
  } catch {
    // 6. Erreur technique : log et 500.
    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_reconcile_payments',
      outcome: 'failed',
      durationMs,
      errorCode: 'INTERNAL_ERROR',
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
