/**
 * @uttily/core — Tests d'intégration PostgreSQL du module Webhook Handler
 * (Lot 5, ADR-010 §10, §11, §13, §15).
 *
 * Tests PostgreSQL réels : confirmation nominale, multi-lignes, échecs
 * invariants, doublons, compensation tardive, événements désordonnés.
 * Reprend le pattern de initiate-payment.integration.test.ts.
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
import { createBookingDraftWithHold } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput as CreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { executeCompensationBatch } from '../compensation-execution';
import { handleWebhook } from './handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput, WebhookHandlerResult } from './types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import { expireBookingDraftsBatch } from '../booking-drafts/expire-booking-drafts-batch';
import { executeRefundRequestBatch } from '../refund-request-execution';
import type { CreateRefundParams, RefundResult } from '../payments/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('webhook_handler');
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
// Seed helpers (reprend initiate-payment.integration.test.ts)
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
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

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

async function seedPaymentAccount(ids: BaseIds, accountId = 'acct_test_123'): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "organization_payment_accounts" (
      "organization_id", "provider", "environment", "provider_account_id",
      "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
      "transfers_capability_status", "settlement_merchant_mode",
      "controller_configuration_snapshot", "requirements_snapshot"
    ) VALUES (
      ${ids.orgId}, 'STRIPE', 'TEST', ${accountId},
      'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true,
      'ACTIVE', 'PLATFORM',
      ${sql.json({ preset: 'CUSTOM' })}, ${sql.json({})}
    )
  `;
}

async function createHeldDraft(ids: BaseIds, keySuffix: string, quantity = 1): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const input: CreateBookingDraftInput = {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity }],
    idempotencyKey: 'held-' + keySuffix,
  };
  const result = await createBookingDraftWithHold(db, input);
  if (result.kind !== 'SUCCESS') throw new Error('Failed to create held draft');
  return result.body.draftId;
}

function makeFinancialTermsConfig(connectedAccountId = 'acct_test_123'): FinancialTermsConfig {
  return {
    tax: {
      version: 'v1',
      status: 'NOT_APPLICABLE',
      amountMinor: null,
      rateBps: null,
      invoiceIssuer: 'Uttily',
    },
    commission: {
      version: 'v1',
      basis: 'percentage',
      amountMinor: 500,
    },
    connectedAccount: {
      accountId: connectedAccountId,
      chargesEnabled: true,
      transfersCapabilityStatus: 'ACTIVE',
      settlementMerchantMode: 'PLATFORM',
      onBehalfOfAccountId: null,
    },
    legalTermsVersion: 'v1',
  };
}

function makeTermsAcceptance(userId: string): TermsAcceptanceProof {
  return {
    termsVersion: 'v1',
    userId,
    acceptedAt: new Date().toISOString(),
  };
}

function makeInitiateInput(ids: BaseIds, draftId: string, keySuffix: string): InitiatePaymentInput {
  return {
    draftId,
    idempotencyKey: 'init-' + keySuffix,
    organizationId: ids.orgId,
    customerUserId: ids.userId,
    environment: 'TEST',
    financialTermsConfig: makeFinancialTermsConfig(),
    termsAcceptance: makeTermsAcceptance(ids.userId),
  };
}

function makeDeps(): WebhookHandlerDeps & { adapter: FakeStripeAdapter } {
  if (!db) throw new Error('db not initialized');
  const adapter = new FakeStripeAdapter({
    platformWebhookSecret: 'whsec_fake_platform',
    connectWebhookSecret: 'whsec_fake_connect',
    environment: 'TEST',
  });
  return { db, provider: adapter, adapter };
}

function makeInitDeps(): InitiatePaymentDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: new FakeStripeAdapter({ environment: 'TEST' }),
  };
}

/**
 * Construit un payload webhook Stripe pour payment_intent.succeeded.
 */
function makeWebhookPayload(
  type: string,
  piId: string,
  amount: number,
  metadata: Record<string, string> = {},
  status = 'succeeded',
  overrides: {
    destination?: string;
    applicationFeeAmount?: number | null;
    onBehalfOf?: string | null;
    eventId?: string;
    created?: number;
  } = {},
): string {
  const destination = overrides.destination ?? 'acct_test_123';
  const applicationFeeAmount = overrides.applicationFeeAmount ?? 500;
  const onBehalfOf = overrides.onBehalfOf ?? null;
  return JSON.stringify({
    id: overrides.eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    type,
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        status,
        amount,
        currency: 'eur',
        metadata,
        transfer_data: { destination },
        application_fee_amount: applicationFeeAmount,
        on_behalf_of: onBehalfOf,
      },
    },
  });
}

function makeWebhookInput(
  rawBody: string,
  adapter: FakeStripeAdapter,
  endpoint: 'platform' | 'connect' = 'platform',
): WebhookHandlerInput {
  const signature = adapter.generateValidSignature(rawBody, endpoint);
  return {
    rawBody,
    signature,
    endpoint,
    environment: 'TEST',
  };
}

/**
 * Récupère le montant du paiement depuis la DB (pour construire un webhook cohérent).
 */
async function getPaymentAmount(draftId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const row = await rawSql`SELECT amount_minor FROM payments WHERE draft_id = ${draftId}`.then(
    (r) => r[0],
  );
  // postgres retourne les bigint comme string — convertir en number.
  return Number(row!.amount_minor);
}

/**
 * Récupère l'ID du paiement depuis la DB.
 */
async function getPaymentId(draftId: string): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const row = await rawSql`SELECT id FROM payments WHERE draft_id = ${draftId}`.then((r) => r[0]);
  return row!.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers Phase 8 (P1-1/P1-2) — compensation tardive et course webhook/worker
// ─────────────────────────────────────────────────────────────────────────────

interface SeedLateCompensationResult {
  paymentId: string;
  refundId: string;
  outboxEventId: string;
  providerPaymentIntentId: string;
  refundIdempotencyKey: string;
  amountMinor: number;
  /** Présent uniquement quand le refund est seedé SUBMITTED (worker terminé). */
  providerRefundId?: string;
}

/**
 * Insère directement un paiement SUCCEEDED + tentative SUCCEEDED + refund
 * LATE_PAYMENT_NO_BOOKING PENDING (provider_refund_id NULL) + outbox
 * PAYMENT_COMPENSATION_REQUESTED — l'état du système entre la création de la
 * compensation (webhook payment_intent.succeeded tardif) et l'exécution du
 * worker de compensation.
 */
async function seedLateCompensation(
  ids: BaseIds,
  keySuffix: string,
): Promise<SeedLateCompensationResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const amountMinor = 10000;

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
      'acct_test_123', 'DESTINATION', 'PLATFORM',
      'TEST'::payment_environment, now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const providerPaymentIntentId = `pi_test_late_${keySuffix}`;
  await sql`
    INSERT INTO "payment_attempts" (
      "organization_id", "payment_id", "attempt_number", "status",
      "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 1, 'SUCCEEDED',
      ${providerPaymentIntentId}, ${'pi_idem_late_' + keySuffix}, 'succeeded'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const refundIdempotencyKey = `refund_late_${payment.id}`;
  const refund = await sql`
    INSERT INTO "refunds" (
      "organization_id", "payment_id", "reason", "status",
      "amount_minor", "currency", "provider_idempotency_key",
      "reverse_transfer", "refund_application_fee", "requested_at"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 'PENDING',
      ${amountMinor}, 'EUR', ${refundIdempotencyKey},
      true, true, now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const outbox = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key"
    ) VALUES (
      ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
      ${sql.json({
        paymentId: payment.id,
        refundIdempotencyKey,
        amountMinor,
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      })},
      'PENDING', 0, now(),
      ${'payment_compensation_' + payment.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    paymentId: payment.id,
    refundId: refund.id,
    outboxEventId: outbox.id,
    providerPaymentIntentId,
    refundIdempotencyKey,
    amountMinor,
  };
}

/**
 * Insère directement un paiement SUCCEEDED + tentative SUCCEEDED + refund
 * LATE_PAYMENT_NO_BOOKING SUBMITTED (provider_refund_id déjà persisté) + outbox
 * PROCESSED — l'état du système APRÈS l'exécution complète du worker de
 * compensation (Phases 1-3), avant l'arrivée du webhook de confirmation.
 */
async function seedSubmittedLateRefund(
  ids: BaseIds,
  keySuffix: string,
): Promise<SeedLateCompensationResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const amountMinor = 10000;
  const providerRefundId = `re_test_submitted_${keySuffix}`;

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
      'acct_test_123', 'DESTINATION', 'PLATFORM',
      'TEST'::payment_environment, now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const providerPaymentIntentId = `pi_test_submitted_${keySuffix}`;
  await sql`
    INSERT INTO "payment_attempts" (
      "organization_id", "payment_id", "attempt_number", "status",
      "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 1, 'SUCCEEDED',
      ${providerPaymentIntentId}, ${'pi_idem_submitted_' + keySuffix}, 'succeeded'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const refundIdempotencyKey = `refund_late_${payment.id}`;
  const refund = await sql`
    INSERT INTO "refunds" (
      "organization_id", "payment_id", "reason", "status",
      "amount_minor", "currency", "provider_idempotency_key",
      "provider_refund_id", "reverse_transfer", "refund_application_fee",
      "requested_at", "submitted_at"
    ) VALUES (
      ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 'SUBMITTED',
      ${amountMinor}, 'EUR', ${refundIdempotencyKey},
      ${providerRefundId}, true, true,
      now(), now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const outbox = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "processed_at", "idempotency_key"
    ) VALUES (
      ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
      ${sql.json({
        paymentId: payment.id,
        refundIdempotencyKey,
        amountMinor,
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      })},
      'PROCESSED', 1, now(), now(),
      ${'payment_compensation_' + payment.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    paymentId: payment.id,
    refundId: refund.id,
    outboxEventId: outbox.id,
    providerPaymentIntentId,
    refundIdempotencyKey,
    amountMinor,
    providerRefundId,
  };
}

/**
 * Construit un payload webhook Stripe charge.refunded avec un seul refund.
 */
function makeChargeRefundedBody(params: {
  eventId?: string;
  created?: number;
  chargeId: string;
  paymentIntentId: string;
  refundId: string;
  refundStatus: string;
  amount: number;
  metadata?: Record<string, string>;
  /** Compte Connect (champ `account` de l'événement) — endpoint connect. */
  account?: string;
}): string {
  return JSON.stringify({
    id: params.eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    type: 'charge.refunded',
    created: params.created ?? Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    ...(params.account !== undefined ? { account: params.account } : {}),
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
              ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
            },
          ],
          has_more: false,
        },
      },
    },
  });
}

