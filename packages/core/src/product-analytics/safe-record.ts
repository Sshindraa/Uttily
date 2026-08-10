/**
 * @uttily/core — Module Product Analytics (G7H-B).
 *
 * Enregistrement best-effort d'un evenement analytics avec isolation d'erreur.
 *
 * Deux contextes :
 * - DatabaseClient hors transaction : await + try/catch.
 * - DatabaseTransaction active : nested transaction/savepoint + try/catch externe.
 *
 * Un simple try/catch autour d'un INSERT qui echoue dans une transaction
 * PostgreSQL est INTERDIT : la transaction resterait aborted. Le savepoint
 * garantit que la transaction externe reste utilisable.
 *
 * Retourne une union fermee :
 * - RECORDED : l'insert a reussi.
 * - DUPLICATE : un evenement identique existait deja (ON CONFLICT DO NOTHING).
 * - DISABLED : l'environnement est DISABLED, aucun appel DB.
 * - FAILED : une erreur a ete catchee et loggee, mais jamais relancee.
 *
 * Les logs sont structures et bornes : eventType et un code d'erreur normalise.
 * JAMAIS sourceId, parametres de recherche, identifiants metier, message
 * PostgreSQL ou donnees personnelles.
 *
 * G7H-B defense-in-depth : bien que `ResolvedAnalyticsEnvironment` soit une
 * union fermee sans PRODUCTION, JavaScript n'empeche pas un cast runtime
 * (`'PRODUCTION' as ResolvedAnalyticsEnvironment`). Les safe recorders
 * rejettent donc explicitement toute valeur differente de 'DEVELOPMENT' ou
 * 'TEST' en retournant DISABLED sans aucun appel DB. Le low-level
 * `recordProductAnalyticsEvent` peut encore accepter PRODUCTION pour une
 * activation future controlee, mais le verrou G7H-B appartient au resolver /
 * safe recorder / cablage.
 */

import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import { ProductAnalyticsError } from './errors';
import { recordProductAnalyticsEvent } from './record-event';
import type { ResolvedAnalyticsEnvironment } from './runtime';
import type { SafeRecordEventInput } from './types';

export type SafeRecordResult = 'RECORDED' | 'DUPLICATE' | 'DISABLED' | 'FAILED';

/**
 * Defense-in-depth G7H-B : verifie qu'un environnement resolu est collectable.
 *
 * Le type `ResolvedAnalyticsEnvironment` est une union fermee sans PRODUCTION,
 * mais JavaScript permet les casts runtime. Cette fonction rejette donc toute
 * valeur differente de 'DEVELOPMENT' ou 'TEST' (y compris 'PRODUCTION' injecte
 * par cast) en retournant false. Le safe recorder retourne alors DISABLED sans
 * aucun appel DB.
 */
function isCollectableEnvironment(
  environment: ResolvedAnalyticsEnvironment,
): environment is 'DEVELOPMENT' | 'TEST' {
  return environment === 'DEVELOPMENT' || environment === 'TEST';
}

/**
 * Normalise un code d'erreur pour le logging structure.
 * N'expose jamais le message PostgreSQL original ni de donnees sensibles.
 */
function normalizeErrorCode(error: unknown): string {
  if (error instanceof ProductAnalyticsError) {
    return error.code;
  }
  return 'ANALYTICS_UNAVAILABLE';
}

/**
 * Log structure borne pour un echec d'enregistrement analytics.
 * Contient uniquement eventType et un code d'erreur normalise.
 * JAMAIS sourceId, parametres, identifiants metier ou message PostgreSQL.
 */
function logAnalyticsFailure(eventType: string, errorCode: string): void {
  console.error(
    JSON.stringify({
      event: 'product-analytics.record-failed',
      eventType,
      errorCode,
    }),
  );
}

/**
 * Enregistre un evenement analytics de maniere best-effort HORS transaction.
 *
 * - Si l'environnement est DISABLED (ou toute valeur non collectable, y compris
 *   PRODUCTION injecte par cast runtime), retourne DISABLED sans appel DB.
 * - Si l'insert reussit, retourne RECORDED.
 * - Si un evenement identique existait deja (DUPLICATE), retourne DUPLICATE.
 * - Si une erreur se produit, la catche, la logge et retourne FAILED.
 *   L'erreur n'est JAMAIS relancee vers le chemin metier.
 *
 * @param db Client de base de donnees (hors transaction).
 * @param input Entree discriminnee de l'evenement.
 * @param environment Environnement resolu (DEVELOPMENT, TEST ou DISABLED).
 */
export async function safeRecordAnalyticsEvent(
  db: DatabaseClient,
  input: SafeRecordEventInput,
  environment: ResolvedAnalyticsEnvironment,
): Promise<SafeRecordResult> {
  // G7H-B defense-in-depth : rejeter toute valeur non collectable.
  // Le type est ferme sans PRODUCTION, mais un cast runtime reste possible.
  if (!isCollectableEnvironment(environment)) {
    return 'DISABLED';
  }

  try {
    const result = await recordProductAnalyticsEvent(db, {
      ...input,
      environment,
    });
    if ('kind' in result && result.kind === 'DUPLICATE') {
      return 'DUPLICATE';
    }
    return 'RECORDED';
  } catch (error) {
    logAnalyticsFailure(input.eventType, normalizeErrorCode(error));
    return 'FAILED';
  }
}

/**
 * Enregistre un evenement analytics de maniere best-effort DANS une transaction.
 *
 * Utilise un SAVEPOINT (nested transaction via tx.transaction) pour isoler
 * l'INSERT analytics. Si l'INSERT echoue, le savepoint est annule mais la
 * transaction externe reste utilisable.
 *
 * - Si l'environnement est DISABLED (ou toute valeur non collectable, y compris
 *   PRODUCTION injecte par cast runtime), retourne DISABLED sans appel DB.
 * - Si l'insert reussit, retourne RECORDED.
 * - Si un evenement identique existait deja (DUPLICATE), retourne DUPLICATE.
 * - Si une erreur se produit, la catche, la logge et retourne FAILED.
 *   Le savepoint est annule ; la transaction externe n'est JAMAIS affectee.
 *   L'erreur n'est JAMAIS relancee vers le chemin metier.
 *
 * @param tx Transaction PostgreSQL active.
 * @param input Entree discriminnee de l'evenement.
 * @param environment Environnement resolu (DEVELOPMENT, TEST ou DISABLED).
 */
export async function safeRecordAnalyticsEventInTransaction(
  tx: DatabaseTransaction,
  input: SafeRecordEventInput,
  environment: ResolvedAnalyticsEnvironment,
): Promise<SafeRecordResult> {
  // G7H-B defense-in-depth : rejeter toute valeur non collectable.
  // Le type est ferme sans PRODUCTION, mais un cast runtime reste possible.
  if (!isCollectableEnvironment(environment)) {
    return 'DISABLED';
  }

  try {
    // Le savepoint isole l'INSERT analytics. Si l'INSERT echoue, le savepoint
    // est annule par Drizzle (ROLLBACK TO SAVEPOINT) et la transaction externe
    // reste utilisable. Le try/catch externe evite que l'erreur remonte.
    const result = await tx.transaction(async (sp) => {
      return await recordProductAnalyticsEvent(sp, {
        ...input,
        environment,
      });
    });
    if ('kind' in result && result.kind === 'DUPLICATE') {
      return 'DUPLICATE';
    }
    return 'RECORDED';
  } catch (error) {
    logAnalyticsFailure(input.eventType, normalizeErrorCode(error));
    return 'FAILED';
  }
}
