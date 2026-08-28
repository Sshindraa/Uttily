import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { verifyCronSecret } from '@/lib/cron-auth';
import { runProductAnalyticsMaintenance } from '@/lib/product-analytics-maintenance';
import {
  emitOperationalLog,
  ProductAnalyticsError,
  type ProductAnalyticsErrorCode,
} from '@uttily/core';

// Désactive l'optimisation statique : cet endpoint doit toujours s'exécuter
// dynamiquement (cron).
export const dynamic = 'force-dynamic';

/**
 * Codes Core autorisés dans une réponse d'erreur.
 *
 * Liste fermée : aucun message, aucune pile, aucun identifiant, aucune
 * structure de table n'est exposé. Un code hors allow-list est normalisé en
 * `MAINTENANCE_FAILED`, ce qui borne strictement la surface de fuite.
 */
const SAFE_ERROR_CODES: ReadonlySet<ProductAnalyticsErrorCode> = new Set<ProductAnalyticsErrorCode>(
  [
    'INVALID_INPUT',
    'INVALID_DATE',
    'INVALID_DAY_RANGE',
    'RANGE_TOO_LARGE',
    'INVALID_ENVIRONMENT',
    'OVERFLOW',
    'ANALYTICS_UNAVAILABLE',
  ],
);

function safeErrorCode(error: ProductAnalyticsError): string {
  return SAFE_ERROR_CODES.has(error.code) ? error.code : 'MAINTENANCE_FAILED';
}

/**
 * Endpoint Cron de maintenance analytics produit (Chantier 18-A / 18.1).
 *
 * Agrège les jours de la fenêtre de rattrapage pour chaque environnement
 * maintenu (DEVELOPMENT, TEST — jamais PRODUCTION), puis purge les événements
 * raw expirés et les agrégats expirés selon les règles Core existantes.
 *
 * Sécurité & Observabilité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}, refus fail-closed avec log structuré UNAUTHORIZED.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Utilisation exclusive de `emitOperationalLog` : aucun raw console.log/warn/error,
 *   aucun message d'erreur brut, aucune stack, aucune fuite sensible.
 * - Réponse déterministe strictement composée de compteurs et labels sûrs.
 *
 * Invariant PRODUCTION :
 * - La route n'écrit aucune configuration et n'active aucune collecte. Le champ
 *   `productionCollectionEnabled` est constant à `false`.
 *
 * Rejeu :
 * - L'agrégation est un recalcul idempotent, la purge est une compaction
 *   additive. Une exécution répétée converge vers le même état.
 *
 * @see ADR-022 (privacy & rétention analytics), conventions cron Uttily
 */
export async function GET(request: Request): Promise<NextResponse> {
  // 1. Authentification (fail-closed).
  if (!verifyCronSecret(request)) {
    emitOperationalLog({
      operation: 'cron_process_product_analytics',
      outcome: 'failed',
      errorCode: 'UNAUTHORIZED',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const db = getDb();
    const result = await runProductAnalyticsMaintenance(db);

    const durationMs = Date.now() - startTime;
    emitOperationalLog({
      operation: 'cron_process_product_analytics',
      outcome: 'success',
      durationMs,
      counts: {
        processed: result.aggregationDaysProcessed,
      },
    });

    // 2. Réponse déterministe : compteurs utiles uniquement.
    return NextResponse.json({
      ok: true,
      window: {
        fromDay: result.window.fromDay,
        toDayExclusive: result.window.toDayExclusive,
      },
      collectionEnvironment: result.collectionEnvironment,
      productionCollectionEnabled: result.productionCollectionEnabled,
      aggregatedEnvironments: result.aggregatedEnvironments,
      aggregationDaysProcessed: result.aggregationDaysProcessed,
      purge: {
        rawEventsDeleted: result.purge.rawEventsDeleted,
        aggregatesDeleted: result.purge.aggregatesDeleted,
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (error instanceof ProductAnalyticsError) {
      // 3. Erreur métier bornée : code allow-listé uniquement, jamais le message.
      const code = safeErrorCode(error);
      emitOperationalLog({
        operation: 'cron_process_product_analytics',
        outcome: 'failed',
        durationMs,
        errorCode: code,
      });
      return NextResponse.json({ ok: false, error: 'Maintenance Error', code }, { status: 500 });
    }

    // 4. Erreur technique : log structuré fermé sans fuite d'information.
    emitOperationalLog({
      operation: 'cron_process_product_analytics',
      outcome: 'failed',
      durationMs,
      errorCode: 'INTERNAL_ERROR',
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
