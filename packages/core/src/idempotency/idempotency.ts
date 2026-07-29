import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import { idempotencyRecords } from '@uttily/database';
import { IdempotencyError } from './errors';
import {
  toRow,
  type IdempotencyRecordRow,
  type IdempotencyReservation,
  type LockKeyResult,
} from './types';

/**
 * @uttily/core — Idempotency protocol (ADR-009 section 11b).
 *
 * Étapes du protocole d'exécution :
 * - Étape 1 (reserveKey) : réserver et committer la clé en PENDING (transaction séparée).
 * - Étape 2 (lockKey)    : verrouiller la ligne PENDING pendant la transaction de création.
 * - Étape 3 (completeKey): terminer atomiquement en COMPLETED dans la même transaction.
 * - Étape 4 (failKey)    : marquer FAILED en cas d'échec, dans la même transaction.
 *
 * L'étape 5 (récupération PENDING expiré) est gérée dans reserveKey.
 *
 * IMPORTANT : ACQUIRED et PENDING passent tous les deux par lockKey.
 * lockKey retourne une union LOCKED | REPLAY qui DOIT être examinée.
 * Ne jamais exécuter la création après un REPLAY.
 *
 * Le use case de création (étape 4 du Lot 4) appellera :
 *
 *   const reservation = await reserveKey(db, { organizationId, operation, key, requestFingerprint });
 *
 *   if (reservation.kind === 'REPLAY') {
 *     return persistedResponse(reservation.record);
 *   }
 *   if (reservation.kind === 'CONFLICT') {
 *     throw new IdempotencyError('CONFLICT_IDEMPOTENCY', 'Clé réutilisée avec un payload différent');
 *   }
 *
 *   // ACQUIRED ou PENDING : une seule transaction pour lockKey + création + completeKey.
 *   return await db.transaction(async (tx) => {
 *     const lock = await lockKey(tx, reservation.record.id);
 *
 *     if (lock.kind === 'REPLAY') {
 *       return persistedResponse(lock.record);
 *     }
 *
 *     // LOCKED : exécuter la création (brouillon, lignes, blocs, allocations).
 *     const draft = await createBookingDraft(tx, ...);
 *
 *     await completeKey(tx, reservation.record.id, {
 *       resourceId: draft.id,
 *       responseStatusCode: 201,
 *       responseBody: draft,
 *     });
 *
 *     return draft;
 *   });
 *
 *   En cas d'erreur métier dans la transaction : le savepoint est annulé,
 *   puis failKey est appelé dans la même transaction externe.
 */

/**
 * Délai d'expiration par défaut d'une clé PENDING : 5 minutes.
 * Au-delà, un PENDING est considéré comme abandonné et peut être renouvelé
 * par une requête concurrente avec la même empreinte (ADR-009 section 11b étape 5).
 */
const DEFAULT_PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Entrée de la fonction reserveKey.
 */
export interface ReserveKeyInput {
  organizationId: string;
  operation: string;
  key: string;
  requestFingerprint: string;
  /** Délai d'expiration du PENDING en millisecondes (défaut 5 minutes). */
  pendingTimeoutMs?: number;
}

/**
 * Étape 1 du protocole d'exécution (ADR-009 section 11b) :
 * réserver et committer la clé en PENDING (transaction séparée, courte).
 *
 * Tente `INSERT ... ON CONFLICT (organization_id, operation, key) DO NOTHING`.
 * - Si l'insertion réussit → ACQUIRED (nouveau PENDING).
 * - Si un enregistrement existe déjà :
 *   - empreinte différente → CONFLICT (409).
 *   - empreinte identique + COMPLETED → REPLAY (retourner la réponse persistée).
 *   - empreinte identique + FAILED → REPLAY (retourner la réponse d'erreur persistée).
 *   - empreinte identique + PENDING expiré → tenter de renouveler → ACQUIRED
 *     (ou relire l'état courant si une autre requête a repris la clé).
 *   - empreinte identique + PENDING actif (non expiré) → PENDING (l'appelant doit
 *     poursuivre vers lockKey qui attendra le verrou puis retournera la réponse).
 *
 * Les timestamps (`pending_timeout_at`) sont calculés côté PostgreSQL via `now()`
 * pour éviter la dérive d'horloge entre instances (ADR-009).
 */
