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
import { DEFAULT_BATCH_LIMIT, MAX_ATTEMPTS } from './scheduling';
import { poseLease } from '../outbox-claim/claim-outbox-batch';
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
    //
    // P2-2 : les casts JSON sont SÛRS (regex-gardés, NULL si invalide) — un
    // événement mal formé ne doit JAMAIS faire échouer le claim de tout le
    // batch. Les JOINs sont LEFT : un payload invalide ne matche ni refund ni
    // payment, passe le filtre environnement (p.id IS NULL — intraitable quelle
    // que soit l'environnement) et sera marqué FAILED (PAYLOAD_MALFORMED) par
    // l'orchestrateur via le champ payload_valid.
    const rows = await tx.execute(sql`
      SELECT
        oe.id AS outbox_event_id,
        oe.organization_id,
        (oe.payload->>'paymentId') AS payment_id,
        (oe.payload->>'refundIdempotencyKey') AS refund_idempotency_key,
        CASE WHEN (oe.payload->>'amountMinor') ~ '^[0-9]+$'
          THEN (oe.payload->>'amountMinor')::bigint
          ELSE NULL
        END AS amount_minor,
        (oe.payload->>'currency') AS currency,
        (oe.payload->>'reason') AS reason,
        -- P1-4 : métadonnées outbox à recouper contre les autorités financières.
        oe.aggregate_type,
        oe.aggregate_id,
        oe.event_version,
        oe.attempt_count,
        oe.lease_until AS current_lease_until,
        -- P2-2 : validité du payload — paymentId UUID valide, amountMinor
        -- entier valide, clé d'idempotence refund présente ET refund existant.
        (
          (oe.payload->>'paymentId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          AND (oe.payload->>'amountMinor') ~ '^[0-9]+$'
          AND (oe.payload->>'refundIdempotencyKey') IS NOT NULL
          AND r."id" IS NOT NULL
        ) AS payload_valid
      FROM "outbox_events" oe
      LEFT JOIN "refunds" r ON r."provider_idempotency_key" = (oe.payload->>'refundIdempotencyKey')
      LEFT JOIN "payments" p ON p."id" = CASE
        WHEN (oe.payload->>'paymentId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (oe.payload->>'paymentId')::uuid
        ELSE NULL
      END
      WHERE oe."status" IN ('PENDING', 'PROCESSING')
        -- PROCESSING est inclus pour permettre la récupération des événements
        -- dont la lease a expiré (worker crashé). La condition lease_until <= now()
        -- garantit qu'on ne reclaims pas un événement encore en cours.
        AND oe."event_type" = 'PAYMENT_COMPENSATION_REQUESTED'
        AND oe."available_at" <= now()
        AND (oe."lease_until" IS NULL OR oe."lease_until" <= now())
        -- P2-7 : borner les reclaims — un événement qui a atteint MAX_ATTEMPTS
        -- (via reschedules OU reclaims après crash) n'est plus reclaimé. Il sera
        -- marqué FAILED par l'orchestrateur si un worker le claim une dernière fois
        -- avec attempt_count + 1 >= MAX_ATTEMPTS, ou restera PROCESSING si aucun
        -- worker ne le claim (lease expirée, plus éligible).
        AND oe."attempt_count" < ${MAX_ATTEMPTS}
        -- P2-2 : un événement mal formé (p.id NULL) ne peut pas être filtré
        -- par environnement ; il passe et sera marqué FAILED (intraitable
        -- quelle que soit l'environnement).
        AND (p."environment" = ${environment}::payment_environment OR p."id" IS NULL)
      ORDER BY oe."available_at" ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF oe SKIP LOCKED
    `);

    const rawRows = rows as unknown as Array<{
      outbox_event_id: string;
      organization_id: string;
      payment_id: string | null;
      refund_idempotency_key: string | null;
      amount_minor: string | number | null;
      currency: string;
      reason: string;
      aggregate_type: string;
      aggregate_id: string;
      event_version: string;
      attempt_count: number;
      current_lease_until: Date | null;
      payload_valid: boolean;
    }>;

    if (rawRows.length === 0) {
      return [];
    }

    // P2-1 : poseLease du module commun (outbox-claim) — UPDATE individuels
    // paramétrés (pas de sql.raw). La stratégie 'reclaim_only' préserve la
    // sémantique ADR-010 §13 : n'incrémente attempt_count que lors d'un reclaim
    // (PROCESSING→PROCESSING), pas lors du claim initial (PENDING→PROCESSING).
    const eventIds = rawRows.map((r) => r.outbox_event_id);
    const leaseMap = await poseLease(tx, eventIds, 'reclaim_only');

    // Construire les ClaimedCompensation avec le snapshot complet.
    const claimed: ClaimedCompensation[] = [];
    for (const r of rawRows) {
      const lease = leaseMap.get(r.outbox_event_id);
      if (!lease) continue;
      claimed.push({
        outboxEventId: r.outbox_event_id,
        organizationId: r.organization_id,
        // P2-2 : pour un payload mal formé ces champs peuvent être NULL —
        // neutralisés ('' / NaN) car executeCompensation n'est jamais appelé
        // quand payloadValid est false.
        paymentId: r.payment_id ?? '',
        refundIdempotencyKey: r.refund_idempotency_key ?? '',
        amountMinor: r.amount_minor === null ? Number.NaN : Number(r.amount_minor),
        currency: r.currency,
        reason: r.reason,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        eventVersion: r.event_version,
        leaseToken: lease.leaseToken,
        leaseUntil: lease.leaseUntil,
        attemptCount: lease.attemptCount,
        payloadValid: r.payload_valid,
      });
    }

    return claimed;
  });
}
