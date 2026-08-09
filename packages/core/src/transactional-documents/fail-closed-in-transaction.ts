/**
 * @uttily/core — Fail-closed helper interne (G5E Round 5, ADR-013 §11).
 *
 * Module interne — NON ré-exporté depuis index.ts.
 *
 * Extrait de transactional-email-pipeline.ts pour permettre :
 *  1. Des tests directs du helper dans une vraie transaction PostgreSQL
 *     (injection cross-event, cardinalité, lease expirée, etc.).
 *  2. Un durcissement du contrôle de cardinalité : les UPDATE RETURNING
 *     sont désormais capturés et analysés au lieu d'être ignorés.
 *  3. Une classe d'erreur typée FencingFailureError pour distinguer une
 *     perte de lease d'une vraie violation d'invariant en Phase A.
 *
 * Contrôle de cardinalité (durci, Round 5) :
 *
 *  Effect UPDATE (SEND_EMAIL → FAILED) :
 *    - RETURNING capturé.
 *    - > 1 ligne → FAIL_CLOSED_CARDINALITY_VIOLATED (impossible avec les
 *      prédicats, mais défensif).
 *    - 0 ligne + sendEmailEffectId non null :
 *        Re-read scopé : SELECT status WHERE id + organization_id +
 *        outbox_event_id + effect_type = 'SEND_EMAIL'.
 *        - 1 ligne avec status COMPLETED ou FAILED → déjà terminal :
 *          acceptable, NE PAS jeter (pas de régression).
 *        - 1 ligne avec status PENDING → la mutation attendue n'a pas eu
 *          lieu (instrumentation ou anomalie) → FAIL_CLOSED_PRECONDITION_VIOLATED.
 *        - 0 ligne → l'effet n'appartient pas à cet événement/org, ou l'ID
 *          n'existe pas du tout. AUCUNE différence observable entre les deux
 *          (pas de re-read non-scopé — pas d'oracle cross-tenant) →
 *          FAIL_CLOSED_EFFECT_SCOPE_MISMATCH.
 *
 *  Notification UPDATE (notification → FAILED) :
 *    - RETURNING capturé.
 *    - > 1 ligne → FAIL_CLOSED_CARDINALITY_VIOLATED.
 *    - 0 ligne + sendEmailEffectId non null :
 *        Re-read scopé : SELECT status WHERE outbox_effect_id +
 *        organization_id + outbox_event_id.
 *        - 1 ligne avec status SENT ou FAILED → déjà terminal :
 *          acceptable, NE PAS jeter.
 *        - 1 ligne avec status PENDING → la mutation attendue n'a pas eu
 *          lieu (instrumentation ou anomalie) → FAIL_CLOSED_PRECONDITION_VIOLATED.
 *        - 0 ligne → acceptable (la notification n'existe pas pour cet
 *          événement/effet — c'est un état légitime : la notification
 *          peut ne pas avoir été créée en Phase A, ou Phase C peut
 *          gérer un cas PENDING × missing). NE PAS jeter. AUCUN re-read
 *          non-scopé.
 *
 *  Outbox UPDATE (outbox → FAILED, lease nettoyé) :
 *    - WHERE inclut AND "lease_until" > transaction_timestamp() (défense-en-
 *      profondeur : un worker avec un lease expiré ne peut pas marquer FAILED).
 *    - Doit retourner exactement 1 ligne. Si != 1 →
 *      RECONCILE_PRECONDITION_VIOLATED (lease perdue ou expirée → rollback).
 */

import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// FencingFailureError — discrimination d'une perte de lease en Phase A
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erreur levée quand le Phase A lock détecte que le lease a expiré ou a été
 * perdu (0 lignes au SELECT FOR UPDATE avec lease_token + lease_until > now()).
 *
 * Le catch en Phase A doit vérifier `instanceof FencingFailureError` et
 * faire `continue` (skip du fail-closed) — l'événement reste PROCESSING
 * avec son lease expiré ; il sera reclamé par un autre worker.
 */
