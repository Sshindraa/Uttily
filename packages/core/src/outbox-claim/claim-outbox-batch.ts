/**
 * @uttily/core — Revendication générique d'un batch d'événements outbox (G5D, ADR-013 §7).
 *
 * Module commun partagé entre le worker de compensation (ADR-010 §13) et le
 * worker de documents transactionnels (ADR-013 §7).
 *
 * Deux stratégies d'incrémentation d'attempt_count sont supportées :
 * - 'always' : incrémente à CHAQUE claim (initial ET reclaim), conformément à
 *   ADR-013 §7. Utilisé par le pipeline documentaire.
 * - 'reclaim_only' : n'incrémente que lors d'un reclaim (PROCESSING→PROCESSING),
 *   conformément à ADR-010 §13. Utilisé par le worker de compensation.
 *
 * La fonction poseLease est extraite pour permettre aux handlers spécialisés
 * (compensation avec JOINs refunds/payments) de faire leur propre SELECT puis
 * d'appeler poseLease pour poser le lease de manière uniforme.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseTransaction } from '@uttily/database';
import { LEASE_INTERVAL, MAX_ATTEMPTS, validateBatchLimit } from './scheduling';
import type { KnownHandlerSelection } from './handler-selection';
import { validateHandlerSelection } from './handler-selection';

/** Stratégie d'incrémentation d'attempt_count. */
export type IncrementStrategy = 'always' | 'reclaim_only';

/** Éligibilité du claim : tous les événements du handler, seulement les incomplets, ou prêts pour l'email transactionnel. */
export type ClaimEligibility =
  'ALL_HANDLER_EVENTS' | 'INCOMPLETE_DOCUMENT_GENERATION' | 'READY_FOR_TRANSACTIONAL_EMAIL';

/**
 * Valide qu'une valeur inconnue correspond exactement à une ClaimEligibilité
 * autorisée (union fermée).
 *
 * @returns La valeur validée ('ALL_HANDLER_EVENTS', 'INCOMPLETE_DOCUMENT_GENERATION' ou 'READY_FOR_TRANSACTIONAL_EMAIL').
 * @throws Error si la valeur est invalide, forgée, null, undefined, ou d'un type incorrect.
 */
export function validateClaimEligibility(eligibility: unknown): ClaimEligibility {
  if (eligibility === 'ALL_HANDLER_EVENTS') return 'ALL_HANDLER_EVENTS';
  if (eligibility === 'INCOMPLETE_DOCUMENT_GENERATION') return 'INCOMPLETE_DOCUMENT_GENERATION';
  if (eligibility === 'READY_FOR_TRANSACTIONAL_EMAIL') return 'READY_FOR_TRANSACTIONAL_EMAIL';
  throw new Error(
    `ClaimEligibility invalide : ${String(eligibility)} (attendu : ALL_HANDLER_EVENTS, INCOMPLETE_DOCUMENT_GENERATION ou READY_FOR_TRANSACTIONAL_EMAIL)`,
  );
}

/** Événement outbox revendiqué (forme générique). */
export interface ClaimedOutboxEvent {
  readonly outboxEventId: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly attemptCount: number;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly payload: unknown;
}

/**
 * Pose un lease sur un ensemble d'événements outbox déjà sélectionnés et verrouillés.
 *
 * Pour chaque eventId :
 * - Génère un token UUID aléatoire.
 * - UPDATE outbox_events SET lease_until = now() + LEASE_INTERVAL, lease_token = token,
 *   status = 'PROCESSING', attempt_count = attempt_count + (selon la stratégie).
 * - Retourne le leaseUntil et le leaseToken pour chaque eventId.
 *
 * Stratégie 'always' (ADR-013 §7) :
 *   attempt_count = attempt_count + 1 (à chaque claim, initial ou reclaim).
 *
 * Stratégie 'reclaim_only' (ADR-010 §13, compatibilité ascendante) :
 *   attempt_count = attempt_count + CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END
 *   (n'incrémente que lors d'un reclaim PROCESSING→PROCESSING).
 *
 * @param tx Transaction PostgreSQL active.
 * @param eventIds IDs des événements à lease-poser.
 * @param incrementStrategy Stratégie d'incrémentation.
 * @returns Map eventId → { leaseToken, leaseUntil, attemptCount }.
 */
