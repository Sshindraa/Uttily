import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { verifyCronSecret } from '@/lib/cron-auth';
import { runProductAnalyticsMaintenance } from '@/lib/product-analytics-maintenance';
import { ProductAnalyticsError, type ProductAnalyticsErrorCode } from '@uttily/core';

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
 * Endpoint Cron de maintenance analytics produit (Chantier 18-A).
 *
 * Agrège les jours de la fenêtre de rattrapage pour chaque environnement
 * maintenu (DEVELOPMENT, TEST — jamais PRODUCTION), puis purge les événements
 * raw expirés et les agrégats expirés selon les règles Core existantes.
 *
 * Sécurité :
 * - Authentification par secret partagé (CRON_SECRET) dans le header
 *   Authorization: Bearer ${CRON_SECRET}, refus fail-closed si absent.
 * - Méthode GET uniquement (Vercel Cron utilise GET).
 * - Réponse strictement composée de compteurs et d'étiquettes d'environnement :
 *   aucune donnée personnelle, aucun identifiant métier, aucun UUID.
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
    console.warn(
      'cron.process-product-analytics: 401 Unauthorized — secret manquant ou incorrect.',
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const db = getDb();
    const result = await runProductAnalyticsMaintenance(db);

    const durationMs = Date.now() - startTime;
    console.log(
      JSON.stringify({
        event: 'cron.process-product-analytics',
        durationMs,
        fromDay: result.window.fromDay,
        toDayExclusive: result.window.toDayExclusive,
        collectionEnvironment: result.collectionEnvironment,
        productionCollectionEnabled: result.productionCollectionEnabled,
        aggregatedEnvironments: result.aggregatedEnvironments,
        aggregationDaysProcessed: result.aggregationDaysProcessed,
        rawEventsDeleted: result.purge.rawEventsDeleted,
        aggregatesDeleted: result.purge.aggregatesDeleted,
      }),
    );

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
      console.error(
        JSON.stringify({
          event: 'cron.process-product-analytics.maintenance-error',
          durationMs,
          code: safeErrorCode(error),
        }),
      );
      return NextResponse.json(
        { ok: false, error: 'Maintenance Error', code: safeErrorCode(error) },
        { status: 500 },
      );
    }

    // 4. Erreur technique : aucune fuite d'interne.
    console.error(
      JSON.stringify({
        event: 'cron.process-product-analytics.error',
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
