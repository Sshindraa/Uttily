/**
 * @uttily/core — Tests d'intégration PostgreSQL du moteur d'exécution des
 * compensations (Phase 8, ADR-010 §13).
 *
 * 13 scénarios couvrant : batch vide, claim + exécution succès, idempotence
 * replay, refund déjà SUBMITTED, crash après claim, stale lease, concurrence
 * SKIP LOCKED, erreur technique avec backoff, max attempts dépassé, refus
 * Stripe (solde Connect), filtrage par environnement, vérification montant
 * mismatch, et provider.environment mismatch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { PaymentProviderError } from '../payments/errors';
import { executeCompensationBatch } from './execute-compensation-batch';
import { claimCompensationBatch } from './claim-compensation-batch';
import { executeCompensation } from './execute-compensation';
import { CompensationError } from './errors';
import type { CompensationDependencies } from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('compensation');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 5 });
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
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
  const { sql } = await import('drizzle-orm');
  if (rawSql) {
    await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON outbox_events`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
  }
  await db.execute(
    sql`TRUNCATE TABLE
      refunds, outbox_events, booking_items, booking_lines, bookings,
      payment_webhook_events, payment_attempts, payments, organization_payment_accounts,
      allocations, booking_draft_lines, booking_drafts, inventory_blocks,
      inventory_movements, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships, organizations,
      users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  itemIds: string[];
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

async function seedBaseData(suffix = SUFFIX()): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30)
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'PUBLISHED')
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix + '-' + i}, ${location.id}, ${cond}, 'ACTIVE')
      RETURNING "id"
    `.then((r) => r[0]!);
    itemIds.push(item.id);
  }
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemIds,
  };
}

interface SeedCompensationResult {
  paymentId: string;
  attemptId: string;
  refundId: string;
  outboxEventId: string;
  providerPaymentIntentId: string;
  refundIdempotencyKey: string;
}

/**
 * Insère directement un paiement SUCCEEDED + payment_attempt + refund PENDING +
 * outbox PAYMENT_COMPENSATION_REQUESTED PENDING.
 */
