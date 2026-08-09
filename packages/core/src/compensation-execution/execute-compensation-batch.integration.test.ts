/**
 * @uttily/core — Tests d'intégration PostgreSQL du moteur d'exécution des
 * compensations (Phase 8, ADR-010 §13).
 *
 * 25 scénarios couvrant : batch vide, claim + exécution succès, idempotence
 * replay, refund déjà SUBMITTED, crash après claim, stale lease, concurrence
 * SKIP LOCKED, erreur technique avec backoff, max attempts dépassé, refus
 * Stripe (solde Connect), filtrage par environnement, vérification montant
 * mismatch, provider.environment mismatch, fencing stale worker, stale token
 * précoce, sélection déterministe de tentative, réponse fournisseur incohérente,
 * flags invalides, classification api_error/idempotency_error, statut
 * requires_action admissible, refund SUCCEEDED puis erreur provider durable,
 * refund déjà FAILED au reclaim, lease expirée non reprise, et isolation des
 * payloads mal formés. Tests 26-27 : transition SUBMITTED → PENDING par webhook
 * requires_action, et isolation de plusieurs payloads mal formés dans le même
 * batch. Tests 30-31 : reclaim après crash incrémente attempt_count (P2-7) et
 * compteurs non incrémentés si lease perdue (P2-5).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput } from '../webhook-handler/types';
import { executeCompensationBatch } from './execute-compensation-batch';
import { claimCompensationBatch } from './claim-compensation-batch';
import { executeCompensation } from './execute-compensation';
import { CompensationError } from './errors';
import { MAX_ATTEMPTS } from './scheduling';
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
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
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
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + _pi},
        'image/jpeg', 102400, 800, 600, ${('000' + _pi).repeat(16).slice(0, 64)},
        ${_pi}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
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
    overrideRefundReason?: string;
    overrideReverseTransfer?: boolean;
    overrideRefundApplicationFee?: boolean;
    overrideOutboxStatus?: string;
    overrideAmountMinor?: number;
    overrideOutboxAmountMinor?: number;
    overrideOutboxCurrency?: string;
    overrideAttemptCount?: number;
    overrideAvailableAt?: string;
    overrideLeaseUntil?: string | null;
    connectedAccountId?: string;
    overrideProviderRefundId?: string;
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
  const providerRefundId = options.overrideProviderRefundId;
  const refund = providerRefundId
    ? await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "status",
          "amount_minor", "currency",
          "provider_idempotency_key", "provider_refund_id",
          "reverse_transfer", "refund_application_fee",
          "requested_at", "submitted_at"
        ) VALUES (
          ${ids.orgId}, ${payment.id}, ${options.overrideRefundReason ?? 'LATE_PAYMENT_NO_BOOKING'}::refund_reason, ${options.overrideRefundStatus ?? 'PENDING'}::refund_status,
          ${amountMinor}, 'EUR',
          ${refundIdempotencyKey}, ${providerRefundId},
          ${options.overrideReverseTransfer ?? true}, ${options.overrideRefundApplicationFee ?? true},
          now(), now()
        )
        RETURNING "id"
      `.then((r) => r[0]!)
    : await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "status",
          "amount_minor", "currency",
          "provider_idempotency_key",
          "reverse_transfer", "refund_application_fee",
          "requested_at"
        ) VALUES (
          ${ids.orgId}, ${payment.id}, ${options.overrideRefundReason ?? 'LATE_PAYMENT_NO_BOOKING'}::refund_reason, ${options.overrideRefundStatus ?? 'PENDING'}::refund_status,
          ${amountMinor}, 'EUR',
          ${refundIdempotencyKey},
          ${options.overrideReverseTransfer ?? true}, ${options.overrideRefundApplicationFee ?? true},
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

/**
 * Dépendances webhook (endpoint platform) — utilisées par les tests qui
 * simulent la course webhook/worker (P1-2/P1-3, 3e correctif Phase 8).
 */
function makeWebhookDeps(): WebhookHandlerDeps & { adapter: FakeStripeAdapter } {
  if (!db) throw new Error('db not initialized');
  const adapter = new FakeStripeAdapter({
    platformWebhookSecret: 'whsec_fake_platform',
    connectWebhookSecret: 'whsec_fake_connect',
    environment: 'TEST',
  });
  return { db, provider: adapter, adapter };
}

function makeWebhookInput(rawBody: string, adapter: FakeStripeAdapter): WebhookHandlerInput {
  const signature = adapter.generateValidSignature(rawBody, 'platform');
  return {
    rawBody,
    signature,
    endpoint: 'platform',
    environment: 'TEST',
  };
}

/**
 * Construit un payload webhook Stripe charge.refunded avec un seul refund
 * (endpoint platform, sans champ account).
 */
