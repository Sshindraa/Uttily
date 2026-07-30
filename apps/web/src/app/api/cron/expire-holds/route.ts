import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { expireBookingDraftsBatch } from '@uttily/core';

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
 * Endpoint Cron pour l'expiration batch des brouillons HELD expirés.
 *
 * Sécurité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Aucune donnée sensible dans la réponse (pas de draft IDs, pas de
 *   détails d'anomalies — seulement des compteurs).
 *
 * Observabilité :
 * - Log structuré du résultat de chaque invocation.
 * - Log d'alerte si anomalyCount > 0.
 * - Log d'erreur en cas d'échec technique.
 *
 * @see ADR-009 §18-19
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification.
  if (!verifyCronSecret(request)) {
    console.warn('cron.expire-holds: 401 Unauthorized — secret manquant ou incorrect.');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Exécuter le batch.
  try {
    const db = getDb();
    const result = await expireBookingDraftsBatch(db, 10);

    // 3. Log structuré.
    console.log(
      JSON.stringify({
        event: 'cron.expire-holds',
        processedCount: result.processedCount,
        expiredCount: result.expiredCount,
        anomalyCount: result.anomalyCount,
        batchLimit: result.batchLimit,
      }),
    );

    // Alerte si anomalies détectées.
    if (result.anomalyCount > 0) {
      console.warn(
        JSON.stringify({
          event: 'cron.expire-holds.anomalies',
          anomalyCount: result.anomalyCount,
          reasons: result.anomalies.map((a) => a.reason),
        }),
      );
    }

    // 4. Réponse sans données sensibles (compteurs uniquement).
    return NextResponse.json({
      ok: true,
      processedCount: result.processedCount,
      expiredCount: result.expiredCount,
      anomalyCount: result.anomalyCount,
      batchLimit: result.batchLimit,
    });
  } catch (error) {
    // 5. Erreur technique : log et 500.
    console.error(
      JSON.stringify({
        event: 'cron.expire-holds.error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
