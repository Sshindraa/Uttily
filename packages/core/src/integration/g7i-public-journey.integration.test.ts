/**
 * @uttily/core — G7I Lot 7 release validation gate.
 *
 * Tests d'intégration PostgreSQL transversaux couvrant la chaîne publique
 * complète (search → details → authority → hold → payment → webhook → confirm),
 * l'isolation multi-tenant des publicIds, et la cohérence des intervalles
 * semi-ouverts [start, end) à travers le flux search→hold→checkout.
 *
 * Ces tests ne dupliquent pas la couverture existante : ils chaînent les 7 étapes
 * dans un seul test end-to-end et vérifient les invariants transversaux.
 *
 * Date de travail : 2026-08-08.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { searchPublicOffers } from '../public-search/search-offers';
import { getPublicOfferDetails } from '../public-search/get-public-offer-details';
import { resolvePublicBookingAuthority } from '../public-search/resolve-public-booking-authority';
import { createPublicSearchCursorCodec } from '../public-search/cursor';
import type {
  PublicProductPublicationGate,
  SearchPublicOffersInput,
  PublicSearchIntent,
} from '../public-search/types';
import type { FlexibleCreateBookingDraftInput } from '../booking-drafts/types';
import { createBookingDraftWithHold } from '../booking-drafts';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput } from '../webhook-handler/types';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g7i_journey');
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
      multi_day_discount_tiers, pricing_plans, destinations, destination_translations,
      locations, organization_memberships,
      organizations, users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor codec & publication gate (test helpers)
// ─────────────────────────────────────────────────────────────────────────────

const testCursorCodec = createPublicSearchCursorCodec(
  'test-secret-for-g7i-journey-tests-only-not-for-production',
);

const fakePublicationGate: PublicProductPublicationGate = {
  async filterEligibleProductIds(_db: DatabaseClient, productIds: readonly string[]) {
    return new Set(productIds);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

interface JourneyIds {
  orgId: string;
  locationId: string;
  publicLocationId: string;
  userId: string;
  categoryId: string;
  productId: string;
  publicProductId: string;
  variantId: string;
  publicVariantId: string;
  inventoryItemId: string;
  destinationPublicId: string;
}

async function seedCountry(): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
    VALUES ('FR', true, 'EUR', 'fr')
    ON CONFLICT ("country_code") DO UPDATE SET "is_active" = true
  `;
}

async function seedDestination(suffix = SUFFIX()): Promise<{ id: string; publicId: string }> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await seedCountry();
  const dest = await sql`
    INSERT INTO "destinations" (
      "public_id", "slug", "country_code", "place_type",
      "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east", "is_active"
    )
    VALUES (
      gen_random_uuid(), ${'annecy-' + suffix}, 'FR', 'CITY',
      ST_SetSRID(ST_MakePoint(6.12, 45.89), 4326),
      45.88, 6.10, 45.90, 6.14, false
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "destination_translations" ("destination_id", "locale", "label")
    VALUES
      (${dest.id}, 'fr', 'Annecy'),
      (${dest.id}, 'en', 'Annecy')
  `;
  await sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${dest.id}`;
  return { id: dest.id, publicId: dest.public_id };
}

async function seedJourneyFixture(suffix = SUFFIX()): Promise<JourneyIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;

  const { publicId: destinationPublicId } = await seedDestination(suffix);

  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "public_display_name", "default_cancellation_policy_code", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, ${'Test Org ' + suffix}, 'FLEXIBLE', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);

  const loc = await sql`
    INSERT INTO "locations" (
      "organization_id", "name", "slug", "time_zone",
      "address_line1", "address_line2", "city", "postal_code", "country_code",
      "geo_point", "pickup_enabled", "is_publicly_listed", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency"
    )
    VALUES (
      ${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris',
      '1 rue du lac', null, 'Annecy', '74000', 'FR',
      ST_SetSRID(ST_MakePoint(6.12, 45.89), 4326),
      true, true, 30, 30, 'EUR'
    )
    RETURNING "id", "public_id"
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
    INSERT INTO "products" (
      "organization_id", "category_id", "name", "slug", "publication_status", "public_id"
    )
    VALUES (
      ${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT', gen_random_uuid()
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);

  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + i},
        'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
        ${i}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;

  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);

  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${loc.id}, 'NEW', 'ACTIVE')
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    orgId: org.id,
    locationId: loc.id,
    publicLocationId: loc.public_id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    publicProductId: product.public_id,
    variantId: variant.id,
    publicVariantId: variant.public_id,
    inventoryItemId: item.id,
    destinationPublicId,
  };
}

async function seedDailyPlan(ids: JourneyIds): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 5000, 0, 'DRAFT', 1)
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${ids.locationId}, 127, '08:00:00', '20:00:00')
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Location journaliere'), (${plan.id}, 'en', 'Daily rental')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  return plan.id;
}

async function seedOpeningHours(locationId: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  for (let weekday = 0; weekday <= 6; weekday++) {
    await sql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES (${locationId}, ${weekday}, '08:00:00', '20:00:00')
    `;
  }
}

async function seedPaymentAccount(ids: JourneyIds, accountId = 'acct_test_123'): Promise<void> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Payment / webhook helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  ids: JourneyIds,
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('G7I — Lot 7 release validation', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // GAP 1: End-to-end public journey chain
  // ─────────────────────────────────────────────────────────────────────────
  it('GAP 1: chain searchPublicOffers → getPublicOfferDetails → resolvePublicBookingAuthority → createBookingDraftWithHold → initiatePayment → handleWebhook → applyBookingConfirmation produces CONFIRMED booking with outbox event', async () => {
    if (!db || !rawSql) return;

    // Seed complete fixture
    const ids = await seedJourneyFixture('g7i-gap1');
    await seedDailyPlan(ids);
    await seedOpeningHours(ids.locationId);
    await seedPaymentAccount(ids);

    // Step 1: searchPublicOffers — DAY_RANGE intent
    const dayRange: PublicSearchIntent = {
      kind: 'DAY_RANGE',
      startDate: '2026-02-10',
      endDateExclusive: '2026-02-12',
    };
    const searchInput: SearchPublicOffersInput = {
      destinationPublicId: ids.destinationPublicId,
      locale: 'fr',
      intent: dayRange,
    };
    const searchResult = await searchPublicOffers(db, searchInput, {
      publicationGate: fakePublicationGate,
      cursorCodec: testCursorCodec,
    });
    expect(searchResult.items.length).toBeGreaterThanOrEqual(1);
    const offer = searchResult.items.find(
      (item) =>
        item.publicProductId === ids.publicProductId &&
        item.publicLocationId === ids.publicLocationId,
    );
    expect(offer).toBeDefined();
    expect(offer!.isAvailable).toBe(true);
    expect(offer!.price.planType).toBe('DAILY');
    expect(offer!.price.totalAmountMinor).toBe(10000);

    // Step 2: getPublicOfferDetails
    const detailsResult = await getPublicOfferDetails(
      db,
      {
        publicProductId: ids.publicProductId,
        publicLocationId: ids.publicLocationId,
        locale: 'fr',
      },
      { publicationGate: fakePublicationGate },
    );
    expect(detailsResult.kind).toBe('SUCCESS');
    if (detailsResult.kind !== 'SUCCESS') return;
    expect(detailsResult.offer.publicProductId).toBe(ids.publicProductId);
    expect(detailsResult.offer.publicLocationId).toBe(ids.publicLocationId);
    expect(detailsResult.offer.timeZone).toBe('Europe/Paris');
    expect(detailsResult.offer.variants.length).toBeGreaterThanOrEqual(1);
    const variantDetail = detailsResult.offer.variants.find(
      (v) => v.publicVariantId === ids.publicVariantId,
    );
    expect(variantDetail).toBeDefined();

    // Step 3: resolvePublicBookingAuthority
    const authorityResult = await resolvePublicBookingAuthority(
      db,
      {
        publicProductId: ids.publicProductId,
        publicLocationId: ids.publicLocationId,
        publicVariantId: ids.publicVariantId,
      },
      { publicationGate: fakePublicationGate },
    );
    expect(authorityResult.kind).toBe('SUCCESS');
    if (authorityResult.kind !== 'SUCCESS') return;
    expect(authorityResult.authority.organizationId).toBe(ids.orgId);
    expect(authorityResult.authority.locationId).toBe(ids.locationId);
    expect(authorityResult.authority.productId).toBe(ids.productId);
    expect(authorityResult.authority.variantId).toBe(ids.variantId);

    // Step 4: createBookingDraftWithHold (FLEXIBLE + DAY_RANGE)
    const draftInput: FlexibleCreateBookingDraftInput = {
      pricingMode: 'FLEXIBLE',
      organizationId: ids.orgId,
      locationId: ids.locationId,
      customerUserId: ids.userId,
      locale: 'fr',
      intent: { kind: 'DAY_RANGE', startDate: '2026-02-10', endDateExclusive: '2026-02-12' },
      lines: [{ variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: 'g7i-gap1-' + SUFFIX(),
    };
    const draftResult = await createBookingDraftWithHold(db, draftInput);
    expect(draftResult.kind).toBe('SUCCESS');
    if (draftResult.kind !== 'SUCCESS') return;
    const draftId = draftResult.body.draftId;

    // Step 5: initiatePayment
    const initDeps = makeInitDeps();
    const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, 'g7i-gap1'));
    expect(initResult.kind).toBe('SUCCESS');
    if (initResult.kind !== 'SUCCESS') return;
    const piId = initResult.providerPaymentIntentId;
    const paymentId = await getPaymentId(draftId);
    const amount = await getPaymentAmount(draftId);

    // Step 6: handleWebhook (internally calls applyBookingConfirmation)
    const deps = makeDeps();
    const body = makeWebhookPayload('payment_intent.succeeded', piId, amount, {
      payment_id: paymentId,
      payment_attempt_id: initResult.paymentAttemptId,
      draft_id: draftId,
      organization_id: ids.orgId,
      protocol_version: 'v1',
    });
    const input = makeWebhookInput(body, deps.adapter);
    const webhookResult = await handleWebhook(deps, input);
    expect(webhookResult.kind).toBe('SUCCESS');

    // Step 7: applyBookingConfirmation result verification — booking is CONFIRMED
    const booking = await rawSql`SELECT id, status FROM bookings WHERE draft_id = ${draftId}`.then(
      (r) => r[0]!,
    );
    expect(booking.status).toBe('CONFIRMED');

    // Verify outbox event BOOKING_CONFIRMED.v1 was created
    const outboxEvent = await rawSql`
      SELECT event_type, event_version, aggregate_type, aggregate_id, status
      FROM outbox_events
      WHERE aggregate_id = ${booking.id} AND event_type = 'BOOKING_CONFIRMED'
      LIMIT 1
    `.then((r) => r[0]);
    expect(outboxEvent).toBeDefined();
    expect(outboxEvent!.event_type).toBe('BOOKING_CONFIRMED');
    expect(outboxEvent!.event_version).toBe('v1');
    expect(outboxEvent!.aggregate_type).toBe('BOOKING');
    expect(outboxEvent!.status).toBe('PENDING');

    // Verify draft is CONVERTED
    const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`.then(
      (r) => r[0]!,
    );
    expect(draft.status).toBe('CONVERTED');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GAP 2: Forged publicVariantId cross-tenant (variant forgery)
  // The cross-tenant product+location mismatch is already covered by the
  // existing test #2 in resolve-public-booking-authority.integration.test.ts.
  // This test adds the variant forgery scenario: a publicVariantId from orgB
  // paired with a valid publicProductId/publicLocationId from orgA.
  // ─────────────────────────────────────────────────────────────────────────
  it('GAP 2: resolvePublicBookingAuthority rejects forged publicVariantId from another organization', async () => {
    if (!db || !rawSql) return;

    // Seed two organizations, each with their own product/location/variant
    const orgA = await seedJourneyFixture('g7i-gap2-a');
    await seedDailyPlan(orgA);
    await seedOpeningHours(orgA.locationId);

    const orgB = await seedJourneyFixture('g7i-gap2-b');
    await seedDailyPlan(orgB);
    await seedOpeningHours(orgB.locationId);

    // Variant forgery: orgB's publicVariantId + orgA's publicProductId/publicLocationId
    const crossResult = await resolvePublicBookingAuthority(
      db,
      {
        publicProductId: orgA.publicProductId,
        publicLocationId: orgA.publicLocationId,
        publicVariantId: orgB.publicVariantId,
      },
      { publicationGate: fakePublicationGate },
    );
    // Must NOT be SUCCESS — variant from another org must be rejected
    expect(crossResult.kind).not.toBe('SUCCESS');
    expect(['NOT_FOUND', 'INVALID_INPUT']).toContain(crossResult.kind);

    // Sanity check: same-org resolution still succeeds
    const validResult = await resolvePublicBookingAuthority(
      db,
      {
        publicProductId: orgA.publicProductId,
        publicLocationId: orgA.publicLocationId,
        publicVariantId: orgA.publicVariantId,
      },
      { publicationGate: fakePublicationGate },
    );
    expect(validResult.kind).toBe('SUCCESS');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GAP 3: Semi-open interval consistency [start, end)
  // ─────────────────────────────────────────────────────────────────────────
  it('GAP 3: blockedStartAt/blockedEndAt follow semi-open [start, end) convention — adjacent block starting at previous block end does not overlap', async () => {
    if (!db || !rawSql) return;

    const ids = await seedJourneyFixture('g7i-gap3');
    await seedDailyPlan(ids);
    await seedOpeningHours(ids.locationId);
    await seedPaymentAccount(ids);

    // Create the first booking draft with a DAY_RANGE [2026-02-10, 2026-02-12)
    const draftInput1: FlexibleCreateBookingDraftInput = {
      pricingMode: 'FLEXIBLE',
      organizationId: ids.orgId,
      locationId: ids.locationId,
      customerUserId: ids.userId,
      locale: 'fr',
      intent: { kind: 'DAY_RANGE', startDate: '2026-02-10', endDateExclusive: '2026-02-12' },
      lines: [{ variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: 'g7i-gap3-1-' + SUFFIX(),
    };
    const draftResult1 = await createBookingDraftWithHold(db, draftInput1);
    expect(draftResult1.kind).toBe('SUCCESS');
    if (draftResult1.kind !== 'SUCCESS') return;
    const draftId1 = draftResult1.body.draftId;

    // Verify the hold block's blockedStartAt and blockedEndAt
    const block1 = await rawSql`
      SELECT blocked_start_at, blocked_end_at, customer_start_at, customer_end_at, status, type
      FROM inventory_blocks
      WHERE inventory_item_id = ${ids.inventoryItemId}
      ORDER BY blocked_start_at
      LIMIT 1
    `.then((r) => r[0]!);
    expect(block1.status).toBe('ACTIVE');
    expect(block1.type).toBe('HOLD');

    // The block's end is exclusive — an adjacent block starting at block1.blocked_end_at
    // must NOT overlap. Confirm the first draft to convert the hold to an ACTIVE block.
    const initDeps = makeInitDeps();
    const initResult1 = await initiatePayment(
      initDeps,
      makeInitiateInput(ids, draftId1, 'g7i-gap3-1'),
    );
    expect(initResult1.kind).toBe('SUCCESS');
    if (initResult1.kind !== 'SUCCESS') return;

    const deps = makeDeps();
    const paymentId1 = await getPaymentId(draftId1);
    const amount1 = await getPaymentAmount(draftId1);
    const body1 = makeWebhookPayload(
      'payment_intent.succeeded',
      initResult1.providerPaymentIntentId,
      amount1,
      {
        payment_id: paymentId1,
        payment_attempt_id: initResult1.paymentAttemptId,
        draft_id: draftId1,
        organization_id: ids.orgId,
        protocol_version: 'v1',
      },
    );
    const webhookResult1 = await handleWebhook(deps, makeWebhookInput(body1, deps.adapter));
    expect(webhookResult1.kind).toBe('SUCCESS');

    // After confirmation, the block is ACTIVE with [blockedStartAt, blockedEndAt)
    const activeBlock = await rawSql`
      SELECT blocked_start_at, blocked_end_at, status, type
      FROM inventory_blocks
      WHERE inventory_item_id = ${ids.inventoryItemId} AND status = 'ACTIVE'
      ORDER BY blocked_start_at
      LIMIT 1
    `.then((r) => r[0]!);
    expect(activeBlock.status).toBe('ACTIVE');

    // Now create a second draft for the adjacent period [2026-02-12, 2026-02-14)
    // — the start of the second block must equal the end of the first (semi-open).
    const draftInput2: FlexibleCreateBookingDraftInput = {
      pricingMode: 'FLEXIBLE',
      organizationId: ids.orgId,
      locationId: ids.locationId,
      customerUserId: ids.userId,
      locale: 'fr',
      intent: { kind: 'DAY_RANGE', startDate: '2026-02-12', endDateExclusive: '2026-02-14' },
      lines: [{ variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: 'g7i-gap3-2-' + SUFFIX(),
    };
    const draftResult2 = await createBookingDraftWithHold(db, draftInput2);
    expect(draftResult2.kind).toBe('SUCCESS');
    if (draftResult2.kind !== 'SUCCESS') return;

    // The second hold block must start at or after the first block's end (no overlap)
    const block2 = await rawSql`
      SELECT blocked_start_at, blocked_end_at, status, type
      FROM inventory_blocks
      WHERE inventory_item_id = ${ids.inventoryItemId} AND type = 'HOLD' AND status = 'ACTIVE'
      ORDER BY blocked_start_at
      LIMIT 1
    `.then((r) => r[0]!);
    expect(block2.type).toBe('HOLD');
    expect(block2.status).toBe('ACTIVE');

    // Semi-open interval: block2.blocked_start_at >= activeBlock.blocked_end_at
    // (the end of the first block is exclusive, so the second can start exactly there)
    const activeEnd = new Date(activeBlock.blocked_end_at).getTime();
    const hold2Start = new Date(block2.blocked_start_at).getTime();
    expect(hold2Start).toBeGreaterThanOrEqual(activeEnd);

    // Verify no temporal overlap between the two blocks:
    // overlap exists if block2.start < block1.end AND block2.end > block1.start
    const activeStart = new Date(activeBlock.blocked_start_at).getTime();
    const hold2End = new Date(block2.blocked_end_at).getTime();
    const hasOverlap = hold2Start < activeEnd && hold2End > activeStart;
    expect(hasOverlap).toBe(false);
  });
});