export async function reserveKey(
  db: DatabaseClient,
  input: ReserveKeyInput,
): Promise<IdempotencyReservation> {
  // Validation des entrées.
  if (!input.organizationId || input.organizationId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'organizationId est requis.');
  }
  if (!input.operation || input.operation.length === 0) {
    throw new IdempotencyError('VALIDATION', 'operation est requis.');
  }
  if (!input.key || input.key.length === 0) {
    throw new IdempotencyError('VALIDATION', 'key est requis.');
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new IdempotencyError(
      'VALIDATION',
      'requestFingerprint doit être un SHA-256 hex64 valide.',
    );
  }
  const pendingTimeoutMs = input.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  if (!Number.isSafeInteger(pendingTimeoutMs) || pendingTimeoutMs <= 0) {
    throw new IdempotencyError(
      'VALIDATION',
      'pendingTimeoutMs doit être un entier strictement positif.',
    );
  }

  // Tente d'insérer en PENDING. ON CONFLICT DO NOTHING.
  // pending_timeout_at est calculé côté PostgreSQL via now() pour éviter la dérive d'horloge.
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      organizationId: input.organizationId,
      operation: input.operation,
      key: input.key,
      requestFingerprint: input.requestFingerprint,
      status: 'PENDING',
      pendingTimeoutAt: sql`now() + make_interval(secs => ${pendingTimeoutMs} / 1000.0)`,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.organizationId,
        idempotencyRecords.operation,
        idempotencyRecords.key,
      ],
    })
    .returning();

  if (inserted.length > 0) {
    return { kind: 'ACQUIRED', record: toRow(inserted[0]!) };
  }

  // Un enregistrement existe déjà : le lire.
  const existing = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, input.organizationId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    // Race condition : l'enregistrement a été supprimé entre l'ON CONFLICT et le SELECT.
    throw new IdempotencyError('UNKNOWN', 'Race condition sur la réservation de clé idempotente.');
  }

  const record = toRow(existing[0]!);

  // Comparer l'empreinte.
  if (record.requestFingerprint !== input.requestFingerprint) {
    return { kind: 'CONFLICT', record };
  }

  // Même empreinte.
  if (record.status === 'COMPLETED') {
    return { kind: 'REPLAY', record };
  }

  if (record.status === 'FAILED') {
    // Retourner la réponse d'erreur persistée (même contrat que REPLAY).
    return { kind: 'REPLAY', record };
  }

  // PENDING : vérifier si expiré (comparaison côté PostgreSQL via now()).
  if (record.status === 'PENDING') {
    const expired = await db
      .select({ isExpired: sql<boolean>`${idempotencyRecords.pendingTimeoutAt} < now()` })
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.id, record.id))
      .limit(1);

    if (expired.length > 0 && expired[0]!.isExpired) {
      // PENDING abandonné : tenter de renouveler via mise à jour conditionnelle.
      // La condition pending_timeout_at < now() est évaluée côté PostgreSQL.
      const renewed = await db
        .update(idempotencyRecords)
        .set({
          pendingTimeoutAt: sql`now() + make_interval(secs => ${pendingTimeoutMs} / 1000.0)`,
        })
        .where(
          and(
            eq(idempotencyRecords.id, record.id),
            eq(idempotencyRecords.status, 'PENDING'),
            eq(idempotencyRecords.requestFingerprint, input.requestFingerprint),
            sql`${idempotencyRecords.pendingTimeoutAt} < now()`,
          ),
        )
        .returning();

      if (renewed.length > 0) {
        return { kind: 'ACQUIRED', record: toRow(renewed[0]!) };
      }

      // Une autre requête a déjà repris la clé ou le statut a changé.
      // Relire et retourner l'état courant.
      const current = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.id, record.id))
        .limit(1);

      if (current.length > 0) {
        const currentRecord = toRow(current[0]!);
        if (currentRecord.status === 'COMPLETED' || currentRecord.status === 'FAILED') {
          return { kind: 'REPLAY', record: currentRecord };
        }
        // Toujours PENDING (une autre requête a repris la clé).
        return { kind: 'PENDING', record: currentRecord };
      }
      throw new IdempotencyError(
        'UNKNOWN',
        'Race condition sur le renouvellement de clé idempotente.',
      );
    }

    // PENDING actif (non expiré) : une autre requête est en cours.
    // L'appelant doit poursuivre vers lockKey (qui attendra le verrou).
    return { kind: 'PENDING', record };
  }

  // Cas anormal : statut inconnu.
  throw new IdempotencyError(
    'UNKNOWN',
    `Statut idempotency inattendu: ${record.status satisfies never}`,
  );
}

