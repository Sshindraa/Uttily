/**
 * @uttily/worker — Finaliseur DB-only des livraisons email (G5H-C2C-A).
 *
 * Met en revue manuelle les notifications PENDING lorsque le budget de
 * tentatives est épuisé ou que la fenêtre de 23h est dépassée, sans appeler
 * R2, Resend ni aucun renderer. Le SEND_EMAIL effect reste PENDING.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  OUTBOX_MAX_ATTEMPTS as MAX_ATTEMPTS,
  validateOutboxBatchLimit as validateBatchLimit,
} from '@uttily/core';

export type EmailDeliveryFinalizerResult = {
  readonly inspectedCount: number;
  readonly finalizedCount: number;
  readonly cutoffCount: number;
  readonly uncertainCount: number;
  readonly inconsistentCount: number;
};

type FinalizerCandidateErrorCode = 'REVALIDATION_FAILED' | 'UPDATE_CARDINALITY_FAILED';

class FinalizerCandidateError extends Error {
  readonly code: FinalizerCandidateErrorCode;

  constructor(code: FinalizerCandidateErrorCode) {
    super(code);
    this.name = 'FinalizerCandidateError';
    this.code = code;
  }
}

const CUTOFF_SECONDS = 23 * 3600;

/**
 * Finalise en base les livraisons email éligibles d'un batch d'événements
 * BOOKING_CONFIRMED.v1.
 *
 * Chaque candidat est traité dans une savepoint PostgreSQL indépendante. Si
 * l'une des vérifications de revalidation échoue ou si un UPDATE ne retourne
 * pas exactement une ligne, le savepoint est roulé entièrement vers l'arrière
 * et le candidat est comptabilisé comme incohérent. Les autres candidats du
 * batch ne sont pas affectés.
 *
 * @param db Client Drizzle.
 * @param batchLimit Limite du batch (1–10, défaut 10).
 * @returns Compteurs d'inspection, finalisation, cutoff, incertitude et incohérences.
 */
