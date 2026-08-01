import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { executeCompensationBatch } from '@uttily/core';

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
    console.warn('cron.process-compensations: 401 Unauthorized — secret manquant ou incorrect.');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Déterminer l'environnement depuis STRIPE_ENVIRONMENT (défaut : TEST).
  const rawEnvironment = process.env.STRIPE_ENVIRONMENT ?? 'TEST';
  if (rawEnvironment !== 'TEST' && rawEnvironment !== 'LIVE') {
    console.error(`cron.process-compensations: STRIPE_ENVIRONMENT invalide : "${rawEnvironment}"`);
    return NextResponse.json({ error: 'Configuration Error' }, { status: 500 });
  }
  const environment = rawEnvironment;

  // 3. Exécuter le batch.
  const startTime = Date.now();
  try {
    const db = getDb();
    const provider = getStripeAdapter();

    const result = await executeCompensationBatch({ db, provider }, { environment });

    // 4. Log structuré avec métriques ADR-010 §13.
    const durationMs = Date.now() - startTime;
    const anomalyCount = result.anomalies.length;
    console.log(
      JSON.stringify({
        event: 'cron.process-compensations',
        durationMs,
        environment,
        claimedCount: result.claimedCount,
        submittedCount: result.submittedCount,
        alreadySucceededCount: result.alreadySucceededCount,
        failedCount: result.failedCount,
        rescheduledCount: result.rescheduledCount,
        anomalyCount,
      }),
    );

    // Alerte si échecs ou anomalies détectées.
    if (result.failedCount > 0 || anomalyCount > 0) {
      console.warn(
        JSON.stringify({
          event: 'cron.process-compensations.alert',
          durationMs,
          environment,
          failedCount: result.failedCount,
          anomalyCount,
          codes: result.anomalies.map((a) => a.code),
        }),
      );
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
  } catch (error) {
    // 6. Erreur technique : log et 500.
    const durationMs = Date.now() - startTime;
    console.error(
      JSON.stringify({
        event: 'cron.process-compensations.error',
        durationMs,
        environment,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