function makeChargeRefundedBody(params: {
  eventId?: string;
  created?: number;
  chargeId: string;
  paymentIntentId: string;
  refundId: string;
  refundStatus: string;
  amount: number;
}): string {
  return JSON.stringify({
    id: params.eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    type: 'charge.refunded',
    created: params.created ?? Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: params.chargeId,
        object: 'charge',
        payment_intent: params.paymentIntentId,
        amount_refunded: params.amount,
        refunds: {
          object: 'list',
          data: [
            {
              id: params.refundId,
              object: 'refund',
              status: params.refundStatus,
              amount: params.amount,
              payment_intent: params.paymentIntentId,
              currency: 'eur',
            },
          ],
          has_more: false,
        },
      },
    },
  });
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

      // Vérifier que attempt_count est toujours 0 après le claim initial
      // (PENDING→PROCESSING n'incrémente pas per ADR-010 §13 reclaim_only).
      const outboxAfter =
        await rawSql`SELECT attempt_count FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outboxAfter[0]!.attempt_count).toBe(0);
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

      // P1-1 : le refund n'est PAS terminalisé FAILED pour MAX_ATTEMPTS_EXCEEDED
      // (erreur interne outbox, pas un refus Stripe). Il reste PENDING pour
      // intervention humaine — le webhook peut encore projeter le statut final.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.failure_code).toBeNull();
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

      // Vérifier que le refund est FAILED avec failure_code = providerErrorCode.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('FAILED');
      expect(refund[0]!.failure_code).toBe('invalid_request_error');
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

      // P1-1 : le refund n'est pas terminalisé pour une anomalie interne.
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
    });

    // 13. provider.environment mismatch
    it('13. provider.environment mismatch : adapter LIVE, environment TEST → ENVIRONMENT_MISMATCH', async () => {
      if (!db || !rawSql) return;
      const adapter = new FakeStripeAdapter({ environment: 'LIVE' });

      await expect(
        executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' }),
      ).rejects.toThrow(CompensationError);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Correctifs Phase 8 (P1-1 à P1-6) — tests 14 à 20
    // ─────────────────────────────────────────────────────────────────────────

    // 14. P1-3 : stale worker incapable de marquer le refund FAILED
    it('14. stale worker : markOutboxFailed avec token périmé → refund et outbox inchangés (fencing RETURNING)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'stale-fencing');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Le successeur reprend la lease PENDANT l'appel provider (token T2),
      // puis le provider lève une erreur durable → le batch tente
      // markOutboxFailed avec le token T1 périmé.
      const successorToken = randomUUID();
      vi.spyOn(adapter, 'createRefund').mockImplementation(async () => {
        await rawSql!`
          UPDATE "outbox_events"
          SET "lease_token" = ${successorToken}::uuid,
              "lease_until" = now() + interval '2 minutes'
          WHERE "id" = ${seed.outboxEventId}
        `;
        throw new PaymentProviderError('UNKNOWN', 'Durable refusal', 'invalid_request_error');
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      // P1-3 (3e correctif) : markOutboxFailed retourne 'lease_lost' — le fencing
      // RETURNING-gated a empêché toute mutation et l'événement appartient au
      // successeur : ce worker ne compte NI échec NI anomalie.
      expect(result.failedCount).toBe(0);
      expect(result.anomalies.length).toBe(0);

      // P1-3 : le fencing RETURNING-gated a empêché toute mutation — le refund
      // n'est PAS marqué FAILED et l'outbox n'est PAS marqué FAILED.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.failure_code).toBeNull();

      const outbox =
        await rawSql`SELECT status, lease_token FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PROCESSING');
      expect(outbox[0]!.lease_token).toBe(successorToken);
    });

    // 15. P1-6 : stale token détecté avant l'appel fournisseur
    it('15. stale token : executeCompensation lève LEASE_LOST en Phase 1, createRefund JAMAIS appelé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'stale-early');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);
      const createRefundSpy = vi.spyOn(adapter, 'createRefund');

      // Claim (token T1).
      const claimed = await claimCompensationBatch(db, 10, 'TEST');
      expect(claimed.length).toBe(1);

      // Perdre la lease : un autre worker pose un nouveau token directement en SQL.
      await rawSql`
        UPDATE "outbox_events"
        SET "lease_token" = ${randomUUID()}::uuid
        WHERE "id" = ${seed.outboxEventId}
      `;

      // executeCompensation avec l'ancien token → LEASE_LOST en Phase 1.
      let leaseLost = false;
      try {
        await executeCompensation(makeDeps(adapter), claimed[0]!, 'TEST');
      } catch (error) {
        if (error instanceof CompensationError && error.code === 'LEASE_LOST') {
          leaseLost = true;
        } else {
          throw error;
        }
      }
      expect(leaseLost).toBe(true);
      // Le provider n'a JAMAIS été appelé.
      expect(createRefundSpy).not.toHaveBeenCalled();
    });

    // 16. P1-4 : sélection déterministe de la tentative réussie
    it('16. plusieurs tentatives : le worker rembourse le PI de la tentative SUCCEEDED, pas celui de la FAILED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'deterministic');

      // Insérer une seconde tentative FAILED avec un PI différent (pi_old).
      await rawSql`
        INSERT INTO "payment_attempts" (
          "organization_id", "payment_id", "attempt_number", "status",
          "provider_payment_intent_id", "provider_idempotency_key", "provider_status",
          "created_at"
        ) VALUES (
          ${ids.orgId}, ${seed.paymentId}, 2, 'FAILED',
          'pi_old_failed_det', 'pi_idem_old_failed_det', 'failed',
          now() + interval '1 second'
        )
      `;

      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);
      const createRefundSpy = vi.spyOn(adapter, 'createRefund');

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.submittedCount).toBe(1);
      expect(createRefundSpy).toHaveBeenCalledTimes(1);
      // Le PI remboursé est celui de la tentative SUCCEEDED (pi_new), pas pi_old.
      expect(createRefundSpy.mock.calls[0]![0].paymentIntentId).toBe(seed.providerPaymentIntentId);
    });

    // 17. P1-5 : réponse fournisseur incohérente (montant) → PROVIDER_RESULT_INVALID, durable
    it('17. provider retourne un montant incohérent → PROVIDER_RESULT_INVALID, outbox FAILED, refund reste PENDING (pas terminalisé), pas de retry', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'bad-result');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Le provider retourne un montant différent de celui demandé (10000).
      vi.spyOn(adapter, 'createRefund').mockResolvedValue({
        id: 're_bad_amount',
        status: 'succeeded',
        amountMinor: 9999,
        currency: 'EUR',
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.rescheduledCount).toBe(0);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('PROVIDER_RESULT_INVALID');

      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      // P1-1 : le refund n'est pas terminalisé FAILED pour PROVIDER_RESULT_INVALID
      // (le refund a pu être créé chez Stripe — le webhook doit pouvoir projeter
      // le statut final).
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.failure_code).toBeNull();
    });

    // 18. P1-6 : flags invalides durablement signalés (pas de boucle PROCESSING)
    it('18. refund avec reverse_transfer = false → REFUND_FLAGS_INVALID, outbox FAILED, refund reste PENDING (pas terminalisé)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      // La contrainte CHECK refunds_late_payment_reverse_transfer interdit
      // reverse_transfer = false pour LATE_PAYMENT_NO_BOOKING : le seed utilise
      // EXTERNAL_REFUND (seul moyen de matérialiser des flags invalides en base).
      // La guard clause des flags est évaluée en Phase 1 avant le recoupement
      // de la raison, donc REFUND_FLAGS_INVALID est bien levée.
      const seed = await seedCompensation(ids, 'flags-invalid', {
        overrideRefundReason: 'EXTERNAL_REFUND',
        overrideReverseTransfer: false,
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.rescheduledCount).toBe(0);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('REFUND_FLAGS_INVALID');

      // L'outbox est FAILED (pas PROCESSING qui bouclerait à l'infini).
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      // P1-1 : le refund n'est pas terminalisé FAILED pour REFUND_FLAGS_INVALID
      // (anomalie interne, pas un refus Stripe).
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.failure_code).toBeNull();
    });

    // 19. P1-6 : api_error (5xx plateforme) est transitoire → reschedule, pas FAILED
    it('19. api_error : provider lève une erreur 5xx → reschedule avec backoff, PAS FAILED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        forceCreateRefundError: new PaymentProviderError(
          'UNKNOWN',
          'Simulated platform 5xx',
          'api_error',
        ),
      });
      const seed = await seedCompensation(ids, 'api-error');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.rescheduledCount).toBe(1);
      expect(result.failedCount).toBe(0);

      const outbox =
        await rawSql`SELECT status, attempt_count, available_at FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PENDING');
      expect(outbox[0]!.attempt_count).toBe(1);
      const availableAt = new Date(outbox[0]!.available_at).getTime();
      expect(availableAt).toBeGreaterThan(Date.now() - 1000);

      // Le refund n'est PAS marqué FAILED.
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
    });

    // 20. P1-6 : idempotency_error est durable → FAILED immédiat, pas de boucle.
    // P1-1 : idempotency_error est un refus Stripe durable (terminalRefund: true)
    // car createRefund a échoué — le refund n'a JAMAIS été créé chez Stripe, il n'y
    // a pas de webhook à attendre, et l'erreur ne disparaîtra jamais au retry.
    it('20. idempotency_error : conflit de paramètres sur même clé → FAILED immédiat, refund FAILED, PAS de reschedule', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        forceCreateRefundError: new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          'Conflit de paramètres sur la même clé',
          'idempotency_error',
        ),
      });
      const seed = await seedCompensation(ids, 'idempotency-error');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.rescheduledCount).toBe(0);

      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('FAILED');
      expect(refund[0]!.failure_code).toBe('idempotency_error');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Correctifs Phase 8, 3e revue (P1-1 à P1-4, P2-1, P2-2) — tests 21 à 25
    // ─────────────────────────────────────────────────────────────────────────

    // 21. P1-2 : création fournisseur retournant requires_action
    it('21. requires_action : statut admissible → refund SUBMITTED + provider_refund_id, outbox PROCESSED, webhook requires_action projeté PENDING sans conflit', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'requires-action');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Le provider retourne requires_action (non terminal, visible, actionnable).
      vi.spyOn(adapter, 'createRefund').mockResolvedValue({
        id: 're_requires_action_1',
        status: 'requires_action',
        amountMinor: 10000,
        currency: 'EUR',
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(result.submittedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.anomalies.length).toBe(0);

      // Le refund est SUBMITTED avec provider_refund_id persisté.
      const refund =
        await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');
      expect(refund[0]!.provider_refund_id).toBe('re_requires_action_1');

      // L'outbox est PROCESSED.
      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PROCESSED');

      // Puis le webhook requires_action (projeté PENDING) : transition acceptée,
      // PAS de conflit terminal (FAILED → PENDING aurait été refusé par la
      // garde terminale REFUND_TERMINAL_STATE_CONFLICT).
      const webhookDeps = makeWebhookDeps();
      const body = makeChargeRefundedBody({
        chargeId: 'ch_requires_action',
        paymentIntentId: seed.providerPaymentIntentId,
        refundId: 're_requires_action_1',
        refundStatus: 'requires_action',
        amount: 10000,
      });
      const webhookResult = await handleWebhook(
        webhookDeps,
        makeWebhookInput(body, webhookDeps.adapter),
      );
      expect(webhookResult.kind).toBe('SUCCESS');

      // P2-2 : le webhook requires_action (projeté PENDING) ne régresse pas un
      // refund SUBMITTED — il reste SUBMITTED.
      const refundAfter = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refundAfter[0]!.status).toBe('SUBMITTED');
      const webhookEvent =
        await rawSql`SELECT status FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
      expect(webhookEvent.length).toBe(1);
      expect(webhookEvent[0]!.status).toBe('PROCESSED');
    });

    // 22. P1-3 : webhook SUCCEEDED puis exception provider durable
    it("22. refund SUCCEEDED projeté par le webhook puis erreur provider durable → outbox PROCESSED (PAS FAILED), submittedCount, pas d'anomalie", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'succeeded-then-error');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);
      const webhookDeps = makeWebhookDeps();

      vi.spyOn(adapter, 'createRefund').mockImplementation(async () => {
        // (a) Stripe a réellement créé le refund : le webhook le projette
        // SUCCEEDED (rattachement du remboursement LATE orphelin).
        const body = makeChargeRefundedBody({
          chargeId: 'ch_succeeded_then_error',
          paymentIntentId: seed.providerPaymentIntentId,
          refundId: 're_succeeded_then_error_1',
          refundStatus: 'succeeded',
          amount: 10000,
        });
        const webhookResult = await handleWebhook(
          webhookDeps,
          makeWebhookInput(body, webhookDeps.adapter),
        );
        expect(webhookResult.kind).toBe('SUCCESS');
        // (b) L'appel retourne néanmoins une erreur durable/ambiguë.
        throw new PaymentProviderError('UNKNOWN', 'Ambiguous durable error', 'idempotency_error');
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      // P1-3 : le refund SUCCEEDED impose outbox PROCESSED — compté
      // alreadySucceeded (P2 metrics), PAS submitted, PAS failed, AUCUNE anomalie.
      expect(result.submittedCount).toBe(0);
      expect(result.alreadySucceededCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.anomalies.length).toBe(0);

      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('PROCESSED');

      // Le refund reste SUCCEEDED, jamais écrasé en FAILED.
      const refund =
        await rawSql`SELECT status, provider_refund_id, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUCCEEDED');
      expect(refund[0]!.provider_refund_id).toBe('re_succeeded_then_error_1');
      expect(refund[0]!.failure_code).toBeNull();
    });

    // 23. P1-4 : refund déjà FAILED au reclaim
    it('23. refund déjà FAILED au reclaim → REFUND_ALREADY_FAILED, outbox FAILED (PAS PROCESSED), anomalie, createRefund JAMAIS appelé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'already-failed', {
        overrideRefundStatus: 'FAILED',
      });
      const createRefundSpy = vi.spyOn(adapter, 'createRefund');

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      // P1-4 : un refund FAILED n'est JAMAIS compté comme soumis.
      expect(result.submittedCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('REFUND_ALREADY_FAILED');
      expect(createRefundSpy).not.toHaveBeenCalled();

      const outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(outbox[0]!.status).toBe('FAILED');

      // Le refund reste FAILED (l'UPDATE monotone exclut les terminaux).
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('FAILED');
    });

    // 24. P2-1 : lease expirée mais pas encore reprise (token inchangé)
    it('24. lease expirée (token inchangé) → LEASE_LOST en Phase 1, createRefund JAMAIS appelé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'expired-lease');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);
      const createRefundSpy = vi.spyOn(adapter, 'createRefund');

      // Claim (token T1, lease valide 2 minutes).
      const claimed = await claimCompensationBatch(db, 10, 'TEST');
      expect(claimed.length).toBe(1);

      // Expirer la lease SANS changer le token — l'événement est reclaimable
      // par un autre worker à tout moment.
      await rawSql`
        UPDATE "outbox_events"
        SET "lease_until" = transaction_timestamp() - interval '1 minute'
        WHERE "id" = ${seed.outboxEventId}
      `;

      let leaseLost = false;
      try {
        await executeCompensation(makeDeps(adapter), claimed[0]!, 'TEST');
      } catch (error) {
        if (error instanceof CompensationError && error.code === 'LEASE_LOST') {
          leaseLost = true;
        } else {
          throw error;
        }
      }
      expect(leaseLost).toBe(true);
      // Le provider n'a JAMAIS été appelé.
      expect(createRefundSpy).not.toHaveBeenCalled();
    });

    // 25. P2-2 : payload mal formé n'empêche pas les autres événements
    it("25. payload mal formé → PAYLOAD_MALFORMED durable + outbox FAILED, l'événement valide du batch est soumis (aucune exception SQL au claim)", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'valid-payload');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Insérer un événement mal formé : amountMinor non numérique et
      // paymentId non UUID — les casts directs auraient levé une erreur SQL
      // et bloqué TOUT le batch.
      const malformed = await rawSql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
          "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, 'PAYMENT', ${randomUUID()}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
          ${rawSql.json({
            paymentId: 'not-a-uuid',
            refundIdempotencyKey: 'refund_malformed_x',
            amountMinor: 'abc',
            currency: 'EUR',
            reason: 'LATE_PAYMENT_NO_BOOKING',
          })},
          'PENDING', 0, now(),
          ${'payment_compensation_malformed_' + randomUUID()}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      // Le claim ne lève AUCUNE exception SQL ; les deux événements sont revendiqués.
      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(2);
      expect(result.submittedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('PAYLOAD_MALFORMED');

      // Le mal formé est FAILED (durable, pas de retry).
      const malformedOutbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${malformed.id}`;
      expect(malformedOutbox[0]!.status).toBe('FAILED');

      // L'événement valide est soumis normalement.
      const validOutbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(validOutbox[0]!.status).toBe('PROCESSED');
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');

      // P1-1 : aucun refund n'est terminalisé FAILED pour PAYLOAD_MALFORMED
      // (le payload malformé ne matche aucun refund valide — l'UPDATE est un no-op).
      const allRefunds = await rawSql`SELECT status FROM refunds`;
      for (const r of allRefunds) {
        expect(r.status).not.toBe('FAILED');
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Correctifs Phase 8, 4e revue — tests 26 à 27
    // ─────────────────────────────────────────────────────────────────────────

    // 26. webhook requires_action sur refund SUBMITTED → reste SUBMITTED (pas de
    // régression vers PENDING). SUBMITTED est un état local signifiant
    // "createRefund accepté" — un webhook requires_action ne doit pas l'annuler.
    it('26. webhook requires_action sur refund SUBMITTED → reste SUBMITTED (pas de régression vers PENDING)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const providerRefundId = 're_test_26_requires_action';
      // Seeder un refund LATE SUBMITTED avec provider_refund_id persisté +
      // outbox PROCESSED (comme si le worker avait fini avec requires_action).
      const seed = await seedCompensation(ids, 'submitted-then-webhook-pending', {
        overrideRefundStatus: 'SUBMITTED',
        overrideOutboxStatus: 'PROCESSED',
        overrideProviderRefundId: providerRefundId,
      });

      // Appeler le handler webhook avec un événement refund requires_action
      // (projeté PENDING localement) pour le même provider_refund_id.
      const webhookDeps = makeWebhookDeps();
      const body = makeChargeRefundedBody({
        chargeId: 'ch_submitted_then_webhook_pending',
        paymentIntentId: seed.providerPaymentIntentId,
        refundId: providerRefundId,
        refundStatus: 'requires_action',
        amount: 10000,
      });
      const webhookResult = await handleWebhook(
        webhookDeps,
        makeWebhookInput(body, webhookDeps.adapter),
      );
      expect(webhookResult.kind).toBe('SUCCESS');

      // P2-2 : le webhook requires_action (projeté PENDING) ne régresse pas un
      // refund SUBMITTED — il reste SUBMITTED.
      const refundAfter =
        await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${seed.refundId}`;
      expect(refundAfter[0]!.status).toBe('SUBMITTED');
      expect(refundAfter[0]!.provider_refund_id).toBe(providerRefundId);

      // L'événement webhook est PROCESSED (pas de conflit terminal).
      const webhookEvent =
        await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
      expect(webhookEvent.length).toBe(1);
      expect(webhookEvent[0]!.status).toBe('PROCESSED');
      expect(webhookEvent[0]!.failure_code).toBeNull();
    });

    // 27. plusieurs payloads mal formés dans le même batch → tous isolés
    // (FAILED), l'événement valide soumis. Vérifie que le safe-cast SQL au claim
    // isole chaque payload mal formé sans bloquer le batch.
    it("27. plusieurs payloads mal formés dans le même batch → tous isolés (FAILED), l'événement valide soumis", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'valid-multi-malformed');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Insérer deux événements mal formés : un avec amountMinor = "abc", un
      // avec paymentId = "not-a-uuid" — les casts directs auraient levé une
      // erreur SQL et bloqué TOUT le batch.
      const malformed1 = await rawSql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
          "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, 'PAYMENT', ${randomUUID()}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
          ${rawSql.json({
            paymentId: 'd1b3e4f2-a1b2-4c3d-8e5f-6a7b8c9d0e1f',
            refundIdempotencyKey: 'refund_malformed_1',
            amountMinor: 'abc',
            currency: 'EUR',
            reason: 'LATE_PAYMENT_NO_BOOKING',
          })},
          'PENDING', 0, now(),
          ${'payment_compensation_malformed_1_' + randomUUID()}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const malformed2 = await rawSql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
          "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, 'PAYMENT', ${randomUUID()}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
          ${rawSql.json({
            paymentId: 'not-a-uuid',
            refundIdempotencyKey: 'refund_malformed_2',
            amountMinor: 10000,
            currency: 'EUR',
            reason: 'LATE_PAYMENT_NO_BOOKING',
          })},
          'PENDING', 0, now(),
          ${'payment_compensation_malformed_2_' + randomUUID()}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      // Le claim ne lève AUCUNE exception SQL ; les trois événements sont
      // revendiqués.
      const result = await executeCompensationBatch(makeDeps(adapter), {
        environment: 'TEST',
        batchLimit: 3,
      });
      expect(result.claimedCount).toBe(3);
      expect(result.submittedCount).toBe(1);
      expect(result.failedCount).toBe(2);
      expect(result.anomalies.length).toBe(2);
      expect(result.anomalies.some((a) => a.code === 'PAYLOAD_MALFORMED')).toBe(true);

      // Les deux outbox mal formés sont FAILED (durable, pas de retry).
      const malformed1Outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${malformed1.id}`;
      expect(malformed1Outbox[0]!.status).toBe('FAILED');
      const malformed2Outbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${malformed2.id}`;
      expect(malformed2Outbox[0]!.status).toBe('FAILED');

      // L'événement valide est soumis normalement.
      const validOutbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(validOutbox[0]!.status).toBe('PROCESSED');
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Correctifs Phase 8, 5e revue (P1-1, P1-2, P2-1 à P2-7) — tests 28 à 29
    // ─────────────────────────────────────────────────────────────────────────

    // 28. P1-1/P2-6 : payload malformé avec refundIdempotencyKey valide matchant
    // un refund PENDING existant → outbox FAILED mais refund reste PENDING (pas
    // terminalisé FAILED — c'est une erreur interne outbox, pas un refus Stripe).
    it('28. payload malformé sur refund PENDING existant → outbox FAILED, refund reste PENDING (pas terminalisé)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'malformed-valid-key', {
        overrideOutboxStatus: 'PROCESSED',
      });
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Insérer un événement mal formé avec le MÊME refundIdempotencyKey que le
      // refund PENDING existant (amountMinor non numérique → payload_valid = false,
      // mais refundIdempotencyKey matche un vrai refund).
      const malformed = await rawSql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
          "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, 'PAYMENT', ${randomUUID()}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
          ${rawSql.json({
            paymentId: 'not-a-uuid',
            refundIdempotencyKey: seed.refundIdempotencyKey,
            amountMinor: 'abc',
            currency: 'EUR',
            reason: 'LATE_PAYMENT_NO_BOOKING',
          })},
          'PENDING', 0, now(),
          ${'payment_compensation_malformed_valid_key_' + randomUUID()}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      // Le mal formé est FAILED (durable, pas de retry).
      expect(result.failedCount).toBe(1);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.code).toBe('PAYLOAD_MALFORMED');

      // L'outbox mal formé est FAILED.
      const malformedOutbox =
        await rawSql`SELECT status FROM outbox_events WHERE id = ${malformed.id}`;
      expect(malformedOutbox[0]!.status).toBe('FAILED');

      // P1-1 : le refund PENDING n'est PAS terminalisé FAILED — c'est une erreur
      // interne outbox, pas un refus Stripe. Le webhook peut encore projeter le
      // statut final depuis Stripe.
      const refund =
        await rawSql`SELECT status, failure_code FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('PENDING');
      expect(refund[0]!.failure_code).toBeNull();
    });

    // 29. P1-2/P2-7 : refund SUBMITTED avec payload malformé → outbox PROCESSED
    // (pas FAILED), refund reste SUBMITTED. Le refund a été soumis à Stripe —
    // l'outbox est PROCESSED, jamais FAILED.
    it('29. refund SUBMITTED + payload malformé → outbox PROCESSED (pas FAILED), refund reste SUBMITTED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const providerRefundId = 're_test_29_submitted_protection';
      // Seeder un refund SUBMITTED avec provider_refund_id persisté.
      const seed = await seedCompensation(ids, 'submitted-protection', {
        overrideRefundStatus: 'SUBMITTED',
        overrideProviderRefundId: providerRefundId,
      });

      // Insérer un événement mal formé avec le MÊME refundIdempotencyKey.
      const malformed = await rawSql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
          "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, 'PAYMENT', ${randomUUID()}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
          ${rawSql.json({
            paymentId: 'not-a-uuid',
            refundIdempotencyKey: seed.refundIdempotencyKey,
            amountMinor: 'abc',
            currency: 'EUR',
            reason: 'LATE_PAYMENT_NO_BOOKING',
          })},
          'PENDING', 0, now(),
          ${'payment_compensation_submitted_protection_' + randomUUID()}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });

      // P1-2 : le refund SUBMITTED est protégé — l'outbox est PROCESSED (pas
      // FAILED), compté comme alreadySucceeded (pas failed, pas d'anomalie).
      expect(result.failedCount).toBe(0);
      expect(result.anomalies.length).toBe(0);
      expect(result.alreadySucceededCount).toBe(1);

      // L'outbox est PROCESSED (le refund a été soumis à Stripe).
      const outbox = await rawSql`SELECT status FROM outbox_events WHERE id = ${malformed.id}`;
      expect(outbox[0]!.status).toBe('PROCESSED');

      // Le refund reste SUBMITTED, jamais terminalisé FAILED.
      const refund =
        await rawSql`SELECT status, failure_code, provider_refund_id FROM refunds WHERE id = ${seed.refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');
      expect(refund[0]!.failure_code).toBeNull();
      expect(refund[0]!.provider_refund_id).toBe(providerRefundId);
    });

    // 30. P2-7 : reclaim après crash incrémente attempt_count. Un événement
    // PROCESSING avec lease expirée est reclaimé avec attempt_count + 1. Après
    // MAX_ATTEMPTS reclaims, l'événement n'est plus éligible (filtre SELECT).
    it('30. reclaim après crash incrémente attempt_count, borne MAX_ATTEMPTS respectée', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'reclaim-attempt-count');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Forcer une erreur transitoire pour que l'orchestrateur reschedule.
      vi.spyOn(adapter, 'createRefund').mockImplementation(async () => {
        throw new PaymentProviderError('UNKNOWN', 'Rate limited', 'rate_limit');
      });

      // Simuler un crash : l'événement est PROCESSING avec lease expirée et
      // attempt_count = 0. Le reclaim doit incrémenter attempt_count.
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PROCESSING',
            "lease_until" = now() - interval '5 minutes',
            "lease_token" = ${randomUUID()}::uuid,
            "attempt_count" = 0
        WHERE "id" = ${seed.outboxEventId}
      `;

      // Premier reclaim (PROCESSING→PROCESSING) : la stratégie reclaim_only
      // incrémente attempt_count de 0 à 1, puis rescheduleOutbox incrémente à 2.
      const result1 = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result1.rescheduledCount).toBe(1);

      const event1 =
        await rawSql`SELECT attempt_count FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(event1[0]!.attempt_count).toBe(2);

      // Simuler un nouveau crash : rescheduleOutbox a remis PENDING, on remet
      // PROCESSING avec lease expirée pour que le reclaim incrémente à nouveau.
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PROCESSING',
            "lease_until" = now() - interval '5 minutes',
            "lease_token" = ${randomUUID()}::uuid,
            "available_at" = now() - interval '1 minute'
        WHERE "id" = ${seed.outboxEventId}
      `;

      // Deuxième reclaim : attempt_count passe de 2 à 3 (reclaim), puis
      // rescheduleOutbox incrémente à 4.
      const result2 = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result2.rescheduledCount).toBe(1);

      const event2 =
        await rawSql`SELECT attempt_count FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(event2[0]!.attempt_count).toBe(4);

      // Simuler un troisième crash.
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PROCESSING',
            "lease_until" = now() - interval '5 minutes',
            "lease_token" = ${randomUUID()}::uuid,
            "available_at" = now() - interval '1 minute'
        WHERE "id" = ${seed.outboxEventId}
      `;

      // Troisième reclaim : le SELECT retourne attempt_count = 4 (avant incrémentation
      // du reclaim). Le reclaim l'incrémente à 5 dans la base. L'orchestrateur vérifie
      // 4 + 1 >= MAX_ATTEMPTS (5 >= 5) → markOutboxFailed.
      const result3 = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result3.failedCount).toBe(1);
      expect(result3.rescheduledCount).toBe(0);

      // L'outbox est FAILED.
      const event3 =
        await rawSql`SELECT status, attempt_count FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(event3[0]!.status).toBe('FAILED');
      // attempt_count = 5 (reclaim a incrémenté de 4 à 5, mais markOutboxFailed
      // n'incrémente pas).
      expect(event3[0]!.attempt_count).toBe(5);
    });

    // 31. P2-5 : rescheduledCount non incrémenté si rescheduleOutbox perd la lease
    it('31. P2-5 : rescheduledCount non incrémenté si rescheduleOutbox perd la lease', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'reschedule-lease-lost');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Forcer une erreur transitoire pour déclencher rescheduleOutbox.
      const sqlConn = rawSql;
      vi.spyOn(adapter, 'createRefund').mockImplementation(async () => {
        // Voler la lease PENDANT l'appel provider (avant Phase 3 et reschedule).
        await sqlConn`
          UPDATE "outbox_events"
          SET "lease_token" = ${randomUUID()}::uuid,
              "lease_until" = now() + interval '2 minutes'
          WHERE "id" = ${seed.outboxEventId}
        `;
        throw new PaymentProviderError('UNKNOWN', 'Rate limited', 'rate_limit');
      });

      const result = await executeCompensationBatch(makeDeps(adapter), { environment: 'TEST' });

      // P2-5 : rescheduledCount n'est PAS incrémenté car rescheduleOutbox a perdu
      // la lease (le token ne matche plus après le vol).
      expect(result.rescheduledCount).toBe(0);
      expect(result.submittedCount).toBe(0);
      expect(result.failedCount).toBe(0);
    });

    // 32. P2-7 edge case : crash avant reschedule, attempt_count atteint MAX_ATTEMPTS
    // via reclaims successifs. L'événement reste PROCESSING avec lease expirée, non
    // reclaimable (filtre attempt_count < MAX_ATTEMPTS). Ce scénario est rare et
    // nécessite une intervention manuelle — il est préféré à la boucle infinie
    // précédente.
    it('32. edge case : MAX_ATTEMPTS crashes avant reschedule → événement stuck PROCESSING, non reclaimable', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const seed = await seedCompensation(ids, 'stuck-max-attempts');
      preloadSucceededIntent(adapter, seed.providerPaymentIntentId);

      // Simuler MAX_ATTEMPTS crashes consécutifs avant reschedule : à chaque fois,
      // l'événement est PROCESSING avec lease expirée. Le reclaim incrémente
      // attempt_count. On ne simule AUCUN reschedule (le worker crash avant).
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await rawSql`
          UPDATE "outbox_events"
          SET "status" = 'PROCESSING',
              "lease_until" = now() - interval '5 minutes',
              "lease_token" = ${randomUUID()}::uuid,
              "available_at" = now() - interval '1 minute'
          WHERE "id" = ${seed.outboxEventId}
        `;
        // Le reclaim incrémente attempt_count. On n'appelle PAS
        // executeCompensationBatch — on simule un crash immédiat après le claim.
        // Pour ce faire, on appelle claimCompensationBatch directement.
        const claimed = await claimCompensationBatch(db, 10, 'TEST');
        expect(claimed.length).toBe(1);
      }

      // Vérifier que attempt_count = MAX_ATTEMPTS.
      const eventBeforeExpiry =
        await rawSql`SELECT status, attempt_count FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(eventBeforeExpiry[0]!.attempt_count).toBe(MAX_ATTEMPTS);

      // L'événement n'est plus reclaimable (filtre attempt_count < MAX_ATTEMPTS).
      const claimedAgain = await claimCompensationBatch(db, 10, 'TEST');
      expect(claimedAgain.length).toBe(0);

      // Simuler l'expiration de la lease : le worker a crashé après le dernier
      // claim, la lease (mise dans le futur par claimCompensationBatch) finit
      // par expirer. L'événement reste PROCESSING, non reclaimable, non FAILED.
      await rawSql`
        UPDATE "outbox_events"
        SET "lease_until" = now() - interval '5 minutes'
        WHERE "id" = ${seed.outboxEventId}
      `;

      // L'événement reste PROCESSING avec lease expirée — stuck, non FAILED.
      // Intervention manuelle requise.
      const event =
        await rawSql`SELECT status, attempt_count, lease_until FROM outbox_events WHERE id = ${seed.outboxEventId}`;
      expect(event[0]!.status).toBe('PROCESSING');
      expect(event[0]!.attempt_count).toBe(MAX_ATTEMPTS);
      expect(new Date(event[0]!.lease_until).getTime()).toBeLessThan(Date.now());
    });
  },
);
