/**
 * @uttily/worker — Tests d'intégration PostgreSQL du finaliseur DB-only
 * des livraisons email (G5H-C2C-A).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '@uttily/core/testing';
import {
  OUTBOX_MAX_ATTEMPTS as MAX_ATTEMPTS,
  BOOKING_CONFIRMED_SELECTION,
  claimOutboxBatch,
} from '@uttily/core';

import { finalizeEmailDeliveries } from './email-delivery-finalizer';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5h');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 10 });
  }
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!ctx || !db) return;
  await db.execute(
    drizzleSql`TRUNCATE TABLE notification_deliveries, outbox_effects, outbox_events, organizations RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrganization(): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const suffix = crypto.randomUUID();
  const rows = await rawSql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Email Finalizer Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `;
  return rows[0]!.id;
}

interface EmailScenarioOpts {
  outboxStatus?: 'PENDING' | 'PROCESSING';
  outboxAttemptCount?: number;
  leaseUntil?: Date | null;
  effectStatus?: 'PENDING' | 'COMPLETED' | 'FAILED';
  effectAttemptCount?: number;
  effectFailureCode?:
    'PROVIDER_RESULT_UNCERTAIN' | 'EMAIL_RETRY_WINDOW_EXPIRED' | 'EMAIL_SEND_FAILED' | null;
  effectCompletedAt?: Date | null;
  notificationStatus?: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
  notificationFirstAttemptStartedAt?: Date | null;
  notificationFailureCode?:
    'PROVIDER_RESULT_UNCERTAIN' | 'EMAIL_RETRY_WINDOW_EXPIRED' | 'EMAIL_SEND_FAILED' | null;
  notificationProviderMessageId?: string | null;
  notificationSentAt?: Date | null;
}

async function seedEmailScenario(
  orgId: string,
  opts: EmailScenarioOpts = {},
): Promise<{
  outboxEventId: string;
  outboxEffectId: string;
  notificationId: string;
  orgId: string;
  leaseToken: string | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const suffix = crypto.randomUUID();
  const aggregateId = crypto.randomUUID();
  const outboxStatus = opts.outboxStatus ?? 'PENDING';
  const leaseToken = outboxStatus === 'PROCESSING' ? crypto.randomUUID() : null;

  const outbox = await rawSql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key",
      "lease_token", "lease_until"
    ) VALUES (
      ${orgId}::uuid, 'BOOKING', ${aggregateId}::uuid, 'BOOKING_CONFIRMED', 'v1',
      ${rawSql.json({})}, ${outboxStatus}::outbox_event_status, ${opts.outboxAttemptCount ?? 0}, now(), ${'outbox-' + suffix},
      ${leaseToken}::uuid, ${opts.leaseUntil ?? null}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const effectStatus = opts.effectStatus ?? 'PENDING';
  const effect = await rawSql`
    INSERT INTO "outbox_effects" (
      "organization_id", "outbox_event_id", "effect_type", "status", "idempotency_key",
      "attempt_count", "failure_code", "completed_at"
    ) VALUES (
      ${orgId}::uuid, ${outbox.id}::uuid, 'SEND_EMAIL', ${effectStatus}::outbox_effect_status, ${'effect-' + suffix},
      ${opts.effectAttemptCount ?? 0}, ${opts.effectFailureCode ?? null}::document_processing_failure_code,
      ${opts.effectCompletedAt ?? null}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const notificationStatus = opts.notificationStatus ?? 'PENDING';
  const notification = await rawSql`
    INSERT INTO "notification_deliveries" (
      "organization_id", "outbox_event_id", "outbox_effect_id", "recipient_email", "template_key",
      "provider_idempotency_key", "status", "provider_message_id", "failure_code", "sent_at",
      "provider_first_attempt_started_at", "idempotency_key"
    ) VALUES (
      ${orgId}::uuid, ${outbox.id}::uuid, ${effect.id}::uuid, 'test-candidate@example.local', 'booking-confirmed',
      ${'provider-' + suffix}, ${notificationStatus}::notification_delivery_status, ${opts.notificationProviderMessageId ?? null},
      ${opts.notificationFailureCode ?? null}::document_processing_failure_code, ${opts.notificationSentAt ?? null},
      ${opts.notificationFirstAttemptStartedAt ?? null}, ${'notification-' + suffix}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    outboxEventId: outbox.id,
    outboxEffectId: effect.id,
    notificationId: notification.id,
    orgId,
    leaseToken,
  };
}

async function getOutboxEvent(outboxEventId: string): Promise<{
  status: string;
  attempt_count: number;
  lease_token: string | null;
  lease_until: Date | null;
  processed_at: Date | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "status", "attempt_count", "lease_token", "lease_until", "processed_at"
    FROM "outbox_events"
    WHERE "id" = ${outboxEventId}::uuid
  `;
  return rows[0] as {
    status: string;
    attempt_count: number;
    lease_token: string | null;
    lease_until: Date | null;
    processed_at: Date | null;
  };
}

async function getOutboxEffect(outboxEffectId: string): Promise<{
  status: string;
  attempt_count: number;
  failure_code: string | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "status", "attempt_count", "failure_code"
    FROM "outbox_effects"
    WHERE "id" = ${outboxEffectId}::uuid
  `;
  return rows[0] as {
    status: string;
    attempt_count: number;
    failure_code: string | null;
  };
}

async function getNotification(notificationId: string): Promise<{
  status: string;
  failure_code: string | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "status", "failure_code"
    FROM "notification_deliveries"
    WHERE "id" = ${notificationId}::uuid
  `;
  return rows[0] as { status: string; failure_code: string | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('finalizeEmailDeliveries — PostgreSQL integration', () => {
  it('1. PENDING + attempt_count = 5, age < 23h -> PROVIDER_RESULT_UNCERTAIN', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      outboxAttemptCount: 2,
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result).toEqual({
      inspectedCount: 1,
      finalizedCount: 1,
      cutoffCount: 0,
      uncertainCount: 1,
      inconsistentCount: 0,
    });

    const notif = await getNotification(notificationId);
    expect(notif.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(notif.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
    expect(event.processed_at).toBeNull();
    expect(event.attempt_count).toBe(2);

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.status).toBe('PENDING');
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
    expect(effect.failure_code).toBeNull();
  });

  it('2. PENDING + age = 23h, attempts < MAX -> EMAIL_RETRY_WINDOW_EXPIRED', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: 4,
      notificationFirstAttemptStartedAt: new Date(Date.now() - (23 * 3600 + 60) * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result).toEqual({
      inspectedCount: 1,
      finalizedCount: 1,
      cutoffCount: 1,
      uncertainCount: 0,
      inconsistentCount: 0,
    });

    const notif = await getNotification(notificationId);
    expect(notif.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(notif.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(4);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
  });

  it('3. PROCESSING + expired lease + attempt_count = 5 -> PROVIDER_RESULT_UNCERTAIN', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      outboxAttemptCount: 5,
      leaseUntil: new Date(Date.now() - 60 * 1000),
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result.uncertainCount).toBe(1);
    expect(result.finalizedCount).toBe(1);
    expect(result.cutoffCount).toBe(0);
    expect(result.inconsistentCount).toBe(0);

    const notif = await getNotification(notificationId);
    expect(notif.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  it('4. PROCESSING + expired lease + cutoff -> EMAIL_RETRY_WINDOW_EXPIRED', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      leaseUntil: new Date(Date.now() - 60 * 1000),
      effectAttemptCount: 4,
      notificationFirstAttemptStartedAt: new Date(Date.now() - (23 * 3600 + 60) * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result.cutoffCount).toBe(1);
    expect(result.finalizedCount).toBe(1);
    expect(result.uncertainCount).toBe(0);

    const notif = await getNotification(notificationId);
    expect(notif.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
  });

  it('5. cutoff + MAX simultaneously -> EMAIL_RETRY_WINDOW_EXPIRED', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - (23 * 3600 + 60) * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result.cutoffCount).toBe(1);
    expect(result.uncertainCount).toBe(0);
    expect(result.finalizedCount).toBe(1);

    const notif = await getNotification(notificationId);
    expect(notif.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');
  });

  it('6. PROCESSING + active lease -> aucune mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      leaseUntil: new Date(Date.now() + 5 * 60 * 1000),
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result).toEqual({
      inspectedCount: 0,
      finalizedCount: 0,
      cutoffCount: 0,
      uncertainCount: 0,
      inconsistentCount: 0,
    });

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).not.toBeNull();
  });

  it('7. attempt_count = 4 + age < 23h -> aucune mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: 4,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);
    expect(result.finalizedCount).toBe(0);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
  });

  it('8. provider_first_attempt_started_at NULL -> aucune finalisation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: null,
    });

    const result = await finalizeEmailDeliveries(db);
    expect(result.finalizedCount).toBe(0);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
  });

  it('9. REQUIRES_MANUAL_REVIEW already -> aucune mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationStatus: 'REQUIRES_MANUAL_REVIEW',
      notificationFailureCode: 'PROVIDER_RESULT_UNCERTAIN',
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);
    expect(result.finalizedCount).toBe(0);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
  });

  it('10. SENT/FAILED delivery -> aucune mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const sentEvent = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationStatus: 'SENT',
      notificationProviderMessageId: 'msg-test',
      notificationSentAt: new Date(),
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const failedEvent = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationStatus: 'FAILED',
      notificationFailureCode: 'EMAIL_SEND_FAILED',
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db, 10);
    expect(result.finalizedCount).toBe(0);

    const sentEventRow = await getOutboxEvent(sentEvent.outboxEventId);
    expect(sentEventRow.status).toBe('PENDING');
    const failedEventRow = await getOutboxEvent(failedEvent.outboxEventId);
    expect(failedEventRow.status).toBe('PENDING');
  });

  it('11. SEND_EMAIL effect COMPLETED/FAILED -> aucune mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const completedEvent = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectStatus: 'COMPLETED',
      effectCompletedAt: new Date(),
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const failedEvent = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectStatus: 'FAILED',
      effectFailureCode: 'EMAIL_SEND_FAILED',
      effectCompletedAt: new Date(),
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db, 10);
    expect(result.finalizedCount).toBe(0);

    const completedEventRow = await getOutboxEvent(completedEvent.outboxEventId);
    expect(completedEventRow.status).toBe('PENDING');
    const failedEventRow = await getOutboxEvent(failedEvent.outboxEventId);
    expect(failedEventRow.status).toBe('PENDING');
  });

  it('12. attempt_count and outbox_events.attempt_count unchanged', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      outboxAttemptCount: 3,
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await finalizeEmailDeliveries(db);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.attempt_count).toBe(3);

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
  });

  it('13. deux finalizers concurrents -> one wins, the other skips', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const [r1, r2] = await Promise.all([finalizeEmailDeliveries(db), finalizeEmailDeliveries(db)]);

    expect(r1.finalizedCount + r2.finalizedCount).toBe(1);
    expect(r1.inspectedCount + r2.inspectedCount).toBe(1);

    const notif = await getNotification(notificationId);
    expect(notif.status).toBe('REQUIRES_MANUAL_REVIEW');

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
  });

  it('14. finalizer contre worker avec lease active -> no mutation', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      leaseUntil: new Date(Date.now() + 5 * 60 * 1000),
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);
    expect(result.finalizedCount).toBe(0);

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).not.toBeNull();
  });

  it('15. finalizer contre claim concurrent -> one wins', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      outboxAttemptCount: 4,
      effectAttemptCount: 4,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 24 * 3600 * 1000),
    });

    const [finalizerResult, claimResult] = await Promise.all([
      finalizeEmailDeliveries(db),
      db.transaction(async (tx) => claimOutboxBatch(tx, BOOKING_CONFIRMED_SELECTION, 1, 'always')),
    ]);

    expect(Number(finalizerResult.finalizedCount === 1) + Number(claimResult.length === 1)).toBe(1);
  });

  it('16. relance après finalisation -> idempotent, zero new transitions', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const first = await finalizeEmailDeliveries(db);
    expect(first.finalizedCount).toBe(1);

    const second = await finalizeEmailDeliveries(db);
    expect(second).toEqual({
      inspectedCount: 0,
      finalizedCount: 0,
      cutoffCount: 0,
      uncertainCount: 0,
      inconsistentCount: 0,
    });
  });

  it('17. multi-tenant -> no cross-org rows affected', async () => {
    if (!db) return;
    const orgA = await seedOrganization();
    const orgB = await seedOrganization();
    const a = await seedEmailScenario(orgA, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const b = await seedEmailScenario(orgB, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db, 10);
    expect(result.finalizedCount).toBe(2);
    expect(result.uncertainCount).toBe(2);

    const notifA = await getNotification(a.notificationId);
    const notifB = await getNotification(b.notificationId);
    const eventA = await getOutboxEvent(a.outboxEventId);
    const eventB = await getOutboxEvent(b.outboxEventId);

    expect(notifA.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(notifB.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(eventA.status).toBe('PENDING');
    expect(eventB.status).toBe('PENDING');
    expect(eventA.lease_token).toBeNull();
    expect(eventB.lease_token).toBeNull();
  });

  it('18. crash de la cinquième tentative -> finalize with PROVIDER_RESULT_UNCERTAIN', async () => {
    if (!db) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      outboxAttemptCount: MAX_ATTEMPTS,
      leaseUntil: new Date(Date.now() - 60 * 1000),
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await finalizeEmailDeliveries(db);

    expect(result.finalizedCount).toBe(1);
    expect(result.uncertainCount).toBe(1);

    const notif = await getNotification(notificationId);
    expect(notif.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(notif.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
    expect(effect.status).toBe('PENDING');

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
    expect(event.attempt_count).toBe(MAX_ATTEMPTS);
  });

  it('19. partial rollback quand UPDATE outbox_events ne touche aucune ligne', async () => {
    if (!db || !rawSql) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const triggerName = 'test_suppress_outbox_update';
    const functionName = 'test_suppress_outbox_update';

    try {
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION ${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.id = '${outboxEventId}'::uuid THEN
            RETURN NULL;
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await rawSql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON outbox_events
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}();
      `);

      const result = await finalizeEmailDeliveries(db);

      expect(result).toEqual({
        inspectedCount: 1,
        finalizedCount: 0,
        cutoffCount: 0,
        uncertainCount: 0,
        inconsistentCount: 1,
      });

      const notif = await getNotification(notificationId);
      expect(notif.status).toBe('PENDING');
      expect(notif.failure_code).toBeNull();

      const effect = await getOutboxEffect(outboxEffectId);
      expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
      expect(effect.status).toBe('PENDING');

      const event = await getOutboxEvent(outboxEventId);
      expect(event.status).toBe('PENDING');
      expect(event.lease_token).toBeNull();
      expect(event.lease_until).toBeNull();
      expect(event.processed_at).toBeNull();
    } finally {
      await rawSql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events;`);
      await rawSql.unsafe(`DROP FUNCTION IF EXISTS ${functionName};`);
    }
  });

  it('20. isolation du batch : un candidat échoue, le suivant réussit', async () => {
    if (!db || !rawSql) return;
    const orgId = await seedOrganization();
    const first = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const second = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await rawSql`UPDATE "outbox_events" SET "available_at" = now() - interval '1 minute' WHERE "id" = ${first.outboxEventId}::uuid`;
    await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${second.outboxEventId}::uuid`;

    const triggerName = 'test_suppress_outbox_update';
    const functionName = 'test_suppress_outbox_update';

    try {
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION ${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.id = '${first.outboxEventId}'::uuid THEN
            RETURN NULL;
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await rawSql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON outbox_events
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}();
      `);

      const result = await finalizeEmailDeliveries(db, 2);

      expect(result.finalizedCount).toBe(1);
      expect(result.inconsistentCount).toBe(1);
      expect(result.inspectedCount).toBe(2);

      const firstNotif = await getNotification(first.notificationId);
      const secondNotif = await getNotification(second.notificationId);
      expect(firstNotif.status).toBe('PENDING');
      expect(secondNotif.status).toBe('REQUIRES_MANUAL_REVIEW');
      expect(secondNotif.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

      const firstEvent = await getOutboxEvent(first.outboxEventId);
      const secondEvent = await getOutboxEvent(second.outboxEventId);
      expect(firstEvent.status).toBe('PENDING');
      expect(secondEvent.status).toBe('PENDING');
      expect(secondEvent.lease_token).toBeNull();
    } finally {
      await rawSql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events;`);
      await rawSql.unsafe(`DROP FUNCTION IF EXISTS ${functionName};`);
    }
  });

  it('21. FOR UPDATE SKIP LOCKED ignore une ligne déjà verrouillée', async () => {
    if (!db || !rawSql) return;
    const orgId = await seedOrganization();
    const { outboxEventId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    let release: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocker = rawSql.begin(async (tx) => {
      await tx`SELECT "id" FROM "outbox_events" WHERE "id" = ${outboxEventId}::uuid FOR UPDATE`;
      release!();
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    await acquired;

    const result = await Promise.race([
      finalizeEmailDeliveries(db),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('finalizer timed out')), 1000),
      ),
    ]);

    await blocker;

    expect(result.inspectedCount).toBe(0);
    expect(result.finalizedCount).toBe(0);

    const notifBefore = await getNotification(notificationId);
    expect(notifBefore.status).toBe('PENDING');

    const final = await finalizeEmailDeliveries(db);
    expect(final).toEqual({
      inspectedCount: 1,
      finalizedCount: 1,
      cutoffCount: 0,
      uncertainCount: 1,
      inconsistentCount: 0,
    });

    const notifAfter = await getNotification(notificationId);
    expect(notifAfter.status).toBe('REQUIRES_MANUAL_REVIEW');

    const eventAfter = await getOutboxEvent(outboxEventId);
    expect(eventAfter.status).toBe('PENDING');
    expect(eventAfter.lease_token).toBeNull();
  });

  it('22. PENDING avec lease complète incohérente -> revalidation échoue sans mutation', async () => {
    if (!db || !rawSql) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PENDING',
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const token = crypto.randomUUID();
    const leaseUntil = new Date(Date.now() + 60 * 60 * 1000);
    await rawSql`UPDATE "outbox_events" SET "lease_token" = ${token}::uuid, "lease_until" = ${leaseUntil}::timestamptz WHERE "id" = ${outboxEventId}::uuid`;

    const result = await finalizeEmailDeliveries(db);

    expect(result.inspectedCount).toBe(1);
    expect(result.inconsistentCount).toBe(1);
    expect(result.finalizedCount).toBe(0);
    expect(result.cutoffCount).toBe(0);
    expect(result.uncertainCount).toBe(0);

    const notification = await getNotification(notificationId);
    expect(notification.status).toBe('PENDING');
    expect(notification.failure_code).toBeNull();

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBe(token);
    expect(event.lease_until?.getTime()).toBe(leaseUntil.getTime());

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
    expect(effect.status).toBe('PENDING');
  });

  it('23. PROCESSING sans lease -> revalidation échoue sans mutation', async () => {
    if (!db || !rawSql) return;
    const orgId = await seedOrganization();
    const { outboxEventId, outboxEffectId, notificationId } = await seedEmailScenario(orgId, {
      outboxStatus: 'PROCESSING',
      leaseUntil: new Date(Date.now() - 60 * 1000),
      effectAttemptCount: MAX_ATTEMPTS,
      notificationFirstAttemptStartedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await rawSql`UPDATE "outbox_events" SET "lease_token" = NULL, "lease_until" = NULL WHERE "id" = ${outboxEventId}::uuid`;

    const result = await finalizeEmailDeliveries(db);

    expect(result.inspectedCount).toBe(1);
    expect(result.inconsistentCount).toBe(1);
    expect(result.finalizedCount).toBe(0);
    expect(result.cutoffCount).toBe(0);
    expect(result.uncertainCount).toBe(0);

    const notification = await getNotification(notificationId);
    expect(notification.status).toBe('PENDING');
    expect(notification.failure_code).toBeNull();

    const event = await getOutboxEvent(outboxEventId);
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();

    const effect = await getOutboxEffect(outboxEffectId);
    expect(effect.attempt_count).toBe(MAX_ATTEMPTS);
    expect(effect.status).toBe('PENDING');
  });
});