export async function poseLease(
  tx: DatabaseTransaction,
  eventIds: string[],
  incrementStrategy: IncrementStrategy,
): Promise<Map<string, { leaseToken: string; leaseUntil: Date; attemptCount: number }>> {
  const result = new Map<string, { leaseToken: string; leaseUntil: Date; attemptCount: number }>();
  if (eventIds.length === 0) return result;

  for (const eventId of eventIds) {
    const token = crypto.randomUUID();
    const incrementExpr =
      incrementStrategy === 'always'
        ? sql`1`
        : sql`CASE WHEN "status" = 'PROCESSING' THEN 1 ELSE 0 END`;

    const rows = await tx.execute(sql`
      UPDATE "outbox_events"
      SET "lease_until" = now() + ${LEASE_INTERVAL},
          "lease_token" = ${token}::uuid,
          "status" = 'PROCESSING',
          "attempt_count" = "attempt_count" + ${incrementExpr}
      WHERE "id" = ${eventId}::uuid
      RETURNING "id", "lease_until", "attempt_count"
    `);
    const row = (
      rows as unknown as Array<{ id: string; lease_until: Date; attempt_count: number }>
    )[0];
    if (row) {
      result.set(row.id, {
        leaseToken: token,
        leaseUntil: row.lease_until,
        attemptCount: row.attempt_count,
      });
    }
  }

  return result;
}

/**
 * Revendique un batch d'événements outbox génériques.
 *
 * Sélectionne les outbox_events avec :
 * - event_type = selection.eventType
 * - event_version = selection.eventVersion
 * - aggregate_type = selection.aggregateType
 * - status IN ('PENDING', 'PROCESSING')
 * - available_at <= now()
 * - (lease_until IS NULL OR lease_until <= now())
 * - attempt_count < MAX_ATTEMPTS
 * - extraFilter (optionnel) : fragment SQL supplémentaire (ex: NOT EXISTS)
 *
 * Verrouille avec FOR UPDATE SKIP LOCKED, ORDER BY available_at ASC, id ASC,
 * LIMIT batchLimit. Pose ensuite le lease via poseLease.
 *
 * La sélection est une union fermée (KnownHandlerSelection) — un
 * handler ne peut pas claimer les événements d'un autre handler.
 * batchLimit est validé via validateBatchLimit en plus de la
 * validation effectuée par l'appelant.
 *
 * Si aucune ligne n'est sélectionnée, retourne un tableau vide (aucune
 * incrémentation).
 *
 * @param tx Transaction PostgreSQL active.
 * @param selection KnownHandlerSelection (union fermée).
 * @param batchLimit Nombre maximum d'événements à revendiquer.
 * @param incrementStrategy Stratégie d'incrémentation d'attempt_count.
 * @param eligibility Filtre d'éligibilité (défaut: ALL_HANDLER_EVENTS).
 * @returns Tableau des événements revendiqués.
 */
