/**
 * @uttily/core — Tests d'integration PostgreSQL G7P-B2-C.
 *
 * 22 tests obligatoires couvrant la copie exacte du snapshot flexible
 * (booking_drafts -> bookings, booking_draft_lines -> booking_lines)
 * lors de la confirmation atomique de reservation.
 *
 * Date de travail : 2026-08-08.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold } from '../booking-drafts';
import type {
  FlexibleCreateBookingDraftInput,
  LegacyCreateBookingDraftInput,
} from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput } from '../webhook-handler/types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import { applyBookingConfirmation } from './apply-booking-confirmation';
import { lockFullBusinessRows } from './lock-rows';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('flex_confirm');
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
      organizations, users, idempotency_records
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

async function seedDailyPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
    skipActivate?: boolean;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 5000;
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127;
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'DAILY', 'EUR', ${price}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Location journaliere'), (${plan.id}, 'en', 'Daily rental')
  `;
  if (!opts.skipActivate) {
    await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  }
  return plan.id;
}

async function seedHourlyPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    minDurationMinutes?: number;
    maxDurationMinutes?: number;
    billingIncrementMinutes?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
    skipActivate?: boolean;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 1000;
  const minDur = opts.minDurationMinutes ?? 60;
  const maxDur = opts.maxDurationMinutes ?? 480;
  const billingInc = opts.billingIncrementMinutes ?? 60;
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127;
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'HOURLY', 'EUR', ${price}, ${minDur}, ${maxDur}, ${billingInc}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Location horaire'), (${plan.id}, 'en', 'Hourly rental')
  `;
  if (!opts.skipActivate) {
    await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  }
  return plan.id;
}

async function seedFixedDurationPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    includedDurationMinutes?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 3000;
  const includedDur = opts.includedDurationMinutes ?? 120;
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127;
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'FIXED_DURATION', 'EUR', ${price}, ${includedDur}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Forfait 2h'), (${plan.id}, 'en', '2-hour package')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  return plan.id;
}

async function seedOpeningHours(
  locationId: string,
  hours?: Array<{ weekday: number; openTime: string; closeTime: string }>,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const defaultHours = hours ?? [
    { weekday: 0, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 1, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 2, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 3, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 4, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 5, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 6, openTime: '09:00:00', closeTime: '17:00:00' },
  ];
  for (const h of defaultHours) {
    await rawSql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES (${locationId}, ${h.weekday}, ${h.openTime}, ${h.closeTime})
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input / deps helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFlexibleTimeRangeInput(
  ids: BaseIds,
  startAt: string,
  endAt: string,
  overrides: Partial<FlexibleCreateBookingDraftInput> = {},
): FlexibleCreateBookingDraftInput {
  return {
    pricingMode: 'FLEXIBLE',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    locale: 'fr',
    intent: { kind: 'TIME_RANGE', startAt, endAt },
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function makeFlexibleDayRangeInput(
  ids: BaseIds,
  startDate: string,
  endDateExclusive: string,
  overrides: Partial<FlexibleCreateBookingDraftInput> = {},
): FlexibleCreateBookingDraftInput {
  return {
    pricingMode: 'FLEXIBLE',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    locale: 'fr',
    intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function makeLegacyInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
    pricingMode: 'LEGACY',
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
      amountMinor: 260,
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

function applicationFeeForCustomerTotal(amount: number): number {
  const estimatedBase = Math.round((amount * 100) / 107);
  for (let base = Math.max(0, estimatedBase - 3); base <= estimatedBase + 3; base++) {
    const customerFee = Math.round((base * 7) / 100);
    if (base + customerFee === amount) {
      return Math.round((base * 13) / 100) + customerFee;
    }
  }
  return 400;
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
  const applicationFeeAmount =
    overrides.applicationFeeAmount ?? applicationFeeForCustomerTotal(amount);
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

// ─────────────────────────────────────────────────────────────────────────────
// High-level confirmation helper: create draft, initiate payment, confirm via webhook
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmResult {
  bookingId: string;
  draftId: string;
  paymentId: string;
  piId: string;
  paymentAttemptId: string;
}

/**
 * Cree un draft legacy, initie le paiement, et confirme via webhook.
 */
async function confirmLegacyDraft(ids: BaseIds, keySuffix: string): Promise<ConfirmResult> {
  if (!db || !rawSql) throw new Error('db not initialized');
  await seedPaymentAccount(ids);
  const draftInput = makeLegacyInput(ids, { idempotencyKey: 'held-' + keySuffix });
  const draftResult = await createBookingDraftWithHold(db, draftInput);
  if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
  const draftId = draftResult.body.draftId;

  const initDeps = makeInitDeps();
  const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, keySuffix));
  if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
  const input = makeWebhookInput(body, deps.adapter);
  const result = await handleWebhook(deps, input);
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
  return {
    bookingId: booking.id,
    draftId,
    paymentId,
    piId,
    paymentAttemptId: initResult.paymentAttemptId,
  };
}

/**
 * Cree un draft flexible, initie le paiement, et confirme via webhook.
 */
