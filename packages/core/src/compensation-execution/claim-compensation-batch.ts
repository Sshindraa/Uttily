/**
 * @uttily/core — Revendication d'un batch de compensations (Phase 8, ADR-010 §13).
 *
 * Transaction PostgreSQL courte qui sélectionne les événements outbox
 * `PAYMENT_COMPENSATION_REQUESTED` au statut `PENDING` dont l'échéance est
 * atteinte, les verrouille avec `FOR UPDATE SKIP LOCKED`, et pose un lease de
 * 2 minutes avec un token UUID.
 *
 * Aucun appel Stripe n'est effectué dans cette transaction — le COMMIT a lieu
 * avant tout appel provider.
 *
 * Le filtrage par environnement se fait via `payments.environment` car le
 * refund n'a pas de colonne environnement.
 */

import { sql } from 'drizzle-orm';
import { type DatabaseClient } from '@uttily/database';
import type { StripeEnvironment } from '../payments/types';
import { LEASE_INTERVAL, DEFAULT_BATCH_LIMIT } from './scheduling';
import type { ClaimedCompensation } from './types';

/**
 * Revendique un batch d'événements de compensation à exécuter.
 *
 * Sélectionne les outbox_events avec:
 * - status = 'PENDING'
 * - event_type = 'PAYMENT_COMPENSATION_REQUESTED'
 * - available_at <= now()
 * - (lease_until IS NULL OR lease_until <= now())
 * - payments.environment = environment (filtrage TEST/LIVE)
 *
 * Verrouille avec FOR UPDATE OF oe SKIP LOCKED, ORDER BY available_at ASC,
 * LIMIT batchLimit. Pose lease_until = now() + 2 minutes et
 * lease_token = UUID aléatoire.
 *
 * @param db Client base de données.
 * @param batchLimit Nombre maximum d'événements à revendiquer.
 * @param environment Environnement Stripe (TEST/LIVE) pour filtrer.
 * @returns Les événements revendiqués avec leur snapshot complet.
 */
export async function claimCompensationBatch(
  db: DatabaseClient,
  batchLimit: number = DEFAULT_BATCH_LIMIT,
  environment: StripeEnvironment = 'TEST',
): Promise<ClaimedCompensation[]> {
  return await db.transaction(async (tx) => {
    // Sélectionner et verrouiller les événements éligibles.
    // Join refunds sur payload->>'refundIdempotencyKey' = refunds.provider_idempotency_key
    // et payments sur payload->>'paymentId' = payments.id pour filtrer par environnement.
    const rows = await tx.execute(sql`
      SELECT
        oe.id AS outbox_event_id,
        oe.organization_id,
        (oe.payload->>'paymentId') AS payment_id,
        (oe.payload->>'refundIdempotencyKey') AS refund_idempotency_key,
        (oe.payload->>'amountMinor')::bigint AS amount_minor,
        (oe.payload->>'currency') AS currency,
        (oe.payload->>'reason') AS reason,
        oe.attempt_count,
        oe.lease_until AS current_lease_until
      FROM "outbox_events" oe
      JOIN "refunds" r ON r."provider_idempotency_key" = (oe.payload->>'refundIdempotencyKey')
      JOIN "payments" p ON p."id" = (oe.payload->>'paymentId')::uuid
      WHERE oe."status" IN ('PENDING', 'PROCESSING')
        -- PROCESSING est inclus pour permettre la récupération des événements
        -- dont la lease a expiré (worker crashé). La condition lease_until <= now()
        -- garantit qu'on ne reclaims pas un événement encore en cours.
        AND oe."event_type" = 'PAYMENT_COMPENSATION_REQUESTED'
        AND oe."available_at" <= now()
        AND (oe."lease_until" IS NULL OR oe."lease_until" <= now())
        AND p."environment" = ${environment}::payment_environment
      ORDER BY oe."available_at" ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF oe SKIP LOCKED
    `);

    const rawRows = rows as unknown as Array<{
      outbox_event_id: string;
      organization_id: string;
      payment_id: string;
      refund_idempotency_key: string;
      amount_minor: string | number;
      currency: string;
      reason: string;
      attempt_count: number;
      current_lease_until: Date | null;
    }>;

    if (rawRows.length === 0) {
      return [];
    }

    // Générer un token UUID par événement et poser le lease.
    // NOTE : le token est généré côté application (Node.js crypto.randomUUID).
    // Le fencing token est utilisé dans un UPDATE conditionnel
    // (WHERE lease_token = ${token}) lors de la persistance, ce qui garantit
    // qu'un worker ne peut effacer que son propre lease.
    const eventIds = rawRows.map((r) => r.outbox_event_id);
    const leaseTokens = rawRows.map(() => crypto.randomUUID());

    // UPDATE avec FROM (VALUES) pour assigner un token différent par ligne.
    const valuesClause = leaseTokens
      .map((token, i) => `('${eventIds[i]}'::uuid, '${token}'::uuid)`)
      .join(', ');
    const leaseRows = await tx.execute(sql`
      UPDATE "outbox_events"
      SET "lease_until" = now() + ${LEASE_INTERVAL},
          "lease_token" = v.token,
          "status" = 'PROCESSING'
      FROM (VALUES ${sql.raw(valuesClause)}) AS v(id, token)
      WHERE "outbox_events"."id" = v.id
      RETURNING "outbox_events"."id" AS id, "outbox_events"."lease_until" AS lease_until
    `);

    // Construire le mapping lease par event.
    const leaseMap = new Map<string, Date>();
    for (const lr of leaseRows as unknown as Array<{
      id: string;
      lease_until: Date;
    }>) {
      leaseMap.set(lr.id, lr.lease_until);
    }

    // Construire le mapping token par event (même ordre que eventIds).
    const tokenMap = new Map<string, string>();
    for (let i = 0; i < eventIds.length; i++) {
      tokenMap.set(eventIds[i]!, leaseTokens[i]!);
    }

    // Construire les ClaimedCompensation avec le snapshot complet.
    const claimed: ClaimedCompensation[] = [];
    for (const r of rawRows) {
      const leaseUntil = leaseMap.get(r.outbox_event_id);
      if (!leaseUntil) continue;
      const leaseToken = tokenMap.get(r.outbox_event_id);
      if (!leaseToken) continue;
      claimed.push({
        outboxEventId: r.outbox_event_id,
        organizationId: r.organization_id,
        paymentId: r.payment_id,
        refundIdempotencyKey: r.refund_idempotency_key,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        reason: r.reason,
        leaseToken,
        leaseUntil,
        attemptCount: r.attempt_count,
      });
    }

    return claimed;
  });
}