function makeDirectRefundBody(params: {
  eventId: string;
  eventType?: 'refund.created' | 'refund.updated';
  created: number;
  refundId: string;
  paymentIntentId: string;
  refundStatus: string;
  amount: number;
  currency?: string;
  metadata?: Record<string, string>;
}): string {
  return JSON.stringify({
    id: params.eventId,
    type: params.eventType ?? 'refund.updated',
    created: params.created,
    api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: params.refundId,
        object: 'refund',
        status: params.refundStatus,
        amount: params.amount,
        currency: params.currency ?? 'eur',
        payment_intent: params.paymentIntentId,
        metadata: params.metadata,
        extra_sensitive_field: 'must-not-persist',
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PostgreSQL synchronization helpers (copiés depuis initiate-payment.integration.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

type RawSql = ReturnType<typeof postgres>;

/**
 * Poll pg_locks until an ungranted advisory lock waiter appears for the given key.
 * This proves the trigger has fired and the transaction is blocked.
 */
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

/**
 * Poll until PostgreSQL's now() is past the given timestamp.
 */
async function waitForPgTimePast(conn: RawSql, targetIso: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await conn`SELECT now() > ${targetIso}::timestamptz AS past`;
    if (rows[0]?.past === true) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for PostgreSQL clock to pass ${targetIso} (${timeoutMs}ms)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('handleWebhook — intégration PostgreSQL', () => {
  interface TaggedRefundFixture {
    ids: BaseIds;
    deps: WebhookHandlerDeps & { adapter: FakeStripeAdapter };
    paymentId: string;
    paymentIntentId: string;
    amount: number;
    refundIds: string[];
  }

  class SucceedingRefundProvider extends FakeStripeAdapter {
    calls: CreateRefundParams[] = [];

    override async createRefund(params: CreateRefundParams): Promise<RefundResult> {
      this.calls.push(params);
      return {
        id: `re_worker_${params.metadata?.refund_id}`,
        status: 'succeeded',
        amountMinor: params.amountMinor,
        currency: 'EUR',
      };
    }
  }

  async function seedTaggedRefundFixture(suffix: string, count = 1): Promise<TaggedRefundFixture> {
    if (!db || !rawSql) throw new Error('DB non initialisée');
    const ids = await seedBaseData(suffix);
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, `tagged-${suffix}`);
    const initResult = await initiatePayment(
      makeInitDeps(),
      makeInitiateInput(ids, draftId, `tagged-${suffix}`),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') throw new Error('initiation de paiement impossible');
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const paymentDeps = makeDeps();
    const succeededBody = makeWebhookPayload(
      'payment_intent.succeeded',
      initResult.providerPaymentIntentId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { eventId: `evt_tagged_payment_${suffix}` },
    );
    const paymentResult = await handleWebhook(
      paymentDeps,
      makeWebhookInput(succeededBody, paymentDeps.adapter),
    );
    expect(paymentResult.kind).toBe('SUCCESS');
    const refundIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const refundId = randomUUID();
      refundIds.push(refundId);
      await rawSql`
        INSERT INTO refunds (
          id, organization_id, payment_id, reason, status, amount_minor, currency,
          provider_idempotency_key, reverse_transfer, refund_application_fee, requested_at
        ) VALUES (
          ${refundId}, ${ids.orgId}, ${paymentId}, 'BOOKING_MODIFICATION', 'PENDING',
          ${amount}, 'EUR', ${'refund_amendment_' + refundId}, true, true, now()
        )
      `;
    }
    return {
      ids,
      deps: makeDeps(),
      paymentId,
      paymentIntentId: initResult.providerPaymentIntentId,
      amount,
      refundIds,
    };
  }

  async function refundState(refundId: string) {
    if (!rawSql) throw new Error('DB non initialisée');
    return rawSql`
      SELECT status, provider_refund_id, provider_event_created_at FROM refunds WHERE id = ${refundId}
    `.then((rows) => rows[0]!);
  }

  // 1. Confirmation nominale
  it('1. payment_intent.succeeded → confirmation atomique, booking créé, outbox créé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'confirm-nominal');

    // Initier le paiement pour passer en PAYMENT_PROCESSING.
    const initDeps = makeInitDeps();
    const initInput = makeInitiateInput(ids, draftId, 'confirm-nominal');
    const initResult = await initiatePayment(initDeps, initInput);
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Construire le webhook succeeded.
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    expect(result.statusCode).toBe(200);

    // Vérifier que la réservation a été créée.
    const booking =
      await rawSql`SELECT id, status, draft_id, payment_id FROM bookings WHERE draft_id = ${draftId}`.then(
        (r) => r[0],
      );
    expect(booking).toBeDefined();
    expect(booking!.status).toBe('CONFIRMED');

    // Vérifier que le brouillon est CONVERTED.
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(draft!.status).toBe('CONVERTED');

    // Vérifier que le paiement est SUCCEEDED.
    const payment =
      await rawSql`SELECT status, succeeded_at FROM payments WHERE id = ${paymentId}`.then(
        (r) => r[0],
      );
    expect(payment!.status).toBe('SUCCEEDED');
    expect(payment!.succeeded_at).not.toBeNull();

    // Vérifier que les holds sont CONVERTED.
    const blocks =
      await rawSql`SELECT status, type FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD'`;
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.status).toBe('CONVERTED');

    // Vérifier qu'un nouveau bloc BOOKING/ACTIVE a été créé.
    const bookingBlocks =
      await rawSql`SELECT status, type, source_id FROM inventory_blocks WHERE source_id = ${booking!.id} AND type = 'BOOKING'`;
    expect(bookingBlocks.length).toBe(1);
    expect(bookingBlocks[0]!.status).toBe('ACTIVE');

    // Vérifier que l'outbox contient BOOKING_CONFIRMED.
    const outbox =
      await rawSql`SELECT event_type, event_version, aggregate_type, aggregate_id FROM outbox_events WHERE aggregate_id = ${booking!.id}`;
    expect(outbox.length).toBe(1);
    expect(outbox[0]!.event_type).toBe('BOOKING_CONFIRMED');
    expect(outbox[0]!.event_version).toBe('v1');

    // Vérifier que l'événement webhook est PROCESSED.
    const webhookEvent =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent.length).toBe(1);
    expect(webhookEvent[0]!.status).toBe('PROCESSED');
  });

  // 2. Doublon : même événement → une seule réservation
  it('2. webhook dupliqué : une seule réservation et un seul événement outbox', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'dup');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'dup'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    // Même corps → même event ID → doublon.
    const input = makeWebhookInput(body, deps.adapter);

    // Premier appel : confirmation.
    const result1 = await handleWebhook(deps, input);
    expect(result1.kind).toBe('SUCCESS');

    // Deuxième appel : doublon.
    const result2 = await handleWebhook(deps, input);
    expect(result2.kind).toBe('SUCCESS');

    // Une seule réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(1);

    // Un seul événement outbox.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id}`;
    expect(outbox.length).toBe(1);

    // Un seul événement webhook.
    const webhookEvents =
      await rawSql`SELECT id FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
  });

  // 3. payment_intent.payment_failed → REQUIRES_PAYMENT_METHOD, holds non libérés
  it('3. payment_intent.payment_failed → REQUIRES_PAYMENT_METHOD, holds conservés', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'failed');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'failed'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.payment_failed',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'requires_payment_method',
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Vérifier que le paiement est REQUIRES_PAYMENT_METHOD.
    const payment = await rawSql`SELECT status FROM payments WHERE draft_id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('REQUIRES_PAYMENT_METHOD');

    // Vérifier que le brouillon est toujours PAYMENT_PROCESSING (non libéré).
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(draft!.status).toBe('PAYMENT_PROCESSING');

    // Vérifier que les holds sont toujours PAYMENT_PROCESSING (non libérés).
    const blocks =
      await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD'`;
    expect(blocks[0]!.status).toBe('PAYMENT_PROCESSING');

    // Pas de réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);
  });

  // 4. payment_intent.canceled → CANCELLED, holds RELEASED
  it('4. payment_intent.canceled → brouillon CANCELLED, holds RELEASED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'canceled');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'canceled'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.canceled',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'canceled',
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Vérifier que le brouillon est CANCELLED.
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(draft!.status).toBe('CANCELLED');

    // Vérifier que les holds sont RELEASED.
    const blocks =
      await rawSql`SELECT id, status FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD'`;
    expect(blocks[0]!.status).toBe('RELEASED');

    // Vérifier que les allocations sont RELEASED.
    if (blocks.length > 0) {
      const allocs =
        await rawSql`SELECT status FROM allocations WHERE inventory_block_id = ${blocks[0]!.id}`;
      expect(allocs[0]!.status).toBe('RELEASED');
    }

    // Vérifier que le paiement est CANCELLED.
    const payment =
      await rawSql`SELECT status, cancelled_at FROM payments WHERE draft_id = ${draftId}`.then(
        (r) => r[0],
      );
    expect(payment!.status).toBe('CANCELLED');
    expect(payment!.cancelled_at).not.toBeNull();

    // Pas de réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);
  });

  // 5. payment_intent.processing → PROCESSING (projection monotone)
  it('5. payment_intent.processing → tentative et paiement PROCESSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'processing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'processing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Vérifier que la tentative est PROCESSING.
    const attempt =
      await rawSql`SELECT status FROM payment_attempts WHERE provider_payment_intent_id = ${piId}`.then(
        (r) => r[0],
      );
    expect(attempt!.status).toBe('PROCESSING');

    // Vérifier que le paiement est PROCESSING.
    const payment = await rawSql`SELECT status FROM payments WHERE draft_id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('PROCESSING');
  });

  // 6. Compensation tardive : brouillon EXPIRED + payment_intent.succeeded
  it('6. paiement tardif : compensation (refund PENDING + outbox), pas de réservation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'late');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'late'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    // Expirer le brouillon manuellement (simuler l'expiration).
    await rawSql`UPDATE booking_drafts SET status = 'EXPIRED' WHERE id = ${draftId}`;
    await rawSql`UPDATE inventory_blocks SET status = 'EXPIRED' WHERE source_id = ${draftId} AND type = 'HOLD'`;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = initResult.paymentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Pas de réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // Paiement SUCCEEDED.
    const payment =
      await rawSql`SELECT status, succeeded_at FROM payments WHERE id = ${paymentId}`.then(
        (r) => r[0],
      );
    expect(payment!.status).toBe('SUCCEEDED');
    expect(payment!.succeeded_at).not.toBeNull();

    // Refund PENDING avec reason LATE_PAYMENT_NO_BOOKING.
    const refund =
      await rawSql`SELECT status, reason, amount_minor, reverse_transfer, refund_application_fee FROM refunds WHERE payment_id = ${paymentId}`;
    expect(refund.length).toBe(1);
    expect(refund[0]!.status).toBe('PENDING');
    expect(refund[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refund[0]!.reverse_transfer).toBe(true);
    expect(refund[0]!.refund_application_fee).toBe(true);

    // Outbox PAYMENT_COMPENSATION_REQUESTED.
    const outbox =
      await rawSql`SELECT event_type FROM outbox_events WHERE aggregate_id = ${paymentId}`;
    expect(outbox.length).toBe(1);
    expect(outbox[0]!.event_type).toBe('PAYMENT_COMPENSATION_REQUESTED');
  });

  // 7. Événements désordonnés : succeeded puis processing → pas de régression
  it('7. événements désordonnés : succeeded puis processing → SUCCEEDED conservé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'disorder');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'disorder'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. succeeded → confirmation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: initResult.paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const result1 = await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));
    expect(result1.kind).toBe('SUCCESS');

    // 2. processing (désordonné) → ignoré, pas de régression.
    const bodyProcessing = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
    );
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyProcessing, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // Vérifier que la réservation existe toujours (pas de régression).
    const booking = await rawSql`SELECT status FROM bookings WHERE draft_id = ${draftId}`;
    expect(booking.length).toBe(1);
    expect(booking[0]!.status).toBe('CONFIRMED');

    // Le paiement reste SUCCEEDED.
    const payment = await rawSql`SELECT status FROM payments WHERE draft_id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('SUCCEEDED');
  });

  // 8. Multi-lignes : confirmation avec quantité > 1
  it('8. confirmation multi-exemplaires : 2 kayaks → 2 booking_items, 2 blocs BOOKING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'multi', 2);

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'multi'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: initResult.paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // 2 booking_items.
    const booking = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`.then(
      (r) => r[0]!,
    );
    const items =
      await rawSql`SELECT id, source_hold_block_id, booking_block_id FROM booking_items WHERE booking_id = ${booking.id}`;
    expect(items.length).toBe(2);

    // 2 blocs BOOKING/ACTIVE.
    const bookingBlocks =
      await rawSql`SELECT id FROM inventory_blocks WHERE source_id = ${booking.id} AND type = 'BOOKING'`;
    expect(bookingBlocks.length).toBe(2);

    // 2 holds CONVERTED.
    const holdBlocks =
      await rawSql`SELECT id FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD' AND status = 'CONVERTED'`;
    expect(holdBlocks.length).toBe(2);
  });

  // 9. Signature invalide → 400, aucune écriture
  it('9. signature invalide → 400, aucune écriture métier', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'badsig');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'badsig'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.succeeded',
      initResult.providerPaymentIntentId,
      10000,
    );
    const input: WebhookHandlerInput = {
      rawBody: body,
      signature: 't=123,v1=invalidsignature',
      endpoint: 'platform',
      environment: 'TEST',
    };

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('FAILURE');
    if (result.kind === 'FAILURE') {
      expect(result.statusCode).toBe(400);
    }

    // Aucune réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // Aucun événement webhook.
    const webhookEvents =
      await rawSql`SELECT id FROM payment_webhook_events WHERE provider_object_id = ${initResult.providerPaymentIntentId}`;
    expect(webhookEvents.length).toBe(0);
  });

  // 10. account.updated sur Connect → dédupliqué et PROCESSED
  it('10. account.updated (Connect) → dédupliqué et PROCESSED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();
    const body = JSON.stringify({
      id: `evt_acct_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
        },
      },
    });
    const input = makeWebhookInput(body, deps.adapter, 'connect');

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // L'événement webhook est PROCESSED.
    const webhookEvent =
      await rawSql`SELECT status, organization_id FROM payment_webhook_events WHERE event_type = 'account.updated'`;
    expect(webhookEvent.length).toBe(1);
    expect(webhookEvent[0]!.status).toBe('PROCESSED');
    expect(webhookEvent[0]!.organization_id).toBe(ids.orgId);

    // Doublon → 200 sans nouvelle ligne.
    const result2 = await handleWebhook(deps, input);
    expect(result2.kind).toBe('SUCCESS');
    const webhookEvents2 =
      await rawSql`SELECT id FROM payment_webhook_events WHERE event_type = 'account.updated'`;
    expect(webhookEvents2.length).toBe(1);
  });

  // 11. Événement non rattachable (aucune tentative) → 200, pas de ligne métier
  it('11. événement non rattachable → 200, aucune réservation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);

    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', 'pi_unknown_123', 10000);
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Aucune réservation.
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
  });

  // 12. Isolation multi-tenant : événement d'un autre tenant non traité
  it('12. isolation multi-tenant : événement non rattachable ne crée pas de réservation cross-tenant', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('tenant1');
    await seedPaymentAccount(ids1);
    const ids2 = await seedBaseData('tenant2');
    await seedPaymentAccount(ids2, 'acct_test_456');

    const draftId1 = await createHeldDraft(ids1, 'tenant1');
    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids1, draftId1, 'tenant1'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    // Webhook avec un PI ID qui n'existe dans aucune tentative.
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', 'pi_nonexistent', 10000);
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
  });

  // 13. Multi-tenant : webhook avec metadata d'une autre organisation → rejet
  it("13. multi-tenant : webhook succeeded avec metadata organization_id d'une autre org → WEBHOOK_ORGANIZATION_MISMATCH", async () => {
    if (!db || !rawSql) return;
    const idsA = await seedBaseData('orga');
    await seedPaymentAccount(idsA);
    const idsB = await seedBaseData('orgb');
    await seedPaymentAccount(idsB, 'acct_test_456');

    // Initier un paiement pour orgA.
    const draftIdA = await createHeldDraft(idsA, 'orgA');
    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(idsA, draftIdA, 'orgA'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftIdA);
    const amount = await getPaymentAmount(draftIdA);

    // Webhook succeeded avec le PI ID d'orgA MAIS metadata.organization_id = orgB.
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftIdA,
      organization_id: idsB.orgId, // ← organisation B (mismatch)
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Organization mismatch est irréconciliable → SUCCESS 200 (pas 500)
    // pour arrêter les retries Stripe. L'événement est marqué FAILED.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée pour orgA ni orgB.
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_ORGANIZATION_MISMATCH');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tests de concurrence déterministes (ADR-010 §15)
  // ─────────────────────────────────────────────────────────────────────────────

  // 14. Doublon concurrent sur le même event_id : deux appels simultanés
  it('14. concurrence : deux webhooks simultanés sur le même event_id → une seule réservation', async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData('conc-dup');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conc-dup');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'conc-dup'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    // Même corps → même event ID → les deux appels partagent le même event_id.
    const input = makeWebhookInput(body, deps.adapter);

    // Deux appels simultanés via Promise.all.
    const [result1, result2] = await Promise.all([
      handleWebhook(deps, input),
      handleWebhook(deps, input),
    ]);

    // Les deux retournent 200 (un SUCCESS traité, l'autre doublon).
    expect(result1.kind).toBe('SUCCESS');
    expect(result2.kind).toBe('SUCCESS');

    // Exactement UNE réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(1);

    // Un seul ensemble d'événements outbox.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id}`;
    expect(outbox.length).toBe(1);

    // Un seul événement webhook.
    const webhookEvents =
      await rawSql`SELECT id FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
  });

  // 15. Webhook contre worker d'expiration : webhook verrouille le draft, batch SKIP LOCKED l'ignore
  it("15. concurrence : webhook verrouille le draft, batch d'expiration SKIP LOCKED l'ignore", async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData('conc-expire');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conc-expire');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'conc-expire'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Expirer le draft dans un futur proche selon l'horloge PostgreSQL.
    const expiryResult =
      await rawSql`SELECT (now() + interval '200 milliseconds')::timestamptz AS expiry`;
    const expiryIso = expiryResult[0]!.expiry.toISOString();
    await rawSql`UPDATE "booking_drafts" SET "expires_at" = ${expiryIso} WHERE "id" = ${draftId}`;
    await rawSql`UPDATE "inventory_blocks" SET "expires_at" = ${expiryIso} WHERE "source_id" = ${draftId}`;

    const sentinelKey = 98770;

    // Trigger: blocks on pg_advisory_xact_lock during UPDATE on booking_drafts.
    // Le webhook fait SELECT FOR UPDATE sur booking_drafts, puis UPDATE (trigger bloque).
    await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_webhook_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await rawSql.unsafe(`
      CREATE TRIGGER test_block_webhook_trigger
      BEFORE UPDATE ON booking_drafts
      FOR EACH ROW
      WHEN (NEW.id = '${draftId}'::uuid)
      EXECUTE FUNCTION test_block_webhook_update()
    `);

    // Sentinel connection holds the session-level lock.
    const sentinelConn = postgres(ctx.databaseUrl, { max: 1 });
    await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

    const db2 = createDatabase(ctx.databaseUrl);
    try {
      const deps = makeDeps();
      const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      });
      const input = makeWebhookInput(body, deps.adapter);

      // Start webhook — TX will SELECT FOR UPDATE, then UPDATE (trigger fires, blocks).
      const webhookPromise = handleWebhook(deps, input);

      // 1. Poll pg_locks until the advisory lock waiter appears.
      //    This PROVES the webhook reached the trigger and is blocked.
      await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

      // 2. Wait for PostgreSQL's clock to pass the expiry.
      await waitForPgTimePast(rawSql, expiryIso);

      // While the webhook is blocked (holding the FOR UPDATE lock), run the batch.
      // Le batch voit expires_at < now() → true, tente SELECT FOR UPDATE SKIP LOCKED,
      // et saute la ligne car le webhook détient le verrou.
      const expireResult = await expireBookingDraftsBatch(db2);
      expect(expireResult.expiredCount).toBe(0);

      // Release the sentinel — webhook's trigger unblocks, webhook commits.
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

      // Wait for webhook to complete.
      const webhookResult = await webhookPromise;
      expect(webhookResult.kind).toBe('SUCCESS');

      // Final state: CONVERTED (webhook a confirmé la réservation).
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('CONVERTED');

      // Une réservation créée.
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(1);
    } finally {
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
      await sentinelConn.end();
      await db2.$client.end();
      await rawSql`DROP TRIGGER IF EXISTS test_block_webhook_trigger ON booking_drafts`;
      await rawSql`DROP FUNCTION IF EXISTS test_block_webhook_update()`;
    }
  });

  // 16. Rollback complet sur invariant brisé : modification du montant après initiation
  it('16. rollback complet : montant modifié après initiation → aucune écriture partielle', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('rollback');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'rollback');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'rollback'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Modifier le montant du payment APRÈS initiation mais AVANT webhook.
    // Cela brise l'invariant montant == piData.amount.
    const tamperedAmount = amount + 999;
    await rawSql`UPDATE "payments" SET "amount_minor" = ${tamperedAmount} WHERE "id" = ${paymentId}`;

    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Amount mismatch est irréconciliable → SUCCESS 200 (pas 500) pour
    // arrêter les retries Stripe. L'événement est marqué FAILED avec failure_code.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune ligne bookings/booking_lines/booking_items créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    const bookingLines = await rawSql`SELECT id FROM booking_lines`;
    expect(bookingLines.length).toBe(0);

    const bookingItems = await rawSql`SELECT id FROM booking_items`;
    expect(bookingItems.length).toBe(0);

    // Aucune ligne outbox orpheline.
    const outbox = await rawSql`SELECT id FROM outbox_events WHERE aggregate_type = 'BOOKING'`;
    expect(outbox.length).toBe(0);

    // Le brouillon reste PAYMENT_PROCESSING (non converti).
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

    // Les holds restent PAYMENT_PROCESSING (non convertis).
    const blocks =
      await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD'`;
    expect(blocks[0]!.status).toBe('PAYMENT_PROCESSING');

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_AMOUNT_MISMATCH');
  });

  // 17. destination mismatch : transfer_data.destination ≠ connectedAccountId du paiement
  it('17. destination mismatch : transfer_data.destination ≠ connectedAccountId → WEBHOOK_DESTINATION_MISMATCH, rollback complet', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('dest-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'dest-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'dest-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Le paiement a connectedAccountId = 'acct_test_123' (via seedPaymentAccount + financialTermsConfig).
    // On envoie une destination différente pour briser l'invariant.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { destination: 'acct_other' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Destination mismatch est irréconciliable → SUCCESS 200 (pas 500).
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée (rollback complet).
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    const bookingLines = await rawSql`SELECT id FROM booking_lines`;
    expect(bookingLines.length).toBe(0);

    const bookingItems = await rawSql`SELECT id FROM booking_items`;
    expect(bookingItems.length).toBe(0);

    // Aucun événement outbox BOOKING_CONFIRMED.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_type = 'BOOKING' AND event_type = 'BOOKING_CONFIRMED'`;
    expect(outbox.length).toBe(0);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_DESTINATION_MISMATCH');
  });

  // 18. commission mismatch : application_fee_amount ≠ commissionAmountMinor du paiement
  it('18. commission mismatch : application_fee_amount ≠ commissionAmountMinor → WEBHOOK_INVARIANT_BROKEN, rollback complet', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('commission-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'commission-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'commission-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Le paiement a commissionAmountMinor = 500 (via financialTermsConfig).
    // On envoie 999 pour briser l'invariant.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { applicationFeeAmount: 999 },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Commission mismatch est irréconciliable → SUCCESS 200 (pas 500).
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée (rollback complet).
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    const bookingLines = await rawSql`SELECT id FROM booking_lines`;
    expect(bookingLines.length).toBe(0);

    const bookingItems = await rawSql`SELECT id FROM booking_items`;
    expect(bookingItems.length).toBe(0);

    // Aucun événement outbox BOOKING_CONFIRMED.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_type = 'BOOKING' AND event_type = 'BOOKING_CONFIRMED'`;
    expect(outbox.length).toBe(0);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // 19. on_behalf_of mismatch : on_behalf_of non null alors que le paiement n'en a pas
  it('19. on_behalf_of mismatch : on_behalf_of non null alors que paiement local est null → WEBHOOK_INVARIANT_BROKEN, rollback complet', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('onbehalf-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'onbehalf-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'onbehalf-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Le paiement a onBehalfOfAccountId = null (via financialTermsConfig).
    // On envoie 'acct_other' pour briser l'invariant.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { onBehalfOf: 'acct_other' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : on_behalf_of mismatch est irréconciliable → SUCCESS 200 (pas 500).
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée (rollback complet).
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    const bookingLines = await rawSql`SELECT id FROM booking_lines`;
    expect(bookingLines.length).toBe(0);

    const bookingItems = await rawSql`SELECT id FROM booking_items`;
    expect(bookingItems.length).toBe(0);

    // Aucun événement outbox BOOKING_CONFIRMED.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_type = 'BOOKING' AND event_type = 'BOOKING_CONFIRMED'`;
    expect(outbox.length).toBe(0);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tests P1/P2 — Phase 6 (ADR-010 §10, §13, §14, §15)
  // ─────────────────────────────────────────────────────────────────────────────

  // 20. Deux event.id distincts, même PI succeeded → une seule réservation, second IGNORED
  it('20. deux event.id distincts pour le même PaymentIntent succeeded → une seule réservation, second événement IGNORED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('dup-distinct');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'dup-distinct');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'dup-distinct'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // Premier événement succeeded → confirmation.
    const body1 = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { eventId: 'evt_distinct_1' },
    );
    const result1 = await handleWebhook(deps, makeWebhookInput(body1, deps.adapter));
    expect(result1.kind).toBe('SUCCESS');

    // Second événement succeeded avec un event.id DIFFÉREENT pour le même PI.
    const body2 = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { eventId: 'evt_distinct_2' },
    );
    const result2 = await handleWebhook(deps, makeWebhookInput(body2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // Une seule réservation.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(1);

    // Un seul événement outbox.
    const outbox =
      await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id}`;
    expect(outbox.length).toBe(1);

    // Deux événements webhook persistés : le premier PROCESSED, le second IGNORED.
    const webhookEvents =
      await rawSql`SELECT provider_event_id, status FROM payment_webhook_events WHERE provider_object_id = ${piId} ORDER BY provider_event_id`;
    expect(webhookEvents.length).toBe(2);
    expect(webhookEvents[0]!.provider_event_id).toBe('evt_distinct_1');
    expect(webhookEvents[0]!.status).toBe('PROCESSED');
    expect(webhookEvents[1]!.provider_event_id).toBe('evt_distinct_2');
    expect(webhookEvents[1]!.status).toBe('IGNORED');
  });

  // 21. processing récent (t2) puis payment_failed ancien (t1 < t2) → ancien IGNORED
  it('21. événements désordonnés : processing récent (t2) puis payment_failed ancien (t1) → ancien IGNORED, tentative reste PROCESSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('stale');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'stale');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'stale'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. processing récent (t2) → traité, tentative PROCESSING.
    const t2 = Math.floor(Date.now() / 1000);
    const bodyProcessing = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
      { eventId: 'evt_proc_t2', created: t2 },
    );
    const result1 = await handleWebhook(deps, makeWebhookInput(bodyProcessing, deps.adapter));
    expect(result1.kind).toBe('SUCCESS');

    // Vérifier que la tentative est PROCESSING.
    const attemptAfterProc =
      await rawSql`SELECT status FROM payment_attempts WHERE provider_payment_intent_id = ${piId}`.then(
        (r) => r[0],
      );
    expect(attemptAfterProc!.status).toBe('PROCESSING');

    // 2. payment_failed ancien (t1 < t2) → IGNORED, pas de régression.
    const t1 = t2 - 60; // 60 secondes plus ancien.
    const bodyFailed = makeWebhookPayload(
      'payment_intent.payment_failed',
      piId,
      amount,
      {
        payment_id: initResult.paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'requires_payment_method',
      { eventId: 'evt_failed_t1', created: t1 },
    );
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyFailed, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // La tentative reste PROCESSING (pas de régression vers REQUIRES_PAYMENT_METHOD).
    const attemptAfterFailed =
      await rawSql`SELECT status FROM payment_attempts WHERE provider_payment_intent_id = ${piId}`.then(
        (r) => r[0],
      );
    expect(attemptAfterFailed!.status).toBe('PROCESSING');

    // L'événement ancien est IGNORED.
    const staleEvent =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_event_id = 'evt_failed_t1'`;
    expect(staleEvent[0]!.status).toBe('IGNORED');
  });

  // 22. Succès depuis HELD/ACTIVE → refusé, aucune réservation
  it('22. succès depuis HELD/ACTIVE → refusé (WEBHOOK_DRAFT_NOT_PROCESSING ou WEBHOOK_INVARIANT_BROKEN), aucune réservation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('held-active');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'held-active');

    // Ne PAS initier le paiement — le draft reste HELD, les blocks restent ACTIVE.
    // Construire un PI ID fictif et un webhook succeeded.
    const deps = makeDeps();
    const piId = 'pi_held_test_123';
    const amount = 10000;

    // Insérer manuellement un payment + payment_attempt avec ce PI ID pour que resolveAttempt le trouve.
    // Sans initiatePayment, il n'y a pas de payment ni de payment_attempt.
    // On doit donc simuler : créer un payment + attempt avec le draft en HELD.
    await rawSql`
      INSERT INTO "payments" (
        "id", "organization_id", "draft_id", "customer_user_id", "status",
        "amount_minor", "currency", "tax_status", "commission_amount_minor",
        "commission_rule_snapshot", "financial_terms_version", "legal_terms_version",
        "terms_acceptance_snapshot", "connected_account_id", "charge_model",
        "settlement_merchant_mode", "environment"
      ) VALUES (
        gen_random_uuid(), ${ids.orgId}, ${draftId}, ${ids.userId}, 'PENDING_PROVIDER',
        ${amount}, 'EUR', 'NOT_APPLICABLE', 500,
        ${rawSql.json({ version: 'v1', basis: 'percentage', amountMinor: 500 })}, 'v1', 'v1',
        ${rawSql.json({ termsVersion: 'v1', userId: ids.userId, acceptedAt: new Date().toISOString() })},
        'acct_test_123', 'DESTINATION', 'PLATFORM', 'TEST'
      )
    `;
    const newPaymentId = await getPaymentId(draftId);
    await rawSql`
      INSERT INTO "payment_attempts" (
        "id", "organization_id", "payment_id", "attempt_number", "status",
        "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
      ) VALUES (
        gen_random_uuid(), ${ids.orgId}, ${newPaymentId}, 1, 'PENDING_PROVIDER',
        ${piId}, ${'idem_held_' + draftId}, 'requires_payment_method'
      )
    `;

    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: newPaymentId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Draft HELD est WEBHOOK_DRAFT_NOT_PROCESSING (irréconciliable) →
    // SUCCESS 200 (pas 500) pour arrêter les retries Stripe.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // Le brouillon reste HELD.
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
      (r) => r[0],
    );
    expect(draft!.status).toBe('HELD');

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(['WEBHOOK_DRAFT_NOT_PROCESSING', 'WEBHOOK_INVARIANT_BROKEN']).toContain(
      webhookEvent[0]!.failure_code,
    );
  });

  // 23. Payment/attempt terminaux incohérents (payment SUCCEEDED, attempt CANCELLED) → événement FAILED
  it('23. payment/attempt terminaux incohérents (payment SUCCEEDED, attempt CANCELLED) → événement FAILED, aucune mutation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('incoherent');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'incoherent');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'incoherent'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Créer une incohérence : payment SUCCEEDED mais attempt CANCELLED.
    await rawSql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'CANCELLED' WHERE "id" = ${initResult.paymentAttemptId}`;

    // Envoyer un événement canceled — la projection monotone devrait détecter l'incohérence.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.canceled',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'canceled',
      { eventId: 'evt_cancel_incoherent' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Le webhook doit retourner SUCCESS (200) car l'incohérence terminale
    // est un invariant brisé irréconciliable. L'événement est marqué FAILED avec
    // failure_code, et 2xx est retourné pour arrêter les retries Stripe.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Le payment reste SUCCEEDED (pas de régression).
    const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('SUCCEEDED');

    // La tentative reste CANCELLED (pas de régression).
    const attempt =
      await rawSql`SELECT status FROM payment_attempts WHERE id = ${initResult.paymentAttemptId}`.then(
        (r) => r[0],
      );
    expect(attempt!.status).toBe('CANCELLED');

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // L'événement webhook est marqué FAILED (P1-2) avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_cancel_incoherent'`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // 24. canceled après draft terminal (CONVERTED) → événement PROCESSED/IGNORED, payment/attempt en cohérence
  it('24. canceled après draft CONVERTED → événement PROCESSED, payment/attempt remis en cohérence si nécessaire', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('cancel-after-converted');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'cancel-after-converted');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'cancel-after-converted'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. succeeded → confirmation (draft devient CONVERTED).
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const result1 = await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));
    expect(result1.kind).toBe('SUCCESS');

    // Vérifier que le draft est CONVERTED.
    const draftAfterConfirm =
      await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then((r) => r[0]);
    expect(draftAfterConfirm!.status).toBe('CONVERTED');

    // 2. canceled (désordonné) après CONVERTED → PROCESSED, pas de mutation du draft.
    const bodyCanceled = makeWebhookPayload(
      'payment_intent.canceled',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'canceled',
      { eventId: 'evt_cancel_after_converted' },
    );
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyCanceled, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // Le draft reste CONVERTED (pas de régression vers CANCELLED).
    const draftAfterCancel =
      await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then((r) => r[0]);
    expect(draftAfterCancel!.status).toBe('CONVERTED');

    // Le payment reste SUCCEEDED.
    const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('SUCCEEDED');

    // La réservation existe toujours.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(1);

    // L'événement canceled est PROCESSED (ignoré car draft terminal).
    const cancelEvent =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_event_id = 'evt_cancel_after_converted'`;
    expect(cancelEvent[0]!.status).toBe('PROCESSED');
  });

  // 25. Faux PaymentIntent utilisant un payment_attempt_id valide dans metadata → doit échouer
  it('25. faux PaymentIntent avec payment_attempt_id valide mais PI ID différent → échec (WEBHOOK_AGGREGATE_INCONSISTENT)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('fake-pi');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'fake-pi');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'fake-pi'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const realPiId = initResult.providerPaymentIntentId;
    const fakePiId = 'pi_fake_malicious_123';
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // Le webhook utilise un faux PI ID mais le payment_attempt_id réel dans metadata.
    // resolveAttempt trouve la tentative par metadata.payment_attempt_id.
    // Ensuite, validateWebhookAuthority vérifie que attemptRow.providerPaymentIntentId === piData.id.
    // Comme le PI ID ne correspond pas, la validation doit échouer.
    const body = makeWebhookPayload('payment_intent.succeeded', fakePiId, amount, {
      payment_id: initResult.paymentId,
      payment_attempt_id: initResult.paymentAttemptId, // ← attempt valide
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : PI ID mismatch est WEBHOOK_AGGREGATE_INCONSISTENT (irréconciliable)
    // → SUCCESS 200 (pas 500) pour arrêter les retries Stripe.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // Le vrai PI ID n'a pas été affecté.
    const attempt =
      await rawSql`SELECT provider_payment_intent_id FROM payment_attempts WHERE id = ${initResult.paymentAttemptId}`.then(
        (r) => r[0],
      );
    expect(attempt!.provider_payment_intent_id).toBe(realPiId);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${fakePiId}`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 26. Refund platform avec event.accountId = null mais payment_intent présent → événement persisté, refund projeté
  it('26. refund platform avec event.accountId = null mais payment_intent présent → événement persisté, refund projeté', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-platform');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-platform');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-platform'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation d'abord.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer un événement charge.refunded avec event.accountId = null mais payment_intent présent.
    // Structure conforme au contrat Stripe réel : charge.refunds = ApiList<Refund> avec data = Refund[].
    const refundId = 're_test_refund_123';
    const body = JSON.stringify({
      id: `evt_refund_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      // Pas de champ "account" → event.accountId = null.
      data: {
        object: {
          id: 'ch_test_charge_123',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
            url: '/v1/charges/ch_test_charge_123/refunds',
          },
        },
      },
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // L'événement webhook doit être persisté (pas de skip).
    const webhookEvents =
      await rawSql`SELECT status, organization_id FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('PROCESSED');
    expect(webhookEvents[0]!.organization_id).toBe(ids.orgId);

    // Le refund doit être projeté dans la table refunds.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, amount_minor FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.status).toBe('SUCCEEDED');
    expect(Number(refundRows[0]!.amount_minor)).toBe(amount);
  });

  it('26bis. refund BOOKING_MODIFICATION tagué par metadata → projection par refund_id sans EXTERNAL_REFUND', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-tagged');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-tagged');
    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-tagged'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();
    const succeeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: initResult.paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(succeeded, deps.adapter));

    const refundId = '77777777-7777-4777-8777-777777777777';
    await rawSql`
      INSERT INTO refunds (
        id, organization_id, payment_id, reason, status, amount_minor, currency,
        provider_idempotency_key, reverse_transfer, refund_application_fee, requested_at
      ) VALUES (
        ${refundId}, ${ids.orgId}, ${paymentId}, 'BOOKING_MODIFICATION', 'PENDING', ${amount}, 'EUR',
        ${'refund_amendment_' + refundId}, true, true, now()
      )
    `;

    const body = makeChargeRefundedBody({
      eventId: 'evt_refund_tagged_success',
      created: 1_900_000_000,
      chargeId: 'ch_refund_tagged',
      paymentIntentId: piId,
      refundId: 're_refund_tagged_success',
      refundStatus: 'succeeded',
      amount,
      metadata: {
        refund_id: refundId,
        organization_id: ids.orgId,
        protocol_version: 'refund-requested-v1',
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    const projected = await rawSql`
      SELECT status, provider_refund_id, provider_event_created_at
      FROM refunds WHERE id = ${refundId}
    `;
    expect(projected[0]!['status']).toBe('SUCCEEDED');
    expect(projected[0]!['provider_refund_id']).toBe('re_refund_tagged_success');
    expect(Number(projected[0]!['provider_event_created_at'])).toBe(1_900_000_000);
    const external = await rawSql`
      SELECT count(*) FROM refunds
      WHERE reason = 'EXTERNAL_REFUND' AND provider_refund_id = 're_refund_tagged_success'
    `;
    expect(Number(external[0]!['count'])).toBe(0);
  });

  it('G7M-B2-B2A webhook direct refund.created : metadata exacte et allow-list sans fuite', async () => {
    if (!rawSql) throw new Error('DB non initialisée');
    const fixture = await seedTaggedRefundFixture('direct-created');
    const body = makeDirectRefundBody({
      eventId: 'evt_b2b2a_direct_created',
      eventType: 'refund.created',
      created: 1_910_000_000,
      refundId: 're_b2b2a_direct_created',
      paymentIntentId: fixture.paymentIntentId,
      refundStatus: 'succeeded',
      amount: fixture.amount,
      metadata: {
        refund_id: fixture.refundIds[0]!,
        organization_id: fixture.ids.orgId,
        protocol_version: 'refund-requested-v1',
        payment_id: fixture.paymentId,
        secret_extra: 'strip-me',
      },
    });
    const result = await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
    expect(result.kind).toBe('SUCCESS');
    expect((await refundState(fixture.refundIds[0]!)).status).toBe('SUCCEEDED');
    const event = await rawSql`
      SELECT normalized_payload FROM payment_webhook_events WHERE provider_event_id = 'evt_b2b2a_direct_created'
    `.then((rows) => rows[0]!);
    expect(event.normalized_payload.object.metadata).toEqual({
      refund_id: fixture.refundIds[0],
      organization_id: fixture.ids.orgId,
      protocol_version: 'refund-requested-v1',
    });
  });

  it('G7M-B2-B2A charge.refunded imbriqué : metadata refund_id choisit exactement le bon refund', async () => {
    if (!rawSql) throw new Error('DB non initialisée');
    const fixture = await seedTaggedRefundFixture('nested-two', 2);
    const targetRefundId = fixture.refundIds[1]!;
    const body = makeChargeRefundedBody({
      eventId: 'evt_b2b2a_nested_two',
      created: 1_910_000_001,
      chargeId: 'ch_b2b2a_nested_two',
      paymentIntentId: fixture.paymentIntentId,
      refundId: 're_b2b2a_nested_two',
      refundStatus: 'succeeded',
      amount: fixture.amount,
      metadata: {
        refund_id: targetRefundId,
        organization_id: fixture.ids.orgId,
        protocol_version: 'refund-requested-v1',
      },
    });
    const result = await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
    expect(result.kind).toBe('SUCCESS');
    expect((await refundState(targetRefundId)).status).toBe('SUCCEEDED');
    expect((await refundState(fixture.refundIds[0]!)).status).toBe('PENDING');
    const external = await rawSql`
      SELECT count(*) FROM refunds WHERE reason = 'EXTERNAL_REFUND'
    `.then((rows) => rows[0]!);
    expect(Number(external.count)).toBe(0);
  });

  it.each([
    ['wrong refund_id', () => ({ refund_id: randomUUID() })],
    ['wrong organization_id', () => ({ organization_id: randomUUID() })],
    ['wrong protocol', () => ({ protocol_version: 'refund-requested-v0' })],
    ['incomplete metadata', () => ({ refund_id: randomUUID(), organization_id: randomUUID() })],
  ])(
    'G7M-B2-B2A metadata forgée ou incomplète (%s) : aucune projection ni EXTERNAL_REFUND',
    async (_label, makeMetadata) => {
      if (!rawSql) throw new Error('DB non initialisée');
      const fixture = await seedTaggedRefundFixture(
        'invalid-meta-' + Math.random().toString(36).slice(2, 6),
      );
      const body = makeDirectRefundBody({
        eventId: `evt_b2b2a_invalid_meta_${randomUUID()}`,
        created: 1_910_000_010,
        refundId: 're_b2b2a_invalid_meta',
        paymentIntentId: fixture.paymentIntentId,
        refundStatus: 'succeeded',
        amount: fixture.amount,
        metadata: makeMetadata(),
      });
      const result = await handleWebhook(
        fixture.deps,
        makeWebhookInput(body, fixture.deps.adapter),
      );
      expect(result.kind).toBe('SUCCESS');
      expect((await refundState(fixture.refundIds[0]!)).status).toBe('PENDING');
      const external = await rawSql`
      SELECT count(*) FROM refunds WHERE reason = 'EXTERNAL_REFUND'
    `.then((rows) => rows[0]!);
      expect(Number(external.count)).toBe(0);
    },
  );

  it.each([
    ['payment intent', { paymentIntentId: 'pi_forged_b2b2a' }],
    ['amount', { amount: 1 }],
    ['currency', { currency: 'usd' }],
  ] as Array<[string, { paymentIntentId?: string; amount?: number; currency?: string }]>)(
    'G7M-B2-B2A incohérence financière (%s) : aucune mutation du refund taggé',
    async (_label, override) => {
      if (!rawSql) throw new Error('DB non initialisée');
      const fixture = await seedTaggedRefundFixture(
        'invalid-financial-' + Math.random().toString(36).slice(2, 6),
      );
      const body = makeDirectRefundBody({
        eventId: `evt_b2b2a_invalid_financial_${randomUUID()}`,
        created: 1_910_000_020,
        refundId: 're_b2b2a_invalid_financial',
        paymentIntentId: override.paymentIntentId ?? fixture.paymentIntentId,
        refundStatus: 'succeeded',
        amount: override.amount ?? fixture.amount,
        ...(override.currency === undefined ? {} : { currency: override.currency }),
        metadata: {
          refund_id: fixture.refundIds[0]!,
          organization_id: fixture.ids.orgId,
          protocol_version: 'refund-requested-v1',
        },
      });
      const result = await handleWebhook(
        fixture.deps,
        makeWebhookInput(body, fixture.deps.adapter),
      );
      expect(result.kind).toBe('SUCCESS');
      expect((await refundState(fixture.refundIds[0]!)).status).toBe('PENDING');
    },
  );

  it.each(['failed', 'canceled'] as const)(
    'G7M-B2-B2A %s → FAILED_REQUIRES_MANUAL_ACTION',
    async (refundStatus) => {
      const fixture = await seedTaggedRefundFixture(`failed-${refundStatus}`);
      const body = makeDirectRefundBody({
        eventId: `evt_b2b2a_${refundStatus}`,
        created: 1_910_000_030,
        refundId: `re_b2b2a_${refundStatus}`,
        paymentIntentId: fixture.paymentIntentId,
        refundStatus,
        amount: fixture.amount,
        metadata: {
          refund_id: fixture.refundIds[0]!,
          organization_id: fixture.ids.orgId,
          protocol_version: 'refund-requested-v1',
        },
      });
      const result = await handleWebhook(
        fixture.deps,
        makeWebhookInput(body, fixture.deps.adapter),
      );
      expect(result.kind).toBe('SUCCESS');
      expect((await refundState(fixture.refundIds[0]!)).status).toBe(
        'FAILED_REQUIRES_MANUAL_ACTION',
      );
    },
  );

  it('G7M-B2-B2A pending/requires_action ne régresse pas SUBMITTED', async () => {
    if (!rawSql) throw new Error('DB non initialisée');
    const fixture = await seedTaggedRefundFixture('pending-submitted');
    await rawSql`
      UPDATE refunds SET status = 'SUBMITTED', provider_refund_id = 're_b2b2a_pending_existing', submitted_at = now()
      WHERE id = ${fixture.refundIds[0]!}
    `;
    const body = makeDirectRefundBody({
      eventId: 'evt_b2b2a_pending_submitted',
      created: 1_910_000_040,
      refundId: 're_b2b2a_pending_existing',
      paymentIntentId: fixture.paymentIntentId,
      refundStatus: 'requires_action',
      amount: fixture.amount,
      metadata: {
        refund_id: fixture.refundIds[0]!,
        organization_id: fixture.ids.orgId,
        protocol_version: 'refund-requested-v1',
      },
    });
    await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
    expect((await refundState(fixture.refundIds[0]!)).status).toBe('SUBMITTED');
  });

  it.each(['SUCCEEDED', 'FAILED_REQUIRES_MANUAL_ACTION', 'SETTLED_OFF_PLATFORM'] as const)(
    'G7M-B2-B2A protège le terminal %s',
    async (status) => {
      if (!rawSql) throw new Error('DB non initialisée');
      const fixture = await seedTaggedRefundFixture(
        `terminal-${status.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      );
      if (status === 'SETTLED_OFF_PLATFORM') {
        await rawSql`
          UPDATE refunds
          SET status = 'FAILED_REQUIRES_MANUAL_ACTION', failed_at = now(), failure_code = 'MANUAL'
          WHERE id = ${fixture.refundIds[0]!}
        `;
        await rawSql`
          UPDATE refunds SET status = 'SETTLED_OFF_PLATFORM', settled_off_platform_at = now(),
            settled_off_platform_by = ${fixture.ids.userId}, settlement_notes = 'terminal protection test'
          WHERE id = ${fixture.refundIds[0]!}
        `;
      } else if (status === 'SUCCEEDED') {
        await rawSql`UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = ${fixture.refundIds[0]!}`;
      } else {
        await rawSql`UPDATE refunds SET status = 'FAILED_REQUIRES_MANUAL_ACTION', failed_at = now() WHERE id = ${fixture.refundIds[0]!}`;
      }
      const body = makeDirectRefundBody({
        eventId: `evt_b2b2a_terminal_${status}`,
        created: 1_910_000_050,
        refundId: `re_b2b2a_terminal_${status}`,
        paymentIntentId: fixture.paymentIntentId,
        refundStatus: 'pending',
        amount: fixture.amount,
        metadata: {
          refund_id: fixture.refundIds[0]!,
          organization_id: fixture.ids.orgId,
          protocol_version: 'refund-requested-v1',
        },
      });
      await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
      expect((await refundState(fixture.refundIds[0]!)).status).toBe(status);
    },
  );

  it('G7M-B2-B2A webhook avant worker final : projette le refund local sans EXTERNAL_REFUND', async () => {
    if (!rawSql) throw new Error('DB non initialisée');
    const fixture = await seedTaggedRefundFixture('race-before-worker');
    const body = makeDirectRefundBody({
      eventId: 'evt_b2b2a_before_worker',
      created: 1_910_000_060,
      refundId: 're_b2b2a_before_worker',
      paymentIntentId: fixture.paymentIntentId,
      refundStatus: 'succeeded',
      amount: fixture.amount,
      metadata: {
        refund_id: fixture.refundIds[0]!,
        organization_id: fixture.ids.orgId,
        protocol_version: 'refund-requested-v1',
      },
    });
    await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
    const current = await refundState(fixture.refundIds[0]!);
    expect(current.status).toBe('SUCCEEDED');
    expect(current.provider_refund_id).toBe('re_b2b2a_before_worker');
  });

  it('G7M-B2-B2A webhook après worker : confirme le provider_refund_id sans régression', async () => {
    if (!db || !rawSql) throw new Error('DB non initialisée');
    const fixture = await seedTaggedRefundFixture('race-after-worker');
    const booking = await rawSql`
      SELECT id FROM bookings WHERE payment_id = ${fixture.paymentId}
    `.then((rows) => rows[0]!);
    const amendmentId = await rawSql`
      INSERT INTO booking_amendments (
        organization_id, booking_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at,
        new_blocked_start_at, new_blocked_end_at, created_by
      ) VALUES (
        ${fixture.ids.orgId}, ${booking.id}, 1, 'REFUND', 'READY_TO_APPLY',
        ${rawSql.json({ total_amount_minor: fixture.amount })}, ${rawSql.json({ total_amount_minor: 0 })},
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${fixture.ids.userId}
      ) RETURNING id
    `.then((rows) => rows[0]!.id);
    await rawSql`
      UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendmentId}
    `;
    await rawSql`
      INSERT INTO outbox_events (
        organization_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, attempt_count, available_at, idempotency_key
      ) VALUES (
        ${fixture.ids.orgId}, 'REFUND', ${fixture.refundIds[0]!}, 'REFUND_REQUESTED', 'v1',
        ${rawSql.json({
          organizationId: fixture.ids.orgId,
          bookingId: booking.id,
          amendmentId,
          refundId: fixture.refundIds[0]!,
        })}, 'PENDING', 0, now(), ${'outbox_tagged_worker_' + fixture.refundIds[0]!}
      )
    `;
    const provider = new SucceedingRefundProvider({ environment: 'TEST' });
    const workerResult = await executeRefundRequestBatch(
      { db, provider },
      { environment: 'TEST', batchLimit: 1 },
    );
    expect(workerResult.anomalies).toEqual([]);
    expect(workerResult).toMatchObject({ claimedCount: 1, submittedCount: 1 });
    const providerRefundId = `re_worker_${fixture.refundIds[0]}`;
    const body = makeDirectRefundBody({
      eventId: 'evt_b2b2a_after_worker',
      created: 1_910_000_070,
      refundId: providerRefundId,
      paymentIntentId: fixture.paymentIntentId,
      refundStatus: 'succeeded',
      amount: fixture.amount,
      metadata: {
        refund_id: fixture.refundIds[0]!,
        organization_id: fixture.ids.orgId,
        protocol_version: 'refund-requested-v1',
      },
    });
    await handleWebhook(fixture.deps, makeWebhookInput(body, fixture.deps.adapter));
    const current = await refundState(fixture.refundIds[0]!);
    expect(current.status).toBe('SUCCEEDED');
    expect(current.provider_refund_id).toBe(providerRefundId);
  });

  // 27. Projection account.updated → organization_payment_accounts mis à jour
  it('27. account.updated → organization_payment_accounts mis à jour (charges_enabled, etc.)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('acct-updated');
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();
    const body = JSON.stringify({
      id: `evt_acct_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: false,
          payouts_enabled: false,
          capabilities: { transfers: 'inactive', card_payments: 'active' },
          requirements: { currently_due: ['individual.verification.document'] },
          controller: { fees_collector: 'PLATFORM' },
        },
      },
    });
    const input = makeWebhookInput(body, deps.adapter, 'connect');

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');

    // L'événement webhook est PROCESSED.
    const webhookEvent =
      await rawSql`SELECT status FROM payment_webhook_events WHERE event_type = 'account.updated'`;
    expect(webhookEvent.length).toBe(1);
    expect(webhookEvent[0]!.status).toBe('PROCESSED');

    // organization_payment_accounts mis à jour.
    const account =
      await rawSql`SELECT charges_enabled, payouts_enabled, transfers_capability_status, last_provider_event_at FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account.length).toBe(1);
    expect(account[0]!.charges_enabled).toBe(false);
    expect(account[0]!.payouts_enabled).toBe(false);
    expect(account[0]!.transfers_capability_status).toBe('INACTIVE');
    expect(account[0]!.last_provider_event_at).not.toBeNull();
  });

  it('27b. account.updated prêt → onboarding local ENABLED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('acct-ready');
    await seedPaymentAccount(ids, 'acct_ready_123');
    await rawSql`
      UPDATE organization_payment_accounts
      SET onboarding_status = 'SUBMITTED', charges_enabled = false,
          payouts_enabled = false, transfers_capability_status = 'PENDING'
      WHERE provider_account_id = 'acct_ready_123'
    `;

    const deps = makeDeps();
    const body = JSON.stringify({
      id: `evt_acct_ready_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      account: 'acct_ready_123',
      data: {
        object: {
          id: 'acct_ready_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'active' },
        },
      },
    });

    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter, 'connect'));
    expect(result.kind).toBe('SUCCESS');

    const account = await rawSql`
      SELECT onboarding_status, charges_enabled, payouts_enabled,
             transfers_capability_status
      FROM organization_payment_accounts
      WHERE provider_account_id = 'acct_ready_123'
    `;
    expect(account[0]!.onboarding_status).toBe('ENABLED');
    expect(account[0]!.charges_enabled).toBe(true);
    expect(account[0]!.payouts_enabled).toBe(true);
    expect(account[0]!.transfers_capability_status).toBe('ACTIVE');
  });

  // 28. Test de deadlock/ordre global : deux webhooks concurrents sur des drafts différents (même org)
  it('28. concurrence : deux webhooks simultanés sur des drafts différents (même org) → aucun deadlock, les deux traitent', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('conc-two-drafts');
    await seedPaymentAccount(ids);
    const draftId1 = await createHeldDraft(ids, 'conc-two-drafts-1');
    const draftId2 = await createHeldDraft(ids, 'conc-two-drafts-2');

    const initDeps = makeInitDeps();
    const initResult1 = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId1, 'conc-two-drafts-1'),
    );
    expect(initResult1.kind).toBe('SUCCESS');
    if (initResult1.kind !== 'SUCCESS') return;

    const initResult2 = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId2, 'conc-two-drafts-2'),
    );
    expect(initResult2.kind).toBe('SUCCESS');
    if (initResult2.kind !== 'SUCCESS') return;

    const piId1 = initResult1.providerPaymentIntentId;
    const piId2 = initResult2.providerPaymentIntentId;
    const amount1 = await getPaymentAmount(draftId1);
    const amount2 = await getPaymentAmount(draftId2);
    const deps = makeDeps();

    const body1 = makeWebhookPayload('payment_intent.succeeded', piId1, amount1, {
      payment_id: initResult1.paymentId,
      payment_attempt_id: initResult1.paymentAttemptId,
      draft_id: draftId1,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const body2 = makeWebhookPayload('payment_intent.succeeded', piId2, amount2, {
      payment_id: initResult2.paymentId,
      payment_attempt_id: initResult2.paymentAttemptId,
      draft_id: draftId2,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });

    // Deux appels simultanés via Promise.all.
    const [result1, result2] = await Promise.all([
      handleWebhook(deps, makeWebhookInput(body1, deps.adapter)),
      handleWebhook(deps, makeWebhookInput(body2, deps.adapter)),
    ]);

    // Les deux retournent 200 (aucun deadlock).
    expect(result1.kind).toBe('SUCCESS');
    expect(result2.kind).toBe('SUCCESS');

    // Une réservation par draft.
    const bookings1 = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId1}`;
    expect(bookings1.length).toBe(1);
    const bookings2 = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId2}`;
    expect(bookings2.length).toBe(1);

    // Les deux drafts sont CONVERTED.
    const draft1 = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId1}`.then(
      (r) => r[0],
    );
    expect(draft1!.status).toBe('CONVERTED');
    const draft2 = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId2}`.then(
      (r) => r[0],
    );
    expect(draft2!.status).toBe('CONVERTED');
  });

  // 29. Concurrence : deux event.id distincts pour le MÊME PaymentIntent succeeded
  // envoyés via Promise.all avec une barrière déterministe → un PROCESSED, un IGNORED
  it('29. concurrence : deux événements succeeded distincts sur le même paiement → un PROCESSED, un IGNORED, une seule réservation', async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData('conc-same-pi');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conc-same-pi');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'conc-same-pi'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Trigger: blocks on pg_advisory_xact_lock during UPDATE on booking_drafts.
    // Le premier webhook fait SELECT FOR UPDATE, puis UPDATE (trigger bloque).
    // Le second webhook attend le FOR UPDATE, puis trouve attempt=SUCCEEDED → IGNORED.
    const sentinelKey = 98771;
    await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_conc_same_pi()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await rawSql.unsafe(`
      CREATE TRIGGER test_block_conc_same_pi_trigger
      BEFORE UPDATE ON booking_drafts
      FOR EACH ROW
      WHEN (NEW.id = '${draftId}'::uuid)
      EXECUTE FUNCTION test_block_conc_same_pi()
    `);

    const sentinelConn = postgres(ctx.databaseUrl, { max: 1 });
    await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

    const db2 = createDatabase(ctx.databaseUrl);
    try {
      const deps1 = makeDeps();
      const deps2 = makeDeps();
      deps2.db = db2;

      const body1 = makeWebhookPayload(
        'payment_intent.succeeded',
        piId,
        amount,
        {
          payment_id: paymentId,
          payment_attempt_id: initResult.paymentAttemptId,
          draft_id: draftId,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        },
        'succeeded',
        { eventId: 'evt_conc_same_pi_1' },
      );
      const body2 = makeWebhookPayload(
        'payment_intent.succeeded',
        piId,
        amount,
        {
          payment_id: paymentId,
          payment_attempt_id: initResult.paymentAttemptId,
          draft_id: draftId,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        },
        'succeeded',
        { eventId: 'evt_conc_same_pi_2' },
      );

      // Lancer le premier webhook — il bloquera sur le trigger pendant l'UPDATE.
      const webhook1Promise = handleWebhook(deps1, makeWebhookInput(body1, deps1.adapter));

      // Attendre que le premier webhook atteigne le trigger (prouve qu'il a le FOR UPDATE).
      await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

      // Lancer le second webhook — il attendra le FOR UPDATE sur booking_drafts.
      const webhook2Promise = handleWebhook(deps2, makeWebhookInput(body2, deps2.adapter));

      // Libérer le sentinel — le premier webhook commit, le second obtient le verrou.
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

      const [result1, result2] = await Promise.all([webhook1Promise, webhook2Promise]);

      // Les deux retournent 200.
      expect(result1.kind).toBe('SUCCESS');
      expect(result2.kind).toBe('SUCCESS');

      // Une seule réservation.
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(1);

      // Un seul outbox.
      const outbox =
        await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id}`;
      expect(outbox.length).toBe(1);

      // Deux événements webhook : un PROCESSED, un IGNORED.
      const webhookEvents =
        await rawSql`SELECT provider_event_id, status FROM payment_webhook_events WHERE provider_object_id = ${piId} ORDER BY provider_event_id`;
      expect(webhookEvents.length).toBe(2);
      const processed = webhookEvents.filter((e) => e.status === 'PROCESSED');
      const ignored = webhookEvents.filter((e) => e.status === 'IGNORED');
      expect(processed.length).toBe(1);
      expect(ignored.length).toBe(1);
    } finally {
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
      await sentinelConn.end();
      await db2.$client.end();
      await rawSql`DROP TRIGGER IF EXISTS test_block_conc_same_pi_trigger ON booking_drafts`;
      await rawSql`DROP FUNCTION IF EXISTS test_block_conc_same_pi()`;
    }
  });

  // 30. Faux PaymentIntent avec payment_id/draft_id mismatch dans metadata → échec
  it('30. faux PaymentIntent avec payment_id mismatch dans metadata → échec (WEBHOOK_AGGREGATE_INCONSISTENT)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('meta-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'meta-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'meta-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // Le webhook utilise le bon PI ID mais un payment_id faux dans metadata.
    // validateWebhookAuthority doit détecter le mismatch sur payment_id.
    const fakePaymentId = '00000000-0000-0000-0000-000000000000';
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: fakePaymentId, // ← payment_id faux
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Incohérence irréconciliable → SUCCESS 200 (pas 500) pour arrêter
    // les retries Stripe. L'événement est marqué FAILED avec failure_code.
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
    expect(bookings.length).toBe(0);

    // L'événement webhook est marqué FAILED avec failure_code.
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P1-1 : Tests 31-35 — Métadonnées Stripe facultatives (champs obligatoires)
  // ─────────────────────────────────────────────────────────────────────────────

  // Helper pour les tests 31-35 : crée un paiement et envoie un webhook avec un metadata manquant.
  async function setupPaymentAndSendWebhookMissingMetadata(
    keySuffix: string,
    metadataToDelete:
      'payment_id' | 'payment_attempt_id' | 'draft_id' | 'organization_id' | 'protocol_version',
  ): Promise<{ result: WebhookHandlerResult; piId: string }> {
    if (!db || !rawSql) throw new Error('db not initialized');
    const ids = await seedBaseData('meta-' + keySuffix);
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'meta-' + keySuffix);

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'meta-' + keySuffix),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') throw new Error('initiatePayment failed');

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    const fullMetadata: Record<string, string> = {
      payment_id: await getPaymentId(draftId),
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    };
    // Supprimer le champ testé.
    const metadata = { ...fullMetadata };
    delete metadata[metadataToDelete];

    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, metadata);
    const input = makeWebhookInput(body, deps.adapter);
    const result = await handleWebhook(deps, input);
    return { result, piId };
  }

  // 31. metadata payment_id absent → WEBHOOK_AGGREGATE_INCONSISTENT + FAILED
  it('31. metadata payment_id absent → échec (WEBHOOK_AGGREGATE_INCONSISTENT), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const { result, piId } = await setupPaymentAndSendWebhookMissingMetadata(
      'no-pid',
      'payment_id',
    );
    // P1-2 : Invariant irréconciliable → SUCCESS 200 (pas 500).
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }
    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
    // L'événement est FAILED avec failure_code.
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 32. metadata payment_attempt_id absent → WEBHOOK_AGGREGATE_INCONSISTENT + FAILED
  it('32. metadata payment_attempt_id absent → échec (WEBHOOK_AGGREGATE_INCONSISTENT), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const { result, piId } = await setupPaymentAndSendWebhookMissingMetadata(
      'no-attempt',
      'payment_attempt_id',
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 33. metadata draft_id absent → WEBHOOK_AGGREGATE_INCONSISTENT + FAILED
  it('33. metadata draft_id absent → échec (WEBHOOK_AGGREGATE_INCONSISTENT), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const { result, piId } = await setupPaymentAndSendWebhookMissingMetadata(
      'no-draft',
      'draft_id',
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 34. metadata organization_id absent → WEBHOOK_AGGREGATE_INCONSISTENT + FAILED
  it('34. metadata organization_id absent → échec (WEBHOOK_AGGREGATE_INCONSISTENT), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const { result, piId } = await setupPaymentAndSendWebhookMissingMetadata(
      'no-org',
      'organization_id',
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 35. metadata protocol_version absent → WEBHOOK_AGGREGATE_INCONSISTENT + FAILED
  it('35. metadata protocol_version absent → échec (WEBHOOK_AGGREGATE_INCONSISTENT), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const { result, piId } = await setupPaymentAndSendWebhookMissingMetadata(
      'no-proto',
      'protocol_version',
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P1-2 : Test 36 — Reprise FAILED (doublon d'un événement FAILED)
  // ─────────────────────────────────────────────────────────────────────────────

  // 36. invariant brisé (montant mismatch) → FAILED + 200, puis rejouer le même → doublon ignoré
  it('36. reprise FAILED : invariant brisé (montant mismatch) → FAILED + 200, puis rejouer le même → doublon ignoré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('failed-replay');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'failed-replay');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'failed-replay'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const amount = await getPaymentAmount(draftId);
    const paymentId = await getPaymentId(draftId);
    const deps = makeDeps();

    // Webhook avec un montant incorrect → WEBHOOK_AMOUNT_MISMATCH.
    const eventId = `evt_failed_replay_${Math.random().toString(36).slice(2, 12)}`;
    const body = makeWebhookPayload(
      'payment_intent.succeeded',
      piId,
      amount + 999, // montant mismatch
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'succeeded',
      { eventId },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    // P1-2 : Invariant irréconciliable → SUCCESS 200 (pas 500).
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Aucune réservation créée.
    const bookings = await rawSql`SELECT id FROM bookings`;
    expect(bookings.length).toBe(0);

    // L'événement est FAILED avec failure_code = 'WEBHOOK_AMOUNT_MISMATCH'.
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${eventId}`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AMOUNT_MISMATCH');

    // Rejouer le MÊME événement (même provider_event_id) → doublon, pas de retraitement.
    const result2 = await handleWebhook(deps, input);
    expect(result2.kind).toBe('SUCCESS');
    if (result2.kind === 'SUCCESS') {
      expect(result2.statusCode).toBe(200);
    }

    // Toujours une seule ligne, toujours FAILED.
    const webhookEvents2 =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${eventId}`;
    expect(webhookEvents2.length).toBe(1);
    expect(webhookEvents2[0]!.status).toBe('FAILED');

    // Toujours aucune réservation.
    const bookings2 = await rawSql`SELECT id FROM bookings`;
    expect(bookings2.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P1-3 : Tests 37-38 — Projection Connect non monotone
  // ─────────────────────────────────────────────────────────────────────────────

  // 37. Connect ancien après nouveau → garde monotone, le compte reste ACTIVE
  it('37. Connect ancien après nouveau → garde monotone, le compte reste ACTIVE', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-monotone');
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();
    const t1 = Math.floor(Date.now() / 1000); // T1 = maintenant
    const t0 = t1 - 3600; // T0 = 1 heure avant T1

    // 1. Envoyer account.updated avec capabilities.transfers = 'active' et created = T1.
    const body1 = JSON.stringify({
      id: `evt_acct_t1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: t1,
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'active' },
        },
      },
    });
    const input1 = makeWebhookInput(body1, deps.adapter, 'connect');
    const result1 = await handleWebhook(deps, input1);
    expect(result1.kind).toBe('SUCCESS');

    // Vérifier que transfers_capability_status = 'ACTIVE'.
    const account1 =
      await rawSql`SELECT transfers_capability_status, last_provider_event_at FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account1.length).toBe(1);
    expect(account1[0]!.transfers_capability_status).toBe('ACTIVE');

    // 2. Envoyer un second account.updated avec capabilities.transfers = 'inactive' et created = T0 < T1.
    const body2 = JSON.stringify({
      id: `evt_acct_t0_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: t0,
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'inactive' },
        },
      },
    });
    const input2 = makeWebhookInput(body2, deps.adapter, 'connect');
    const result2 = await handleWebhook(deps, input2);
    expect(result2.kind).toBe('SUCCESS');

    // Le compte doit rester ACTIVE (l'événement ancien est ignoré par la garde monotone).
    const account2 =
      await rawSql`SELECT transfers_capability_status FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account2.length).toBe(1);
    expect(account2[0]!.transfers_capability_status).toBe('ACTIVE');
  });

  // 38. mismatch event.accountId / data.object.id → aucune mise à jour
  it('38. mismatch accountId/data.id → aucune mise à jour, événement marqué FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-mismatch');
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();

    // Envoyer account.updated avec event.accountId = 'acct_test_123' (existe en DB)
    // mais data.object.id = 'acct_other' (différent de event.accountId).
    const body = JSON.stringify({
      id: `evt_acct_mismatch_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_other',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'active' },
        },
      },
    });
    const input = makeWebhookInput(body, deps.adapter, 'connect');
    const result = await handleWebhook(deps, input);
    // P1-3 : FAILED retourne 200 (pas 500) pour arrêter les retries Stripe.
    expect(result.kind).toBe('SUCCESS');

    // L'événement doit être marqué FAILED (mismatch irréconciliable).
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE event_type = 'account.updated' AND provider_account_id = 'acct_test_123'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');

    // organization_payment_accounts ne doit pas être modifié (toujours ACTIVE).
    const account =
      await rawSql`SELECT transfers_capability_status FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account.length).toBe(1);
    expect(account[0]!.transfers_capability_status).toBe('ACTIVE');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P1-4 : Tests 39-42 — Projection Refund sans garde monotone
  // ─────────────────────────────────────────────────────────────────────────────

  // 39. Régression refund terminal : événement ancien ne régresse pas un refund SUCCEEDED
  it('39. régression refund terminal : événement ancien (pending) ne régresse pas un refund SUCCEEDED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-regression');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-regression');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-regression'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer un premier charge.refunded avec refund SUCCEEDED et created = T1.
    const refundId = 're_test_regression_123';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_t1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_regression_123',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED avec provider_event_created_at = T1.
    const refund1 =
      await rawSql`SELECT status, provider_event_created_at FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1.length).toBe(1);
    expect(refund1[0]!.status).toBe('SUCCEEDED');
    expect(Number(refund1[0]!.provider_event_created_at)).toBe(t1);

    // 3. Envoyer un second charge.refunded avec refund pending et created = T0 < T1.
    const t0 = t1 - 3600;
    const bodyRefund2 = JSON.stringify({
      id: `evt_refund_t0_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t0,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_regression_123',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));

    // Le refund doit rester SUCCEEDED (l'événement ancien est ignoré par la garde monotone).
    const refund2 =
      await rawSql`SELECT status, provider_event_created_at FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2.length).toBe(1);
    expect(refund2[0]!.status).toBe('SUCCEEDED');
    expect(Number(refund2[0]!.provider_event_created_at)).toBe(t1);
  });

  // 40. Deux refunds externes sur le même paiement → deux lignes refunds créées
  it('40. deux refunds externes sur le même paiement → deux lignes refunds créées (plus de violation UNIQUE)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('two-refunds');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'two-refunds');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'two-refunds'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer un premier charge.refunded avec refundId_1.
    const refundId1 = 're_test_two_refunds_1';
    const refundAmount1 = Math.floor(amount / 2);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_two_refunds',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: refundAmount1,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId1,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount1,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // 3. Envoyer un second charge.refunded avec refundId_2 (même paiement, refund différent).
    const refundId2 = 're_test_two_refunds_2';
    const refundAmount2 = amount - refundAmount1;
    const bodyRefund2 = JSON.stringify({
      id: `evt_refund_2_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000) + 1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_two_refunds',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId2,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount2,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));

    // Deux lignes refunds doivent exister avec des provider_refund_id différents.
    const refundRows =
      await rawSql`SELECT provider_refund_id, status, reason FROM refunds WHERE provider_refund_id IN (${refundId1}, ${refundId2}) ORDER BY provider_refund_id`;
    expect(refundRows.length).toBe(2);
    expect(refundRows[0]!.provider_refund_id).toBe(refundId1);
    expect(refundRows[0]!.status).toBe('SUCCEEDED');
    expect(refundRows[0]!.reason).toBe('EXTERNAL_REFUND');
    expect(refundRows[1]!.provider_refund_id).toBe(refundId2);
    expect(refundRows[1]!.status).toBe('SUCCEEDED');
    expect(refundRows[1]!.reason).toBe('EXTERNAL_REFUND');
  });

  // 41. Montant refund incohérent → mise à jour skipée (recoupement amount)
  it('41. montant refund incohérent → mise à jour skipée (recoupement amount)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-amount-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-amount-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-amount-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund SUCCEEDED avec un montant connu.
    const refundId = 're_test_amount_mismatch_123';
    const refundAmount = 3000;
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_amt_1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_amount_mismatch',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: refundAmount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED avec amount_minor = 3000.
    const refund1 =
      await rawSql`SELECT status, amount_minor FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1.length).toBe(1);
    expect(refund1[0]!.status).toBe('SUCCEEDED');
    expect(Number(refund1[0]!.amount_minor)).toBe(refundAmount);

    // 3. Envoyer un second événement avec un montant différent pour le même refund.
    const t2 = t1 + 100;
    const bodyRefund2 = JSON.stringify({
      id: `evt_refund_amt_2_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_amount_mismatch',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: 9999,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount: 9999, // montant différent du refund local (3000)
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    // L'événement doit être marqué FAILED (incohérence amount).
    expect(result2.kind).toBe('SUCCESS');

    // Le refund doit rester avec amount_minor = 3000 (non modifié).
    const refund2 =
      await rawSql`SELECT status, amount_minor FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2.length).toBe(1);
    expect(refund2[0]!.status).toBe('SUCCEEDED');
    expect(Number(refund2[0]!.amount_minor)).toBe(refundAmount);
  });

  // 42. Devise refund incohérente → mise à jour skipée (recoupement currency)
  it('42. devise refund incohérente → mise à jour skipée (recoupement currency)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-currency-mismatch');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-currency-mismatch');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-currency-mismatch'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund SUCCEEDED.
    const refundId = 're_test_currency_mismatch_123';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_cur_1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_currency_mismatch',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1.length).toBe(1);
    expect(refund1[0]!.status).toBe('SUCCEEDED');

    // 3. Envoyer un second événement avec une devise différente (usd au lieu de eur).
    const t2 = t1 + 100;
    const bodyRefund2 = JSON.stringify({
      id: `evt_refund_cur_2_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_currency_mismatch',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'usd', // devise différente (la DB exige EUR)
              },
            ],
            has_more: false,
          },
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    // L'événement doit être marqué FAILED (incohérence currency).
    expect(result2.kind).toBe('SUCCESS');

    // Le refund doit rester SUCCEEDED (non régressé par l'événement incohérent).
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2.length).toBe(1);
    expect(refund2[0]!.status).toBe('SUCCEEDED');
  });

  // 43. Invariant irréconciliable → savepoint rollback, FAILED persisté, 200 (pas 500).
  // Corrompre une allocation (draft_line_id inexistant) déclenche un
  // WEBHOOK_INVARIANT_BROKEN via les invariants de cohérence. Cette erreur est
  // irréconciliable (isIrreconcilable → true) : le savepoint est annulé par
  // ROLLBACK TO SAVEPOINT, l'événement est marqué FAILED dans la transaction
  // extérieure (qui commit), et le handler retourne 200 pour arrêter les
  // retries Stripe — contrairement à une erreur technique qui donnerait 500.
  it('43. invariant irréconciliable → savepoint rollback, FAILED persisté, 200 (pas 500)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('savepoint-atomicity');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'savepoint-atomicity');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'savepoint-atomicity'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // Corrompre une allocation : lui assigner un draftLineId qui n'existe pas
    // dans booking_draft_lines. Cela déclenche un WEBHOOK_INVARIANT_BROKEN
    // (incohérence ligne/allocation). La FK constraint et le trigger de
    // cohérence sur allocations empêchent cette modification directement —
    // on les désactive temporairement.
    await rawSql`ALTER TABLE allocations DROP CONSTRAINT allocations_draft_line_id_booking_draft_lines_id_fk`;
    await rawSql`DROP TRIGGER IF EXISTS before_check_allocation_consistency ON allocations`;

    // Sauvegarder l'original draft_line_id pour pouvoir le restaurer avant
    // de ré-ajouter la FK constraint (sinon le ADD CONSTRAINT échoue car la
    // ligne corrompue viole la FK).
    const allocRows = await rawSql`SELECT id, draft_line_id FROM allocations LIMIT 1`;
    expect(allocRows.length).toBeGreaterThan(0);
    const allocId = allocRows[0]!.id;
    const originalDraftLineId = allocRows[0]!.draft_line_id;

    try {
      const fakeDraftLineId = crypto.randomUUID();
      await rawSql`UPDATE allocations SET draft_line_id = ${fakeDraftLineId} WHERE id = ${allocId}`;

      const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      });
      const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter));

      // Invariant irréconciliable → FAILED + 200 (pas 500, arrête les retries Stripe).
      expect(result.kind).toBe('SUCCESS');
      if (result.kind === 'SUCCESS') {
        expect(result.statusCode).toBe(200);
      }

      // Aucune ligne bookings créée — le savepoint a été annulé.
      const bookingsRows = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookingsRows.length).toBe(0);

      // Aucune ligne booking_lines.
      const bookingLines = await rawSql`SELECT id FROM booking_lines`;
      expect(bookingLines.length).toBe(0);

      // Aucune ligne outbox.
      const outbox = await rawSql`SELECT id FROM outbox_events WHERE aggregate_type = 'BOOKING'`;
      expect(outbox.length).toBe(0);

      // Le brouillon reste PAYMENT_PROCESSING (non converti).
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

      // Les holds restent PAYMENT_PROCESSING (non convertis).
      const blocks =
        await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId} AND type = 'HOLD'`;
      expect(blocks[0]!.status).toBe('PAYMENT_PROCESSING');

      // L'événement webhook est marqué FAILED (invariant irréconciliable persisté).
      const webhookEvent =
        await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_object_id = ${piId}`;
      expect(webhookEvent[0]!.status).toBe('FAILED');
      expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
    } finally {
      // Restaurer le draft_line_id original, puis la FK constraint et le trigger.
      await rawSql`UPDATE allocations SET draft_line_id = ${originalDraftLineId} WHERE id = ${allocId}`;
      await rawSql`ALTER TABLE allocations ADD CONSTRAINT allocations_draft_line_id_booking_draft_lines_id_fk FOREIGN KEY (draft_line_id) REFERENCES booking_draft_lines(id) ON DELETE cascade`;
      await rawSql`CREATE TRIGGER before_check_allocation_consistency
        BEFORE INSERT OR UPDATE OF draft_line_id, inventory_block_id ON allocations
        FOR EACH ROW EXECUTE FUNCTION check_allocation_consistency()`;
    }
  });

  // 44. Nouveau refund invalide : montant négatif, devise non-EUR, PI incohérent → FAILED
  it('44. nouveau refund invalide : montant ≤ 0, devise non-EUR, PI incohérent → FAILED (pas dinsertion)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-invalid-new');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-invalid-new');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-invalid-new'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // Confirmer la réservation d'abord.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 1. Refund avec montant négatif → FAILED (REFUND_INVALID_AMOUNT).
    const refundIdNegative = 're_test_negative_amount';
    const evtIdNegative = `evt_refund_neg_${Math.random().toString(36).slice(2, 12)}`;
    const bodyNegative = JSON.stringify({
      id: evtIdNegative,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_negative',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: -500,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundIdNegative,
                object: 'refund',
                status: 'succeeded',
                amount: -500,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyNegative, deps.adapter));
    const refundNegative =
      await rawSql`SELECT id FROM refunds WHERE provider_refund_id = ${refundIdNegative}`;
    expect(refundNegative.length).toBe(0);
    const evtNegative =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtIdNegative}`;
    expect(evtNegative[0]!.status).toBe('FAILED');
    expect(evtNegative[0]!.failure_code).toBe('REFUND_INVALID_AMOUNT');

    // 2. Refund avec devise non-EUR → FAILED (REFUND_CURRENCY_MISMATCH).
    const refundIdUsd = 're_test_usd_currency';
    const evtIdUsd = `evt_refund_usd_${Math.random().toString(36).slice(2, 12)}`;
    const bodyUsd = JSON.stringify({
      id: evtIdUsd,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_usd',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: 500,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundIdUsd,
                object: 'refund',
                status: 'succeeded',
                amount: 500,
                payment_intent: piId,
                currency: 'usd',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyUsd, deps.adapter));
    const refundUsd =
      await rawSql`SELECT id FROM refunds WHERE provider_refund_id = ${refundIdUsd}`;
    expect(refundUsd.length).toBe(0);
    const evtUsd =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtIdUsd}`;
    expect(evtUsd[0]!.status).toBe('FAILED');
    expect(evtUsd[0]!.failure_code).toBe('REFUND_CURRENCY_MISMATCH');

    // 3. Refund avec payment_intent incohérent → FAILED (REFUND_PI_MISMATCH).
    const refundIdPiMismatch = 're_test_pi_mismatch';
    const evtIdPiMismatch = `evt_refund_pi_mismatch_${Math.random().toString(36).slice(2, 12)}`;
    const bodyPiMismatch = JSON.stringify({
      id: evtIdPiMismatch,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_pi_mismatch',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: 500,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundIdPiMismatch,
                object: 'refund',
                status: 'succeeded',
                amount: 500,
                payment_intent: 'pi_wrong_intent_id',
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyPiMismatch, deps.adapter));
    const refundPiMismatch =
      await rawSql`SELECT id FROM refunds WHERE provider_refund_id = ${refundIdPiMismatch}`;
    expect(refundPiMismatch.length).toBe(0);
    const evtPiMismatch =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtIdPiMismatch}`;
    expect(evtPiMismatch[0]!.status).toBe('FAILED');
    expect(evtPiMismatch[0]!.failure_code).toBe('REFUND_PI_MISMATCH');
  });

  // 45. Connect statut inconnu → FAILED, aucune mise à jour
  it('45. Connect statut inconnu (capabilities.transfers = "unknown") → FAILED, aucune mise à jour', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-unknown-cap');
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();

    // Envoyer account.updated avec capabilities.transfers = 'unknown_value'.
    const body = JSON.stringify({
      id: `evt_acct_unknown_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'unknown_value' },
        },
      },
    });
    const input = makeWebhookInput(body, deps.adapter, 'connect');
    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // Le compte ne doit pas être mis à jour (transfers_capability_status reste ACTIVE).
    const account =
      await rawSql`SELECT transfers_capability_status, last_provider_event_at FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account.length).toBe(1);
    expect(account[0]!.transfers_capability_status).toBe('ACTIVE');

    // L'événement webhook doit être FAILED.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE event_type = 'account.updated' AND provider_account_id = 'acct_test_123'`;
    expect(webhookEvent.length).toBe(1);
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_AGGREGATE_INCONSISTENT');
  });

  // 46. Connect timestamps égaux → second événement ignoré (garde <=)
  it('46. Connect timestamps égaux : second account.updated avec même created → IGNORED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-equal-ts');
    await seedPaymentAccount(ids, 'acct_test_123');

    const deps = makeDeps();
    const t1 = Math.floor(Date.now() / 1000);

    // 1. Premier account.updated avec capabilities.transfers = 'active' et created = T1.
    const body1 = JSON.stringify({
      id: `evt_acct_eq1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: t1,
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'active' },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(body1, deps.adapter, 'connect'));

    // Vérifier que transfers_capability_status = 'ACTIVE'.
    const account1 =
      await rawSql`SELECT transfers_capability_status FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account1[0]!.transfers_capability_status).toBe('ACTIVE');

    // 2. Second account.updated avec même created = T1 mais transfers = 'inactive'.
    const body2 = JSON.stringify({
      id: `evt_acct_eq2_${Math.random().toString(36).slice(2, 12)}`,
      type: 'account.updated',
      created: t1, // Même timestamp
      api_version: '2026-06-24.dahlia',
      account: 'acct_test_123',
      data: {
        object: {
          id: 'acct_test_123',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: 'inactive' },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(body2, deps.adapter, 'connect'));

    // Le compte doit rester ACTIVE (même timestamp → ignoré par la garde <=).
    const account2 =
      await rawSql`SELECT transfers_capability_status FROM organization_payment_accounts WHERE provider_account_id = 'acct_test_123'`;
    expect(account2[0]!.transfers_capability_status).toBe('ACTIVE');
  });

  // 47. Régression refund SUCCEEDED→PENDING avec même timestamp → ignoré
  it('47. régression refund SUCCEEDED→PENDING avec même timestamp → refund reste SUCCEEDED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-equal-ts-regression');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-equal-ts-regression');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-equal-ts-regression'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund SUCCEEDED avec created = T1.
    const refundId = 're_test_equal_ts_regression';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_eq_t1_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_equal_ts',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1[0]!.status).toBe('SUCCEEDED');

    // 3. Envoyer un second événement avec même created = T1 mais statut 'pending'.
    const bodyRefund2 = JSON.stringify({
      id: `evt_refund_eq_t1_pending_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1, // Même timestamp
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_equal_ts',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));

    // Le refund doit rester SUCCEEDED (même timestamp → ignoré par la garde <=).
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('SUCCEEDED');
  });

  // 48. Régression terminale SUCCEEDED→FAILED avec événement plus récent → immuable
  it('48. régression terminale SUCCEEDED→FAILED avec événement plus récent → refund reste SUCCEEDED (immuable), événement FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-terminal-regression');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-terminal-regression');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-terminal-regression'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund SUCCEEDED avec created = T1.
    const refundId = 're_test_terminal_regression';
    const t1 = Math.floor(Date.now() / 1000);
    const evtId1 = `evt_refund_term_t1_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund1 = JSON.stringify({
      id: evtId1,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_terminal',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1[0]!.status).toBe('SUCCEEDED');

    // 3. Envoyer un second événement PLUS RÉCENT (T2 > T1) avec statut 'failed'.
    // P2-2 : Un refund terminal (SUCCEEDED) est immuable — toute transition vers
    // un état différent (FAILED) doit être journalisée sans écraser l'état.
    const t2 = t1 + 100;
    const evtId2 = `evt_refund_term_t2_failed_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId2,
      type: 'refund.updated',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'failed',
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));

    // Le refund doit rester SUCCEEDED (état terminal immuable).
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('SUCCEEDED');

    // P2-3 : L'événement doit être marqué FAILED avec REFUND_TERMINAL_STATE_CONFLICT.
    const evt2 =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId2}`;
    expect(evt2[0]!.status).toBe('FAILED');
    expect(evt2[0]!.failure_code).toBe('REFUND_TERMINAL_STATE_CONFLICT');
  });

  // 49. charge.refunded avec deux refunds : premier valide, second invalide → FAILED, zéro mutation (P1-1)
  it('49. charge.refunded avec deux refunds : premier valide, second invalide (devise non-EUR) → FAILED, zéro mutation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-partial-projection');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-partial-projection');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-partial-projection'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer charge.refunded avec deux refunds dans refunds.data :
    //    - Premier : valide (amount correct, EUR, payment_intent correct, status succeeded)
    //    - Second : invalide (devise USD)
    const refundId1 = 're_test_partial_valid';
    const refundId2 = 're_test_partial_invalid';
    const refundAmount = Math.floor(amount / 2);
    const evtId = `evt_refund_partial_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_partial',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId1,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount,
                payment_intent: piId,
                currency: 'eur',
              },
              {
                id: refundId2,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount,
                payment_intent: piId,
                currency: 'usd', // devise invalide → FAILED
              },
            ],
            has_more: false,
          },
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_CURRENCY_MISMATCH.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_CURRENCY_MISMATCH');

    // 4. Aucun refund n'a été inséré (zéro mutation — le savepoint a tout annulé).
    const refundRows =
      await rawSql`SELECT id FROM refunds WHERE provider_refund_id IN (${refundId1}, ${refundId2})`;
    expect(refundRows.length).toBe(0);
  });

  // 50. refund.updated sur refund existant sans payment_intent → FAILED (pas de transition) (P1-2)
  it('50. refund.updated sur refund existant sans payment_intent → FAILED (pas de transition)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-existing-no-pi');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-existing-no-pi');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-existing-no-pi'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund PENDING (non-terminal) via charge.refunded.
    const refundId = 're_test_existing_no_pi';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_create_no_pi_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_existing_no_pi',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est PENDING.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1[0]!.status).toBe('PENDING');

    // 3. Envoyer refund.updated SANS payment_intent (champ absent) avec statut
    // 'pending' (transition PENDING→PENDING, non-terminal — isole P1-2).
    // Note : 'processing' n'est plus un statut valide (P1-2) — on utilise 'pending'
    // qui mappera à PENDING (non-terminal) et atteindra le check payment_intent.
    const t2 = t1 + 100;
    const evtId2 = `evt_refund_no_pi_update_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId2,
      type: 'refund.updated',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'pending',
          amount,
          // payment_intent absent — P1-2 : OBLIGATOIRE pour un refund existant
          currency: 'eur',
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // 4. L'événement doit être FAILED avec REFUND_PI_MISSING.
    const evt2 =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId2}`;
    expect(evt2[0]!.status).toBe('FAILED');
    expect(evt2[0]!.failure_code).toBe('REFUND_PI_MISSING');

    // 5. Le refund garde son état original (pas de transition).
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('PENDING');
  });

  // 51. charge.refunded sans refunds.data exploitable → FAILED avec REFUND_OBJECTS_MISSING (P1)
  it('51. charge.refunded sans refunds.data exploitable → FAILED avec REFUND_OBJECTS_MISSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-objects-missing');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-objects-missing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-objects-missing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer charge.refunded avec refunds.data vide.
    const evtId = `evt_refund_no_objects_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_no_objects',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [],
            has_more: false,
          },
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_OBJECTS_MISSING.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_OBJECTS_MISSING');
  });

  // 52. refund.updated avec id absent → FAILED avec REFUND_ID_MISSING (P1)
  it('52. refund.updated avec id absent → FAILED avec REFUND_ID_MISSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-id-missing');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-id-missing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-id-missing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer refund.updated avec un objet sans id.
    const evtId = `evt_refund_no_id_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'refund.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          object: 'refund',
          status: 'succeeded',
          amount,
          payment_intent: piId,
          currency: 'eur',
          // id absent — P1 : REFUND_ID_MISSING
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_ID_MISSING.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_ID_MISSING');
  });

  // 53. refund.updated avec statut absent → FAILED avec REFUND_STATUS_MISSING (P1)
  it('53. refund.updated avec statut absent → FAILED avec REFUND_STATUS_MISSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-status-missing');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-status-missing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-status-missing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer refund.updated avec un objet sans status.
    const evtId = `evt_refund_no_status_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'refund.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 're_test_no_status',
          object: 'refund',
          amount,
          payment_intent: piId,
          currency: 'eur',
          // status absent — P1 : REFUND_STATUS_MISSING
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_STATUS_MISSING.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_STATUS_MISSING');
  });

  // 54. refund.updated avec statut Stripe inconnu → FAILED avec REFUND_PROVIDER_STATE_UNSUPPORTED (P1)
  it('54. refund.updated avec statut Stripe inconnu → FAILED avec REFUND_PROVIDER_STATE_UNSUPPORTED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-unknown-state');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-unknown-state');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-unknown-state'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer refund.updated avec un statut Stripe inconnu.
    const evtId = `evt_refund_unknown_state_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'refund.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 're_test_unknown_state',
          object: 'refund',
          status: 'unknown_state', // statut Stripe inconnu — P1 : REFUND_PROVIDER_STATE_UNSUPPORTED
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_PROVIDER_STATE_UNSUPPORTED.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_PROVIDER_STATE_UNSUPPORTED');
  });

  // 55. charge.refunded multi-refunds dont le second a un statut inconnu → FAILED avec rollback total (P1)
  it('55. charge.refunded multi-refunds dont le second a un statut inconnu → FAILED avec rollback total', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-multi-unknown');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-multi-unknown');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-multi-unknown'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer charge.refunded avec deux refunds :
    //    - Premier : valide (amount correct, EUR, payment_intent correct, status succeeded)
    //    - Second : statut Stripe inconnu
    const refundId1 = 're_test_multi_valid';
    const refundId2 = 're_test_multi_unknown';
    const refundAmount = Math.floor(amount / 2);
    const evtId = `evt_refund_multi_unknown_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_multi_unknown',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId1,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount,
                payment_intent: piId,
                currency: 'eur',
              },
              {
                id: refundId2,
                object: 'refund',
                status: 'unknown_state', // statut inconnu → FAILED
                amount: refundAmount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_PROVIDER_STATE_UNSUPPORTED.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_PROVIDER_STATE_UNSUPPORTED');

    // 4. Aucun refund n'a été inséré (zéro mutation — le savepoint a tout annulé).
    const refundRows =
      await rawSql`SELECT id FROM refunds WHERE provider_refund_id IN (${refundId1}, ${refundId2})`;
    expect(refundRows.length).toBe(0);
  });

  // 56. refund.failed sur refund PENDING → transition FAILED + événement PROCESSED (P1-1)
  it('56. refund.failed sur refund PENDING → transition FAILED + PROCESSED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-failed-pending');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-failed-pending');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-failed-pending'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund PENDING via charge.refunded avec status: 'pending'.
    const refundId = 're_test_failed_pending';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_create_failed_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_failed_pending',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est PENDING.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1[0]!.status).toBe('PENDING');

    // 3. Envoyer refund.failed avec le même refundId, status: 'failed', created plus récent.
    const t2 = t1 + 100;
    const evtId2 = `evt_refund_failed_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId2,
      type: 'refund.failed',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'failed',
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // 4. Le refund doit maintenant être FAILED.
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('FAILED');

    // 5. L'événement doit être PROCESSED.
    const evt2 =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_event_id = ${evtId2}`;
    expect(evt2[0]!.status).toBe('PROCESSED');
  });

  // 57. refund.failed dupliqué → déduplication (deuxième événement ignoré) (P1-1)
  it('57. refund.failed dupliqué → déduplication (deuxième ignoré)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-failed-dup');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-failed-dup');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-failed-dup'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund PENDING via charge.refunded.
    const refundId = 're_test_failed_dup';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_create_dup_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_failed_dup',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // 3. Envoyer refund.failed deux fois avec le MÊME event.id.
    const t2 = t1 + 100;
    const evtId = `evt_refund_failed_dup_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId,
      type: 'refund.failed',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'failed',
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result1 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result1.kind).toBe('SUCCESS');

    // Deuxième envoi — même event.id → doublon.
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // 4. Le deuxième événement doit être IGNORED (doublon).
    const evtRows =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evtRows.length).toBe(1);
    expect(evtRows[0]!.status).toBe('PROCESSED');

    // Le refund doit être FAILED (traité par le premier, le deuxième est ignoré).
    const refund = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund[0]!.status).toBe('FAILED');
  });

  // 58. refund.failed avec événement ancien → garde monotone (pas de régression) (P1-1)
  it('58. refund.failed avec événement ancien → garde monotone (pas de régression)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-failed-monotone');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-failed-monotone');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-failed-monotone'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund SUCCEEDED via charge.refunded avec created = T1.
    const refundId = 're_test_failed_monotone';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_refund_create_monotone_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_failed_monotone',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'succeeded',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est SUCCEEDED.
    const refund1 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1[0]!.status).toBe('SUCCEEDED');

    // 3. Envoyer refund.failed avec created = T0 (antérieur à T1).
    const t0 = t1 - 100;
    const evtId2 = `evt_refund_failed_old_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId2,
      type: 'refund.failed',
      created: t0,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'failed',
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // 4. Le refund doit rester SUCCEEDED (garde monotone — événement antérieur ignoré).
    const refund2 = await rawSql`SELECT status FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('SUCCEEDED');
  });

  // 59. charge.refunded avec un refund valide + un élément non-objet → FAILED avec REFUND_OBJECT_INVALID (P1-3)
  it('59. charge.refunded avec refund valide + élément non-objet → FAILED avec REFUND_OBJECT_INVALID', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('refund-object-invalid');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'refund-object-invalid');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'refund-object-invalid'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Envoyer charge.refunded avec refunds.data = [refundValide, null].
    const refundId1 = 're_test_object_invalid_valid';
    const refundAmount = Math.floor(amount / 2);
    const evtId = `evt_refund_object_invalid_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_test_object_invalid',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId1,
                object: 'refund',
                status: 'succeeded',
                amount: refundAmount,
                payment_intent: piId,
                currency: 'eur',
              },
              null, // P1-3 : élément non-objet → REFUND_OBJECT_INVALID
            ],
            has_more: false,
          },
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 3. L'événement doit être FAILED avec REFUND_OBJECT_INVALID.
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_OBJECT_INVALID');

    // 4. Aucun refund n'a été inséré (zéro mutation — le savepoint a tout annulé).
    const refundRows = await rawSql`SELECT id FROM refunds WHERE provider_refund_id = ${refundId1}`;
    expect(refundRows.length).toBe(0);
  });

  // P1-3 : Asymétrie terminal/non-terminal — payment SUCCEEDED, attempt PROCESSING → WEBHOOK_INVARIANT_BROKEN
  it('P1-3a. asymétrie terminale : payment=SUCCEEDED, attempt=PROCESSING → WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('asym-succeeded-processing');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'asym-succeeded-processing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'asym-succeeded-processing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Créer une asymétrie : payment SUCCEEDED (terminal) mais attempt PROCESSING (non-terminal).
    await rawSql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'PROCESSING' WHERE "id" = ${initResult.paymentAttemptId}`;

    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
      { eventId: 'evt_asym_succeeded_processing' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // L'événement webhook est marqué FAILED avec WEBHOOK_INVARIANT_BROKEN.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_asym_succeeded_processing'`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');

    // Le payment reste SUCCEEDED (pas de régression).
    const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`.then(
      (r) => r[0],
    );
    expect(payment!.status).toBe('SUCCEEDED');
  });

  // P1-3 : Asymétrie terminal/non-terminal — payment FAILED, attempt REQUIRES_ACTION → WEBHOOK_INVARIANT_BROKEN
  it('P1-3b. asymétrie terminale : payment=FAILED, attempt=REQUIRES_ACTION → WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('asym-failed-requires');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'asym-failed-requires');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'asym-failed-requires'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Créer une asymétrie : payment FAILED (terminal) mais attempt REQUIRES_ACTION (non-terminal).
    await rawSql`UPDATE "payments" SET "status" = 'FAILED', "failed_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'REQUIRES_ACTION' WHERE "id" = ${initResult.paymentAttemptId}`;

    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.payment_failed',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'requires_payment_method',
      { eventId: 'evt_asym_failed_requires' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_asym_failed_requires'`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // P1-3 : Asymétrie terminal/non-terminal — attempt SUCCEEDED, payment PROCESSING → WEBHOOK_INVARIANT_BROKEN
  it('P1-3c. asymétrie terminale : attempt=SUCCEEDED, payment=PROCESSING → WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('asym-attempt-succeeded');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'asym-attempt-succeeded');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'asym-attempt-succeeded'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Créer une asymétrie : attempt SUCCEEDED (terminal) mais payment PROCESSING (non-terminal).
    await rawSql`UPDATE "payment_attempts" SET "status" = 'SUCCEEDED' WHERE "id" = ${initResult.paymentAttemptId}`;
    await rawSql`UPDATE "payments" SET "status" = 'PROCESSING' WHERE "id" = ${paymentId}`;

    // Envoyer un événement payment_failed — passe par handle-non-success qui
    // appelle validateWebhookAuthority, qui détecte l'asymétrie terminale.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.payment_failed',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'requires_payment_method',
      { eventId: 'evt_asym_attempt_succeeded' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_asym_attempt_succeeded'`;
    expect(webhookEvent[0]!.status).toBe('FAILED');
    expect(webhookEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // P1-3 : Les deux non-terminaux et cohérents → OK (pas d'erreur)
  it('P1-3d. non-terminaux cohérents : payment=PROCESSING, attempt=PROCESSING → OK (pas WEBHOOK_INVARIANT_BROKEN)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('asym-ok-processing');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'asym-ok-processing');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'asym-ok-processing'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Les deux sont PROCESSING (non-terminal, cohérent) — pas d'asymétrie.
    await rawSql`UPDATE "payments" SET "status" = 'PROCESSING' WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'PROCESSING' WHERE "id" = ${initResult.paymentAttemptId}`;

    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
      { eventId: 'evt_asym_ok_processing' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // L'événement ne doit PAS être FAILED avec WEBHOOK_INVARIANT_BROKEN.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_asym_ok_processing'`;
    expect(webhookEvent[0]!.failure_code).not.toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // P2-3 : Cas légitimes de la garde terminale — les deux terminaux avec le même
  // statut ne doivent PAS déclencher WEBHOOK_INVARIANT_BROKEN. La garde passe car
  // il n'y a ni asymétrie terminal/non-terminal ni incohérence terminale.
  it('P2-3a. garde terminale légitime : payment=SUCCEEDED, attempt=SUCCEEDED → pas WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('legit-succeeded-succeeded');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'legit-succeeded-succeeded');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'legit-succeeded-succeeded'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Les deux sont SUCCEEDED (terminal, cohérent) — pas d'asymétrie ni d'incohérence.
    await rawSql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'SUCCEEDED' WHERE "id" = ${initResult.paymentAttemptId}`;

    // Envoyer un événement non-succès (processing) qui passe par handle-non-success
    // → applyProcessingProjection → validateWebhookAuthority. La garde terminale
    // doit passer (les deux sont terminaux et cohérents).
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.processing',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'processing',
      { eventId: 'evt_legit_succeeded_succeeded' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // L'événement ne doit PAS être FAILED avec WEBHOOK_INVARIANT_BROKEN.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_legit_succeeded_succeeded'`;
    expect(webhookEvent[0]!.failure_code).not.toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  it('P2-3b. garde terminale légitime : payment=FAILED, attempt=FAILED → pas WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('legit-failed-failed');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'legit-failed-failed');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'legit-failed-failed'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Les deux sont FAILED (terminal, cohérent) — pas d'asymétrie ni d'incohérence.
    await rawSql`UPDATE "payments" SET "status" = 'FAILED', "failed_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'FAILED' WHERE "id" = ${initResult.paymentAttemptId}`;

    // Envoyer un événement payment_failed qui passe par handlePaymentFailed
    // → validateWebhookAuthority. La garde terminale doit passer.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.payment_failed',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'requires_payment_method',
      { eventId: 'evt_legit_failed_failed' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // L'événement ne doit PAS être FAILED avec WEBHOOK_INVARIANT_BROKEN.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_legit_failed_failed'`;
    expect(webhookEvent[0]!.failure_code).not.toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  it('P2-3c. garde terminale légitime : payment=CANCELLED, attempt=CANCELLED → pas WEBHOOK_INVARIANT_BROKEN', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('legit-cancelled-cancelled');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'legit-cancelled-cancelled');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'legit-cancelled-cancelled'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Les deux sont CANCELLED (terminal, cohérent) — pas d'asymétrie ni d'incohérence.
    await rawSql`UPDATE "payments" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "id" = ${paymentId}`;
    await rawSql`UPDATE "payment_attempts" SET "status" = 'CANCELLED' WHERE "id" = ${initResult.paymentAttemptId}`;

    // Envoyer un événement canceled qui passe par handleCanceled
    // → applyCancellation → validateWebhookAuthority. La garde terminale doit passer.
    const deps = makeDeps();
    const body = makeWebhookPayload(
      'payment_intent.canceled',
      piId,
      amount,
      {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
      'canceled',
      { eventId: 'evt_legit_cancelled_cancelled' },
    );
    const input = makeWebhookInput(body, deps.adapter);

    const result = await handleWebhook(deps, input);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.statusCode).toBe(200);
    }

    // L'événement ne doit PAS être FAILED avec WEBHOOK_INVARIANT_BROKEN.
    const webhookEvent =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = 'evt_legit_cancelled_cancelled'`;
    expect(webhookEvent[0]!.failure_code).not.toBe('WEBHOOK_INVARIANT_BROKEN');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 8 — P1-1/P1-2 : course webhook vs worker de compensation
  // ─────────────────────────────────────────────────────────────────────────────

  // P8-1. Webhook reçu entre createRefund et la Phase 3 du worker : le webhook
  // rattache le remboursement LATE orphelin au lieu de créer un EXTERNAL_REFUND.
  it("P8-1. webhook reçu avant la persistance du worker : rattachement du remboursement LATE orphelin, pas d'EXTERNAL_REFUND", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('orphan-attach');
    const seed = await seedLateCompensation(ids, 'orphan-attach');
    const deps = makeDeps();

    // Le refund LATE est encore PENDING sans provider_refund_id : simuler le
    // webhook Stripe qui arrive AVANT la Phase 3 du worker.
    const body = makeChargeRefundedBody({
      chargeId: 'ch_orphan_attach',
      paymentIntentId: seed.providerPaymentIntentId,
      refundId: 're_orphan_attach_1',
      refundStatus: 'succeeded',
      amount: seed.amountMinor,
    });
    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // Le remboursement LATE a été rattaché : provider_refund_id + SUCCEEDED.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, reason FROM refunds WHERE payment_id = ${seed.paymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refundRows[0]!.provider_refund_id).toBe('re_orphan_attach_1');
    expect(refundRows[0]!.status).toBe('SUCCEEDED');

    // L'événement webhook est PROCESSED.
    const webhookEvents =
      await rawSql`SELECT status FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('PROCESSED');
  });

  // P8-2. Aucune duplication EXTERNAL_REFUND : après le rattachement, une seule
  // ligne refunds existe et le worker ne lève pas de conflit unique.
  it("P8-2. après rattachement webhook : une seule ligne refunds, le worker marque l'outbox PROCESSED sans conflit", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('orphan-no-dup');
    const seed = await seedLateCompensation(ids, 'orphan-no-dup');
    const deps = makeDeps();

    // 1. Le webhook rattache le remboursement LATE (SUCCEEDED).
    const body = makeChargeRefundedBody({
      chargeId: 'ch_orphan_no_dup',
      paymentIntentId: seed.providerPaymentIntentId,
      refundId: 're_orphan_no_dup_1',
      refundStatus: 'succeeded',
      amount: seed.amountMinor,
    });
    const webhookResult = await handleWebhook(deps, makeWebhookInput(body, deps.adapter));
    expect(webhookResult.kind).toBe('SUCCESS');

    // 2. Le worker de compensation s'exécute ensuite : le refund est déjà
    // SUCCEEDED (REFUND_ALREADY_SUBMITTED) → outbox PROCESSED, aucune
    // violation de contrainte unique sur provider_refund_id.
    const batchResult = await executeCompensationBatch(
      { db, provider: new FakeStripeAdapter({ environment: 'TEST' }) },
      { environment: 'TEST' },
    );
    expect(batchResult.claimedCount).toBe(1);
    expect(batchResult.failedCount).toBe(0);

    // Une SEULE ligne refunds pour ce paiement — pas d'EXTERNAL_REFUND créé.
    const refundRows =
      await rawSql`SELECT reason, status, provider_refund_id FROM refunds WHERE payment_id = ${seed.paymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refundRows[0]!.provider_refund_id).toBe('re_orphan_no_dup_1');

    // L'outbox est PROCESSED.
    const outbox = await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
    expect(outbox[0]!.status).toBe('PROCESSED');
  });

  // P8-3. Webhook SUCCEEDED entre createRefund et la Phase 3 : la Phase 3 ne
  // régresse JAMAIS le statut vers SUBMITTED, l'outbox est marqué PROCESSED.
  it('P8-3. webhook SUCCEEDED pendant createRefund : la Phase 3 ne régresse pas vers SUBMITTED, outbox PROCESSED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('orphan-race');
    const seed = await seedLateCompensation(ids, 'orphan-race');
    const webhookDeps = makeDeps();

    // Adapter du worker : createRefund simule la course — le webhook arrive
    // PENDANT l'appel provider (entre la Phase 1 et la Phase 3 du worker).
    const workerAdapter = new FakeStripeAdapter({ environment: 'TEST' });
    vi.spyOn(workerAdapter, 'createRefund').mockImplementation(async () => {
      const body = makeChargeRefundedBody({
        chargeId: 'ch_orphan_race',
        paymentIntentId: seed.providerPaymentIntentId,
        refundId: 're_orphan_race_1',
        refundStatus: 'succeeded',
        amount: seed.amountMinor,
      });
      const webhookResult = await handleWebhook(
        webhookDeps,
        makeWebhookInput(body, webhookDeps.adapter),
      );
      expect(webhookResult.kind).toBe('SUCCESS');
      return {
        id: 're_orphan_race_1',
        status: 'succeeded',
        amountMinor: seed.amountMinor,
        currency: 'EUR',
      };
    });

    const batchResult = await executeCompensationBatch(
      { db, provider: workerAdapter },
      { environment: 'TEST' },
    );
    expect(batchResult.claimedCount).toBe(1);
    expect(batchResult.submittedCount).toBe(1);
    expect(batchResult.failedCount).toBe(0);

    // P1-2 : transition monotone — le statut reste SUCCEEDED, jamais régressé
    // vers SUBMITTED, et provider_refund_id n'est pas écrasé.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, succeeded_at FROM refunds WHERE id = ${seed.refundId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.status).toBe('SUCCEEDED');
    expect(refundRows[0]!.provider_refund_id).toBe('re_orphan_race_1');
    expect(refundRows[0]!.succeeded_at).not.toBeNull();

    // L'outbox est PROCESSED dans la même transaction que la Phase 3.
    const outbox = await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
    expect(outbox[0]!.status).toBe('PROCESSED');
  });

  // P8-4. Worker SUBMITTED puis webhook SUCCEEDED : la projection webhook fait
  // transitionner le refund SUBMITTED → SUCCEEDED sans conflit (le worker a
  // déjà persisté provider_refund_id et marqué l'outbox PROCESSED).
  it('P8-4. worker SUBMITTED puis webhook SUCCEEDED : transition SUBMITTED → SUCCEEDED, pas de conflit', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('submitted-then-webhook');
    const seed = await seedSubmittedLateRefund(ids, 'submitted-then-webhook');
    const deps = makeDeps();
    const providerRefundId = seed.providerRefundId!;

    // Le worker a fini (refund SUBMITTED + provider_refund_id + outbox
    // PROCESSED) : le webhook Stripe de confirmation arrive ensuite.
    const body = makeChargeRefundedBody({
      chargeId: 'ch_submitted_then_webhook',
      paymentIntentId: seed.providerPaymentIntentId,
      refundId: providerRefundId,
      refundStatus: 'succeeded',
      amount: seed.amountMinor,
    });
    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // Le refund est passé à SUCCEEDED (succeeded_at set), provider_refund_id
    // inchangé — aucune nouvelle ligne refunds (pas d'EXTERNAL_REFUND).
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, reason, succeeded_at FROM refunds WHERE payment_id = ${seed.paymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refundRows[0]!.status).toBe('SUCCEEDED');
    expect(refundRows[0]!.provider_refund_id).toBe(providerRefundId);
    expect(refundRows[0]!.succeeded_at).not.toBeNull();

    // L'événement webhook est PROCESSED.
    const webhookEvents =
      await rawSql`SELECT status FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('PROCESSED');

    // L'outbox reste PROCESSED (le worker n'est pas rejoué).
    const outbox = await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
    expect(outbox[0]!.status).toBe('PROCESSED');
  });

  // P8-5. Webhook FAILED entre createRefund et la Phase 3 : la Phase 3 ne
  // régresse JAMAIS le statut terminal FAILED vers SUBMITTED, l'outbox est
  // marqué PROCESSED. Variante FAILED de P8-3 (SUCCEEDED).
  it('P8-5. webhook FAILED pendant createRefund : la Phase 3 ne régresse pas le statut terminal FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('orphan-race-failed');
    const seed = await seedLateCompensation(ids, 'orphan-race-failed');
    const webhookDeps = makeDeps();

    // Adapter du worker : createRefund simule la course — le webhook FAILED
    // arrive PENDANT l'appel provider (entre la Phase 1 et la Phase 3).
    const workerAdapter = new FakeStripeAdapter({ environment: 'TEST' });
    vi.spyOn(workerAdapter, 'createRefund').mockImplementation(async () => {
      const body = makeChargeRefundedBody({
        chargeId: 'ch_orphan_race_failed',
        paymentIntentId: seed.providerPaymentIntentId,
        refundId: 're_orphan_race_failed_1',
        refundStatus: 'failed',
        amount: seed.amountMinor,
      });
      const webhookResult = await handleWebhook(
        webhookDeps,
        makeWebhookInput(body, webhookDeps.adapter),
      );
      expect(webhookResult.kind).toBe('SUCCESS');
      // L'appel createRefund lui-même reste admissible côté worker (pending) —
      // c'est le webhook qui projette l'échec terminal.
      return {
        id: 're_orphan_race_failed_1',
        status: 'pending',
        amountMinor: seed.amountMinor,
        currency: 'EUR',
      };
    });

    const batchResult = await executeCompensationBatch(
      { db, provider: workerAdapter },
      { environment: 'TEST' },
    );
    expect(batchResult.claimedCount).toBe(1);
    expect(batchResult.submittedCount).toBe(1);
    expect(batchResult.failedCount).toBe(0);

    // Transition monotone — le statut terminal FAILED projeté par le webhook
    // n'est JAMAIS régressé vers SUBMITTED par la Phase 3, provider_refund_id
    // est présent et non écrasé.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, failed_at FROM refunds WHERE id = ${seed.refundId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.status).toBe('FAILED');
    expect(refundRows[0]!.provider_refund_id).toBe('re_orphan_race_failed_1');
    expect(refundRows[0]!.failed_at).not.toBeNull();

    // L'outbox est PROCESSED dans la même transaction que la Phase 3.
    const outbox = await rawSql`SELECT status FROM outbox_events WHERE id = ${seed.outboxEventId}`;
    expect(outbox[0]!.status).toBe('PROCESSED');
  });

  // P8-6. Webhook Connect précoce (endpoint connect, event.accountId non null) :
  // le paymentId est résolu depuis le payment_intent MÊME quand l'org est déjà
  // résolue via accountId — le remboursement LATE orphelin est rattaché et
  // projeté SUCCEEDED, jamais consommé sans projection ni EXTERNAL_REFUND.
  it("P8-6. webhook Connect précoce : rattachement du remboursement LATE orphelin avec org résolue via accountId, pas d'EXTERNAL_REFUND", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-early-refund');
    // Compte Connect de l'organisation — permet la résolution org via accountId.
    await seedPaymentAccount(ids, 'acct_test_123');
    const seed = await seedLateCompensation(ids, 'connect-early-refund');
    const deps = makeDeps();

    // Le refund LATE est encore PENDING sans provider_refund_id : simuler le
    // webhook Stripe qui arrive sur l'endpoint CONNECT (account non null)
    // AVANT la Phase 3 du worker.
    const body = makeChargeRefundedBody({
      chargeId: 'ch_connect_early',
      paymentIntentId: seed.providerPaymentIntentId,
      refundId: 're_connect_early_1',
      refundStatus: 'succeeded',
      amount: seed.amountMinor,
      account: 'acct_test_123',
    });
    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter, 'connect'));
    expect(result.kind).toBe('SUCCESS');

    // Le remboursement LATE a été rattaché : provider_refund_id + SUCCEEDED —
    // le paymentId a été résolu depuis le payment_intent malgré orgId déjà set.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, reason FROM refunds WHERE payment_id = ${seed.paymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refundRows[0]!.provider_refund_id).toBe('re_connect_early_1');
    expect(refundRows[0]!.status).toBe('SUCCEEDED');

    // L'événement webhook est PROCESSED (pas IGNORED/acquitté sans projection).
    const webhookEvents =
      await rawSql`SELECT status, organization_id FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('PROCESSED');
    expect(webhookEvents[0]!.organization_id).toBe(ids.orgId);
  });

  // P8-6-bis. Webhook Connect précoce avec accountId ≠ connectedAccountId du
  // paiement : l'événement est FAILED (refund_account_mismatch), le refund LATE
  // orphelin n'est PAS rattaché (provider_refund_id reste NULL), aucun
  // EXTERNAL_REFUND créé.
  it('P8-6-bis. webhook Connect précoce avec accountId ≠ connectedAccountId du paiement → FAILED, pas de rattachement', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('connect-mismatch');
    // Compte Connect A de l'organisation — le paiement utilise ce compte.
    await seedPaymentAccount(ids, 'acct_test_123');
    const seed = await seedLateCompensation(ids, 'connect-mismatch');
    const deps = makeDeps();

    // Le refund LATE est encore PENDING sans provider_refund_id : simuler un
    // webhook Stripe sur l'endpoint CONNECT avec event.accountId = compte_B
    // (différent du connectedAccountId du paiement = acct_test_123).
    const body = makeChargeRefundedBody({
      chargeId: 'ch_connect_mismatch',
      paymentIntentId: seed.providerPaymentIntentId,
      refundId: 're_connect_mismatch_1',
      refundStatus: 'succeeded',
      amount: seed.amountMinor,
      account: 'acct_test_456',
    });
    const result = await handleWebhook(deps, makeWebhookInput(body, deps.adapter, 'connect'));
    expect(result.kind).toBe('SUCCESS');

    // L'événement webhook est FAILED (refund_account_mismatch) — pas PROCESSED.
    const webhookEvents =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE event_type = 'charge.refunded'`;
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0]!.status).toBe('FAILED');
    expect(webhookEvents[0]!.failure_code).toBe('REFUND_ACCOUNT_MISMATCH');

    // Le refund LATE orphelin est inchangé : pas rattaché, provider_refund_id
    // toujours NULL, statut toujours PENDING.
    const refundRows =
      await rawSql`SELECT status, provider_refund_id, reason FROM refunds WHERE payment_id = ${seed.paymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('LATE_PAYMENT_NO_BOOKING');
    expect(refundRows[0]!.provider_refund_id).toBeNull();
    expect(refundRows[0]!.status).toBe('PENDING');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // G7M-A : Tests de compatibilité — refund historique (payment_id) et
  // refund d'origine amendement (amendment_payment_id, payment_id NULL).
  // ─────────────────────────────────────────────────────────────────────────────

  // G7M-A-1. Refund historique avec payment_id : la projection webhook continue
  // de fonctionner (le guard paymentId === null ne casse pas les refunds existants).
  it('G7M-A-1. refund historique avec payment_id → refund.updated projette le statut correctement', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('g7m-a-historical');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'g7m-a-historical');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'g7m-a-historical'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    // 2. Créer un refund PENDING via charge.refunded (refund historique avec payment_id).
    const refundId = 're_g7m_a_historical';
    const t1 = Math.floor(Date.now() / 1000);
    const bodyRefund1 = JSON.stringify({
      id: `evt_g7m_a_hist_create_${Math.random().toString(36).slice(2, 12)}`,
      type: 'charge.refunded',
      created: t1,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: 'ch_g7m_a_hist',
          object: 'charge',
          payment_intent: piId,
          amount_refunded: amount,
          refunds: {
            object: 'list',
            data: [
              {
                id: refundId,
                object: 'refund',
                status: 'pending',
                amount,
                payment_intent: piId,
                currency: 'eur',
              },
            ],
            has_more: false,
          },
        },
      },
    });
    await handleWebhook(deps, makeWebhookInput(bodyRefund1, deps.adapter));

    // Vérifier que le refund est PENDING avec payment_id non-null.
    const refund1 =
      await rawSql`SELECT status, payment_id FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund1.length).toBe(1);
    expect(refund1[0]!.status).toBe('PENDING');
    expect(refund1[0]!.payment_id).not.toBeNull();

    // 3. Envoyer refund.updated avec statut 'succeeded' (transition PENDING → SUCCEEDED).
    const t2 = t1 + 100;
    const evtId2 = `evt_g7m_a_hist_update_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund2 = JSON.stringify({
      id: evtId2,
      type: 'refund.updated',
      created: t2,
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'succeeded',
          amount,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result2 = await handleWebhook(deps, makeWebhookInput(bodyRefund2, deps.adapter));
    expect(result2.kind).toBe('SUCCESS');

    // 4. Le refund doit être SUCCEEDED (projection correcte, pas bloqué par le guard).
    const refund2 =
      await rawSql`SELECT status, payment_id FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund2[0]!.status).toBe('SUCCEEDED');
    expect(refund2[0]!.payment_id).not.toBeNull();

    // L'événement est PROCESSED.
    const evt2 =
      await rawSql`SELECT status FROM payment_webhook_events WHERE provider_event_id = ${evtId2}`;
    expect(evt2[0]!.status).toBe('PROCESSED');
  });

  // G7M-A-2. Refund d'origine amendement (payment_id NULL, amendment_payment_id set) :
  // le guard fail-closed lève RefundProjectionError(REFUND_PI_MISSING) — pas de
  // type crash, pas de bad JOIN, pas de silent failure.
  it("G7M-A-2. refund d'origine amendement (payment_id NULL) → REFUND_PI_MISSING (fail-closed)", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData('g7m-a-amendment');
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'g7m-a-amendment');

    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId, 'g7m-a-amendment'),
    );
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;

    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);
    const deps = makeDeps();

    // 1. Confirmer la réservation pour obtenir un booking.
    const bodySucceeded = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    await handleWebhook(deps, makeWebhookInput(bodySucceeded, deps.adapter));

    const booking = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`.then(
      (r) => r[0]!,
    );

    // 2. Insérer la chaîne complète d'amendement via raw SQL :
    //    booking_amendment (SUPPLEMENT) : INSERT en HOLD_PENDING (requis par le trigger),
    //    puis transition HOLD_PENDING → READY_TO_APPLY → APPLIED.
    const amendment = await rawSql`
      INSERT INTO "booking_amendments" (
        "organization_id", "booking_id", "amendment_number", "type", "status",
        "financial_snapshot_before", "financial_snapshot_after",
        "new_customer_start_at", "new_customer_end_at",
        "new_blocked_start_at", "new_blocked_end_at",
        "hold_deadline", "created_by"
      ) VALUES (
        ${ids.orgId}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
        ${rawSql.json({ total: amount })}, ${rawSql.json({ total: amount + 2000 })},
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
        now() + interval '10 minutes', ${ids.userId}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`UPDATE "booking_amendments" SET "status" = 'READY_TO_APPLY' WHERE "id" = ${amendment.id}`;
    await rawSql`UPDATE "booking_amendments" SET "status" = 'APPLIED', "applied_at" = now() WHERE "id" = ${amendment.id}`;

    const amendmentPayment = await rawSql`
      INSERT INTO "amendment_payments" (
        "organization_id", "booking_id", "amendment_id", "customer_user_id",
        "amount_minor", "currency", "environment",
        "connected_account_id", "charge_model", "settlement_merchant_mode",
        "status"
      ) VALUES (
        ${ids.orgId}, ${booking.id}, ${amendment.id}, ${ids.userId},
        2000, 'EUR', 'TEST',
        'acct_test_123', 'DESTINATION', 'PLATFORM',
        'PENDING_PROVIDER'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`UPDATE "amendment_payments" SET "status" = 'PROCESSING' WHERE "id" = ${amendmentPayment.id}`;
    await rawSql`UPDATE "amendment_payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${amendmentPayment.id}`;

    // 3. Insérer un refund AMENDMENT_COMPENSATION avec payment_id NULL et
    //    amendment_payment_id set (XOR satisfait), provider_refund_id set,
    //    statut PENDING.
    const refundId = 're_g7m_a_amendment';
    const refundIdempotencyKey = `refund_amendment_${amendmentPayment.id}`;
    await rawSql`
      INSERT INTO "refunds" (
        "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
        "amount_minor", "currency", "provider_idempotency_key", "provider_refund_id",
        "reverse_transfer", "refund_application_fee", "requested_at"
      ) VALUES (
        ${ids.orgId}, NULL, ${amendmentPayment.id}, 'AMENDMENT_COMPENSATION', 'PENDING',
        2000, 'EUR', ${refundIdempotencyKey}, ${refundId},
        true, true, now()
      )
    `;

    // 4. Envoyer refund.updated avec payment_intent pour ce refund.
    //    Le guard existingRow.paymentId === null doit lever REFUND_PI_MISSING.
    const evtId = `evt_g7m_a_amendment_update_${Math.random().toString(36).slice(2, 12)}`;
    const bodyRefund = JSON.stringify({
      id: evtId,
      type: 'refund.updated',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: refundId,
          object: 'refund',
          status: 'succeeded',
          amount: 2000,
          payment_intent: piId,
          currency: 'eur',
        },
      },
    });
    const result = await handleWebhook(deps, makeWebhookInput(bodyRefund, deps.adapter));
    expect(result.kind).toBe('SUCCESS');

    // 5. L'événement doit être FAILED avec REFUND_PI_MISSING (fail-closed explicite).
    const evt =
      await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE provider_event_id = ${evtId}`;
    expect(evt.length).toBe(1);
    expect(evt[0]!.status).toBe('FAILED');
    expect(evt[0]!.failure_code).toBe('REFUND_PI_MISSING');

    // 6. Le refund reste PENDING (pas de mutation, pas de bad JOIN).
    const refund =
      await rawSql`SELECT status, payment_id, amendment_payment_id FROM refunds WHERE provider_refund_id = ${refundId}`;
    expect(refund.length).toBe(1);
    expect(refund[0]!.status).toBe('PENDING');
    expect(refund[0]!.payment_id).toBeNull();
    expect(refund[0]!.amendment_payment_id).not.toBeNull();
  });
});