export async function finalizeEmailDeliveries(
  db: DatabaseClient,
  batchLimit?: number,
): Promise<EmailDeliveryFinalizerResult> {
  const limit = validateBatchLimit(batchLimit);

  return db.transaction(async (tx) => {
    const events = (await tx.execute(sql`
      SELECT "id", "organization_id"
      FROM "outbox_events"
      WHERE "event_type" = 'BOOKING_CONFIRMED'
        AND "event_version" = 'v1'
        AND "aggregate_type" = 'BOOKING'
        AND (
          ("status" = 'PENDING')
          OR
          (
            "status" = 'PROCESSING'
            AND (
              ("lease_token" IS NOT NULL AND "lease_until" <= transaction_timestamp())
              OR
              ("lease_token" IS NULL AND "lease_until" IS NULL)
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM "outbox_effects" oe
          JOIN "notification_deliveries" nd
            ON nd."outbox_event_id" = "outbox_events"."id"
            AND nd."organization_id" = "outbox_events"."organization_id"
            AND nd."outbox_effect_id" = oe."id"
          WHERE oe."outbox_event_id" = "outbox_events"."id"
            AND oe."organization_id" = "outbox_events"."organization_id"
            AND oe."effect_type" = 'SEND_EMAIL'
            AND oe."status" = 'PENDING'
            AND nd."status" = 'PENDING'
            AND nd."provider_first_attempt_started_at" IS NOT NULL
            AND (
              oe."attempt_count" >= ${MAX_ATTEMPTS}
              OR EXTRACT(EPOCH FROM (transaction_timestamp() - nd."provider_first_attempt_started_at")) >= ${CUTOFF_SECONDS}
            )
        )
      ORDER BY "available_at" ASC, "id" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as Array<{ id: string; organization_id: string }>;

    const inspectedCount = events.length;
    let finalizedCount = 0;
    let cutoffCount = 0;
    let uncertainCount = 0;
    let inconsistentCount = 0;

    for (const event of events) {
      const outboxEventId = event.id;
      const orgId = event.organization_id;

      try {
        const outcome = await tx.transaction(async (sp) => {
          const effectRows = (await sp.execute(sql`
            SELECT "id", "attempt_count", "status"
            FROM "outbox_effects"
            WHERE "outbox_event_id" = ${outboxEventId}::uuid
              AND "effect_type" = 'SEND_EMAIL'
              AND "organization_id" = ${orgId}::uuid
            FOR UPDATE
          `)) as unknown as Array<{ id: string; attempt_count: number; status: string }>;

          const notificationRows = (await sp.execute(sql`
            SELECT "id", "status", "provider_first_attempt_started_at",
              EXTRACT(EPOCH FROM (transaction_timestamp() - "provider_first_attempt_started_at"))::int as age_seconds
            FROM "notification_deliveries"
            WHERE "outbox_event_id" = ${outboxEventId}::uuid
              AND "organization_id" = ${orgId}::uuid
            FOR UPDATE
          `)) as unknown as Array<{
            id: string;
            status: string;
            provider_first_attempt_started_at: Date | null;
            age_seconds: number | null;
          }>;

          const outboxRows = (await sp.execute(sql`
            SELECT "status", "lease_token"
            FROM "outbox_events"
            WHERE "id" = ${outboxEventId}::uuid
              AND "organization_id" = ${orgId}::uuid
              AND (
                ("status" = 'PENDING' AND "lease_token" IS NULL AND "lease_until" IS NULL)
                OR
                ("status" = 'PROCESSING' AND "lease_token" IS NOT NULL AND "lease_until" <= transaction_timestamp())
              )
          `)) as unknown as Array<{ status: string; lease_token: string | null }>;

          if (effectRows.length !== 1 || notificationRows.length !== 1 || outboxRows.length !== 1) {
            throw new FinalizerCandidateError('REVALIDATION_FAILED');
          }

          const effect = effectRows[0]!;
          const notification = notificationRows[0]!;
          const outbox = outboxRows[0]!;

          if (effect.status !== 'PENDING') {
            throw new FinalizerCandidateError('REVALIDATION_FAILED');
          }

          if (
            notification.status !== 'PENDING' ||
            notification.provider_first_attempt_started_at === null
          ) {
            throw new FinalizerCandidateError('REVALIDATION_FAILED');
          }

          const ageSeconds = notification.age_seconds ?? 0;
          const isCutoff = ageSeconds >= CUTOFF_SECONDS;
          const isUncertain = effect.attempt_count >= MAX_ATTEMPTS;

          if (!isCutoff && !isUncertain) {
            throw new FinalizerCandidateError('REVALIDATION_FAILED');
          }

          const failureCode = isCutoff ? 'EMAIL_RETRY_WINDOW_EXPIRED' : 'PROVIDER_RESULT_UNCERTAIN';

          const notifUpdate = (await sp.execute(sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = ${failureCode}::document_processing_failure_code
            WHERE "id" = ${notification.id}::uuid
              AND "organization_id" = ${orgId}::uuid
              AND "outbox_event_id" = ${outboxEventId}::uuid
              AND "status" = 'PENDING'
              AND "provider_first_attempt_started_at" IS NOT NULL
            RETURNING "id"
          `)) as unknown as Array<{ id: string }>;

          if (notifUpdate.length !== 1) {
            throw new FinalizerCandidateError('UPDATE_CARDINALITY_FAILED');
          }

          const leaseToken = outbox.lease_token;

          const outboxUpdate = (await sp.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PENDING',
                "lease_token" = NULL,
                "lease_until" = NULL,
                "processed_at" = NULL
            WHERE "id" = ${outboxEventId}::uuid
              AND "organization_id" = ${orgId}::uuid
              AND (
                ("status" = 'PENDING' AND "lease_token" IS NULL AND "lease_until" IS NULL)
                OR
                ("status" = 'PROCESSING' AND "lease_token" = ${leaseToken}::uuid)
              )
            RETURNING "id"
          `)) as unknown as Array<{ id: string }>;

          if (outboxUpdate.length !== 1) {
            throw new FinalizerCandidateError('UPDATE_CARDINALITY_FAILED');
          }

          return { isCutoff };
        });

        finalizedCount++;
        if (outcome.isCutoff) {
          cutoffCount++;
        } else {
          uncertainCount++;
        }
      } catch (error) {
        if (error instanceof FinalizerCandidateError) {
          inconsistentCount++;
          continue;
        }
        throw error;
      }
    }

    return {
      inspectedCount,
      finalizedCount,
      cutoffCount,
      uncertainCount,
      inconsistentCount,
    };
  });
}