export async function claimOutboxBatch(
  tx: DatabaseTransaction,
  selection: KnownHandlerSelection,
  batchLimit: number,
  incrementStrategy: IncrementStrategy,
  eligibility: ClaimEligibility = 'ALL_HANDLER_EVENTS',
): Promise<ClaimedOutboxEvent[]> {
  const validatedSelection = validateHandlerSelection(selection);
  const validatedLimit = validateBatchLimit(batchLimit);
  const validatedEligibility = validateClaimEligibility(eligibility);

  let extraFilter: SQL | undefined;
  if (validatedEligibility === 'INCOMPLETE_DOCUMENT_GENERATION') {
    extraFilter = sql`AND NOT EXISTS (
      SELECT 1 FROM "outbox_effects" oe
      WHERE oe."outbox_event_id" = "outbox_events"."id"
        AND oe."organization_id" = "outbox_events"."organization_id"
        AND oe."effect_type" IN ('GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT')
        AND oe."status" = 'COMPLETED'
      GROUP BY oe."outbox_event_id"
      HAVING COUNT(*) = 3
    )`;
  } else if (validatedEligibility === 'READY_FOR_TRANSACTIONAL_EMAIL') {
    extraFilter = sql`AND EXISTS (
      SELECT 1 FROM "outbox_effects" oe
      WHERE oe."outbox_event_id" = "outbox_events"."id"
        AND oe."organization_id" = "outbox_events"."organization_id"
        AND oe."effect_type" IN ('GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT')
        AND oe."status" = 'COMPLETED'
      GROUP BY oe."outbox_event_id"
      HAVING COUNT(*) = 3
    ) AND EXISTS (
      SELECT 1 FROM "outbox_effects" oe
      WHERE oe."outbox_event_id" = "outbox_events"."id"
        AND oe."organization_id" = "outbox_events"."organization_id"
        AND oe."effect_type" = 'SEND_EMAIL'
        AND oe."status" = 'PENDING'
        AND oe."attempt_count" < ${MAX_ATTEMPTS}
    ) AND NOT EXISTS (
      SELECT 1 FROM "outbox_effects" oe
      WHERE oe."outbox_event_id" = "outbox_events"."id"
        AND oe."organization_id" = "outbox_events"."organization_id"
        AND oe."status" = 'FAILED'
    ) AND NOT EXISTS (
      SELECT 1 FROM "notification_deliveries" nd
      WHERE nd."outbox_event_id" = "outbox_events"."id"
        AND nd."organization_id" = "outbox_events"."organization_id"
        AND nd."status" IN ('SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW')
    )`;
  }

  const attemptFilter =
    validatedEligibility === 'READY_FOR_TRANSACTIONAL_EMAIL'
      ? sql``
      : sql`AND "attempt_count" < ${MAX_ATTEMPTS}`;

  const rows = await tx.execute(sql`
    SELECT
      "id" AS outbox_event_id,
      "organization_id",
      "aggregate_type",
      "aggregate_id",
      "event_type",
      "event_version",
      "attempt_count",
      "payload"
    FROM "outbox_events"
    WHERE "event_type" = ${validatedSelection.eventType}
      AND "event_version" = ${validatedSelection.eventVersion}
      AND "aggregate_type" = ${validatedSelection.aggregateType}
      AND "status" IN ('PENDING', 'PROCESSING')
      AND "available_at" <= now()
      AND ("lease_until" IS NULL OR "lease_until" <= now())
      /* Email budget is enforced on the SEND_EMAIL effect in extraFilter; outbox_events.attempt_count is telemetry only for READY_FOR_TRANSACTIONAL_EMAIL. */
      ${attemptFilter}
      ${extraFilter ?? sql``}
    ORDER BY "available_at" ASC, "id" ASC
    LIMIT ${validatedLimit}
    FOR UPDATE SKIP LOCKED
  `);

  const rawRows = rows as unknown as Array<{
    outbox_event_id: string;
    organization_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: string;
    attempt_count: number;
    payload: unknown;
  }>;

  if (rawRows.length === 0) {
    return [];
  }

  const eventIds = rawRows.map((r) => r.outbox_event_id);
  const leaseMap = await poseLease(tx, eventIds, incrementStrategy);

  const claimed: ClaimedOutboxEvent[] = [];
  for (const r of rawRows) {
    const lease = leaseMap.get(r.outbox_event_id);
    if (!lease) continue;
    claimed.push({
      outboxEventId: r.outbox_event_id,
      organizationId: r.organization_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      eventVersion: r.event_version,
      attemptCount: lease.attemptCount,
      leaseToken: lease.leaseToken,
      leaseUntil: lease.leaseUntil,
      payload: r.payload,
    });
  }

  return claimed;
}