/**
 * Étape 2 du protocole (ADR-009 section 11b) : verrouiller la ligne PENDING
 * pendant la transaction de création. Doit être appelé DANS la transaction
 * de création, avant d'exécuter la logique métier.
 *
 * Utilise SELECT ... FOR UPDATE pour poser un verrou pessimiste sur la ligne.
 * Si une autre requête a terminé pendant l'attente, retourne REPLAY (la réponse
 * persistée doit être retournée telle quelle). Si la ligne est toujours PENDING,
 * retourne LOCKED (cette transaction exécute la création).
 *
 * @param tx Transaction active (DatabaseTransaction)
 * @param recordId ID de l'enregistrement idempotency_records à verrouiller
 * @returns LOCKED si PENDING (cette transaction exécute), REPLAY si terminé
 * @throws IdempotencyError si la ligne n'existe pas (cas anormal)
 */
export async function lockKey(tx: DatabaseTransaction, recordId: string): Promise<LockKeyResult> {
  // SELECT ... FOR UPDATE via drizzle-orm : utiliser .for('update')
  const rows = await tx
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.id, recordId))
    .for('update')
    .limit(1);

  if (rows.length === 0) {
    throw new IdempotencyError(
      'UNKNOWN',
      `Enregistrement idempotent ${recordId} introuvable lors du verrouillage.`,
    );
  }

  const record = toRow(rows[0]!);

  if (record.status === 'PENDING') {
    return { kind: 'LOCKED', record };
  }

  if (record.status === 'COMPLETED' || record.status === 'FAILED') {
    return { kind: 'REPLAY', record };
  }

  // Cas anormal : statut inconnu.
  throw new IdempotencyError(
    'UNKNOWN',
    `Statut idempotency inattendu lors du verrouillage: ${record.status satisfies never}`,
  );
}

/**
 * Entrée de la fonction completeKey.
 */
export interface CompleteKeyInput {
  resourceId: string;
  responseStatusCode: number;
  responseBody: unknown;
}

/**
 * Étape 3 du protocole (ADR-009 section 11b) : terminer atomiquement en COMPLETED.
 *
 * Doit être appelé DANS la transaction de création, après que la ressource a été
 * créée. La mise à jour est conditionnelle sur `status = 'PENDING'` : si l'enregistrement
 * n'est plus PENDING (race), aucune ligne n'est mise à jour et une erreur est levée.
 * `completed_at` est calculé côté PostgreSQL via `now()` pour éviter la dérive d'horloge.
 *
 * @param tx transaction active (DatabaseTransaction) — partage la même transaction que la création.
 */
export async function completeKey(
  tx: DatabaseTransaction,
  recordId: string,
  response: CompleteKeyInput,
): Promise<IdempotencyRecordRow> {
  const updated = await tx
    .update(idempotencyRecords)
    .set({
      status: 'COMPLETED',
      resourceId: response.resourceId,
      responseStatusCode: response.responseStatusCode,
      responseBody: response.responseBody,
      completedAt: sql`now()`,
    })
    .where(and(eq(idempotencyRecords.id, recordId), eq(idempotencyRecords.status, 'PENDING')))
    .returning();

  if (updated.length === 0) {
    throw new IdempotencyError(
      'UNKNOWN',
      `Impossible de terminer l'enregistrement idempotent ${recordId} : non trouvé ou non PENDING.`,
    );
  }
  return toRow(updated[0]!);
}

/**
 * Entrée de la fonction failKey.
 */
export interface FailKeyInput {
  responseStatusCode: number;
  responseBody: unknown;
}

/**
 * Étape 4 du protocole (ADR-009 section 11b) : marquer comme FAILED.
 *
 * Doit être appelé DANS la transaction, après rollback du savepoint de l'opération
 * métier. La mise à jour est conditionnelle sur `status = 'PENDING'`. Le `resourceId`
 * reste NULL (contrainte CHECK `idempotency_records_failed_has_response`).
 * `completed_at` est calculé côté PostgreSQL via `now()` pour éviter la dérive d'horloge.
 *
 * @param tx transaction active (DatabaseTransaction) — la transaction externe est ensuite committée.
 */
export async function failKey(
  tx: DatabaseTransaction,
  recordId: string,
  response: FailKeyInput,
): Promise<IdempotencyRecordRow> {
  const updated = await tx
    .update(idempotencyRecords)
    .set({
      status: 'FAILED',
      responseStatusCode: response.responseStatusCode,
      responseBody: response.responseBody,
      completedAt: sql`now()`,
    })
    .where(and(eq(idempotencyRecords.id, recordId), eq(idempotencyRecords.status, 'PENDING')))
    .returning();

  if (updated.length === 0) {
    throw new IdempotencyError(
      'UNKNOWN',
      `Impossible de marquer l'enregistrement idempotent ${recordId} comme FAILED : non trouvé ou non PENDING.`,
    );
  }
  return toRow(updated[0]!);
}
