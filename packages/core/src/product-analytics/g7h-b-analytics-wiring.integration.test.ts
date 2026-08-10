/**
 * @uttily/core — Tests d'integration PostgreSQL G7H-B (analytics wiring).
 *
 * Verifie le cablage des trois evenements analytics dans les parcours reels :
 * - BOOKING_ATTEMPTED enregistre avant l'echec metier.
 * - Replay → un seul evenement.
 * - Deux appels concurrents → un seul evenement.
 * - sourceId = UUID de l'enregistrement d'idempotence.
 * - BOOKING_CONFIRMED atomique avec la confirmation.
 * - Echec analytics dans le savepoint ne rollback pas le booking/outbox.
 * - Rollback metier ne laisse pas d'evenement BOOKING_CONFIRMED.
 * - Concurrent webhook/reconciliation → un booking et un evenement.
 * - Separation DEVELOPMENT/TEST.
 * - Aucune ligne PRODUCTION.
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
import { createBookingDraftWithHold, BookingDraftError } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput } from '../webhook-handler/types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import { reconcilePaymentsBatch, type ReconciliationDependencies } from '../payment-reconciliation';
import { recordProductAnalyticsEvent } from './record-event';
import type { ResolvedAnalyticsEnvironment } from './runtime';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g7h_b_wiring');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 5 });
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourne null sans lever d'erreur.");
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
      location_opening_hours, pricing_plan_translations, pricing_plan_windows,
      multi_day_discount_tiers, pricing_plans, locations, organization_memberships,
      organizations, users, idempotency_records, product_analytics_events, product_analytics_daily
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

function makeInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
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

function makeInitiateInput(
  ids: BaseIds,
  draftId: string,
  keySuffix: string,
  accountId = 'acct_test_123',
): InitiatePaymentInput {
  return {
    draftId,
    idempotencyKey: 'init-' + keySuffix,
    organizationId: ids.orgId,
    customerUserId: ids.userId,
    environment: 'TEST',
    financialTermsConfig: makeFinancialTermsConfig(accountId),
    termsAcceptance: makeTermsAcceptance(ids.userId),
  };
}

function makeInitDeps(): InitiatePaymentDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: new FakeStripeAdapter({ environment: 'TEST' }),
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

async function getPaymentAmount(draftId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const row = await rawSql`SELECT amount_minor FROM payments WHERE draft_id = ${draftId}`.then(
    (r) => r[0],
  );
  return Number(row!.amount_minor);
}

async function getPaymentId(draftId: string): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const row = await rawSql`SELECT id FROM payments WHERE draft_id = ${draftId}`.then((r) => r[0]);
  return row!.id;
}

/** Compte les evenements analytics par type et environnement. */
async function countAnalyticsEvents(eventType?: string, environment?: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  if (eventType && environment) {
    const rows = await rawSql`
      SELECT COUNT(*)::int as cnt FROM product_analytics_events
      WHERE event_type = ${eventType} AND environment = ${environment}
    `;
    return rows[0]!.cnt;
  }
  if (eventType) {
    const rows = await rawSql`
      SELECT COUNT(*)::int as cnt FROM product_analytics_events
      WHERE event_type = ${eventType}
    `;
    return rows[0]!.cnt;
  }
  const rows = await rawSql`SELECT COUNT(*)::int as cnt FROM product_analytics_events`;
  return rows[0]!.cnt;
}

/** Recupere tous les evenements analytics d'un type donne. */
async function getAnalyticsEvents(eventType: string): Promise<
  Array<{
    id: string;
    event_type: string;
    environment: string;
    source_id: string;
    occurred_at: Date;
    has_results: boolean | null;
  }>
> {
  if (!rawSql) throw new Error('rawSql not initialized');
  return rawSql`
    SELECT id, event_type, environment, source_id, occurred_at, has_results
    FROM product_analytics_events
    WHERE event_type = ${eventType}
    ORDER BY occurred_at
  ` as Promise<
    Array<{
      id: string;
      event_type: string;
      environment: string;
      source_id: string;
      occurred_at: Date;
      has_results: boolean | null;
    }>
  >;
}

/** Definit process.env.PRODUCT_ANALYTICS_ENVIRONMENT temporairement et restaure apres. */
function withAnalyticsEnv<T>(env: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
  if (env === undefined) {
    delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
  } else {
    process.env.PRODUCT_ANALYTICS_ENVIRONMENT = env;
  }
  return fn().finally(() => {
    if (original === undefined) {
      delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
    } else {
      process.env.PRODUCT_ANALYTICS_ENVIRONMENT = original;
    }
  });
}

/**
 * Attend qu'une connexion PostgreSQL attende un advisory lock (granted=false).
 * Permet de synchroniser deterministiquement deux operations concurrentes.
 */