async function seedCompensation(
  ids: BaseIds,
  keySuffix: string,
  options: {
    environment?: 'TEST' | 'LIVE';
    overrideRefundStatus?: string;
    overrideOutboxStatus?: string;
    overrideAmountMinor?: number;
    overrideOutboxAmountMinor?: number;
    overrideOutboxCurrency?: string;
    overrideAttemptCount?: number;
    overrideAvailableAt?: string;
    overrideLeaseUntil?: string | null;
    connectedAccountId?: string;
  } = {},
): Promise<SeedCompensationResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const environment = options.environment ?? 'TEST';
  const connectedAccountId = options.connectedAccountId ?? 'acct_test_123';
  const amountMinor = options.overrideAmountMinor ?? 10000;

  // Créer un booking draft (requis par payments.draft_id).
  const draft = await sql`
    INSERT INTO "booking_drafts" (
      "organization_id", "location_id", "customer_user_id",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
      "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
      "billable_unit", "billable_unit_count",
      "currency", "cancellation_policy_snapshot"
    ) VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      'Europe/Paris', 30, 30,
      ${amountMinor}, 0, ${amountMinor},
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Créer le paiement SUCCEEDED.
  const payment = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id", "charge_model", "settlement_merchant_mode",
      "environment", "succeeded_at"
    ) VALUES (
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      'SUCCEEDED', ${amountMinor}, 'EUR',
      'NOT_APPLICABLE', 500,
      'v1', 'v1',
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: new Date().toISOString() })},
      ${connectedAccountId}, 'DESTINATION', 'PLATFORM',
      ${environment}::payment_environment, now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const providerPaymentIntentId = `pi_test_${keySuffix}`;
  const providerIdempotencyKey = `pi_idem_${keySuffix}`;

  // Créer le payment_attempt avec provider_payment_intent_id.
  const attempt = await sql`
    INSERT INTO "payment_attempts" (
      "organization_id", "payment_id", "attempt_number", "status",
      "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 1, 'SUCCEEDED',
      ${providerPaymentIntentId}, ${providerIdempotencyKey}, 'succeeded'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Créer le refund PENDING.
  const refundIdempotencyKey = `refund_late_${payment.id}`;
  const refund = await sql`
    INSERT INTO "refunds" (
      "organization_id", "payment_id", "reason", "status",
      "amount_minor", "currency",
      "provider_idempotency_key",
      "reverse_transfer", "refund_application_fee",
      "requested_at"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', ${options.overrideRefundStatus ?? 'PENDING'}::refund_status,
      ${amountMinor}, 'EUR',
      ${refundIdempotencyKey},
      true, true,
      now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Créer l'outbox event PAYMENT_COMPENSATION_REQUESTED.
  const outboxAmountMinor = options.overrideOutboxAmountMinor ?? amountMinor;
  const outboxCurrency = options.overrideOutboxCurrency ?? 'EUR';
  const outboxStatus = options.overrideOutboxStatus ?? 'PENDING';
  const attemptCount = options.overrideAttemptCount ?? 0;
  const availableAt = options.overrideAvailableAt ?? 'now()';
  const leaseUntil = options.overrideLeaseUntil;

  let outboxEventId: string;
  if (leaseUntil === undefined || leaseUntil === null) {
    const outbox = await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
        ${sql.json({
          paymentId: payment.id,
          refundIdempotencyKey,
          amountMinor: outboxAmountMinor,
          currency: outboxCurrency,
          reason: 'LATE_PAYMENT_NO_BOOKING',
        })},
        ${outboxStatus}::outbox_event_status, ${attemptCount}, ${sql.unsafe(availableAt)},
        ${'payment_compensation_' + payment.id}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    outboxEventId = outbox.id;
  } else {
    // Avec lease_until (pour les tests de stale lease).
    const leaseToken = randomUUID();
    const outbox = await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key",
        "lease_token", "lease_until"
      ) VALUES (
        ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
        ${sql.json({
          paymentId: payment.id,
          refundIdempotencyKey,
          amountMinor: outboxAmountMinor,
          currency: outboxCurrency,
          reason: 'LATE_PAYMENT_NO_BOOKING',
        })},
        ${outboxStatus}::outbox_event_status, ${attemptCount}, ${sql.unsafe(availableAt)},
        ${'payment_compensation_' + payment.id},
        ${leaseToken}::uuid, ${sql.unsafe(leaseUntil)}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    outboxEventId = outbox.id;
  }

  return {
    paymentId: payment.id,
    attemptId: attempt.id,
    refundId: refund.id,
    outboxEventId,
    providerPaymentIntentId,
    refundIdempotencyKey,
  };
}

/**
 * Pré-charge le FakeStripeAdapter avec un PaymentIntent succeeded pour que
 * createRefund puisse l'utiliser.
 */
function preloadSucceededIntent(
  adapter: FakeStripeAdapter,
  providerPaymentIntentId: string,
  amountMinor: number = 10000,
  connectedAccountId: string = 'acct_test_123',
): void {
  adapter.preloadPaymentIntent({
    id: providerPaymentIntentId,
    status: 'succeeded',
    latestChargeId: `ch_${providerPaymentIntentId}`,
    amountMinor,
    currency: 'EUR',
    connectedAccountId,
    applicationFeeAmountMinor: 500,
    onBehalfOfAccountId: null,
    environment: 'TEST',
    metadata: {
      payment_id: '',
      payment_attempt_id: '',
      draft_id: '',
      organization_id: '',
      protocol_version: 'v1',
    },
    idempotencyKey: `pi_idem_${providerPaymentIntentId}`,
  });
}

function makeDeps(adapter?: FakeStripeAdapter): CompensationDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: adapter ?? new FakeStripeAdapter({ environment: 'TEST' }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PostgreSQL synchronization helpers
// ─────────────────────────────────────────────────────────────────────────────

type RawSql = ReturnType<typeof postgres>;

async function waitForAdvisoryLockWaiter(
  conn: RawSql,
  key: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await conn`
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 1
        AND (classid::bigint << 32) | objid::bigint = ${key}
        AND granted = false
      LIMIT 1
    `;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for advisory lock waiter on key ${key} (${timeoutMs}ms)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'executeCompensationBatch — intégration PostgreSQL',
  () => {
    // 1. Claim vide
    it('1. claim vide : base vide → claimedCount=0', async () => {
      if (!db || !rawSql) return;
      const result = await executeCompensationBatch(makeDeps(), { environment: 'TEST' });
      expect(result.claimedCount).toBe(0);
      expect(result.submittedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.rescheduledCount).toBe(0);
    });

    // 2. Claim + exécution succès
    it('2. claim + exécution succès : refund PENDING → SUBMITTED, outbox PROCESSED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'success');

      // Pré-charger le PI succeeded dans le fake.
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.submittedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.rescheduledCount).toBe(0);

      // Vérifier que le refund est SUBMITTED avec provider_refund_id.
      const refund =
        await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');
      expect(refund[0]!.provider_refund_id).not.toBeNull();

      // Vérifier que l'outbox est PROCESSED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PROCESSED');
    });

    // 3. Idempotence replay : outbox déjà PROCESSED → non reclaimé
    it('3. idempotence replay : outbox déjà PROCESSED → non reclaimé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedCompensation(ids, 'replay', { overrideOutboxStatus: 'PROCESSED' });

      const result = await executeCompensationBatch(makeDeps(), { environment: 'TEST' });
      expect(result.claimedCount).toBe(0);
    });

    // 4. Refund déjà SUBMITTED
    it('4. refund déjà SUBMITTED : executeCompensation détecte REFUND_ALREADY_SUBMITTED, marque outbox PROCESSED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'already-submitted', {
        overrideRefundStatus: 'SUBMITTED',
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.submittedCount).toBe(1); // REFUND_ALREADY_SUBMITTED compte comme submitted
      expect(result.failedCount).toBe(0);

      // L'outbox doit être PROCESSED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PROCESSED');
    });

    // 5. Crash après claim, récupération
    it('5. crash après claim : expiration lease, second claim récupère', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seed = await seedCompensation(ids, 'crash');

      // Claimer avec un premier worker, puis simuler un crash.
      const db1 = createDatabase(ctx!.databaseUrl);
      const claimed1 = await claimCompensationBatch(db1, 10, 'TEST');
      expect(claimed1.length).toBe(1);
      await db1.$client.end();

      // Mettre le lease dans le passé pour simuler l'expiration.
      await rawSql`UPDATE "outbox_events" SET "lease_until" = now() - interval '1 minute' WHERE "id" = ${seed.outboxEventId}`;

      // Un nouveau worker peut récupérer l'événement.
      const claimed2 = await claimCompensationBatch(db, 10, 'TEST');
      expect(claimed2.length).toBe(1);
      expect(claimed2[0]!.outboxEventId).toBe(seed.outboxEventId);
    });

    // 6. Stale lease
    it('6. stale lease : executeCompensation avec ancien token → LEASE_LOST, aucune mutation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'stale-lease');

      // Pré-charger le PI succeeded dans le fake.
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Worker 1 claim (lease token T1).
      const db1 = createDatabase(ctx!.databaseUrl);
      const claimed1 = await claimCompensationBatch(db1, 10, 'TEST');
      expect(claimed1.length).toBe(1);
      const tokenT1 = claimed1[0]!.leaseToken;
      await db1.$client.end();

      // Simuler un crash de worker 1 : expirer le lease.
      await rawSql`UPDATE "outbox_events" SET "lease_until" = now() - interval '1 minute' WHERE "id" = ${seed.outboxEventId}`;

      // Worker 2 claim (nouveau lease token T2).
      const claimed2 = await claimCompensationBatch(db, 10, 'TEST');
      expect(claimed2.length).toBe(1);
      const tokenT2 = claimed2[0]!.leaseToken;
      expect(tokenT2).not.toBe(tokenT1);

      // Worker 1 tente executeCompensation avec l'ancien token T1.
      const staleClaimed = { ...claimed1[0]!, leaseToken: tokenT1 };
      let leaseLost = false;
      try {
        await executeCompensation(makeDeps(adapter), staleClaimed, 'TEST');
      } catch (error) {
        if (error instanceof CompensationError && error.code === 'LEASE_LOST') {
          leaseLost = true;
        } else {
          throw error;
        }
      }
      expect(leaseLost).toBe(true);

      // Vérifier qu'aucune mutation n'a eu lieu (refund reste PENDING).
      const refund =
        await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.provider_refund_id).toBeNull();
    });

    // 7. Concurrence SKIP LOCKED
    it('7. deux workers concurrents : SKIP LOCKED, aucune double revendication', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seed = await seedCompensation(ids, 'concurrent');

      // Créer un trigger qui bloque l'UPDATE de lease sur outbox_events.
      const sentinelKey = 98791;
      await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_before_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
      await rawSql.unsafe(`
      CREATE TRIGGER test_block_trigger
      BEFORE UPDATE ON outbox_events
      FOR EACH ROW
      WHEN (NEW.id = '${seed.outboxEventId}'::uuid)
      EXECUTE FUNCTION test_block_before_update()
    `);

      // Connexion sentinelle qui prend l'advisory lock.
      const sentinelConn = postgres(ctx!.databaseUrl, { max: 1 });
      await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

      const db1 = createDatabase(ctx!.databaseUrl);
      const db2 = createDatabase(ctx!.databaseUrl);

      try {
        // Lancer le premier claim — il va SELECT FOR UPDATE, puis UPDATE lease
        // (trigger se déclenche, bloque sur l'advisory lock).
        const claim1Promise = claimCompensationBatch(db1, 10, 'TEST');

        // Attendre que le trigger se déclenche (le waiter advisory apparaît).
        await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

        // Lancer le second claim — il doit retourner 0 (SKIP LOCKED).
        const claimed2 = await claimCompensationBatch(db2, 10, 'TEST');
        expect(claimed2.length).toBe(0);

        // Libérer le sentinel — la première transaction se débloque.
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;
        const claimed1 = await claim1Promise;
        expect(claimed1.length).toBe(1);
        expect(claimed1[0]!.outboxEventId).toBe(seed.outboxEventId);
      } finally {
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
        await sentinelConn.end();
        await db1.$client.end();
        await db2.$client.end();
        await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON outbox_events`;
        await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
      }
    });

    // 8. Erreur technique avec backoff
    it('8. erreur technique : provider lève une erreur transitoire → reschedule, attemptCount incrémenté', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        forceCreateRefundError: new PaymentProviderError(
          'UNKNOWN',
          'Simulated transient error',
          'api_connection_error',
        ),
      });
      const seed = await seedCompensation(ids, 'transient');

      // Pré-charger le PI succeeded dans le fake (createRefund vérifie le PI).
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.rescheduledCount).toBe(1);
      expect(result.submittedCount).toBe(0);
      expect(result.failedCount).toBe(0);

      // Vérifier que attempt_count est incrémenté.
      const outbox =
        await rawSql`SELECT attempt_count, status, available_at FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.attempt_count).toBe(1);
      expect(outbox[0]!.status).toBe('PENDING');
      // available_at doit être dans le futur (backoff).
      const availableAt = new Date(outbox[0]!.available_at).getTime();
      expect(availableAt).toBeGreaterThan(Date.now() - 1000);
    });

    // 9. Max attempts dépassé
    it('9. max attempts dépassé : attemptCount = MAX_ATTEMPTS - 1, erreur → FAILED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        forceCreateRefundError: new PaymentProviderError(
          'UNKNOWN',
          'Simulated transient error',
          'api_connection_error',
        ),
      });
      const seed = await seedCompensation(ids, 'max-attempts', {
        overrideAttemptCount: 4, // MAX_ATTEMPTS - 1 = 4
      });

      // Pré-charger le PI succeeded dans le fake.
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.rescheduledCount).toBe(0);

      // Vérifier que l'outbox est FAILED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      // Vérifier que le refund est FAILED avec failure_code.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('FAILED');
      expect(refund[0]!.failure_code).not.toBeNull();
    });

    // 10. Refus Stripe (solde Connect)
    it('10. refus Stripe : provider lève une erreur de refus → FAILED, pas de retry', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        forceCreateRefundError: new PaymentProviderError(
          'UNKNOWN',
          'Insufficient balance for reversal',
          'invalid_request_error',
        ),
      });
      const seed = await seedCompensation(ids, 'refusal');

      // Pré-charger le PI succeeded dans le fake.
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.rescheduledCount).toBe(0);

      // Vérifier que l'outbox est FAILED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      // Vérifier que le refund est FAILED avec failure_code.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('FAILED');
      expect(refund[0]!.failure_code).not.toBeNull();
    });

    // 11. Filtrage par environnement
    it('11. filtrage par environnement : paiement TEST, batch LIVE → non claimé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedCompensation(ids, 'env-filter', { environment: 'TEST' });

      // Batch avec environnement LIVE ne doit pas claimer le paiement TEST.
      const result = await executeCompensationBatch(
        { db: db!, provider: new FakeStripeAdapter({ environment: 'LIVE' }) },
        { environment: 'LIVE' },
      );
      expect(result.claimedCount).toBe(0);
    });

    // 12. Vérification montant mismatch
    it('12. montant mismatch : payload outbox dit 10000 mais refund dit 5000 → AMOUNT_MISMATCH, anomalie', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'amount-mismatch', {
        overrideAmountMinor: 5000,
        overrideOutboxAmountMinor: 10000, // Mismatch : payload dit 10000, refund dit 5000
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('AMOUNT_MISMATCH');

      // Vérifier que l'outbox est FAILED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');
    });

    // 13. provider.environment mismatch
    it('13. provider.environment mismatch : adapter LIVE, environment TEST → ENVIRONMENT_MISMATCH', async () => {
      if (!db || !rawSql) return;
      const adapter = new FakeStripeAdapter({ environment: 'LIVE' });

      await expect(
        executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' }),
      ).rejects.toThrow(CompensationError);
    });
  },
);
