import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  emitOperationalLog,
  expireBookingDraftsBatch,
  expireSupplementAmendmentsBatch,
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
 * Endpoint Cron pour l'expiration batch des brouillons HELD et des suppléments expirés.
 *
 * Sécurité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Aucune donnée sensible dans la réponse (pas d'identifiants métiers — seulement des compteurs).
 *
 * Observabilité :
 * - Log structuré du résultat de chaque invocation.
 * - Log d'alerte si anomalyCount > 0.
 * - Log d'erreur en cas d'échec technique.
 *
 * @see ADR-009 §18-19, ADR-023 §10.3
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification.
  if (!verifyCronSecret(request)) {
    emitOperationalLog({
      operation: 'cron_expire_holds',
      outcome: 'failed',
      errorCode: 'UNAUTHORIZED',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Exécuter les batchs d'expiration (brouillons et suppléments).
  const startTime = Date.now();
  try {
    const db = getDb();
    const draftsResult = await expireBookingDraftsBatch(db, 10);
    const supplementsResult = await expireSupplementAmendmentsBatch(db, { batchLimit: 10 });

    // 3. Log structuré.
    const durationMs = Date.now() - startTime;
    const expiredHoldCount = draftsResult.expired.reduce((sum, e) => sum + e.blockIds.length, 0);
    const anomalyCount = draftsResult.anomalyCount;
    emitOperationalLog({
      operation: 'cron_expire_holds',
      outcome: anomalyCount > 0 ? 'degraded' : 'success',
      durationMs,
      counts: {
        processed: draftsResult.processedCount + supplementsResult.processedCount,
        expired: expiredHoldCount + supplementsResult.expiredCount,
        anomalies: anomalyCount,
      },
    });

    // Alerte si anomalies détectées.
    if (draftsResult.anomalyCount > 0) {
      emitOperationalLog({
        operation: 'cron_expire_holds',
        outcome: 'degraded',
        durationMs,
        counts: { anomalies: draftsResult.anomalyCount },
        errorCode: 'ANOMALY_DETECTED',
      });
    }

    // 4. Réponse sans données sensibles (compteurs uniquement).
    return NextResponse.json({
      ok: true,
      processedCount: draftsResult.processedCount,
      expiredCount: draftsResult.expiredCount,
      anomalyCount: draftsResult.anomalyCount,
      batchLimit: draftsResult.batchLimit,
      drafts: {
        processedCount: draftsResult.processedCount,
        expiredCount: draftsResult.expiredCount,
        anomalyCount: draftsResult.anomalyCount,
        batchLimit: draftsResult.batchLimit,
      },
      supplements: {
        processedCount: supplementsResult.processedCount,
        expiredCount: supplementsResult.expiredCount,
      },
    });
  } catch {
    // 5. Erreur technique : log et 500.
    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_expire_holds',
      outcome: 'failed',
      durationMs,
      errorCode: 'INTERNAL_ERROR',
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
