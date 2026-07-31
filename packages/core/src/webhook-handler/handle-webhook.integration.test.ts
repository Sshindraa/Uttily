/**
 * @uttily/core — Tests d'intégration PostgreSQL du module Webhook Handler
 * (Lot 5, ADR-010 §10, §11, §13, §15).
 *
 * Tests PostgreSQL réels : confirmation nominale, multi-lignes, échecs
 * invariants, doublons, compensation tardive, événements désordonnés.
 * Reprend le pattern de initiate-payment.integration.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold } from '../booking-drafts';
import type { CreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from './handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput, WebhookHandlerResult } from './types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import { expireBookingDraftsBatch } from '../booking-drafts/expire-booking-drafts-batch';

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
        "settlement_merchant_mode"
      ) VALUES (
        gen_random_uuid(), ${ids.orgId}, ${draftId}, ${ids.userId}, 'PENDING_PROVIDER',
        ${amount}, 'EUR', 'NOT_APPLICABLE', 500,
        ${rawSql.json({ version: 'v1', basis: 'percentage', amountMinor: 500 })}, 'v1', 'v1',
        ${rawSql.json({ termsVersion: 'v1', userId: ids.userId, acceptedAt: new Date().toISOString() })},
        'acct_test_123', 'DESTINATION', 'PLATFORM'
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
});
