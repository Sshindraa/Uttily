import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { reconcilePaymentsBatch } from '@uttily/core';

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
 * Endpoint Cron pour la réconciliation batch des paiements non-terminaux.
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
 * - Log d'alerte si anomalyCount > 0.
 * - Log d'erreur en cas d'échec technique.
 *
 * @see ADR-010 §12
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification.
  if (!verifyCronSecret(request)) {
    console.warn('cron.reconcile-payments: 401 Unauthorized — secret manquant ou incorrect.');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Déterminer l'environnement depuis STRIPE_ENVIRONMENT (défaut : TEST).
  const rawEnvironment = process.env.STRIPE_ENVIRONMENT ?? 'TEST';
  if (rawEnvironment !== 'TEST' && rawEnvironment !== 'LIVE') {
    console.error(`cron.reconcile-payments: STRIPE_ENVIRONMENT invalide : "${rawEnvironment}"`);
    return NextResponse.json({ error: 'Configuration Error' }, { status: 500 });
  }
  const environment = rawEnvironment;

  // 3. Exécuter le batch.
  const startTime = Date.now();
  try {
    const db = getDb();
    const provider = getStripeAdapter();

    // Mesurer l'âge du plus vieux PAYMENT_PROCESSING avant le batch (ADR-010 §12).
    const oldestRows = (await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (transaction_timestamp() - pa.created_at))::bigint AS age_seconds
      FROM payment_attempts pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.status = 'PROCESSING'
        AND p.environment = ${environment}::payment_environment
      ORDER BY pa.created_at ASC
      LIMIT 1
    `)) as unknown as Array<{ age_seconds: bigint }>;
    const oldestProcessingAgeSeconds =
      oldestRows.length > 0 ? Number(oldestRows[0]!.age_seconds) : null;

    const result = await reconcilePaymentsBatch({ db, provider }, { environment });

    // 4. Log structuré avec métriques ADR-010 §12.
    const durationMs = Date.now() - startTime;
    console.log(
      JSON.stringify({
        event: 'cron.reconcile-payments',
        durationMs,
        environment,
        oldestProcessingAgeSeconds,
        claimedCount: result.claimedCount,
        reconciledCount: result.reconciledCount,
        confirmedCount: result.confirmedCount,
        cancelledCount: result.cancelledCount,
        rescheduledCount: result.rescheduledCount,
        compensationRequestedCount: result.compensationRequestedCount,
        anomalyCount: result.anomalyCount,
      }),
    );

    // Alerte si anomalies détectées.
    if (result.anomalyCount > 0) {
      console.warn(
        JSON.stringify({
          event: 'cron.reconcile-payments.anomalies',
          durationMs,
          environment,
          anomalyCount: result.anomalyCount,
          codes: result.anomalies.map((a) => a.code),
        }),
      );
    }

    // 5. Réponse sans données sensibles (compteurs uniquement).
    return NextResponse.json({
      ok: true,
      environment,
      claimedCount: result.claimedCount,
      reconciledCount: result.reconciledCount,
      confirmedCount: result.confirmedCount,
      cancelledCount: result.cancelledCount,
      rescheduledCount: result.rescheduledCount,
      compensationRequestedCount: result.compensationRequestedCount,
      anomalyCount: result.anomalyCount,
    });
  } catch (error) {
    // 6. Erreur technique : log et 500.
    const durationMs = Date.now() - startTime;
    console.error(
      JSON.stringify({
        event: 'cron.reconcile-payments.error',
        durationMs,
        environment,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