export class FencingFailureError extends Error {
  readonly _fencingFailure = true as const;
  constructor(message = 'FENCING_FAILURE') {
    super(message);
    this.name = 'FencingFailureError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// failClosedInTransaction — helper de fail-closed avec contrôle de cardinalité
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marque un événement outbox comme FAILED + son effet SEND_EMAIL comme FAILED
 * + sa notification comme FAILED, dans une transaction/savepoint active.
 *
 * Toutes les UPDATE portent les prédicats multi-tenant (organization_id,
 * outbox_event_id) pour empêcher toute mutation cross-event.
 *
 * @param tx Transaction ou savepoint Drizzle active.
 * @param outboxEventId ID de l'événement outbox à marquer FAILED.
 * @param organizationId ID de l'organisation (prédicat multi-tenant).
 * @param leaseToken Token de lease du worker (prédicat de fencing).
 * @param sendEmailEffectId ID de l'effet SEND_EMAIL (ou null si introuvable).
 * @param failureCode Code d'échec à persister.
 * @throws {Error} 'FAIL_CLOSED_CARDINALITY_VIOLATED' si un UPDATE retourne > 1 ligne.
 * @throws {Error} 'FAIL_CLOSED_PRECONDITION_VIOLATED' si l'effet ou la notification
 *         est encore PENDING après un UPDATE à 0 ligne (la mutation attendue n'a pas
 *         eu lieu — instrumentation ou anomalie).
 * @throws {Error} 'FAIL_CLOSED_EFFECT_SCOPE_MISMATCH' si l'ID d'effet n'appartient
 *         pas à cet événement/org ou n'existe pas du tout (aucune différence
 *         observable entre les deux — pas d'oracle cross-tenant).
 * @throws {Error} 'RECONCILE_PRECONDITION_VIOLATED' si l'UPDATE outbox retourne != 1
 *         ligne (lease perdue ou expirée → rollback savepoint).
 */
export async function failClosedInTransaction(
  tx: Parameters<Parameters<import('@uttily/database').DatabaseClient['transaction']>[0]>[0],
  outboxEventId: string,
  organizationId: string,
  leaseToken: string,
  sendEmailEffectId: string | null,
  failureCode: string,
): Promise<void> {
  // ─── Effect UPDATE (SEND_EMAIL → FAILED si PENDING) ───
  // REQ 5: prédicats id + organization_id + outbox_event_id + effect_type +
  // status = 'PENDING', et RETURNING "id" pour contrôle de cardinalité.
  if (sendEmailEffectId) {
    const effectRows = (await tx.execute(sql`
      UPDATE "outbox_effects"
      SET "status" = 'FAILED',
          "completed_at" = transaction_timestamp(),
          "failure_code" = ${failureCode}::document_processing_failure_code
      WHERE "id" = ${sendEmailEffectId}::uuid
        AND "organization_id" = ${organizationId}::uuid
        AND "outbox_event_id" = ${outboxEventId}::uuid
        AND "effect_type" = 'SEND_EMAIL'
        AND "status" = 'PENDING'
      RETURNING "id"
    `)) as unknown as Array<{ id: string }>;

    if (effectRows.length > 1) {
      // Impossible avec les prédicats (id est unique), mais défensif.
      throw new Error('FAIL_CLOSED_CARDINALITY_VIOLATED');
    }

    if (effectRows.length === 0) {
      // 0 ligne : l'effet n'est plus PENDING (déjà terminal), ou l'ID
      // n'appartient pas à cet événement/org (cross-event), ou l'ID
      // n'existe pas du tout. Re-read scopé pour distinguer — AUCUN re-read
      // non-scopé (pas d'oracle cross-tenant).
      const scopedReRead = (await tx.execute(sql`
        SELECT "status" FROM "outbox_effects"
        WHERE "id" = ${sendEmailEffectId}::uuid
          AND "organization_id" = ${organizationId}::uuid
          AND "outbox_event_id" = ${outboxEventId}::uuid
          AND "effect_type" = 'SEND_EMAIL'
      `)) as unknown as Array<{ status: string }>;

      if (
        scopedReRead.length === 1 &&
        (scopedReRead[0]!.status === 'COMPLETED' || scopedReRead[0]!.status === 'FAILED')
      ) {
        // Déjà terminal → acceptable, pas de régression. Ne PAS jeter.
      } else if (scopedReRead.length === 1 && scopedReRead[0]!.status === 'PENDING') {
        // L'effet est encore PENDING : la mutation attendue n'a pas eu lieu
        // (instrumentation ou anomalie). Ne PAS accepter silencieusement.
        throw new Error('FAIL_CLOSED_PRECONDITION_VIOLATED');
      } else if (scopedReRead.length === 0) {
        // Le re-read scopé retourne 0 lignes : l'effet n'appartient pas à
        // cet événement/org, ou n'existe pas du tout. AUCUNE différence
        // observable entre les deux (pas de re-read non-scopé — pas d'oracle
        // cross-tenant).
        throw new Error('FAIL_CLOSED_EFFECT_SCOPE_MISMATCH');
      } else {
        // > 1 ligne du re-read scopé — impossible avec les prédicats, mais défensif.
        throw new Error('FAIL_CLOSED_CARDINALITY_VIOLATED');
      }
    }
  }

  // ─── Notification UPDATE (notification → FAILED si PENDING) ───
  // REQ 5: prédicats outbox_effect_id + organization_id + outbox_event_id +
  // status = 'PENDING', et RETURNING "id" pour contrôle de cardinalité.
  if (sendEmailEffectId) {
    const notifRows = (await tx.execute(sql`
      UPDATE "notification_deliveries"
      SET "status" = 'FAILED',
          "failure_code" = ${failureCode}::document_processing_failure_code
      WHERE "outbox_effect_id" = ${sendEmailEffectId}::uuid
        AND "organization_id" = ${organizationId}::uuid
        AND "outbox_event_id" = ${outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id"
    `)) as unknown as Array<{ id: string }>;

    if (notifRows.length > 1) {
      throw new Error('FAIL_CLOSED_CARDINALITY_VIOLATED');
    }

    if (notifRows.length === 0) {
      // 0 ligne : la notification n'est plus PENDING (déjà terminal), ou
      // n'existe pas / n'appartient pas à cet événement/org. Re-read scopé
      // pour distinguer — AUCUN re-read non-scopé.
      const notifReRead = (await tx.execute(sql`
        SELECT "status" FROM "notification_deliveries"
        WHERE "outbox_effect_id" = ${sendEmailEffectId}::uuid
          AND "organization_id" = ${organizationId}::uuid
          AND "outbox_event_id" = ${outboxEventId}::uuid
      `)) as unknown as Array<{ status: string }>;

      if (
        notifReRead.length === 1 &&
        (notifReRead[0]!.status === 'SENT' || notifReRead[0]!.status === 'FAILED')
      ) {
        // Déjà terminal → acceptable, pas de régression. Ne PAS jeter.
      } else if (notifReRead.length === 1 && notifReRead[0]!.status === 'PENDING') {
        // La notification est encore PENDING : la mutation attendue n'a pas
        // eu lieu (instrumentation ou anomalie). Ne PAS accepter silencieusement.
        throw new Error('FAIL_CLOSED_PRECONDITION_VIOLATED');
      } else if (notifReRead.length === 0) {
        // La notification n'existe pas pour cet événement/effet — c'est un
        // état légitime : la notification peut ne pas avoir été créée en
        // Phase A, ou Phase C peut gérer un cas PENDING × missing.
        // Ne PAS jeter. AUCUN re-read non-scopé.
      } else {
        // > 1 ligne du re-read scopé — impossible avec les prédicats, mais défensif.
        throw new Error('FAIL_CLOSED_CARDINALITY_VIOLATED');
      }
    }
  }

  // ─── Outbox UPDATE (outbox → FAILED, lease nettoyé) ───
  // REQ 5 + REQ 7: prédicats id + organization_id + lease_token +
  // lease_until > transaction_timestamp() (défense-en-profondeur : un worker
  // avec un lease expiré ne peut pas marquer FAILED).
  // Doit retourner exactement 1 ligne.
  const outboxUpdate = (await tx.execute(sql`
    UPDATE "outbox_events"
    SET "status" = 'FAILED',
        "lease_token" = NULL,
        "lease_until" = NULL,
        "processed_at" = NULL
    WHERE "id" = ${outboxEventId}::uuid
      AND "organization_id" = ${organizationId}::uuid
      AND "lease_token" = ${leaseToken}::uuid
      AND "lease_until" > transaction_timestamp()
    RETURNING "id"
  `)) as unknown as Array<{ id: string }>;

  if (outboxUpdate.length !== 1) {
    // Precondition violée (lease perdue ou expirée) → rollback.
    throw new Error('RECONCILE_PRECONDITION_VIOLATED');
  }
}