async function waitForAdvisoryLockWaiter(
  conn: ReturnType<typeof postgres>,
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
  'G7H-B — Analytics wiring (integration PostgreSQL)',
  () => {
    // =========================================================================
    // BOOKING_ATTEMPTED
    // =========================================================================
    describe('BOOKING_ATTEMPTED', () => {
      it("enregistre BOOKING_ATTEMPTED apres reserveKey et avant l'echec metier (LEGACY)", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-fail');
        // Declencher un VRAI echec metier (availability conflict) apres reserveKey :
        // quantity 4 > 3 exemplaires disponibles → CONFLICT_BLOCK.
        const input = makeInput(ids, {
          customerStartAt: STD_START,
          customerEndAt: STD_END,
          idempotencyKey: 'attempt-fail-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 4 }],
        });
        // L'appel doit retourner FAILURE (pas throw) — l'echec metier est persiste
        // via failKey et retourne comme union FAILURE.
        const result = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        // Le test doit FAIL si l'operation retourne SUCCESS.
        expect(result.kind).toBe('FAILURE');
        if (result.kind !== 'FAILURE') return; // type narrowing
        expect(result.statusCode).toBe(409);
        expect(result.body.error).toBe('CONFLICT_BLOCK');

        // Verifier que l'enregistrement d'idempotence existe en status FAILED.
        const idempotencyRecord = await rawSql`
          SELECT id, created_at, status FROM idempotency_records
          WHERE key = ${input.idempotencyKey}
        `.then((r) => r[0]!);
        expect(idempotencyRecord.status).toBe('FAILED');

        // Verifier BOOKING_ATTEMPTED existe avec exact sourceId/occurredAt.
        const events = await getAnalyticsEvents('BOOKING_ATTEMPTED');
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.source_id).toBe(idempotencyRecord.id);
        expect(event.occurred_at.getTime()).toBe(idempotencyRecord.created_at.getTime());
        expect(event.environment).toBe('DEVELOPMENT');
      });

      it('enregistre BOOKING_ATTEMPTED avec sourceId = record.id et occurredAt = record.createdAt', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-ids');
        const input = makeInput(ids, { idempotencyKey: 'attempt-ids-' + SUFFIX() });
        await createBookingDraftWithHold(db, input, 'DEVELOPMENT');

        const events = await getAnalyticsEvents('BOOKING_ATTEMPTED');
        expect(events).toHaveLength(1);
        const event = events[0]!;
        // sourceId doit etre l'UUID de l'enregistrement d'idempotence.
        const idempotencyRecord = await rawSql`
          SELECT id, created_at FROM idempotency_records
          WHERE key = ${input.idempotencyKey}
        `.then((r) => r[0]!);
        expect(event.source_id).toBe(idempotencyRecord.id);
        expect(event.occurred_at.getTime()).toBe(idempotencyRecord.created_at.getTime());
      });

      it('replay → un seul evenement BOOKING_ATTEMPTED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-replay');
        const key = 'attempt-replay-' + SUFFIX();
        const input = makeInput(ids, { idempotencyKey: key });

        // Premier appel : SUCCESS.
        const result1 = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expect(result1.kind).toBe('SUCCESS');

        // Deuxieme appel avec la meme cle : REPLAY.
        const result2 = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expect(result2.kind).toBe('SUCCESS');

        // Un seul evenement BOOKING_ATTEMPTED (deduplication par sourceId).
        const count = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'DEVELOPMENT');
        expect(count).toBe(1);
      });

      it('idempotency conflict (payload different) ne compte pas', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-conflict');
        const key = 'attempt-conflict-' + SUFFIX();
        const input1 = makeInput(ids, { idempotencyKey: key });
        await createBookingDraftWithHold(db, input1, 'DEVELOPMENT');

        // Deuxieme appel avec la meme cle mais un payload different.
        const input2 = makeInput(ids, {
          idempotencyKey: key,
          customerStartAt: new Date('2026-03-10T09:00:00.000Z'),
          customerEndAt: new Date('2026-03-12T17:00:00.000Z'),
        });
        await expect(createBookingDraftWithHold(db, input2, 'DEVELOPMENT')).rejects.toThrowError(
          BookingDraftError,
        );

        // Un seul evenement BOOKING_ATTEMPTED (le conflict n'a pas emis).
        const count = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'DEVELOPMENT');
        expect(count).toBe(1);
      });

      it('deux appels concurrents avec la meme cle → un seul evenement', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-concurrent');
        const key = 'attempt-concurrent-' + SUFFIX();
        const input = makeInput(ids, { idempotencyKey: key });

        // Lancer deux appels concurrents.
        const results = await Promise.allSettled([
          createBookingDraftWithHold(db, input, 'DEVELOPMENT'),
          createBookingDraftWithHold(db, input, 'DEVELOPMENT'),
        ]);

        // Au moins un doit reussir.
        const successes = results.filter(
          (r) => r.status === 'fulfilled' && r.value.kind === 'SUCCESS',
        );
        expect(successes.length).toBeGreaterThanOrEqual(1);

        // Un seul evenement BOOKING_ATTEMPTED (deduplication par sourceId).
        const count = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'DEVELOPMENT');
        expect(count).toBe(1);
      });

      it('DISABLED → aucun evenement BOOKING_ATTEMPTED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('attempt-disabled');
        const input = makeInput(ids, { idempotencyKey: 'attempt-disabled-' + SUFFIX() });
        await createBookingDraftWithHold(db, input, 'DISABLED');
        const count = await countAnalyticsEvents('BOOKING_ATTEMPTED');
        expect(count).toBe(0);
      });
    });

    // =========================================================================
    // BOOKING_CONFIRMED
    // =========================================================================
    describe('BOOKING_CONFIRMED', () => {
      async function confirmLegacyDraft(
        ids: BaseIds,
        keySuffix: string,
        analyticsEnv: 'DEVELOPMENT' | 'TEST' | 'DISABLED' = 'DEVELOPMENT',
      ): Promise<{ bookingId: string; draftId: string; paymentId: string; piId: string }> {
        if (!db || !rawSql) throw new Error('db not initialized');
        await seedPaymentAccount(ids);
        const draftInput = makeInput(ids, { idempotencyKey: 'held-' + keySuffix });
        const draftResult = await createBookingDraftWithHold(db, draftInput, analyticsEnv);
        if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
        const draftId = draftResult.body.draftId;

        const initDeps = makeInitDeps();
        const initResult = await initiatePayment(
          initDeps,
          makeInitiateInput(ids, draftId, keySuffix),
        );
        if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
        const piId = initResult.providerPaymentIntentId;
        const paymentId = await getPaymentId(draftId);
        const amount = await getPaymentAmount(draftId);

        // Pour BOOKING_CONFIRMED, l'environnement analytics est resolu via
        // process.env car handleWebhook ne le passe pas explicitement.
        const envForWebhook = analyticsEnv === 'DISABLED' ? undefined : analyticsEnv;
        const deps = makeDeps();
        const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
          payment_id: paymentId,
          payment_attempt_id: initResult.paymentAttemptId,
          draft_id: draftId,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        });
        const input = makeWebhookInput(body, deps.adapter);
        const result = await withAnalyticsEnv(envForWebhook, () => handleWebhook(deps, input));
        if (result.kind !== 'SUCCESS')
          throw new Error(
            'Webhook confirmation failed: ' +
              ('error' in result ? result.error : '') +
              ' ' +
              ('message' in result ? result.message : ''),
          );

        const booking = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`.then(
          (r) => r[0]!,
        );
        return { bookingId: booking.id, draftId, paymentId, piId };
      }

      it('enregistre BOOKING_CONFIRMED avec sourceId = bookingId', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-1');
        const { bookingId } = await confirmLegacyDraft(ids, 'confirmed-1');

        const events = await getAnalyticsEvents('BOOKING_CONFIRMED');
        expect(events).toHaveLength(1);
        expect(events[0]!.source_id).toBe(bookingId);
        expect(events[0]!.environment).toBe('DEVELOPMENT');
      });

      it('occurredAt = confirmedAt retourne par PostgreSQL', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-at');
        const { bookingId } = await confirmLegacyDraft(ids, 'confirmed-at');

        const booking =
          await rawSql`SELECT confirmed_at FROM bookings WHERE id = ${bookingId}`.then(
            (r) => r[0]!,
          );
        const events = await getAnalyticsEvents('BOOKING_CONFIRMED');
        expect(events).toHaveLength(1);
        expect(events[0]!.occurred_at.getTime()).toBe(booking.confirmed_at.getTime());
      });

      it('echec analytics dans le savepoint ne rollback pas le booking/outbox (trigger reel)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-savepoint');
        await seedPaymentAccount(ids);
        const draftInput = makeInput(ids, { idempotencyKey: 'held-savepoint' });
        const draftResult = await createBookingDraftWithHold(db, draftInput, 'DEVELOPMENT');
        if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
        const draftId = draftResult.body.draftId;

        const initDeps = makeInitDeps();
        const initResult = await initiatePayment(
          initDeps,
          makeInitiateInput(ids, draftId, 'savepoint'),
        );
        if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
        const piId = initResult.providerPaymentIntentId;
        const paymentId = await getPaymentId(draftId);
        const amount = await getPaymentAmount(draftId);

        // Installer un trigger BEFORE INSERT sur product_analytics_events qui
        // leve une exception UNIQUEMENT pour event_type = 'BOOKING_CONFIRMED'.
        // Cela force un echec reel de l'INSERT analytics dans le savepoint.
        const sql = rawSql;
        try {
          await sql.unsafe(`
            CREATE OR REPLACE FUNCTION test_block_booking_confirmed_analytics()
            RETURNS trigger AS $$
            BEGIN
              IF NEW.event_type = 'BOOKING_CONFIRMED' THEN
                RAISE EXCEPTION 'test: analytics blocked';
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
          `);
          await sql.unsafe(`
            CREATE TRIGGER test_block_booking_confirmed_analytics
            BEFORE INSERT ON product_analytics_events
            FOR EACH ROW
            EXECUTE FUNCTION test_block_booking_confirmed_analytics()
          `);

          // Capturer le log structure pour verifier qu'aucun message PostgreSQL
          // ne fuite (le log ne contient que eventType et errorCode).
          const logCalls: string[] = [];
          const originalConsoleError = console.error;
          console.error = (msg: string) => {
            if (typeof msg === 'string' && msg.includes('product-analytics.record-failed')) {
              logCalls.push(msg);
            }
          };

          const deps = makeDeps();
          const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
            payment_id: paymentId,
            payment_attempt_id: initResult.paymentAttemptId,
            draft_id: draftId,
            organization_id: ids.orgId,
            protocol_version: 'v1',
          });
          const input = makeWebhookInput(body, deps.adapter);
          let result: { kind: string };
          try {
            result = await withAnalyticsEnv('DEVELOPMENT', () => handleWebhook(deps, input));
          } finally {
            console.error = originalConsoleError;
          }

          // La confirmation doit reussir malgre l'echec analytics (savepoint).
          expect(result.kind).toBe('SUCCESS');

          // Le booking est present.
          const booking = await sql`SELECT id FROM bookings WHERE draft_id = ${draftId}`.then(
            (r) => r[0]!,
          );
          expect(booking).toBeDefined();

          // L'outbox BOOKING_CONFIRMED.v1 est present.
          const outbox = await sql`
            SELECT id FROM outbox_events
            WHERE aggregate_type = 'BOOKING' AND aggregate_id = ${booking.id}
              AND event_type = 'BOOKING_CONFIRMED' AND event_version = 'v1'
          `.then((r) => r[0]!);
          expect(outbox).toBeDefined();

          // Le paiement et la tentative sont SUCCEEDED.
          const paymentRow = await sql`SELECT status FROM payments WHERE id = ${paymentId}`.then(
            (r) => r[0]!,
          );
          expect(paymentRow.status).toBe('SUCCEEDED');
          const attemptRow =
            await sql`SELECT status FROM payment_attempts WHERE payment_id = ${paymentId} ORDER BY attempt_number DESC LIMIT 1`.then(
              (r) => r[0]!,
            );
          expect(attemptRow.status).toBe('SUCCEEDED');

          // Zero evenement analytics BOOKING_CONFIRMED : l'INSERT a reellement
          // echoue (le trigger a leve une exception).
          const analyticsCount = await countAnalyticsEvents('BOOKING_CONFIRMED');
          expect(analyticsCount).toBe(0);

          // Le log structure est present et ne contient pas de message PostgreSQL.
          expect(logCalls.length).toBeGreaterThanOrEqual(1);
          for (const logCall of logCalls) {
            const parsed = JSON.parse(logCall);
            expect(parsed.event).toBe('product-analytics.record-failed');
            expect(parsed.eventType).toBe('BOOKING_CONFIRMED');
            expect(parsed.errorCode).toBe('ANALYTICS_UNAVAILABLE');
            // JAMAIS de message PostgreSQL dans le log.
            expect(parsed.message).toBeUndefined();
            expect(parsed.cause).toBeUndefined();
            expect(logCall).not.toContain('test: analytics blocked');
          }
        } finally {
          // Nettoyer le trigger et la fonction meme en cas d'echec.
          await sql`DROP TRIGGER IF EXISTS test_block_booking_confirmed_analytics ON product_analytics_events`;
          await sql`DROP FUNCTION IF EXISTS test_block_booking_confirmed_analytics()`;
        }
      });

      it("rollback metier ne laisse pas d'evenement BOOKING_CONFIRMED", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-rollback');
        await seedPaymentAccount(ids);
        const draftInput = makeInput(ids, { idempotencyKey: 'held-rollback' });
        const draftResult = await createBookingDraftWithHold(db, draftInput, 'DEVELOPMENT');
        if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
        const draftId = draftResult.body.draftId;

        const initDeps = makeInitDeps();
        const initResult = await initiatePayment(
          initDeps,
          makeInitiateInput(ids, draftId, 'rollback'),
        );
        if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
        const piId = initResult.providerPaymentIntentId;
        const paymentId = await getPaymentId(draftId);
        const amount = await getPaymentAmount(draftId);

        // Envoyer un webhook avec un montant incorrect pour forcer un echec
        // de validation (autorite). La transaction doit etre rollbackee.
        const deps = makeDeps();
        const body = makeWebhookPayload(
          'payment_intent.succeeded',
          piId,
          amount + 99999, // montant incorrect
          {
            payment_id: paymentId,
            payment_attempt_id: initResult.paymentAttemptId,
            draft_id: draftId,
            organization_id: ids.orgId,
            protocol_version: 'v1',
          },
        );
        const input = makeWebhookInput(body, deps.adapter);
        await withAnalyticsEnv('DEVELOPMENT', () => handleWebhook(deps, input));

        // Aucun booking ne doit exister.
        const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
        expect(bookings).toHaveLength(0);

        // Aucun evenement BOOKING_CONFIRMED ne doit exister.
        const count = await countAnalyticsEvents('BOOKING_CONFIRMED');
        expect(count).toBe(0);
      });

      it('duplicate webhook (sequentiel) → un seul booking et un seul evenement', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-dup-webhook');
        const { bookingId } = await confirmLegacyDraft(ids, 'dup-webhook');

        // Deuxieme webhook avec le meme PaymentIntent : doit etre idempotent.
        const deps = makeDeps();
        const paymentId = await getPaymentId(
          (await rawSql`SELECT draft_id FROM bookings WHERE id = ${bookingId}`.then((r) => r[0]!))
            .draft_id,
        );
        const piId = (
          await rawSql`SELECT provider_payment_intent_id FROM payment_attempts WHERE payment_id = ${paymentId}`.then(
            (r) => r[0]!,
          )
        ).provider_payment_intent_id;
        const amount = await getPaymentAmount(
          (await rawSql`SELECT draft_id FROM bookings WHERE id = ${bookingId}`.then((r) => r[0]!))
            .draft_id,
        );
        const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
          payment_id: paymentId,
          draft_id: (
            await rawSql`SELECT draft_id FROM bookings WHERE id = ${bookingId}`.then((r) => r[0]!)
          ).draft_id,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        });
        const input = makeWebhookInput(body, deps.adapter);
        const result2 = await withAnalyticsEnv('DEVELOPMENT', () => handleWebhook(deps, input));
        // Le deuxieme webhook doit retourner SUCCESS (idempotent) ou un statut 200.
        expect(result2.kind).toBe('SUCCESS');

        // Un seul booking.
        const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${
          (await rawSql`SELECT draft_id FROM bookings WHERE id = ${bookingId}`.then((r) => r[0]!))
            .draft_id
        }`;
        expect(bookings).toHaveLength(1);

        // Un seul evenement BOOKING_CONFIRMED.
        const events = await getAnalyticsEvents('BOOKING_CONFIRMED');
        expect(events).toHaveLength(1);
      });

      it('vraie concurrence webhook/reconciliation (advisory lock) → un booking, un outbox, un analytics', async () => {
        if (!db || !rawSql || !ctx) return;
        const sql = rawSql;
        const ids = await seedBaseData('confirmed-real-concurrent');
        await seedPaymentAccount(ids);

        // 1. Creer un held draft et initier le paiement.
        const draftInput = makeInput(ids, { idempotencyKey: 'held-real-concurrent' });
        const draftResult = await createBookingDraftWithHold(db, draftInput, 'DEVELOPMENT');
        if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
        const draftId = draftResult.body.draftId;

        const reconAdapter = new FakeStripeAdapter({ environment: 'TEST' });
        const initDeps: InitiatePaymentDependencies = { db, provider: reconAdapter };
        const initResult = await initiatePayment(
          initDeps,
          makeInitiateInput(ids, draftId, 'real-concurrent'),
        );
        if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
        const piId = initResult.providerPaymentIntentId;
        const paymentId = await getPaymentId(draftId);
        const amount = await getPaymentAmount(draftId);

        // 2. Marquer le PI comme succeeded dans le fake adapter.
        reconAdapter.simulatePaymentIntentStatus(piId, 'succeeded');

        // 3. Mettre reconcile_after dans le passe pour rendre la tentative eligible.
        const attemptRow =
          await sql`SELECT id FROM payment_attempts WHERE payment_id = ${paymentId}`.then(
            (r) => r[0]!,
          );
        await sql`UPDATE "payment_attempts"
          SET "reconcile_after" = now() - interval '1 hour',
              "reconcile_lease_until" = NULL,
              "reconcile_lease_token" = NULL
          WHERE "id" = ${attemptRow.id}`;

        // 4. Installer un trigger BEFORE UPDATE sur booking_drafts qui bloque
        //    sur un advisory lock transactionnel. Cela permet de synchroniser
        //    deterministement la reconciliation et le webhook.
        const sentinelKey = 98801;
        await sql.unsafe(`
          CREATE OR REPLACE FUNCTION test_block_draft_concurrent_update()
          RETURNS trigger AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(${sentinelKey});
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await sql.unsafe(`
          CREATE TRIGGER test_block_draft_concurrent_trigger
          BEFORE UPDATE ON booking_drafts
          FOR EACH ROW
          WHEN (NEW.id = '${draftId}'::uuid)
          EXECUTE FUNCTION test_block_draft_concurrent_update()
        `);

        // 5. Connexion sentinelle qui prend l'advisory lock.
        const sentinelConn = postgres(ctx.databaseUrl, { max: 1 });
        // DB client separe pour le webhook (deux connexions PostgreSQL).
        const dbWebhook = createDatabase(ctx.databaseUrl);
        // DB client separe pour la reconciliation.
        const dbRecon = createDatabase(ctx.databaseUrl);

        const originalEnv = process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
        process.env.PRODUCT_ANALYTICS_ENVIRONMENT = 'DEVELOPMENT';

        try {
          await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

          // 6. Lancer reconcilePaymentsBatch en arriere-plan.
          //    Il va : claim → retrieve (succeeded) → applyReconciliationResult →
          //    lockFullBusinessRows (SELECT FOR UPDATE draft) →
          //    applyBookingConfirmation (UPDATE draft → trigger → bloque advisory).
          const reconDeps: ReconciliationDependencies = { db: dbRecon, provider: reconAdapter };
          const reconPromise = reconcilePaymentsBatch(reconDeps, { environment: 'TEST' });

          // 7. Attendre que le trigger se declenche (le waiter advisory apparait).
          await waitForAdvisoryLockWaiter(sql, sentinelKey);

          // 8. Lancer le webhook en parallele sur une SEPARATE connexion.
          //    Il va : resolveAttempt → confirmBooking → lockFullBusinessRows
          //    (SELECT FOR UPDATE draft) → bloque car le draft est verrouille
          //    par la transaction de reconciliation.
          const webhookDeps: WebhookHandlerDeps & { adapter: FakeStripeAdapter } = {
            db: dbWebhook,
            provider: reconAdapter,
            adapter: reconAdapter,
          };
          const webhookBody = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
            payment_id: paymentId,
            payment_attempt_id: initResult.paymentAttemptId,
            draft_id: draftId,
            organization_id: ids.orgId,
            protocol_version: 'v1',
          });
          const webhookInput = makeWebhookInput(webhookBody, reconAdapter);
          const webhookPromise = handleWebhook(webhookDeps, webhookInput);

          // 9. Liberer le sentinel — la reconciliation se debloque, cree la
          //    booking, commit. Le webhook se debloque alors, voit le draft
          //    CONVERTED et leve WEBHOOK_LATE_PAYMENT (idempotence).
          await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

          // 10. Attendre les deux resultats concurremment avec un timeout borne.
          //    Le webhook voit le draft CONVERTED → WEBHOOK_LATE_PAYMENT →
          //    compensateLatePayment trouve une reservation existante → IGNORED →
          //    SUCCESS 200.
          const CONCURRENT_TIMEOUT_MS = 30_000;
          let concurrentTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const concurrentTimeout = new Promise<never>((_, reject) => {
            concurrentTimeoutId = setTimeout(
              () =>
                reject(
                  new Error(
                    `Concurrent webhook/reconciliation timed out after ${CONCURRENT_TIMEOUT_MS}ms`,
                  ),
                ),
              CONCURRENT_TIMEOUT_MS,
            );
          });
          try {
            const [reconResult, webhookResult] = await Promise.race([
              Promise.all([reconPromise, webhookPromise]),
              concurrentTimeout,
            ]);

            // La reconciliation doit avoir confirme exactement un paiement.
            expect(reconResult.claimedCount).toBe(1);
            expect(reconResult.reconciledCount).toBe(1);
            expect(reconResult.confirmedCount).toBe(1);
            expect(reconResult.anomalyCount).toBe(0);

            // Le webhook voit le draft CONVERTED apres que la reconciliation a
            // gagne la course. Il declenche WEBHOOK_LATE_PAYMENT, appelle
            // compensateLatePayment qui trouve une reservation existante →
            // marque IGNORED → retourne SUCCESS 200.
            expect(webhookResult.kind).toBe('SUCCESS');
            if (webhookResult.kind === 'SUCCESS') {
              expect(webhookResult.statusCode).toBe(200);
            }

            // 11. Verifier exactement un booking.
            const bookings =
              await sql`SELECT id, confirmed_at FROM bookings WHERE draft_id = ${draftId}`;
            expect(bookings).toHaveLength(1);
            const booking = bookings[0]!;

            // 12. Verifier exactement un outbox BOOKING_CONFIRMED.v1.
            const outbox = await sql`
              SELECT id FROM outbox_events
              WHERE aggregate_type = 'BOOKING' AND aggregate_id = ${booking.id}
                AND event_type = 'BOOKING_CONFIRMED' AND event_version = 'v1'
            `;
            expect(outbox).toHaveLength(1);

            // 13. Verifier exactement un evenement analytics BOOKING_CONFIRMED.
            const analyticsEvents = await getAnalyticsEvents('BOOKING_CONFIRMED');
            expect(analyticsEvents).toHaveLength(1);
            const analyticsEvent = analyticsEvents[0]!;
            expect(analyticsEvent.environment).toBe('DEVELOPMENT');

            // 14. sourceId = booking.id.
            expect(analyticsEvent.source_id).toBe(booking.id);

            // 15. occurredAt = booking.confirmed_at.
            expect(analyticsEvent.occurred_at.getTime()).toBe(booking.confirmed_at.getTime());
          } finally {
            if (concurrentTimeoutId !== undefined) clearTimeout(concurrentTimeoutId);
          }
        } finally {
          // Restaurer l'environnement analytics.
          if (originalEnv === undefined) {
            delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
          } else {
            process.env.PRODUCT_ANALYTICS_ENVIRONMENT = originalEnv;
          }
          // Nettoyer le trigger, la fonction et les connexions.
          await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
          await sentinelConn.end();
          await dbWebhook.$client.end();
          await dbRecon.$client.end();
          await sql`DROP TRIGGER IF EXISTS test_block_draft_concurrent_trigger ON booking_drafts`;
          await sql`DROP FUNCTION IF EXISTS test_block_draft_concurrent_update()`;
        }
      });

      it('DISABLED → aucun evenement BOOKING_CONFIRMED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('confirmed-disabled');
        await confirmLegacyDraft(ids, 'confirmed-disabled', 'DISABLED');
        const count = await countAnalyticsEvents('BOOKING_CONFIRMED');
        expect(count).toBe(0);
      });
    });

    // =========================================================================
    // Separation DEVELOPMENT / TEST
    // =========================================================================
    describe('separation DEVELOPMENT / TEST', () => {
      it('DEVELOPMENT et TEST sont isoles', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('env-sep');
        const inputDev = makeInput(ids, { idempotencyKey: 'env-dev-' + SUFFIX() });
        const inputTest = makeInput(ids, { idempotencyKey: 'env-test-' + SUFFIX() });

        await createBookingDraftWithHold(db, inputDev, 'DEVELOPMENT');
        await createBookingDraftWithHold(db, inputTest, 'TEST');

        const devCount = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'DEVELOPMENT');
        const testCount = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'TEST');
        expect(devCount).toBe(1);
        expect(testCount).toBe(1);

        // Les evenements sont dans des environnements differents.
        const devEvents = await getAnalyticsEvents('BOOKING_ATTEMPTED');
        const devEvent = devEvents.find((e) => e.environment === 'DEVELOPMENT');
        const testEvent = devEvents.find((e) => e.environment === 'TEST');
        expect(devEvent).toBeDefined();
        expect(devEvent!.source_id).not.toBe(testEvent!.source_id);
      });
    });

    // =========================================================================
    // Aucune ligne PRODUCTION
    // =========================================================================
    describe('PRODUCTION impossible', () => {
      it("aucune ligne PRODUCTION n'est jamais inseree", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('no-prod');
        const input = makeInput(ids, { idempotencyKey: 'no-prod-' + SUFFIX() });

        // Avec DISABLED, aucun evenement analytics n'est emis.
        await createBookingDraftWithHold(db, input, 'DISABLED');

        // Aucune ligne PRODUCTION.
        const prodCount = await countAnalyticsEvents('BOOKING_ATTEMPTED', 'PRODUCTION');
        expect(prodCount).toBe(0);

        // Verifier qu'aucune ligne PRODUCTION n'existe dans toute la table.
        const allProd = await rawSql`
          SELECT COUNT(*)::int as cnt FROM product_analytics_events WHERE environment = 'PRODUCTION'
        `;
        expect(allProd[0]!.cnt).toBe(0);
      });

      it('PRODUCTION injecte par cast dans createBookingDraftWithHold → aucun evenement analytics', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData('no-prod-cast');
        const input = makeInput(ids, { idempotencyKey: 'no-prod-cast-' + SUFFIX() });

        // Injecter PRODUCTION par cast runtime — le safe recorder doit rejeter
        // (defense-in-depth) et retourner DISABLED sans appel DB.
        await createBookingDraftWithHold(
          db,
          input,
          'PRODUCTION' as unknown as ResolvedAnalyticsEnvironment,
        );

        // Aucun evenement analytics (ni PRODUCTION, ni DEVELOPMENT, ni TEST).
        const totalCount = await countAnalyticsEvents();
        expect(totalCount).toBe(0);

        // Aucune ligne PRODUCTION dans toute la table.
        const allProd = await rawSql`
          SELECT COUNT(*)::int as cnt FROM product_analytics_events WHERE environment = 'PRODUCTION'
        `;
        expect(allProd[0]!.cnt).toBe(0);
      });

      it('PRODUCTION injecte par cast dans safeRecordAnalyticsEvent → DISABLED et zero DB', async () => {
        if (!db || !rawSql) return;
        const { safeRecordAnalyticsEvent } = await import('./safe-record');
        const result = await safeRecordAnalyticsEvent(
          db,
          {
            eventType: 'BOOKING_ATTEMPTED',
            sourceId: randomUUID(),
            occurredAt: new Date(),
          },
          'PRODUCTION' as unknown as ResolvedAnalyticsEnvironment,
        );
        expect(result).toBe('DISABLED');

        // Aucune ligne ajoutee.
        const totalCount = await countAnalyticsEvents();
        expect(totalCount).toBe(0);
      });

      it('PRODUCTION injecte par cast dans safeRecordAnalyticsEventInTransaction → DISABLED et zero DB', async () => {
        if (!db || !rawSql) return;
        const { safeRecordAnalyticsEventInTransaction } = await import('./safe-record');
        const result = await db.transaction(async (tx) => {
          return await safeRecordAnalyticsEventInTransaction(
            tx,
            {
              eventType: 'BOOKING_ATTEMPTED',
              sourceId: randomUUID(),
              occurredAt: new Date(),
            },
            'PRODUCTION' as unknown as ResolvedAnalyticsEnvironment,
          );
        });
        expect(result).toBe('DISABLED');

        // Aucune ligne ajoutee.
        const totalCount = await countAnalyticsEvents();
        expect(totalCount).toBe(0);
      });
    });

    // =========================================================================
    // PUBLIC_SEARCH_PERFORMED (via recordProductAnalyticsEvent direct)
    // =========================================================================
    describe('PUBLIC_SEARCH_PERFORMED', () => {
      it('enregistre un evenement search avec hasResults=true', async () => {
        if (!db || !rawSql) return;
        const sourceId = randomUUID();
        const occurredAt = new Date();
        await recordProductAnalyticsEvent(db, {
          eventType: 'PUBLIC_SEARCH_PERFORMED',
          environment: 'DEVELOPMENT',
          sourceId,
          occurredAt,
          hasResults: true,
        });

        const events = await getAnalyticsEvents('PUBLIC_SEARCH_PERFORMED');
        expect(events).toHaveLength(1);
        expect(events[0]!.has_results).toBe(true);
        expect(events[0]!.source_id).toBe(sourceId);
      });

      it('enregistre un evenement search avec hasResults=false', async () => {
        if (!db || !rawSql) return;
        const sourceId = randomUUID();
        const occurredAt = new Date();
        await recordProductAnalyticsEvent(db, {
          eventType: 'PUBLIC_SEARCH_PERFORMED',
          environment: 'TEST',
          sourceId,
          occurredAt,
          hasResults: false,
        });

        const events = await getAnalyticsEvents('PUBLIC_SEARCH_PERFORMED');
        expect(events).toHaveLength(1);
        expect(events[0]!.has_results).toBe(false);
      });

      it('deux recherches avec des sourceId differents → deux evenements', async () => {
        if (!db || !rawSql) return;
        await recordProductAnalyticsEvent(db, {
          eventType: 'PUBLIC_SEARCH_PERFORMED',
          environment: 'DEVELOPMENT',
          sourceId: randomUUID(),
          occurredAt: new Date(),
          hasResults: true,
        });
        await recordProductAnalyticsEvent(db, {
          eventType: 'PUBLIC_SEARCH_PERFORMED',
          environment: 'DEVELOPMENT',
          sourceId: randomUUID(),
          occurredAt: new Date(),
          hasResults: false,
        });

        const count = await countAnalyticsEvents('PUBLIC_SEARCH_PERFORMED', 'DEVELOPMENT');
        expect(count).toBe(2);
      });
    });
  },
);