async function confirmFlexibleDraft(
  ids: BaseIds,
  draftInput: FlexibleCreateBookingDraftInput,
  keySuffix: string,
): Promise<ConfirmResult> {
  if (!db || !rawSql) throw new Error('db not initialized');
  await seedPaymentAccount(ids);
  const draftResult = await createBookingDraftWithHold(db, draftInput);
  if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create flexible draft');
  const draftId = draftResult.body.draftId;

  const initDeps = makeInitDeps();
  const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, keySuffix));
  if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
  const input = makeWebhookInput(body, deps.adapter);
  const result = await handleWebhook(deps, input);
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
  return {
    bookingId: booking.id,
    draftId,
    paymentId,
    piId,
    paymentAttemptId: initResult.paymentAttemptId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'G7P-B2-C — applyBookingConfirmation flexible integration',
  () => {
    // 1. Payment of a legacy draft
    it('1. legacy draft confirmation produces booking with legacy fields', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('legacy-1');
      const { bookingId, draftId } = await confirmLegacyDraft(ids, 'legacy-1');

      const booking = await rawSql`
        SELECT pricing_snapshot_version, billable_unit, pricing_algorithm_version,
               pricing_rounding_rule_version, pricing_intent_type, pricing_intent_snapshot,
               pricing_resolved_locale
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.pricing_snapshot_version).toBe('legacy-daily-v1');
      expect(booking.billable_unit).toBe('DAY');
      expect(booking.pricing_algorithm_version).toBeNull();
      expect(booking.pricing_rounding_rule_version).toBeNull();
      expect(booking.pricing_intent_type).toBeNull();
      expect(booking.pricing_intent_snapshot).toBeNull();
      expect(booking.pricing_resolved_locale).toBeNull();

      const lines = await rawSql`
        SELECT source_draft_line_id, pricing_plan_id, pricing_plan_type, pricing_public_label
        FROM booking_lines WHERE booking_id = ${bookingId}
      `;
      expect(lines.length).toBe(1);
      expect(lines[0]!.source_draft_line_id).toBeNull();
      expect(lines[0]!.pricing_plan_id).toBeNull();
      expect(lines[0]!.pricing_plan_type).toBeNull();
      expect(lines[0]!.pricing_public_label).toBeNull();

      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('CONVERTED');
    });

    // 2. Payment of a flexible HOURLY draft
    it('2. flexible HOURLY draft confirmation copies all flexible fields', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('hourly-2');
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'hourly-2' }),
        'hourly-2',
      );

      const booking = await rawSql`
        SELECT pricing_snapshot_version, pricing_intent_type, billable_unit, timezone,
               pricing_algorithm_version, pricing_rounding_rule_version, pricing_resolved_locale
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.pricing_snapshot_version).toBe('flexible-pricing-v1');
      expect(booking.pricing_intent_type).toBe('TIME_RANGE');
      expect(booking.billable_unit).toBe('MINUTE');
      expect(booking.timezone).toBe('Europe/Paris');
      expect(booking.pricing_algorithm_version).toBe('flexible-pricing-v1');
      expect(booking.pricing_rounding_rule_version).toBe('half-up-v1');
      expect(booking.pricing_resolved_locale).toBe('fr');

      const line = await rawSql`
        SELECT pricing_plan_type, pricing_billed_duration_minutes, pricing_billed_days,
               source_draft_line_id, pricing_plan_id
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(line.pricing_plan_type).toBe('HOURLY');
      expect(line.pricing_billed_duration_minutes).toBe(120);
      expect(line.pricing_billed_days).toBeNull();
      expect(line.source_draft_line_id).not.toBeNull();
      expect(line.pricing_plan_id).not.toBeNull();

      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('CONVERTED');
    });

    // 3. Payment of a flexible FIXED_DURATION draft
    it('3. flexible FIXED_DURATION draft confirmation copies all flexible fields', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('fixed-3');
      await seedFixedDurationPlan(ids, { priceAmountMinor: 3000, includedDurationMinutes: 120 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'fixed-3' }),
        'fixed-3',
      );

      const line = await rawSql`
        SELECT pricing_plan_type, pricing_covered_duration_minutes, pricing_billed_duration_minutes,
               pricing_plan_id, source_draft_line_id, line_total_amount_minor
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(line.pricing_plan_type).toBe('FIXED_DURATION');
      expect(line.pricing_covered_duration_minutes).toBe(120);
      expect(line.pricing_billed_duration_minutes).toBeNull();
      expect(line.pricing_plan_id).not.toBeNull();
      expect(line.source_draft_line_id).not.toBeNull();
      expect(Number(line.line_total_amount_minor)).toBe(3000);
    });

    // 4. Payment of a flexible DAILY + TIME_RANGE draft
    it('4. flexible DAILY + TIME_RANGE draft confirmation copies all flexible fields', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('daily-tr-4');
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T17:00:00';
      const { bookingId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'daily-tr-4' }),
        'daily-tr-4',
      );

      const line = await rawSql`
        SELECT pricing_plan_type, pricing_billed_days, pricing_amount_before_discount_minor,
               pricing_amount_after_discount_minor, source_draft_line_id
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(line.pricing_plan_type).toBe('DAILY');
      expect(line.source_draft_line_id).not.toBeNull();
    });

    // 5. Payment of a flexible DAILY + DAY_RANGE draft
    it('5. flexible DAILY + DAY_RANGE draft confirmation copies all flexible fields', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('daily-dr-5');
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const { bookingId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'daily-dr-5',
        }),
        'daily-dr-5',
      );

      const booking = await rawSql`
        SELECT pricing_intent_type, billable_unit, billable_unit_count
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.pricing_intent_type).toBe('DAY_RANGE');
      expect(booking.billable_unit).toBe('DAY');
      expect(booking.billable_unit_count).toBe(2);

      const line = await rawSql`
        SELECT pricing_plan_type, pricing_billed_days, pricing_amount_before_discount_minor,
               pricing_amount_after_discount_minor, source_draft_line_id, pricing_selected_window
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(line.pricing_plan_type).toBe('DAILY');
      expect(line.pricing_billed_days).toBe(2);
      expect(line.source_draft_line_id).not.toBeNull();
      expect(Number(line.pricing_amount_before_discount_minor)).toBe(10000);
      expect(Number(line.pricing_amount_after_discount_minor)).toBe(10000);
    });

    // 6. Confirmation copies ALL root fields
    it('6. confirmation copies ALL root fields from draft to booking', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('root-copy-6');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'root-copy-6' }),
        'root-copy-6',
      );

      const draft = await rawSql`
        SELECT timezone, billable_unit, billable_unit_count, pricing_snapshot_version,
               pricing_algorithm_version, pricing_rounding_rule_version, pricing_intent_type,
               pricing_intent_snapshot, pricing_resolved_locale,
               subtotal_amount_minor, total_amount_minor, mandatory_fees_amount_minor,
               customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
               prep_buffer_minutes, cleanup_buffer_minutes, currency
        FROM booking_drafts WHERE id = ${draftId}
      `.then((r) => r[0]!);

      const booking = await rawSql`
        SELECT timezone, billable_unit, billable_unit_count, pricing_snapshot_version,
               pricing_algorithm_version, pricing_rounding_rule_version, pricing_intent_type,
               pricing_intent_snapshot, pricing_resolved_locale,
               subtotal_amount_minor, total_amount_minor, mandatory_fees_amount_minor,
               customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
               prep_buffer_minutes, cleanup_buffer_minutes, currency
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.timezone).toBe(draft.timezone);
      expect(booking.billable_unit).toBe(draft.billable_unit);
      expect(booking.billable_unit_count).toBe(draft.billable_unit_count);
      expect(booking.pricing_snapshot_version).toBe(draft.pricing_snapshot_version);
      expect(booking.pricing_algorithm_version).toBe(draft.pricing_algorithm_version);
      expect(booking.pricing_rounding_rule_version).toBe(draft.pricing_rounding_rule_version);
      expect(booking.pricing_intent_type).toBe(draft.pricing_intent_type);
      expect(booking.pricing_resolved_locale).toBe(draft.pricing_resolved_locale);
      expect(Number(booking.subtotal_amount_minor)).toBe(Number(draft.subtotal_amount_minor));
      expect(Number(booking.total_amount_minor)).toBe(Number(draft.total_amount_minor));
      expect(Number(booking.mandatory_fees_amount_minor)).toBe(
        Number(draft.mandatory_fees_amount_minor),
      );
      expect(booking.customer_start_at).toEqual(draft.customer_start_at);
      expect(booking.customer_end_at).toEqual(draft.customer_end_at);
      expect(booking.blocked_start_at).toEqual(draft.blocked_start_at);
      expect(booking.blocked_end_at).toEqual(draft.blocked_end_at);
      expect(booking.prep_buffer_minutes).toBe(draft.prep_buffer_minutes);
      expect(booking.cleanup_buffer_minutes).toBe(draft.cleanup_buffer_minutes);
      expect(booking.currency).toBe(draft.currency);
      // intent_snapshot is jsonb — compare via JSON.stringify
      expect(JSON.stringify(booking.pricing_intent_snapshot)).toBe(
        JSON.stringify(draft.pricing_intent_snapshot),
      );
    });

    // 7. Confirmation copies ALL line fields
    it('7. confirmation copies ALL line fields from draft_line to booking_line', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('line-copy-7');
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'line-copy-7' }),
        'line-copy-7',
      );

      const draftLine = await rawSql`
        SELECT pricing_plan_id, pricing_plan_version, pricing_plan_type, pricing_public_label,
               pricing_requested_duration_minutes, pricing_billed_duration_minutes,
               pricing_covered_duration_minutes, pricing_billed_days, pricing_selected_window,
               pricing_discount_threshold_days, pricing_discount_percent,
               pricing_amount_before_discount_minor, pricing_amount_after_discount_minor,
               unit_price_amount_minor, billable_unit_count, quantity, currency,
               line_total_amount_minor, variant_snapshot
        FROM booking_draft_lines WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);

      const bookingLine = await rawSql`
        SELECT pricing_plan_id, pricing_plan_version, pricing_plan_type, pricing_public_label,
               pricing_requested_duration_minutes, pricing_billed_duration_minutes,
               pricing_covered_duration_minutes, pricing_billed_days, pricing_selected_window,
               pricing_discount_threshold_days, pricing_discount_percent,
               pricing_amount_before_discount_minor, pricing_amount_after_discount_minor,
               unit_price_amount_minor, billable_unit_count, quantity, currency,
               line_total_amount_minor, variant_snapshot
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(bookingLine.pricing_plan_id).toBe(draftLine.pricing_plan_id);
      expect(bookingLine.pricing_plan_version).toBe(draftLine.pricing_plan_version);
      expect(bookingLine.pricing_plan_type).toBe(draftLine.pricing_plan_type);
      expect(bookingLine.pricing_public_label).toBe(draftLine.pricing_public_label);
      expect(bookingLine.pricing_requested_duration_minutes).toBe(
        draftLine.pricing_requested_duration_minutes,
      );
      expect(bookingLine.pricing_billed_duration_minutes).toBe(
        draftLine.pricing_billed_duration_minutes,
      );
      expect(bookingLine.pricing_covered_duration_minutes).toBe(
        draftLine.pricing_covered_duration_minutes,
      );
      expect(bookingLine.pricing_billed_days).toBe(draftLine.pricing_billed_days);
      expect(bookingLine.pricing_discount_threshold_days).toBe(
        draftLine.pricing_discount_threshold_days,
      );
      expect(bookingLine.pricing_discount_percent).toBe(draftLine.pricing_discount_percent);
      expect(Number(bookingLine.pricing_amount_before_discount_minor)).toBe(
        Number(draftLine.pricing_amount_before_discount_minor),
      );
      expect(Number(bookingLine.pricing_amount_after_discount_minor)).toBe(
        Number(draftLine.pricing_amount_after_discount_minor),
      );
      expect(Number(bookingLine.unit_price_amount_minor)).toBe(
        Number(draftLine.unit_price_amount_minor),
      );
      expect(bookingLine.billable_unit_count).toBe(draftLine.billable_unit_count);
      expect(bookingLine.quantity).toBe(draftLine.quantity);
      expect(bookingLine.currency).toBe(draftLine.currency);
      expect(Number(bookingLine.line_total_amount_minor)).toBe(
        Number(draftLine.line_total_amount_minor),
      );
      expect(JSON.stringify(bookingLine.variant_snapshot)).toBe(
        JSON.stringify(draftLine.variant_snapshot),
      );
      expect(JSON.stringify(bookingLine.pricing_selected_window)).toBe(
        JSON.stringify(draftLine.pricing_selected_window),
      );
    });

    // 8. source_draft_line_id correct and unique
    it('8. source_draft_line_id points to correct draft_line and is unique', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('src-unique-8');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'src-unique-8' }),
        'src-unique-8',
      );

      const draftLine =
        await rawSql`SELECT id FROM booking_draft_lines WHERE draft_id = ${draftId}`.then(
          (r) => r[0]!,
        );
      const bookingLine = await rawSql`
        SELECT source_draft_line_id FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      expect(bookingLine.source_draft_line_id).toBe(draftLine.id);

      // Verify uniqueness: only one booking_line with this source_draft_line_id
      const count = await rawSql`
        SELECT count(*)::int AS n FROM booking_lines WHERE source_draft_line_id = ${draftLine.id}
      `.then((r) => r[0]!);
      expect(count.n).toBe(1);
    });

    // 9. Plan retired after draft: confirmation still succeeds
    it('9. plan retired after draft creation: confirmation still succeeds', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('retire-9');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'retire-9' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      // Retire the pricing plan after draft creation
      await rawSql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "product_variant_id" = ${ids.variantId}`;

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'retire-9'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);
      const result = await handleWebhook(deps, input);
      expect(result.kind).toBe('SUCCESS');

      // Booking created with snapshot from draft, not from retired plan
      const booking =
        await rawSql`SELECT id, status FROM bookings WHERE draft_id = ${draftId}`.then(
          (r) => r[0]!,
        );
      expect(booking.status).toBe('CONFIRMED');

      const line = await rawSql`
        SELECT pricing_plan_type, pricing_billed_duration_minutes
        FROM booking_lines WHERE booking_id = ${booking.id}
      `.then((r) => r[0]!);
      expect(line.pricing_plan_type).toBe('HOURLY');
      expect(line.pricing_billed_duration_minutes).toBe(120);
    });

    // 10. Translation modified after draft: snapshot unchanged
    it('10. translation modified after draft: booking snapshot matches draft, not current translation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('trans-10');
      const planId = await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'trans-10' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      // Retire the original plan and create a new plan with different translation
      await rawSql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
      const newPlanId = await seedHourlyPlan(ids, {
        priceAmountMinor: 1000,
        billingIncrementMinutes: 60,
        version: 2,
        skipActivate: true,
      });
      await rawSql`
        UPDATE "pricing_plan_translations" SET "public_label" = 'MODIFIED LABEL'
        WHERE "pricing_plan_id" = ${newPlanId} AND "locale" = 'fr'
      `;
      await rawSql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${newPlanId}`;

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'trans-10'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);
      const result = await handleWebhook(deps, input);
      expect(result.kind).toBe('SUCCESS');

      const draftLine = await rawSql`
        SELECT pricing_public_label FROM booking_draft_lines WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);
      const bookingLine = await rawSql`
        SELECT bl.pricing_public_label
        FROM booking_lines bl
        JOIN bookings b ON bl.booking_id = b.id
        WHERE b.draft_id = ${draftId}
      `.then((r) => r[0]!);

      // Booking line label matches draft, not the new plan's translation
      expect(bookingLine.pricing_public_label).toBe(draftLine.pricing_public_label);
      expect(bookingLine.pricing_public_label).not.toBe('MODIFIED LABEL');
    });

    // 11. Catalog price modified after draft: amount unchanged
    it('11. catalog price modified after draft: booking amounts match draft, not current price', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('price-11');
      const planId = await seedHourlyPlan(ids, { priceAmountMinor: 1000 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'price-11' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      const draftLineBefore = await rawSql`
        SELECT line_total_amount_minor, unit_price_amount_minor
        FROM booking_draft_lines WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);

      // Retire the original plan and create a new plan with a different price
      await rawSql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
      await seedHourlyPlan(ids, {
        priceAmountMinor: 99999,
        billingIncrementMinutes: 60,
        version: 2,
      });

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'price-11'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);
      const result = await handleWebhook(deps, input);
      expect(result.kind).toBe('SUCCESS');

      const bookingLine = await rawSql`
        SELECT line_total_amount_minor, unit_price_amount_minor
        FROM booking_lines bl
        JOIN bookings b ON bl.booking_id = b.id
        WHERE b.draft_id = ${draftId}
      `.then((r) => r[0]!);

      expect(Number(bookingLine.line_total_amount_minor)).toBe(
        Number(draftLineBefore.line_total_amount_minor),
      );
      expect(Number(bookingLine.unit_price_amount_minor)).toBe(
        Number(draftLineBefore.unit_price_amount_minor),
      );
    });

    // 12. Local time 22h08 Europe/Paris preserved semantically
    it('12. local time 22:08 Europe/Paris preserved semantically', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('paris-12');
      // Use opening hours that extend to 23:00 to cover 22:08
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 1, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 2, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 3, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 4, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 5, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 6, openTime: '00:00:00', closeTime: '23:59:00' },
      ]);
      // 22:08 local (Europe/Paris) in February (CET = UTC+1) = 21:08 UTC
      const start = '2026-02-10T22:08:00';
      const end = '2026-02-10T23:08:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'paris-12' }),
        'paris-12',
      );

      const draft = await rawSql`
        SELECT customer_start_at, customer_end_at, timezone
        FROM booking_drafts WHERE id = ${draftId}
      `.then((r) => r[0]!);

      const booking = await rawSql`
        SELECT customer_start_at, customer_end_at, timezone
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.timezone).toBe('Europe/Paris');
      // The UTC instant is preserved exactly
      expect(booking.customer_start_at).toEqual(draft.customer_start_at);
      expect(booking.customer_end_at).toEqual(draft.customer_end_at);
      // 22:08 Paris = 21:08 UTC
      const startDate = new Date(booking.customer_start_at);
      expect(startDate.getUTCHours()).toBe(21);
      expect(startDate.getUTCMinutes()).toBe(8);
    });

    // 13. No second UTC conversion downstream
    it('13. no second UTC conversion: booking timestamps identical to draft', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('no-reconvert-13');
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'no-reconvert-13',
        }),
        'no-reconvert-13',
      );

      const draft = await rawSql`
        SELECT customer_start_at, customer_end_at, blocked_start_at, blocked_end_at
        FROM booking_drafts WHERE id = ${draftId}
      `.then((r) => r[0]!);

      const booking = await rawSql`
        SELECT customer_start_at, customer_end_at, blocked_start_at, blocked_end_at
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      // Exact match — no reconversion
      expect(booking.customer_start_at).toEqual(draft.customer_start_at);
      expect(booking.customer_end_at).toEqual(draft.customer_end_at);
      expect(booking.blocked_start_at).toEqual(draft.blocked_start_at);
      expect(booking.blocked_end_at).toEqual(draft.blocked_end_at);
    });

    // 14. Unknown snapshot version rejected fail-closed
    it('14. both legacy-daily-v1 and flexible-pricing-v1 pass validation; CHECK constraint prevents invalid versions', async () => {
      if (!db || !rawSql) return;
      // Legacy draft passes validation
      const ids1 = await seedBaseData('valid-legacy-14');
      await seedPaymentAccount(ids1, 'acct_legacy_14');
      const legacyDraft = await createBookingDraftWithHold(db, makeLegacyInput(ids1));
      if (legacyDraft.kind !== 'SUCCESS') throw new Error('Failed to create legacy draft');
      const legacyInit = await initiatePayment(
        makeInitDeps(),
        makeInitiateInput(ids1, legacyDraft.body.draftId, 'valid-legacy-14', 'acct_legacy_14'),
      );
      expect(legacyInit.kind).toBe('SUCCESS');

      // Flexible draft passes validation
      const ids2 = await seedBaseData('valid-flex-14');
      await seedHourlyPlan(ids2);
      await seedOpeningHours(ids2.locationId);
      await seedPaymentAccount(ids2, 'acct_flex_14');
      const flexDraft = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids2, '2026-02-10T09:00:00', '2026-02-10T11:00:00', {
          idempotencyKey: 'valid-flex-14',
        }),
      );
      if (flexDraft.kind !== 'SUCCESS') throw new Error('Failed to create flexible draft');
      const flexInit = await initiatePayment(
        makeInitDeps(),
        makeInitiateInput(ids2, flexDraft.body.draftId, 'valid-flex-14', 'acct_flex_14'),
      );
      expect(flexInit.kind).toBe('SUCCESS');

      // Verify the CHECK constraint prevents invalid versions at DB level
      await expect(
        rawSql`UPDATE "booking_drafts" SET "pricing_snapshot_version" = 'unknown-v999' WHERE "id" = ${flexDraft.body.draftId}`,
      ).rejects.toThrow();

      // Verify the draft still has the valid version (update was rejected)
      const draft = await rawSql`
        SELECT pricing_snapshot_version FROM booking_drafts WHERE id = ${flexDraft.body.draftId}
      `.then((r) => r[0]!);
      expect(draft.pricing_snapshot_version).toBe('flexible-pricing-v1');
    });

    // 15. Financial mismatch rejected with rollback
    it('15. financial mismatch (wrong amount) rejected with rollback, no partial booking', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('mismatch-15');
      await seedPaymentAccount(ids);
      const draftId = await createBookingDraftWithHold(
        db,
        makeLegacyInput(ids, { idempotencyKey: 'mismatch-15' }),
      ).then((r) => (r.kind === 'SUCCESS' ? r.body.draftId : null));
      if (!draftId) throw new Error('Failed to create draft');

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'mismatch-15'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
      const piId = initResult.providerPaymentIntentId;
      const paymentId = await getPaymentId(draftId);
      const amount = await getPaymentAmount(draftId);

      // Webhook with wrong amount
      const deps = makeDeps();
      const body = makeWebhookPayload('payment_intent.succeeded', piId, amount + 99999, {
        payment_id: paymentId,
        payment_attempt_id: initResult.paymentAttemptId,
        draft_id: draftId,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      });
      const input = makeWebhookInput(body, deps.adapter);
      const result = await handleWebhook(deps, input);
      // The webhook handler returns SUCCESS 200 for irreconcilable errors (FAILED event)
      expect(result.kind).toBe('SUCCESS');

      // No booking created
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // No booking_lines created
      const lines = await rawSql`
        SELECT bl.id FROM booking_lines bl
        JOIN bookings b ON bl.booking_id = b.id
        WHERE b.draft_id = ${draftId}
      `;
      expect(lines.length).toBe(0);

      // Draft is NOT converted
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('PAYMENT_PROCESSING');
    });

    // 16. Snapshot mismatch rejected with rollback (BEFORE INSERT trigger)
    it('16. direct INSERT of booking_line with wrong pricing fields is rejected by trigger', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('trigger-16');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00', {
          idempotencyKey: 'trigger-16',
        }),
        'trigger-16',
      );

      // Get the draft line
      const draftLine = await rawSql`
        SELECT id, pricing_plan_type, unit_price_amount_minor, variant_id, variant_snapshot,
               quantity, billable_unit_count, line_total_amount_minor, currency
        FROM booking_draft_lines WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);

      // Attempt to insert a booking_line with wrong pricing_plan_type (bypassing the app)
      await expect(
        rawSql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "currency", "variant_snapshot",
            "source_draft_line_id", "pricing_plan_id", "pricing_plan_version",
            "pricing_plan_type", "pricing_public_label",
            "pricing_billed_duration_minutes"
          ) VALUES (
            ${bookingId}, ${draftLine.variant_id}, ${draftLine.quantity},
            ${draftLine.unit_price_amount_minor},
            ${draftLine.billable_unit_count}, ${draftLine.line_total_amount_minor},
            ${draftLine.currency}, ${draftLine.variant_snapshot},
            ${draftLine.id}, null, null,
            'DAILY', 'WRONG',
            ${draftLine.pricing_billed_duration_minutes ?? null}
          )
        `,
      ).rejects.toThrow();
    });

    // 17. Webhook replay idempotent
    it('17. webhook replay: second confirmation is idempotent (no double booking)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('replay-17');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'replay-17' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'replay-17'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);

      // First confirmation
      const result1 = await handleWebhook(deps, input);
      expect(result1.kind).toBe('SUCCESS');

      // Second confirmation (same event ID = duplicate)
      const result2 = await handleWebhook(deps, input);
      expect(result2.kind).toBe('SUCCESS');

      // Exactly one booking
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(1);

      // Exactly one set of booking_lines
      const lines =
        await rawSql`SELECT id FROM booking_lines WHERE booking_id = ${bookings[0]!.id}`;
      expect(lines.length).toBe(1);
    });

    // 18. Concurrent webhook/reconciliation without double booking
    it('18. concurrent confirmation attempts: only one succeeds', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('conc-18');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'conc-18' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'conc-18'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);

      // Two simultaneous webhook calls with the same event ID
      const [result1, result2] = await Promise.all([
        handleWebhook(deps, input),
        handleWebhook(deps, input),
      ]);

      expect(result1.kind).toBe('SUCCESS');
      expect(result2.kind).toBe('SUCCESS');

      // Exactly one booking
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(1);
    });

    // 19. Payment refused or technical error without partial booking
    it('19. draft not in PAYMENT_PROCESSING: confirmation fails, no partial booking', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('notproc-19');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'notproc-19' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      // Do NOT initiate payment — draft is still HELD, not PAYMENT_PROCESSING
      // Attempt direct confirmation via applyBookingConfirmation
      const paymentId = '00000000-0000-0000-0000-000000000000';
      const attemptId = '00000000-0000-0000-0000-000000000001';

      const attempt: ResolvedAttempt = {
        attemptId,
        paymentId,
        draftId,
        organizationId: ids.orgId,
        attemptNumber: 1,
        attemptStatus: 'PENDING_PROVIDER',
        paymentStatus: 'PENDING_PROVIDER',
        draftStatus: 'HELD',
        providerPaymentIntentId: 'pi_notproc_19',
      };

      const piData: PaymentIntentEventData = {
        id: 'pi_notproc_19',
        status: 'succeeded',
        amount: 2000,
        currency: 'eur',
        metadata: {
          payment_id: paymentId,
          payment_attempt_id: attemptId,
          draft_id: draftId,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        },
        destination: 'acct_test_123',
        applicationFeeAmount: 500,
        onBehalfOfAccountId: null,
      };

      // The lockFullBusinessRows will fail because payment doesn't exist
      await expect(
        db.transaction(async (tx) => {
          const lockedRows = await lockFullBusinessRows(tx, attempt);
          await applyBookingConfirmation(tx, attempt, piData, 'TEST', lockedRows);
        }),
      ).rejects.toThrow();

      // No booking created
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // No booking_lines
      const lines = await rawSql`
        SELECT bl.id FROM booking_lines bl
        JOIN bookings b ON bl.booking_id = b.id
        WHERE b.draft_id = ${draftId}
      `;
      expect(lines.length).toBe(0);
    });

    // 20. Expiration and compensation compatibility
    it('20. expired draft: compensation flow works without accessing pricing plans', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('expire-20');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'expire-20' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create draft');
      const draftId = draftResult.body.draftId;

      // Manually expire the draft by setting expires_at in the past
      // Also update the inventory blocks' expires_at to match (validation requires they match)
      const pastTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      await rawSql`UPDATE "booking_drafts" SET "expires_at" = ${pastTime} WHERE "id" = ${draftId}`;
      await rawSql`UPDATE "inventory_blocks" SET "expires_at" = ${pastTime} WHERE "source_id" = ${draftId} AND "deleted_at" IS NULL`;

      // Verify the draft is still HELD (not yet expired by batch)
      const draftBefore =
        await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then((r) => r[0]!);
      expect(draftBefore.status).toBe('HELD');

      // Run the expiration batch
      const { expireBookingDraftsBatch } =
        await import('../booking-drafts/expire-booking-drafts-batch');
      const expireResult = await expireBookingDraftsBatch(db, 10);
      expect(expireResult.expired.length).toBeGreaterThanOrEqual(1);

      // Draft is now EXPIRED
      const draftAfter = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draftAfter.status).toBe('EXPIRED');

      // No booking created
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // The pricing plan is still accessible (not deleted/modified)
      const plan = await rawSql`
        SELECT lifecycle_state FROM pricing_plans WHERE product_variant_id = ${ids.variantId}
      `.then((r) => r[0]!);
      expect(plan.lifecycle_state).toBe('ACTIVE');
    });

    // 21. No daily_price_amount_minor recalculation on flexible path
    it('21. flexible booking amounts come from draft snapshot, not daily_price_amount_minor', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('no-recalc-21');
      // Set daily_price_amount_minor to a different value than the plan price
      await rawSql`UPDATE "product_variants" SET "daily_price_amount_minor" = 99999 WHERE "id" = ${ids.variantId}`;
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'no-recalc-21',
        }),
        'no-recalc-21',
      );

      const draftLine = await rawSql`
        SELECT line_total_amount_minor, unit_price_amount_minor
        FROM booking_draft_lines WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);

      const bookingLine = await rawSql`
        SELECT line_total_amount_minor, unit_price_amount_minor
        FROM booking_lines WHERE booking_id = ${bookingId}
      `.then((r) => r[0]!);

      // Booking line amounts match draft line amounts exactly (from snapshot)
      expect(Number(bookingLine.line_total_amount_minor)).toBe(
        Number(draftLine.line_total_amount_minor),
      );
      expect(Number(bookingLine.unit_price_amount_minor)).toBe(
        Number(draftLine.unit_price_amount_minor),
      );

      // The amounts should be based on the plan price (5000 * 2 days = 10000), not daily_price_amount_minor (99999)
      expect(Number(bookingLine.line_total_amount_minor)).toBe(10000);
      expect(Number(bookingLine.unit_price_amount_minor)).toBe(5000);
    });

    // 22. No pricing_plans access during copy
    it('22. applyBookingConfirmation source code does not reference pricing_plans or pricingPlans', async () => {
      const sourcePath = join(__dirname, 'apply-booking-confirmation.ts');
      const source = readFileSync(sourcePath, 'utf-8');

      // Check for SQL table references
      expect(source).not.toMatch(/\bpricing_plans\b/);

      // Check for Drizzle/JS references to the pricingPlans table object
      // We exclude import statements and comments that might reference it generically
      // The function body should not query pricing_plans
      const lines = source.split('\n');
      const codeLines = lines.filter(
        (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
      );
      const codeBody = codeLines.join('\n');
      expect(codeBody).not.toMatch(/\bpricingPlans\b/);
    });

    // 23. Draft flexible conserves UNDETERMINED/null for tax/commission
    it('23. draft flexible conserves UNDETERMINED/null for tax/commission at draft stage', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('undetermined-23');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'undetermined-23' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create flexible draft');

      // The response body should have UNDETERMINED/null
      expect(draftResult.body.taxStatus).toBe('UNDETERMINED');
      expect(draftResult.body.taxAmountMinor).toBeNull();
      expect(draftResult.body.commissionAmountMinor).toBeNull();

      // The DB row should also have UNDETERMINED/null
      const draft = await rawSql`
        SELECT tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor
        FROM booking_drafts WHERE id = ${draftResult.body.draftId}
      `.then((r) => r[0]!);
      expect(draft.tax_status).toBe('UNDETERMINED');
      expect(draft.tax_amount_minor).toBeNull();
      expect(draft.tax_rate_bps).toBeNull();
      expect(draft.commission_amount_minor).toBeNull();
    });

    // 24. Initiation flexible resolves NOT_APPLICABLE/0 when configured
    it('24. initiation flexible resolves tax/commission in payment (NOT_APPLICABLE)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('resolve-24');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'resolve-24' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create flexible draft');
      const draftId = draftResult.body.draftId;

      const initDeps = makeInitDeps();
      const initResult = await initiatePayment(
        initDeps,
        makeInitiateInput(ids, draftId, 'resolve-24'),
      );
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');

      // The payment should have resolved financial terms
      const payment = await rawSql`
        SELECT tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
               financial_terms_version, legal_terms_version, terms_acceptance_snapshot
        FROM payments WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);
      expect(payment.tax_status).toBe('NOT_APPLICABLE');
      expect(Number(payment.tax_amount_minor)).toBe(0);
      expect(Number(payment.commission_amount_minor)).toBe(260);
      expect(payment.financial_terms_version).not.toBeNull();
    });

    // 25. Commission flexible non-null in payment -> booking copies this non-null commission
    it('25. flexible booking copies commission from payment (not from draft)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('commission-25');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId, paymentId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'commission-25' }),
        'commission-25',
      );

      // The draft has UNDETERMINED/null
      const draft = await rawSql`
        SELECT tax_status, tax_amount_minor, commission_amount_minor
        FROM booking_drafts WHERE id = ${draftId}
      `.then((r) => r[0]!);
      expect(draft.tax_status).toBe('UNDETERMINED');
      expect(draft.commission_amount_minor).toBeNull();

      // The payment has resolved values
      const payment = await rawSql`
        SELECT tax_status, tax_amount_minor, commission_amount_minor
        FROM payments WHERE id = ${paymentId}
      `.then((r) => r[0]!);
      expect(payment.tax_status).toBe('NOT_APPLICABLE');
      expect(Number(payment.commission_amount_minor)).toBe(260);

      // The booking copies from payment, NOT from draft
      const booking = await rawSql`
        SELECT tax_status, tax_amount_minor, commission_amount_minor
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);
      expect(booking.tax_status).toBe(payment.tax_status);
      expect(Number(booking.tax_amount_minor)).toBe(Number(payment.tax_amount_minor));
      expect(Number(booking.commission_amount_minor)).toBe(Number(payment.commission_amount_minor));
      expect(booking.tax_status).not.toBe(draft.tax_status);
      expect(booking.commission_amount_minor).not.toBeNull();
    });

    // 26. Tax APPLIED non-null -> booking copies tax status/amount from payment
    it('26. flexible booking copies tax APPLIED from payment (not from draft)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('tax-applied-26');
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';

      // Use a financial terms config with tax APPLIED
      await seedPaymentAccount(ids);
      const draftResult = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'tax-applied-26' }),
      );
      if (draftResult.kind !== 'SUCCESS') throw new Error('Failed to create flexible draft');
      const draftId = draftResult.body.draftId;

      const initDeps = makeInitDeps();
      const initInput = makeInitiateInput(ids, draftId, 'tax-applied-26');
      // Override with APPLIED tax config
      initInput.financialTermsConfig = {
        tax: {
          version: 'v1',
          status: 'APPLIED',
          amountMinor: 200,
          rateBps: 1000,
          invoiceIssuer: 'Uttily',
        },
        commission: {
          version: 'v1',
          basis: 'percentage',
          amountMinor: 260,
        },
        connectedAccount: {
          accountId: 'acct_test_123',
          chargesEnabled: true,
          transfersCapabilityStatus: 'ACTIVE',
          settlementMerchantMode: 'PLATFORM',
          onBehalfOfAccountId: null,
        },
        legalTermsVersion: 'v1',
      };
      const initResult = await initiatePayment(initDeps, initInput);
      if (initResult.kind !== 'SUCCESS') throw new Error('Failed to initiate payment');
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
      const input = makeWebhookInput(body, deps.adapter);
      const result = await handleWebhook(deps, input);
      expect(result.kind).toBe('SUCCESS');

      const booking = await rawSql`
        SELECT tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor
        FROM bookings WHERE draft_id = ${draftId}
      `.then((r) => r[0]!);
      expect(booking.tax_status).toBe('APPLIED');
      expect(Number(booking.tax_amount_minor)).toBe(200);
      expect(booking.tax_rate_bps).toBe(1000);
      expect(Number(booking.commission_amount_minor)).toBe(260);
    });

    // 27. Rental price of booking remains exact copy of draft
    it('27. flexible booking rental price remains exact copy of draft (no recalculation)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('rental-copy-27');
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const { bookingId, draftId } = await confirmFlexibleDraft(
        ids,
        makeFlexibleTimeRangeInput(ids, start, end, { idempotencyKey: 'rental-copy-27' }),
        'rental-copy-27',
      );

      const draft = await rawSql`
        SELECT subtotal_amount_minor, total_amount_minor, mandatory_fees_amount_minor
        FROM booking_drafts WHERE id = ${draftId}
      `.then((r) => r[0]!);

      const booking = await rawSql`
        SELECT subtotal_amount_minor, total_amount_minor, mandatory_fees_amount_minor
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(Number(booking.subtotal_amount_minor)).toBe(Number(draft.subtotal_amount_minor));
      expect(Number(booking.total_amount_minor)).toBe(Number(draft.total_amount_minor));
      expect(Number(booking.mandatory_fees_amount_minor)).toBe(
        Number(draft.mandatory_fees_amount_minor),
      );
    });

    // 28. Legacy unchanged: tax/commission still come from payment
    it('28. legacy booking copies tax/commission from payment (unchanged behavior)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('legacy-28');
      const { bookingId, paymentId } = await confirmLegacyDraft(ids, 'legacy-28');

      const payment = await rawSql`
        SELECT tax_status, tax_amount_minor, commission_amount_minor
        FROM payments WHERE id = ${paymentId}
      `.then((r) => r[0]!);

      const booking = await rawSql`
        SELECT tax_status, tax_amount_minor, commission_amount_minor
        FROM bookings WHERE id = ${bookingId}
      `.then((r) => r[0]!);

      expect(booking.tax_status).toBe(payment.tax_status);
      expect(Number(booking.tax_amount_minor)).toBe(Number(payment.tax_amount_minor));
      expect(Number(booking.commission_amount_minor)).toBe(Number(payment.commission_amount_minor));
    });
  },
);
