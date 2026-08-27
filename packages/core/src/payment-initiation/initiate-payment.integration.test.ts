import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold, expireBookingDraftsBatch } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput as CreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from './initiate-payment';
import type { InitiatePaymentDependencies, InitiatePaymentInput } from './types';
import { PaymentInitiationError } from './errors';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { PaymentProviderError } from '../payments/errors';
import type {
  PaymentProviderAdapter,
  CreatePaymentIntentParams,
  CancelPaymentIntentParams,
  CreateRefundParams,
  VerifyWebhookParams,
  CreateConnectedAccountParams,
  CreateOnboardingLinkParams,
  CreateAccountSessionParams,
} from '../payments/types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('payment_initiation');
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
  // Safety: drop any leftover test triggers/functions from previous runs.
  if (rawSql) {
    await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON booking_drafts`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
    await rawSql`DROP TRIGGER IF EXISTS test_block_trigger_b ON booking_drafts`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_before_update_b()`;
  }
  await db.execute(
    sql`TRUNCATE TABLE
      payment_attempts, payments, payment_webhook_events, organization_payment_accounts,
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

/** Période standard : 10–12 février 2026 (3 jours civils Europe/Paris). */
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

/**
 * Crée les données de base : organisation, lieu, utilisateur, catégorie,
 * produit PUBLISHED, variante (prix 5000, EUR, active), 3 exemplaires.
 */
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

interface PaymentAccountFixture {
  organizationId: string;
  provider: 'STRIPE';
  environment: 'TEST' | 'LIVE';
  providerAccountId: string;
  accountApiGeneration: 'ACCOUNTS_V2' | 'ACCOUNTS_V1_CONTROLLER_PROPERTIES';
  onboardingStatus: 'PENDING' | 'SUBMITTED' | 'ENABLED' | 'DISABLED' | 'REJECTED';
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'UNREQUESTED';
  settlementMerchantMode: 'PLATFORM' | 'CONNECTED_ACCOUNT';
  controllerConfigurationSnapshot: Record<string, unknown>;
  requirementsSnapshot: Record<string, unknown>;
}

/**
 * Insère un organization_payment_accounts pour l'organisation.
 */
async function seedPaymentAccount(
  ids: BaseIds,
  overrides: Partial<PaymentAccountFixture> = {},
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const defaults: PaymentAccountFixture = {
    organizationId: ids.orgId,
    provider: 'STRIPE',
    environment: 'TEST',
    providerAccountId: 'acct_test_123',
    accountApiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES',
    onboardingStatus: 'ENABLED',
    chargesEnabled: true,
    payoutsEnabled: true,
    transfersCapabilityStatus: 'ACTIVE',
    settlementMerchantMode: 'PLATFORM',
    controllerConfigurationSnapshot: { preset: 'CUSTOM' },
    requirementsSnapshot: {},
  };
  const merged = { ...defaults, ...overrides };
  await sql`
    INSERT INTO "organization_payment_accounts" (
      "organization_id", "provider", "environment", "provider_account_id",
      "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
      "transfers_capability_status", "settlement_merchant_mode",
      "controller_configuration_snapshot", "requirements_snapshot"
    ) VALUES (
      ${merged.organizationId}, ${merged.provider}, ${merged.environment}, ${merged.providerAccountId},
      ${merged.accountApiGeneration}, ${merged.onboardingStatus}, ${merged.chargesEnabled}, ${merged.payoutsEnabled},
      ${merged.transfersCapabilityStatus}, ${merged.settlementMerchantMode},
      ${sql.json(merged.controllerConfigurationSnapshot as unknown as Parameters<typeof sql.json>[0])}, ${sql.json(merged.requirementsSnapshot as unknown as Parameters<typeof sql.json>[0])}
    )
  `;
}

/**
 * Crée un brouillon HELD réel via createBookingDraftWithHold.
 */
async function createHeldDraft(ids: BaseIds, keySuffix: string): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const input: CreateBookingDraftInput = {
    pricingMode: 'LEGACY',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'held-' + keySuffix,
  };
  const result = await createBookingDraftWithHold(db, input);
  if (result.kind !== 'SUCCESS') throw new Error('Failed to create held draft');
  return result.body.draftId;
}

/**
 * Crée un brouillon HELD avec une quantité personnalisée.
 */
async function createHeldDraftWithQty(
  ids: BaseIds,
  keySuffix: string,
  quantity: number,
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const input: CreateBookingDraftInput = {
    pricingMode: 'LEGACY',
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

function makeFinancialTermsConfig(
  connectedAccountId: string = 'acct_test_123',
): FinancialTermsConfig {
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
      amountMinor: 500, // 5 EUR on 100 EUR
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

function makeInitiateInput(
  ids: BaseIds,
  draftId: string,
  keySuffix: string,
  overrides: Partial<InitiatePaymentInput> = {},
): InitiatePaymentInput {
  return {
    draftId,
    idempotencyKey: 'init-' + keySuffix,
    organizationId: ids.orgId,
    customerUserId: ids.userId,
    environment: 'TEST',
    financialTermsConfig: makeFinancialTermsConfig(),
    termsAcceptance: makeTermsAcceptance(ids.userId),
    ...overrides,
  };
}

function makeDeps(): InitiatePaymentDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: new FakeStripeAdapter({ environment: 'TEST' }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PostgreSQL synchronization helpers
// ─────────────────────────────────────────────────────────────────────────────

type RawSql = ReturnType<typeof postgres>;

/**
 * Poll pg_locks until an ungranted advisory lock waiter appears for the given key.
 * This proves the trigger has fired and the transaction is blocked.
 * Timeout after `timeoutMs` (default 5000ms).
 */
async function waitForAdvisoryLockWaiter(
  conn: RawSql,
  key: number,
  timeoutMs = 30000,
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
 * This proves the draft has actually expired according to the DB clock.
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

/**
 * Poll pg_locks/pg_stat_activity until a connection waiting for a row lock
 * on booking_drafts appears. This proves the initiation's SELECT FOR UPDATE
 * is blocked waiting for the batch's transaction to commit.
 */
async function waitForRowLockWaiterOnBookingDrafts(conn: RawSql, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await conn`
      SELECT 1 FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'transactionid'
        AND l.granted = false
        AND a.query LIKE '%booking_drafts%'
      LIMIT 1
    `;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for row lock waiter on booking_drafts (${timeoutMs}ms)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('initiatePayment — intégration PostgreSQL', () => {
  // 1. Initiation nominale
  it('1. initiation nominale : draft HELD → PAYMENT_PROCESSING, payment créé, PaymentIntent créé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'nominal');
    const deps = makeDeps();
    const input = makeInitiateInput(ids, draftId, 'nominal');

    const result = await initiatePayment(deps, input);

    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    expect(result.paymentId).toBeDefined();
    expect(result.paymentAttemptId).toBeDefined();
    expect(result.providerPaymentIntentId).toMatch(/^pi_/);
    expect(result.clientSecret).toBeDefined();
    expect(result.clientSecret).toContain('_secret_');
    expect(result.processingDeadlineAt).toBeInstanceOf(Date);

    // Verify draft transitioned to PAYMENT_PROCESSING
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

    // Verify blocks transitioned to PAYMENT_PROCESSING
    const blocks = await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId}`;
    for (const b of blocks) expect(b.status).toBe('PAYMENT_PROCESSING');

    // Verify allocations remain ALLOCATED
    const allocs = await rawSql`
        SELECT a.status FROM allocations a
        JOIN inventory_blocks ib ON a.inventory_block_id = ib.id
        WHERE ib.source_id = ${draftId}
      `;
    for (const a of allocs) expect(a.status).toBe('ALLOCATED');

    // Verify payment exists
    const payments =
      await rawSql`SELECT count(*)::int AS n FROM payments WHERE draft_id = ${draftId}`;
    expect(payments[0]!.n).toBe(1);

    // Verify payment_attempt exists
    const attempts = await rawSql`SELECT count(*)::int AS n FROM payment_attempts`;
    expect(attempts[0]!.n).toBe(1);
  });

  // 2. Transition multi-exemplaires tout ou rien
  it('2. transition multi-exemplaires : tous les blocs passent à PAYMENT_PROCESSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraftWithQty(ids, 'multi', 2);

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'multi'));
    expect(result.kind).toBe('SUCCESS');

    // All blocks should be PAYMENT_PROCESSING
    const blocks = await rawSql`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE status = 'PAYMENT_PROCESSING')::int AS pp
        FROM inventory_blocks WHERE source_id = ${draftId}
      `;
    expect(blocks[0]!.n).toBe(2);
    expect(blocks[0]!.pp).toBe(2);
  });

  // 3. Brouillon expiré refusé
  it('3. brouillon expiré refusé (DRAFT_EXPIRED)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'expired');

    // Set expires_at to past
    await rawSql`UPDATE "booking_drafts" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${draftId}`;
    await rawSql`UPDATE "inventory_blocks" SET "expires_at" = now() - interval '1 minute' WHERE "source_id" = ${draftId}`;

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'expired'));

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('VALIDATION'); // DRAFT_EXPIRED maps to VALIDATION
    expect(result.message).toContain('expir');

    // Draft should still be HELD (not transitioned)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 4. Termes financiers inconnus : aucune transition
  it('4. termes financiers non résolus : FINANCIAL_TERMS_UNRESOLVED, aucune transition', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'unresolved');

    const input = makeInitiateInput(ids, draftId, 'unresolved', {
      financialTermsConfig: {
        tax: null,
        commission: null,
        connectedAccount: null,
        legalTermsVersion: 'v1',
      },
    });

    const result = await initiatePayment(makeDeps(), input);

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('FINANCIAL_TERMS_UNRESOLVED');

    // Draft should still be HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 5a. Compte connecté absent
  it('5a. compte connecté absent : CONNECTED_ACCOUNT_NOT_FOUND', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Don't seed payment account
    const draftId = await createHeldDraft(ids, 'no-acct');

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'no-acct'));

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('NOT_FOUND');

    // Draft should still be HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 5b. Compte connecté non prêt (charges disabled)
  it('5b. compte connecté non prêt (charges disabled) : CONNECTED_ACCOUNT_NOT_READY', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids, { chargesEnabled: false });
    const draftId = await createHeldDraft(ids, 'not-ready');

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'not-ready'));

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('PAYMENT_ACCOUNT_NOT_READY');

    // Draft should still be HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 5b-bis. Compte connecté non prêt (payouts disabled)
  it('5b-bis. compte connecté non prêt (payouts disabled) : PAYMENT_ACCOUNT_NOT_READY', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids, { payoutsEnabled: false });
    const draftId = await createHeldDraft(ids, 'payouts-not-ready');

    const result = await initiatePayment(
      makeDeps(),
      makeInitiateInput(ids, draftId, 'payouts-not-ready'),
    );

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('PAYMENT_ACCOUNT_NOT_READY');

    // Le compte est contrôlé avant l'appel provider et le draft reste HELD.
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 5c. Mauvais environnement
  it('5c. mauvais environnement : CONNECTED_ACCOUNT_NOT_FOUND (TEST vs LIVE)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Seed a TEST account but request LIVE
    await seedPaymentAccount(ids, { environment: 'TEST' });
    const draftId = await createHeldDraft(ids, 'env-mismatch');

    const result = await initiatePayment(
      makeDeps(),
      makeInitiateInput(ids, draftId, 'env-mismatch', { environment: 'LIVE' }),
    );

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('NOT_FOUND');

    // Draft should still be HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 6. Isolation multi-tenant
  it('6. isolation multi-tenant : organisation B ne peut pas initier le draft de A', async () => {
    if (!db || !rawSql) return;
    const idsA = await seedBaseData('orga');
    const idsB = await seedBaseData('orgb');
    await seedPaymentAccount(idsA, { providerAccountId: 'acct_test_A' });
    await seedPaymentAccount(idsB, { providerAccountId: 'acct_test_B' });
    const draftId = await createHeldDraft(idsA, 'tenant');

    // Try to initiate with orgB's context
    const result = await initiatePayment(makeDeps(), makeInitiateInput(idsB, draftId, 'tenant'));

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('FORBIDDEN');
  });

  // 7. Même clé + même requête : même résultat (REPLAY)
  it('7. même clé + même requête : même paymentId, même attemptId (REPLAY)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'replay-same');

    const input = makeInitiateInput(ids, draftId, 'replay-same');
    const provider = new FakeStripeAdapter({ environment: 'TEST' });
    const deps = { db: db!, provider };
    const r1 = await initiatePayment(deps, input);
    expect(r1.kind).toBe('SUCCESS');

    // Second call with same key → REPLAY (same provider instance)
    const r2 = await initiatePayment(deps, input);
    expect(r2.kind).toBe('REPLAY');
    if (r2.kind !== 'REPLAY') return;
    expect(r2.paymentId).toBe((r1 as { paymentId: string }).paymentId);
    expect(r2.paymentAttemptId).toBe((r1 as { paymentAttemptId: string }).paymentAttemptId);
    expect(r2.providerPaymentIntentId).toBe(
      (r1 as { providerPaymentIntentId: string }).providerPaymentIntentId,
    );

    // Only one payment, one attempt in DB
    const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
    expect(payments[0]!.n).toBe(1);
    const attempts = await rawSql`SELECT count(*)::int AS n FROM payment_attempts`;
    expect(attempts[0]!.n).toBe(1);
  });

  // 8. Même clé + requête différente : 409
  it('8. même clé + requête différente : IDEMPOTENCY_CONFLICT (409)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conflict');

    const input1 = makeInitiateInput(ids, draftId, 'conflict');
    await initiatePayment(makeDeps(), input1);

    // Different request: different draftId
    const draftId2 = await createHeldDraft(ids, 'conflict2');
    const input2 = makeInitiateInput(ids, draftId2, 'conflict2', {
      idempotencyKey: input1.idempotencyKey,
    });

    await expect(initiatePayment(makeDeps(), input2)).rejects.toThrow(PaymentInitiationError);
    try {
      await initiatePayment(makeDeps(), input2);
    } catch (err) {
      expect((err as PaymentInitiationError).code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  // 9. Deux requêtes concurrentes avec la même clé
  it('9. deux requêtes concurrentes avec la même clé : un SUCCESS, un REPLAY', async () => {
    if (!db || !rawSql || !ctx) return;
    // Note: db2 connection is closed in the finally block below to avoid leaks.
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'concurrent-same');

    const input = makeInitiateInput(ids, draftId, 'concurrent-same');
    const db2 = createDatabase(ctx.databaseUrl);
    // Share a single FakeStripeAdapter instance across both concurrent requests
    // so that the REPLAY path can retrieve the PaymentIntent created by the
    // winning request. Using separate adapter instances would cause a
    // NOT_FOUND error in handleReplay since each FakeStripeAdapter has its
    // own in-memory state.
    const sharedProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const deps1 = { db: db!, provider: sharedProvider };
    const deps2 = { db: db2, provider: sharedProvider };

    try {
      const [r1, r2] = await Promise.all([
        initiatePayment(deps1, input),
        initiatePayment(deps2, input),
      ]);

      // One should be SUCCESS, the other REPLAY (or both SUCCESS with same IDs)
      const successCount = [r1, r2].filter((r) => r.kind === 'SUCCESS').length;
      const replayCount = [r1, r2].filter((r) => r.kind === 'REPLAY').length;
      expect(successCount + replayCount).toBe(2);

      // Both should have same paymentId
      const id1 = r1.kind === 'SUCCESS' ? r1.paymentId : (r1 as { paymentId: string }).paymentId;
      const id2 = r2.kind === 'SUCCESS' ? r2.paymentId : (r2 as { paymentId: string }).paymentId;
      expect(id1).toBe(id2);

      // Only one payment in DB
      const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
      expect(payments[0]!.n).toBe(1);
    } finally {
      await db2.$client.end();
    }
  }, 60000);

  // 10. Deux clés différentes sur le même draft : un payment, une tentative
  it('10. deux clés différentes sur le même draft : un payment, une tentative non terminale', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'two-keys');

    const input1 = makeInitiateInput(ids, draftId, 'two-keys-1');
    const provider = new FakeStripeAdapter({ environment: 'TEST' });
    const deps = { db: db!, provider };
    const r1 = await initiatePayment(deps, input1);
    expect(r1.kind).toBe('SUCCESS');

    const input2 = makeInitiateInput(ids, draftId, 'two-keys-2');
    const r2 = await initiatePayment(deps, input2);
    expect(r2.kind).toBe('SUCCESS');

    // Same paymentId
    expect((r1 as { paymentId: string }).paymentId).toBe((r2 as { paymentId: string }).paymentId);

    // Only one payment, one attempt in DB
    const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
    expect(payments[0]!.n).toBe(1);
    const attempts = await rawSql`
        SELECT count(*)::int AS n FROM payment_attempts
        WHERE status IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')
      `;
    expect(attempts[0]!.n).toBe(1);
  });

  // 11a. Concurrence réelle : initiation détient le verrou FOR UPDATE, batch SKIP LOCKED l'ignore
  it("11a. concurrence réelle : initiation détient le verrou FOR UPDATE, batch SKIP LOCKED l'ignore", async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conc-init');

    // Expirer le draft dans un futur proche selon l'horloge PostgreSQL.
    // L'initiation vérifie `transaction_timestamp() >= expires_at` au début de TX A :
    // à ce moment, le draft n'est PAS encore expiré, donc TX A procède.
    // Pendant que TX A est bloquée dans le trigger, le draft expire selon l'horloge PG.
    // Le batch voit alors `expires_at < now()` → true, tente SELECT FOR UPDATE SKIP LOCKED,
    // et saute la ligne car TX A détient le verrou.
    const expiryResult = await rawSql`SELECT (now() + interval '5 seconds')::timestamptz AS expiry`;
    const expiryIso = expiryResult[0]!.expiry.toISOString();
    await rawSql`UPDATE "booking_drafts" SET "expires_at" = ${expiryIso} WHERE "id" = ${draftId}`;
    await rawSql`UPDATE "inventory_blocks" SET "expires_at" = ${expiryIso} WHERE "source_id" = ${draftId}`;

    const sentinelKey = 98765;

    // Trigger: blocks on pg_advisory_xact_lock during UPDATE.
    // NOTE: The sentinel key must be inlined as a literal (not a parameter)
    // because it appears inside a $$ dollar-quoted function body, where
    // PostgreSQL cannot resolve $1-style parameter placeholders.
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
      BEFORE UPDATE ON booking_drafts
      FOR EACH ROW
      WHEN (NEW.id = '${draftId}'::uuid)
      EXECUTE FUNCTION test_block_before_update()
    `);

    // Sentinel connection holds the session-level lock.
    const sentinelConn = postgres(ctx.databaseUrl, { max: 1 });
    await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

    const db2 = createDatabase(ctx.databaseUrl);
    try {
      // Start initiation — TX A will SELECT FOR UPDATE, then UPDATE (trigger fires, blocks).
      const initPromise = initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'conc-init'));

      // 1. Poll pg_locks until the advisory lock waiter appears.
      //    This PROVES TX A reached the trigger and is blocked.
      await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

      // 2. Wait for PostgreSQL's clock to pass the expiry.
      //    This PROVES the draft is now expired according to the DB.
      await waitForPgTimePast(rawSql, expiryIso);

      // While TX A is blocked (holding the FOR UPDATE lock), run the batch.
      // Le batch voit expires_at < now() → true, tente SELECT FOR UPDATE SKIP LOCKED,
      // et saute la ligne car TX A détient le verrou.
      const expireResult = await expireBookingDraftsBatch(db2);
      expect(expireResult.expiredCount).toBe(0);

      // Release the sentinel — TX A's trigger unblocks, TX A commits.
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

      // Wait for initiation to complete.
      const initResult = await initPromise;
      expect(initResult.kind).toBe('SUCCESS');

      // Final state: PAYMENT_PROCESSING.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
    } finally {
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
      await sentinelConn.end();
      await db2.$client.end();
      // Clean up trigger and function.
      await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON booking_drafts`;
      await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
    }
  }, 60000);

  // 11b. Concurrence réelle : batch détient le verrou FOR UPDATE, initiation attend puis observe EXPIRED
  it('11b. concurrence réelle : batch détient le verrou FOR UPDATE, initiation attend puis observe EXPIRED', async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'conc-expire');

    // Make draft expired.
    const expiredTime = new Date(Date.now() - 60000).toISOString();
    await rawSql`UPDATE "booking_drafts" SET "expires_at" = ${expiredTime} WHERE "id" = ${draftId}`;
    await rawSql`UPDATE "inventory_blocks" SET "expires_at" = ${expiredTime} WHERE "source_id" = ${draftId}`;

    const sentinelKey = 98766;

    // Same trigger approach — block the batch's UPDATE.
    // NOTE: The sentinel key must be inlined as a literal (not a parameter)
    // because it appears inside a $$ dollar-quoted function body.
    await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_before_update_b()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await rawSql.unsafe(`
      CREATE TRIGGER test_block_trigger_b
      BEFORE UPDATE ON booking_drafts
      FOR EACH ROW
      WHEN (NEW.id = '${draftId}'::uuid)
      EXECUTE FUNCTION test_block_before_update_b()
    `);

    const sentinelConn = postgres(ctx.databaseUrl, { max: 1 });
    await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

    const db2 = createDatabase(ctx.databaseUrl);
    try {
      // Start the batch — it will SELECT FOR UPDATE SKIP LOCKED (gets the lock),
      // then UPDATE (trigger fires, blocks).
      const batchPromise = expireBookingDraftsBatch(db2);

      // 1. Poll pg_locks until the batch's advisory lock waiter appears.
      //    This PROVES the batch reached the trigger and is blocked, holding the FOR UPDATE lock.
      await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

      // 2. Start initiation — TX A does SELECT FOR UPDATE (NOT SKIP LOCKED) → waits.
      const initPromise = initiatePayment(
        makeDeps(),
        makeInitiateInput(ids, draftId, 'conc-expire'),
      );

      // 3. Poll pg_locks/pg_stat_activity for the initiation waiting for the row lock.
      //    The initiation's SELECT FOR UPDATE will wait for the batch's transaction.
      //    This shows up as an ungranted transactionid lock with a query referencing booking_drafts.
      await waitForRowLockWaiterOnBookingDrafts(rawSql);

      // 4. Release the sentinel — batch's trigger unblocks, batch commits (EXPIRED).
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

      // 5. Wait for the batch to complete.
      const batchResult = await batchPromise;
      expect(batchResult.expiredCount).toBe(1);

      // 6. Initiation was waiting for the lock. Now the batch has committed,
      //    initiation gets the lock and sees EXPIRED.
      const initResult = await initPromise;
      expect(initResult.kind).toBe('FAILURE');

      // Final state: EXPIRED.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('EXPIRED');
    } finally {
      await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
      await sentinelConn.end();
      await db2.$client.end();
      // Clean up trigger and function.
      await rawSql`DROP TRIGGER IF EXISTS test_block_trigger_b ON booking_drafts`;
      await rawSql`DROP FUNCTION IF EXISTS test_block_before_update_b()`;
    }
  });

  // 12. Invariant rompu : rollback total
  it('12. invariant rompu (bloc non ACTIVE) : rollback total, aucune transition', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'invariant');

    // Manually set a block to EXPIRED (inconsistent with HELD draft)
    await rawSql`
        UPDATE "inventory_blocks" SET "status" = 'EXPIRED'
        WHERE "source_id" = ${draftId}
        AND "id" = (SELECT "id" FROM "inventory_blocks" WHERE "source_id" = ${draftId} LIMIT 1)
      `;

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'invariant'));
    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNKNOWN');

    // Draft should still be HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');

    // No payment created
    const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
    expect(payments[0]!.n).toBe(0);
  });

  // 13. Panne avant commit A : aucun état partiel
  it('13. panne avant commit A (erreur métier) : aucun état partiel', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Don't seed payment account → CONNECTED_ACCOUNT_NOT_FOUND
    const draftId = await createHeldDraft(ids, 'no-account');

    const result = await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'no-account'));
    expect(result.kind).toBe('FAILURE');

    // Draft still HELD
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');

    // No payment, no attempt
    const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
    expect(payments[0]!.n).toBe(0);

    // Idempotency record should be FAILED (not PENDING)
    const idem =
      await rawSql`SELECT status FROM idempotency_records WHERE operation = 'initiate_payment' LIMIT 1`;
    expect(idem[0]!.status).toBe('FAILED');
  });

  // 14. Erreur réseau après commit A : holds protégés, tentative récupérable
  it('14. erreur réseau après commit A : holds protégés (PAYMENT_PROCESSING), tentative récupérable', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'network-error');

    // Use a fake that throws on createPaymentIntent
    const errorProvider = new FakeStripeAdapter({
      environment: 'TEST',
      forceCreatePaymentIntentError: new PaymentProviderError(
        'UNKNOWN',
        'Network error',
        'network_error',
      ),
    });
    const deps: InitiatePaymentDependencies = { db: db!, provider: errorProvider };

    // initiatePayment should throw PROVIDER_CALL_FAILED
    await expect(
      initiatePayment(deps, makeInitiateInput(ids, draftId, 'network-error')),
    ).rejects.toThrow();

    // Draft should be PAYMENT_PROCESSING (Transaction A committed)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

    // Blocks should be PAYMENT_PROCESSING
    const blocks = await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId}`;
    for (const b of blocks) expect(b.status).toBe('PAYMENT_PROCESSING');

    // Payment and attempt should exist
    const payments = await rawSql`SELECT count(*)::int AS n FROM payments`;
    expect(payments[0]!.n).toBe(1);
    const attempts = await rawSql`SELECT count(*)::int AS n FROM payment_attempts`;
    expect(attempts[0]!.n).toBe(1);

    // Idempotency record should still be PENDING (recoverable by retry)
    const idem =
      await rawSql`SELECT status FROM idempotency_records WHERE operation = 'initiate_payment' LIMIT 1`;
    expect(idem[0]!.status).toBe('PENDING');

    // Retry with a working provider should succeed
    const retryResult = await initiatePayment(
      makeDeps(),
      makeInitiateInput(ids, draftId, 'network-error'),
    );
    expect(retryResult.kind).toBe('SUCCESS');
  });

  // 15. Retry après échec B : même PaymentIntent, pas de double création
  it('15. retry après échec B : même PaymentIntent, pas de double création', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'retry-b');

    // Use a SINGLE provider instance that tracks create vs retrieve
    const provider = new FakeStripeAdapter({ environment: 'TEST' });
    let createCallCount = 0;
    const baseCreate = provider.createPaymentIntent.bind(provider);
    provider.createPaymentIntent = async (params) => {
      createCallCount++;
      return baseCreate(params);
    };
    let retrieveCallCount = 0;
    const baseRetrieve = provider.retrievePaymentIntent.bind(provider);
    provider.retrievePaymentIntent = async (id) => {
      retrieveCallCount++;
      return baseRetrieve(id);
    };

    const deps = { db: db!, provider };
    const input = makeInitiateInput(ids, draftId, 'retry-b');

    // First call: succeeds fully (A + Stripe + B)
    const r1 = await initiatePayment(deps, input);
    expect(r1.kind).toBe('SUCCESS');
    expect(createCallCount).toBe(1);
    expect(retrieveCallCount).toBe(0);
    const originalIntentId = (r1 as { providerPaymentIntentId: string }).providerPaymentIntentId;

    // Simulate crash after Stripe but before B: reset idempotency to PENDING
    // and clear the provider projection on the attempt
    await rawSql`UPDATE "idempotency_records" SET "status" = 'PENDING', "completed_at" = NULL, "resource_id" = NULL, "response_status_code" = NULL, "response_body" = NULL WHERE "operation" = 'initiate_payment' AND "key" = ${input.idempotencyKey}`;
    await rawSql`UPDATE "payment_attempts" SET "provider_payment_intent_id" = NULL, "provider_status" = NULL, "status" = 'PENDING_PROVIDER' WHERE "payment_id" = (SELECT id FROM payments WHERE draft_id = ${draftId})`;

    // Reset counters
    createCallCount = 0;
    retrieveCallCount = 0;

    // Retry with same key — Transaction A finds existing attempt without provider_payment_intent_id
    // Since the attempt is non-terminal (PENDING_PROVIDER), it reuses it
    // Then calls createPaymentIntent with the same provider idempotency key → same PaymentIntent
    const r2 = await initiatePayment(deps, input);
    expect(r2.kind).toBe('SUCCESS');

    // Same PaymentIntent ID (provider idempotency ensures this)
    expect((r2 as { providerPaymentIntentId: string }).providerPaymentIntentId).toBe(
      originalIntentId,
    );

    // createPaymentIntent was called again (not retrieve) since provider_payment_intent_id was null
    expect(createCallCount).toBe(1);
    expect(retrieveCallCount).toBe(0);

    // Only one attempt in DB
    const attempts = await rawSql`SELECT count(*)::int AS n FROM payment_attempts`;
    expect(attempts[0]!.n).toBe(1);
  });

  // 16. Replay COMPLETED : retrieve, pas create
  it('16. replay COMPLETED : retrieve le PaymentIntent, pas create', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'replay-completed');

    const input = makeInitiateInput(ids, draftId, 'replay-completed');
    const provider = new FakeStripeAdapter({ environment: 'TEST' });
    const deps = { db: db!, provider };
    const r1 = await initiatePayment(deps, input);
    expect(r1.kind).toBe('SUCCESS');

    // Replay with same key (same provider instance)
    const r2 = await initiatePayment(deps, input);
    expect(r2.kind).toBe('REPLAY');
    if (r2.kind !== 'REPLAY') return;
    expect(r2.providerPaymentIntentId).toBe(
      (r1 as { providerPaymentIntentId: string }).providerPaymentIntentId,
    );
    expect(r2.clientSecret).toBeDefined();
  });

  // 17. clientSecret absent de payments, payment_attempts et idempotency_records
  it('17. clientSecret absent de payments, payment_attempts et idempotency_records', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'no-secret');

    await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'no-secret'));

    // Check payments table
    const paymentRows = await rawSql`SELECT * FROM payments`;
    const paymentJson = JSON.stringify(paymentRows);
    expect(paymentJson).not.toContain('client_secret');
    expect(paymentJson).not.toContain('clientSecret');

    // Check payment_attempts table
    const attemptRows = await rawSql`SELECT * FROM payment_attempts`;
    const attemptJson = JSON.stringify(attemptRows);
    expect(attemptJson).not.toContain('client_secret');
    expect(attemptJson).not.toContain('clientSecret');

    // Check idempotency_records
    const idemRows = await rawSql`SELECT * FROM idempotency_records`;
    const idemJson = JSON.stringify(idemRows);
    expect(idemJson).not.toContain('client_secret');
    expect(idemJson).not.toContain('clientSecret');
    expect(idemJson).not.toContain('_secret_');
  });

  // 18. Provider appelé hors transaction
  it("18. provider appelé hors transaction (draft déjà PAYMENT_PROCESSING avant l'appel)", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'outside-tx');

    // Use a custom provider wrapper that checks draft status when called
    let draftStatusAtProviderTime: string | null = null;
    const baseProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const trackingProvider: PaymentProviderAdapter = {
      environment: 'TEST' as const,
      createPaymentIntent: async (params: CreatePaymentIntentParams) => {
        const draft = await rawSql!`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
        draftStatusAtProviderTime = draft[0]!.status;
        return baseProvider.createPaymentIntent(params);
      },
      retrievePaymentIntent: (id: string) => baseProvider.retrievePaymentIntent(id),
      cancelPaymentIntent: (p: CancelPaymentIntentParams) => baseProvider.cancelPaymentIntent(p),
      createRefund: (p: CreateRefundParams) => baseProvider.createRefund(p),
      retrieveRefund: (id: string) => baseProvider.retrieveRefund(id),
      verifyWebhook: (p: VerifyWebhookParams) => baseProvider.verifyWebhook(p),
      createConnectedAccount: (p: CreateConnectedAccountParams) =>
        baseProvider.createConnectedAccount(p),
      retrieveConnectedAccount: (id: string) => baseProvider.retrieveConnectedAccount(id),
      createOnboardingLink: (p: CreateOnboardingLinkParams) => baseProvider.createOnboardingLink(p),
      createAccountSession: (p: CreateAccountSessionParams) => baseProvider.createAccountSession(p),
      projectCapabilities: (id: string) => baseProvider.projectCapabilities(id),
    };

    const result = await initiatePayment(
      { db: db!, provider: trackingProvider },
      makeInitiateInput(ids, draftId, 'outside-tx'),
    );
    expect(result.kind).toBe('SUCCESS');

    // Draft was already PAYMENT_PROCESSING when provider was called
    expect(draftStatusAtProviderTime).toBe('PAYMENT_PROCESSING');
  });

  // 19. Contrainte PostgreSQL d'une seule tentative non terminale
  it('19. contrainte PostgreSQL : une seule tentative non terminale par paiement', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'unique-attempt');

    await initiatePayment(makeDeps(), makeInitiateInput(ids, draftId, 'unique-attempt'));

    // Try to insert a second non-terminal attempt directly — should fail
    const payment = await rawSql`SELECT id FROM payments WHERE draft_id = ${draftId}`;
    await expect(
      rawSql`
          INSERT INTO "payment_attempts" (
            "organization_id", "payment_id", "attempt_number", "status",
            "provider_idempotency_key", "provider_status"
          ) VALUES (
            ${ids.orgId}, ${payment[0]!.id}, 2, 'PENDING_PROVIDER',
            'pi_manual_key', NULL
          )
        `,
    ).rejects.toThrow(); // unique constraint violation
  });

  // 20. Ordre de verrouillage déterministe : pas de deadlock en concurrence
  it('20. ordre de verrouillage déterministe : pas de deadlock en concurrence', async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);

    // Create two drafts
    const draftId1 = await createHeldDraft(ids, 'lock-1');
    const draftId2 = await createHeldDraft(ids, 'lock-2');

    const db2 = createDatabase(ctx.databaseUrl);
    try {
      // Concurrent initiations on different drafts — should not deadlock
      const [r1, r2] = await Promise.all([
        initiatePayment(makeDeps(), makeInitiateInput(ids, draftId1, 'lock-1')),
        initiatePayment(
          { db: db2, provider: new FakeStripeAdapter({ environment: 'TEST' }) },
          makeInitiateInput(ids, draftId2, 'lock-2'),
        ),
      ]);

      expect(r1.kind).toBe('SUCCESS');
      expect(r2.kind).toBe('SUCCESS');
    } finally {
      await db2.$client.end();
    }
  });

  // 23. Garde monotone : webhook terminal pendant Transaction B, pas de régression
  it('23. garde monotone : webhook terminal pendant Transaction B, pas de régression', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'monotone');

    const baseProvider = new FakeStripeAdapter({ environment: 'TEST' });
    // Custom provider that simulates a webhook setting SUCCEEDED during the provider call
    const webhookSimulatingProvider: PaymentProviderAdapter = {
      environment: 'TEST' as const,
      createPaymentIntent: async (params: CreatePaymentIntentParams) => {
        // Simulate webhook: set the attempt to SUCCEEDED before the provider returns
        await rawSql!`
          UPDATE "payment_attempts"
          SET "status" = 'SUCCEEDED', "provider_status" = 'succeeded', "updated_at" = now()
          WHERE "payment_id" = (SELECT id FROM payments WHERE draft_id = ${draftId})
        `;
        await rawSql!`
          UPDATE "payments"
          SET "status" = 'SUCCEEDED', "succeeded_at" = now(), "updated_at" = now()
          WHERE "draft_id" = ${draftId}
        `;
        // Return a non-terminal status to test the guard
        const result = await baseProvider.createPaymentIntent(params);
        return { ...result, status: 'requires_payment_method' as const };
      },
      retrievePaymentIntent: (id: string) => baseProvider.retrievePaymentIntent(id),
      cancelPaymentIntent: (p: CancelPaymentIntentParams) => baseProvider.cancelPaymentIntent(p),
      createRefund: (p: CreateRefundParams) => baseProvider.createRefund(p),
      retrieveRefund: (id: string) => baseProvider.retrieveRefund(id),
      verifyWebhook: (p: VerifyWebhookParams) => baseProvider.verifyWebhook(p),
      createConnectedAccount: (p: CreateConnectedAccountParams) =>
        baseProvider.createConnectedAccount(p),
      retrieveConnectedAccount: (id: string) => baseProvider.retrieveConnectedAccount(id),
      createOnboardingLink: (p: CreateOnboardingLinkParams) => baseProvider.createOnboardingLink(p),
      createAccountSession: (p: CreateAccountSessionParams) => baseProvider.createAccountSession(p),
      projectCapabilities: (id: string) => baseProvider.projectCapabilities(id),
    };

    const deps = { db: db!, provider: webhookSimulatingProvider };
    const result = await initiatePayment(deps, makeInitiateInput(ids, draftId, 'monotone'));

    // Should succeed (Transaction B completes, but doesn't regress)
    expect(result.kind).toBe('SUCCESS');

    // Verify attempt status is still SUCCEEDED (not regressed to REQUIRES_PAYMENT_METHOD)
    const attempt =
      await rawSql`SELECT status, provider_status FROM payment_attempts WHERE payment_id = (SELECT id FROM payments WHERE draft_id = ${draftId})`;
    expect(attempt[0]!.status).toBe('SUCCEEDED');
    expect(attempt[0]!.provider_status).toBe('succeeded'); // Not overwritten to 'requires_payment_method'

    // Verify payments.status is still SUCCEEDED
    const payment = await rawSql`SELECT status FROM payments WHERE draft_id = ${draftId}`;
    expect(payment[0]!.status).toBe('SUCCEEDED');
  });

  // 24. Validation réponse provider : montant incohérent → PROVIDER_STATE_INCONSISTENT
  it('24. validation réponse provider : montant incohérent → PROVIDER_STATE_INCONSISTENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'wrong-amount');

    const baseProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const wrongAmountProvider: PaymentProviderAdapter = {
      environment: 'TEST' as const,
      createPaymentIntent: async (params: CreatePaymentIntentParams) => {
        const result = await baseProvider.createPaymentIntent(params);
        // Return a different amount than what was persisted
        return { ...result, amountMinor: result.amountMinor + 1 };
      },
      retrievePaymentIntent: (id: string) => baseProvider.retrievePaymentIntent(id),
      cancelPaymentIntent: (p: CancelPaymentIntentParams) => baseProvider.cancelPaymentIntent(p),
      createRefund: (p: CreateRefundParams) => baseProvider.createRefund(p),
      retrieveRefund: (id: string) => baseProvider.retrieveRefund(id),
      verifyWebhook: (p: VerifyWebhookParams) => baseProvider.verifyWebhook(p),
      createConnectedAccount: (p: CreateConnectedAccountParams) =>
        baseProvider.createConnectedAccount(p),
      retrieveConnectedAccount: (id: string) => baseProvider.retrieveConnectedAccount(id),
      createOnboardingLink: (p: CreateOnboardingLinkParams) => baseProvider.createOnboardingLink(p),
      createAccountSession: (p: CreateAccountSessionParams) => baseProvider.createAccountSession(p),
      projectCapabilities: (id: string) => baseProvider.projectCapabilities(id),
    };

    const result = await initiatePayment(
      { db: db!, provider: wrongAmountProvider },
      makeInitiateInput(ids, draftId, 'wrong-amount'),
    );

    // Transaction B detects the amount mismatch and returns FAILURE
    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');

    // Draft should be PAYMENT_PROCESSING (Transaction A committed before the error)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
  });

  // 25. Autorité serveur : connectedAccountId du snapshot ≠ compte → PROVIDER_STATE_INCONSISTENT
  it('25. autorité serveur : connectedAccountId du snapshot ≠ compte → PROVIDER_STATE_INCONSISTENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids, { providerAccountId: 'acct_actual' });
    const draftId = await createHeldDraft(ids, 'acct-mismatch');

    // Use a snapshot with a DIFFERENT connectedAccountId than the account
    const input = makeInitiateInput(ids, draftId, 'acct-mismatch', {
      financialTermsConfig: makeFinancialTermsConfig('acct_wrong'),
    });

    const result = await initiatePayment(makeDeps(), input);

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');

    // Draft should still be HELD (error in Transaction A)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 26. Autorité serveur : settlementMerchantMode du snapshot ≠ compte → PROVIDER_STATE_INCONSISTENT
  it('26. autorité serveur : settlementMerchantMode du snapshot ≠ compte → PROVIDER_STATE_INCONSISTENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Seed account with PLATFORM mode
    await seedPaymentAccount(ids, { settlementMerchantMode: 'PLATFORM' });
    const draftId = await createHeldDraft(ids, 'settlement-mismatch');

    // Use a snapshot with CONNECTED_ACCOUNT mode (mismatch)
    const config = makeFinancialTermsConfig();
    config.connectedAccount!.settlementMerchantMode = 'CONNECTED_ACCOUNT';

    const input = makeInitiateInput(ids, draftId, 'settlement-mismatch', {
      financialTermsConfig: config,
    });

    const result = await initiatePayment(makeDeps(), input);

    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');

    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('HELD');
  });

  // 27. Validation réponse provider : destination différente → PROVIDER_STATE_INCONSISTENT
  it('27. validation réponse provider : destination différente → PROVIDER_STATE_INCONSISTENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'wrong-dest');

    const baseProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const wrongDestProvider: PaymentProviderAdapter = {
      environment: 'TEST' as const,
      createPaymentIntent: async (params: CreatePaymentIntentParams) => {
        const result = await baseProvider.createPaymentIntent(params);
        // Return a different connectedAccountId than what was persisted
        return { ...result, connectedAccountId: 'acct_wrong' };
      },
      retrievePaymentIntent: (id: string) => baseProvider.retrievePaymentIntent(id),
      cancelPaymentIntent: (p: CancelPaymentIntentParams) => baseProvider.cancelPaymentIntent(p),
      createRefund: (p: CreateRefundParams) => baseProvider.createRefund(p),
      retrieveRefund: (id: string) => baseProvider.retrieveRefund(id),
      verifyWebhook: (p: VerifyWebhookParams) => baseProvider.verifyWebhook(p),
      createConnectedAccount: (p: CreateConnectedAccountParams) =>
        baseProvider.createConnectedAccount(p),
      retrieveConnectedAccount: (id: string) => baseProvider.retrieveConnectedAccount(id),
      createOnboardingLink: (p: CreateOnboardingLinkParams) => baseProvider.createOnboardingLink(p),
      createAccountSession: (p: CreateAccountSessionParams) => baseProvider.createAccountSession(p),
      projectCapabilities: (id: string) => baseProvider.projectCapabilities(id),
    };

    const result = await initiatePayment(
      { db: db!, provider: wrongDestProvider },
      makeInitiateInput(ids, draftId, 'wrong-dest'),
    );

    // Transaction B detects the destination mismatch and returns FAILURE
    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');

    // Draft should be PAYMENT_PROCESSING (Transaction A committed before the error)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
  });

  // 28. Validation réponse provider : destination nulle → PROVIDER_STATE_INCONSISTENT (fail-closed)
  it('28. validation réponse provider : destination nulle → PROVIDER_STATE_INCONSISTENT (fail-closed)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedPaymentAccount(ids);
    const draftId = await createHeldDraft(ids, 'null-dest');

    const baseProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const nullDestProvider: PaymentProviderAdapter = {
      environment: 'TEST' as const,
      createPaymentIntent: async (params: CreatePaymentIntentParams) => {
        const result = await baseProvider.createPaymentIntent(params);
        // Return null connectedAccountId (missing transfer_data.destination)
        return { ...result, connectedAccountId: null };
      },
      retrievePaymentIntent: (id: string) => baseProvider.retrievePaymentIntent(id),
      cancelPaymentIntent: (p: CancelPaymentIntentParams) => baseProvider.cancelPaymentIntent(p),
      createRefund: (p: CreateRefundParams) => baseProvider.createRefund(p),
      retrieveRefund: (id: string) => baseProvider.retrieveRefund(id),
      verifyWebhook: (p: VerifyWebhookParams) => baseProvider.verifyWebhook(p),
      createConnectedAccount: (p: CreateConnectedAccountParams) =>
        baseProvider.createConnectedAccount(p),
      retrieveConnectedAccount: (id: string) => baseProvider.retrieveConnectedAccount(id),
      createOnboardingLink: (p: CreateOnboardingLinkParams) => baseProvider.createOnboardingLink(p),
      createAccountSession: (p: CreateAccountSessionParams) => baseProvider.createAccountSession(p),
      projectCapabilities: (id: string) => baseProvider.projectCapabilities(id),
    };

    const result = await initiatePayment(
      { db: db!, provider: nullDestProvider },
      makeInitiateInput(ids, draftId, 'null-dest'),
    );

    // Transaction B detects the null destination (fail-closed) and returns FAILURE
    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');

    // Draft should be PAYMENT_PROCESSING (Transaction A committed before the error)
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
    expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
  });

  // 29. Réutilisation d'un paiement dans un environnement différent → UNSUPPORTED_PROVIDER_STATE
  // (mappage public de PROVIDER_STATE_INCONSISTENT via toActionErrorCode()).
  it('29. réutilisation paiement environnement différent : paiement TEST existant, initiation LIVE → UNSUPPORTED_PROVIDER_STATE (mappage public de PROVIDER_STATE_INCONSISTENT)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Seeder un compte TEST et un compte LIVE pour la même org.
    await seedPaymentAccount(ids, { environment: 'TEST', providerAccountId: 'acct_test_123' });
    await seedPaymentAccount(ids, { environment: 'LIVE', providerAccountId: 'acct_live_123' });
    const draftId = await createHeldDraft(ids, 'env-reuse');

    // Première initiation en TEST — crée un paiement TEST.
    const testProvider = new FakeStripeAdapter({ environment: 'TEST' });
    const testInput = makeInitiateInput(ids, draftId, 'env-reuse-test', {
      environment: 'TEST',
      financialTermsConfig: makeFinancialTermsConfig('acct_test_123'),
    });
    const r1 = await initiatePayment({ db: db!, provider: testProvider }, testInput);
    expect(r1.kind).toBe('SUCCESS');

    // Vérifier que le paiement est en environnement TEST.
    const paymentRow = await rawSql`SELECT environment FROM payments WHERE draft_id = ${draftId}`;
    expect(paymentRow[0]!.environment).toBe('TEST');

    // Deuxième initiation avec une clé différente mais en LIVE — doit détecter
    // que le payment existant est TEST et lever PROVIDER_STATE_INCONSISTENT.
    const liveProvider = new FakeStripeAdapter({ environment: 'LIVE' });
    const liveInput = makeInitiateInput(ids, draftId, 'env-reuse-live', {
      environment: 'LIVE',
      financialTermsConfig: makeFinancialTermsConfig('acct_live_123'),
    });

    const result = await initiatePayment({ db: db!, provider: liveProvider }, liveInput);
    expect(result.kind).toBe('FAILURE');
    if (result.kind !== 'FAILURE') return;
    // Le code interne PROVIDER_STATE_INCONSISTENT est mappé vers UNSUPPORTED_PROVIDER_STATE
    // pour l'API publique via toActionErrorCode().
    expect(result.error).toBe('UNSUPPORTED_PROVIDER_STATE');
    expect(result.message).toContain('TEST');
    expect(result.message).toContain('LIVE');
  });
});
