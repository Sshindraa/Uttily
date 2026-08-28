import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { resolveStripeEnvironment } from '@/lib/payment-config';
import { emitOperationalLog, executeCompensationBatch } from '@uttily/core';

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
 * Endpoint Cron pour l'exécution batch des compensations (refunds tardifs).
 *
 * Sécurité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Aucune donnée sensible dans la réponse (pas de payment IDs, pas de
 *   détails d'anomalies — seulement des compteurs).
 *
 * Observabilité :
 * - Log structuré du résultat de chaque invocation.
 * - Log d'alerte si failedCount > 0 ou anomalyCount > 0.
 * - Log d'erreur en cas d'échec technique.
 *
 * @see ADR-010 §13
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification.
  if (!verifyCronSecret(request)) {
    emitOperationalLog({
      operation: 'cron_process_compensations',
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
      operation: 'cron_process_compensations',
      outcome: 'failed',
      errorCode: 'CONFIGURATION_INVALID',
    });
    return NextResponse.json({ error: 'Configuration Error' }, { status: 500 });
  }

  // 3. Exécuter le batch.
  const startTime = Date.now();
  try {
    const db = getDb();
    const provider = getStripeAdapter();

    const result = await executeCompensationBatch({ db, provider }, { environment });

    // 4. Log structuré avec métriques ADR-010 §13.
    const durationMs = Date.now() - startTime;
    const anomalyCount = result.anomalies.length;
    emitOperationalLog({
      operation: 'cron_process_compensations',
      outcome: result.failedCount > 0 || anomalyCount > 0 ? 'degraded' : 'success',
      durationMs,
      counts: {
        claimed: result.claimedCount,
        submitted: result.submittedCount,
        alreadyResolved: result.alreadySucceededCount,
        failed: result.failedCount,
        rescheduled: result.rescheduledCount,
        anomalies: anomalyCount,
      },
    });

    // Alerte si échecs ou anomalies détectées.
    if (result.failedCount > 0 || anomalyCount > 0) {
      emitOperationalLog({
        operation: 'cron_process_compensations',
        outcome: 'degraded',
        durationMs,
        counts: { failed: result.failedCount, anomalies: anomalyCount },
        errorCode: 'ANOMALY_DETECTED',
      });
    }

    // 5. Réponse sans données sensibles (compteurs uniquement).
    return NextResponse.json({
      ok: true,
      environment,
      claimedCount: result.claimedCount,
      submittedCount: result.submittedCount,
      alreadySucceededCount: result.alreadySucceededCount,
      failedCount: result.failedCount,
      rescheduledCount: result.rescheduledCount,
      anomalyCount,
    });
  } catch {
    // 6. Erreur technique : log et 500.
    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_process_compensations',
      outcome: 'failed',
      durationMs,
      errorCode: 'INTERNAL_ERROR',
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
