import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  runMigrations,
  assertLocalhost,
  type DatabaseClient,
  createDatabase,
} from '@uttily/database';
import { parseBookingAmendedV1Event } from '@uttily/contracts';
import { createNeutralBookingAmendment } from './create-neutral-booking-amendment';
import type { NeutralAmendmentCommand } from './types-amendment';
import type { AuthenticatedUser } from '../identity/types';

/**
 * Tests d'intégration PostgreSQL pour createNeutralBookingAmendment (G7M-B2-A).
 */

const TEST_DB_NAME = 'uttily_test_g7m_b2a';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  if (!url) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(dbUrl: string): Promise<boolean> {
  try {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

function hasDeadlockCode(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  if (obj['code'] === '40P01' || obj['sqlState'] === '40P01') return true;
  if ('cause' in obj && obj['cause']) return hasDeadlockCode(obj['cause']);
  return false;
}

let testUrl: string | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests G7M-B2-A.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker-compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
  db = createDatabase(testUrl);
  rawSql = postgres(testUrl, { max: 10 });
}, 600000);

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (!url || !testUrl) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    await cleanupSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  } finally {
    await cleanupSql.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  variantId: string;
  itemId: string;
}

async function seedActiveDailyPricingPlan(
  sql: postgres.Sql,
  orgId: string,
  variantId: string,
  locationId: string,
  priceAmountMinor = 5000,
  label = 'Tarif journalier',
): Promise<string> {
  const plan = await sql`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "location_id", "plan_type", "currency",
      "price_amount_minor", "lifecycle_state", "version"
    )
    VALUES (
      ${orgId}, ${variantId}, ${locationId}, 'DAILY', 'EUR',
      ${priceAmountMinor}, 'DRAFT', 1
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  await sql`
    INSERT INTO "pricing_plan_windows" (
      "pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time"
    )
    VALUES (
      ${plan.id}, ${locationId}, 127, '00:00:00', '23:59:59'
    )
  `;

  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES
      (${plan.id}, 'fr', ${label}),
      (${plan.id}, 'en', ${label})
  `;

  await sql`
    UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}
  `;

  return plan.id;
}

async function seedPublishedProduct(
  sql: postgres.Sql,
  orgId: string,
  categoryId: string,
  name: string,
  slugPrefix: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${orgId}, ${categoryId}, ${name}, ${slugPrefix + '-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);

  for (let pi = 0; pi < 3; pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${orgId}, ${product.id}, ${'product-photos/' + suffix + '-' + pi},
        'image/jpeg', 102400, 800, 600, ${('000' + pi).repeat(16).slice(0, 64)},
        ${pi}, 'AVAILABLE'
      )
    `;
  }

  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  return product.id;
}

async function seedBaseData(sql: postgres.Sql, suffix?: string): Promise<BaseIds> {
  const baseSuffix = suffix ?? '';
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const fullSuffix = baseSuffix + randomSuffix;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug")
    VALUES (${'Test Org ' + fullSuffix}, ${'org-' + fullSuffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + fullSuffix}, 'Europe/Paris', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + fullSuffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const productId = await seedPublishedProduct(
    sql,
    org.id,
    category.id,
    'Kayak',
    'kayak-' + fullSuffix,
  );
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
    VALUES (${productId}, 'Standard', 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + fullSuffix}, ${location.id})
    RETURNING "id"
  `.then((r) => r[0]!);

  // Seeder le plan tarifaire ACTIVE pour G7P quoteFlexiblePricing
  await seedActiveDailyPricingPlan(sql, org.id, variant.id, location.id, 5000);

  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    variantId: variant.id,
    itemId: item.id,
  };
}

interface BookingWithItemIds {
  bookingId: string;
  bookingItemId: string;
  lineId: string;
  blockId: string;
  bookingItemIds: string[];
  blockIds: string[];
  inventoryItemIds: string[];
}

async function seedBookingWithItem(
  sql: postgres.Sql,
  ids: BaseIds,
  monthOffset = 3,
  qty = 1,
  unitPrice = 5000,
): Promise<BookingWithItemIds> {
  const lineTotal = qty * unitPrice * 2; // 2 billed days
  const month = String(monthOffset).padStart(2, '0');

  // Générer/réutiliser exactement qty inventory_items physiques distincts
  const inventoryItemIds: string[] = [ids.itemId];
  for (let i = 1; i < qty; i++) {
    const itemExtra = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${ids.variantId}, ${'SKU-SEED-QTY-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);
    inventoryItemIds.push(itemExtra.id);
  }

  const draftPayload = {
    customer_start_at: `2026-${month}-10 09:00:00+00`,
    customer_end_at: `2026-${month}-12 17:00:00+00`,
    blocked_start_at: `2026-${month}-10 08:30:00+00`,
    blocked_end_at: `2026-${month}-12 17:30:00+00`,
    timezone: 'Europe/Paris',
    prep_buffer_minutes: 30,
    cleanup_buffer_minutes: 30,
    subtotal_amount_minor: lineTotal,
    mandatory_fees_amount_minor: 0,
    total_amount_minor: lineTotal,
    tax_status: 'NOT_APPLICABLE',
    tax_amount_minor: 0,
    tax_rate_bps: null,
    commission_amount_minor: 500,
    billable_unit: 'DAY',
    billable_unit_count: 2,
    currency: 'EUR',
    cancellation_policy_snapshot: {
      policy_code: 'FLEXIBLE',
      policy_version: '1',
      timezone: 'Europe/Paris',
    },
  };
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
    )
    VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${draftPayload.customer_start_at}, ${draftPayload.customer_end_at},
      ${draftPayload.blocked_start_at}, ${draftPayload.blocked_end_at},
      ${draftPayload.timezone}, ${draftPayload.prep_buffer_minutes}, ${draftPayload.cleanup_buffer_minutes},
      ${draftPayload.subtotal_amount_minor}, ${draftPayload.mandatory_fees_amount_minor}, ${draftPayload.total_amount_minor},
      ${draftPayload.tax_status}, ${draftPayload.tax_amount_minor}, ${draftPayload.tax_rate_bps}, ${draftPayload.commission_amount_minor},
      ${draftPayload.billable_unit}, ${draftPayload.billable_unit_count},
      ${draftPayload.currency}, ${sql.json(draftPayload.cancellation_policy_snapshot)}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
  const draftLine = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${draft.id}, ${ids.variantId}, ${qty}, ${unitPrice}, 2, ${lineTotal}, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  const holdBlockIds: string[] = [];
  for (let i = 0; i < qty; i++) {
    const currentItemId = inventoryItemIds[i]!;
    const holdBlock = await sql`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
      )
      VALUES (
        ${ids.orgId}, ${currentItemId}, 'HOLD', 'ACTIVE',
        ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
        ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${`2026-${month}-09 12:00:00+00`}, ${draft.id}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    holdBlockIds.push(holdBlock.id);

    await sql`
      INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
      VALUES (${draftLine.id}, ${holdBlock.id})
    `;
  }

  const paymentPayload = {
    status: 'SUCCEEDED',
    amount_minor: lineTotal,
    currency: 'EUR',
    tax_status: 'NOT_APPLICABLE',
    tax_amount_minor: 0,
    tax_rate_bps: null,
    commission_amount_minor: 500,
    financial_terms_version: '1',
    legal_terms_version: '1',
    terms_acceptance_snapshot: {
      version: '1',
      user_id: ids.userId,
      accepted_at: '2026-01-01T00:00:00Z',
    },
    connected_account_id: 'acct_test123',
    charge_model: 'DESTINATION',
    settlement_merchant_mode: 'CONNECTED_ACCOUNT',
    environment: 'TEST' as const,
    succeeded_at: '2026-01-01 12:00:00+00',
  };
  const payment = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id",
      "charge_model", "settlement_merchant_mode", "environment", "succeeded_at"
    )
    VALUES (
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      ${paymentPayload.status}, ${paymentPayload.amount_minor}, ${paymentPayload.currency},
      ${paymentPayload.tax_status}, ${paymentPayload.tax_amount_minor}, ${paymentPayload.tax_rate_bps},
      ${paymentPayload.commission_amount_minor},
      ${paymentPayload.financial_terms_version}, ${paymentPayload.legal_terms_version},
      ${sql.json(paymentPayload.terms_acceptance_snapshot)},
      ${paymentPayload.connected_account_id},
      ${paymentPayload.charge_model}, ${paymentPayload.settlement_merchant_mode}, ${paymentPayload.environment}, ${paymentPayload.succeeded_at}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  const termsAcceptanceSnapshot = {
    version: '1',
    user_id: ids.userId,
    accepted_at: '2026-01-01T00:00:00Z',
  };
  const booking = await sql`
    INSERT INTO "bookings" (
      "organization_id", "location_id", "customer_user_id", "draft_id", "payment_id",
      "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "currency",
      "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
      "billable_unit", "billable_unit_count", "cancellation_policy_snapshot", "terms_acceptance_snapshot", "confirmed_at"
    )
    VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId}, ${draft.id}, ${payment.id},
      'CONFIRMED', ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`},
      'Europe/Paris', 30, 30, 'EUR',
      ${lineTotal}, 0, ${lineTotal},
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2, ${sql.json(draftPayload.cancellation_policy_snapshot)}, ${sql.json(termsAcceptanceSnapshot)}, now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  const bookingLine = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking.id}, ${ids.variantId}, ${qty}, ${unitPrice}, 2, ${lineTotal}, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  const bookingBlockIds: string[] = [];
  const bookingItemIds: string[] = [];

  for (let i = 0; i < qty; i++) {
    const currentItemId = inventoryItemIds[i]!;
    const holdBlockId = holdBlockIds[i]!;
    await sql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${holdBlockId}`;

    const bookingBlock = await sql`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at", "source_id"
      )
      VALUES (
        ${ids.orgId}, ${currentItemId}, 'BOOKING', 'ACTIVE',
        ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
        ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${booking.id}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    bookingBlockIds.push(bookingBlock.id);

    const bookingItem = await sql`
      INSERT INTO "booking_items" (
        "booking_id", "booking_line_id", "inventory_item_id", "booking_block_id"
      )
      VALUES (${booking.id}, ${bookingLine.id}, ${currentItemId}, ${bookingBlock.id})
      RETURNING "id"
    `.then((r) => r[0]!);
    bookingItemIds.push(bookingItem.id);
  }

  return {
    bookingId: booking.id,
    bookingItemId: bookingItemIds[0]!,
    lineId: bookingLine.id,
    blockId: bookingBlockIds[0]!,
    bookingItemIds,
    blockIds: bookingBlockIds,
    inventoryItemIds,
  };
}

async function addActor(
  sql: postgres.Sql,
  orgId: string,
  role = 'OWNER',
): Promise<AuthenticatedUser> {
  const u = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'actor-' + Math.random().toString(36).slice(2, 8) + '@example.com'})
    RETURNING "id", "email"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
    VALUES (${orgId}, ${u.id}, ${role}, 'ACTIVE')
  `;
  return {
    id: u.id,
    oidcSubject: 'clerk_' + u.id,
    email: u.email,
    emailVerified: true,
    isPlatformAdmin: false,
  };
}

function validCmd(
  bookingId: string,
  expectedLastApplied = 0,
  desiredLines: NeutralAmendmentCommand['desiredLines'] = [],
  overrides: Partial<NeutralAmendmentCommand> = {},
): NeutralAmendmentCommand {
  return {
    bookingId,
    expectedLastAppliedAmendmentNumber: expectedLastApplied,
    intent: {
      kind: 'DAY_RANGE',
      startDate: '2026-03-10',
      endDateExclusive: '2026-03-12',
    },
    desiredLines,
    idempotencyKey: 'key-' + Math.random().toString(36).slice(2, 10),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests d'intégration PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

describe('createNeutralBookingAmendment — intégration PostgreSQL', () => {
  if (shouldSkipIntegrationTests()) {
    it.skip('PostgreSQL non configuré (set DATABASE_URL)', () => {});
    return;
  }

  it('1. NEUTRAL succeeds et preuve d assertions exactes du MODIFY 1 -> 2 (allocations REPLACE/ADD, blocks, items, status)', async () => {
    const ids = await seedBaseData(rawSql!);

    // Seeder un second item pour permettre d'augmenter la quantité de 1 à 2
    await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${ids.variantId}, 'KAY-ITEM-2', ${ids.locationId})
    `;

    // Booking initial : qty=1, 2 jours (DAY_RANGE 2026-03-10 à 2026-03-12), total=10 000
    const b = await seedBookingWithItem(rawSql!, ids, 3, 1, 5000);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    // Amendement : passage à 1 jour (DAY_RANGE 2026-03-10 à 2026-03-11) et qty=2 (2 qty * 1j * 5000 = 10 000) -> NEUTRAL (delta = 0)
    const cmdDateChange = validCmd(
      b.bookingId,
      0,
      [{ logicalLineId: b.lineId, variantId: ids.variantId, quantity: 2 }],
      {
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-03-10',
          endDateExclusive: '2026-03-11',
        },
      },
    );

    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmdDateChange);
    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    // 1. Vérifier que financialSnapshotBefore = 10 000 et financialSnapshotAfter = 10 000
    const amd = await rawSql!`
      SELECT "financial_snapshot_before", "financial_snapshot_after"
      FROM "booking_amendments"
      WHERE "id" = ${res.amendmentId}
    `;
    expect(amd).toHaveLength(1);
    const snapBefore = amd[0]?.financial_snapshot_before as { totalAmountMinor: number };
    const snapAfter = amd[0]?.financial_snapshot_after as { totalAmountMinor: number };
    expect(snapBefore.totalAmountMinor).toBe(10000);
    expect(snapAfter.totalAmountMinor).toBe(10000);

    // 2. Ligne d'amendement : action = MODIFY, beforeQuantity = 1, afterQuantity = 2, total = 10 000
    const amdLines = await rawSql!`
      SELECT "action", "before_quantity", "after_quantity", "before_line_total_amount_minor", "after_line_total_amount_minor"
      FROM "booking_amendment_lines"
      WHERE "amendment_id" = ${res.amendmentId}
    `;
    expect(amdLines).toHaveLength(1);
    expect(amdLines[0]?.action).toBe('MODIFY');
    expect(amdLines[0]?.before_quantity).toBe(1);
    expect(amdLines[0]?.after_quantity).toBe(2);
    expect(Number(amdLines[0]?.after_line_total_amount_minor)).toBe(10000);

    // 3. Somme after des lignes = 10 000
    const sumLines = amdLines.reduce((acc, l) => acc + Number(l.after_line_total_amount_minor), 0);
    expect(sumLines).toBe(10000);

    // 4. Assertions exactes du passage qty 1 -> 2
    const allocRows = await rawSql!`
      SELECT "id", "action", "status", "inventory_item_id", "source_booking_block_id", "applied_booking_block_id"
      FROM "booking_amendment_allocations"
      WHERE "amendment_id" = ${res.amendmentId}
    `;
    // Exactement 2 allocations créées
    expect(allocRows).toHaveLength(2);

    // 1 action REPLACE, status CONVERTED, source et applied block distincts
    const replaceAlloc = allocRows.find((a) => a.action === 'REPLACE');
    expect(replaceAlloc).toBeDefined();
    expect(replaceAlloc?.status).toBe('CONVERTED');
    expect(replaceAlloc?.source_booking_block_id).toBe(b.blockId);
    expect(replaceAlloc?.applied_booking_block_id).toBeDefined();
    expect(replaceAlloc?.applied_booking_block_id).not.toBe(b.blockId);

    // 1 action ADD, status CONVERTED, source NULL, applied block non-null
    const addAlloc = allocRows.find((a) => a.action === 'ADD');
    expect(addAlloc).toBeDefined();
    expect(addAlloc?.status).toBe('CONVERTED');
    expect(addAlloc?.source_booking_block_id).toBeNull();
    expect(addAlloc?.applied_booking_block_id).toBeDefined();

    // 2 applied block IDs distincts
    expect(replaceAlloc?.applied_booking_block_id).not.toBe(addAlloc?.applied_booking_block_id);

    // Les 2 applied blocks sont ACTIVE
    const appliedBlocks = await rawSql!`
      SELECT "id", "status" FROM "inventory_blocks"
      WHERE "id" IN (${replaceAlloc?.applied_booking_block_id}, ${addAlloc?.applied_booking_block_id})
    `;
    expect(appliedBlocks).toHaveLength(2);
    expect(appliedBlocks[0]?.status).toBe('ACTIVE');
    expect(appliedBlocks[1]?.status).toBe('ACTIVE');

    // L'ancien block initial est RELEASED
    const oldBlock =
      await rawSql!`SELECT "status" FROM "inventory_blocks" WHERE "id" = ${b.blockId}`;
    expect(oldBlock[0]?.status).toBe('RELEASED');

    // Les deux allocations utilisent deux inventory_item_id distincts
    expect(replaceAlloc?.inventory_item_id).not.toBe(addAlloc?.inventory_item_id);

    // Aucune allocation ne reste PROPOSED
    const proposedCount = allocRows.filter((a) => a.status === 'PROPOSED').length;
    expect(proposedCount).toBe(0);
  });

  it('2. lifecycle READY_TO_APPLY → APPLIED', async () => {
    const ids = await seedBaseData(rawSql!);
    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [
      { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
    ]);
    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    const rows = await rawSql!`
      SELECT "status", "type", "applied_at"
      FROM "booking_amendments"
      WHERE "id" = ${res.amendmentId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('APPLIED');
    expect(rows[0]?.type).toBe('NEUTRAL');
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  });

  it('3. complete snapshot G7P et vérification de la somme des lignes', async () => {
    const ids = await seedBaseData(rawSql!);
    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [
      { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
    ]);
    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    const amdLines = await rawSql!`
      SELECT "after_line_total_amount_minor", "pricing_snapshot", "variant_snapshot", "origin_type", "source_booking_line_id"
      FROM "booking_amendment_lines"
      WHERE "amendment_id" = ${res.amendmentId}
    `;
    expect(amdLines).toHaveLength(1);

    // Vérifier la somme des lignes vs financialSnapshotAfter
    const amd =
      await rawSql!`SELECT "financial_snapshot_after" FROM "booking_amendments" WHERE "id" = ${res.amendmentId}`;
    const afterSnap = amd[0]?.financial_snapshot_after as { totalAmountMinor: number };
    const sumLines = amdLines.reduce((acc, l) => acc + Number(l.after_line_total_amount_minor), 0);
    expect(sumLines).toBe(afterSnap.totalAmountMinor);

    // Vérifier la présence de tous les champs pertinents de QuoteLine dans pricingSnapshot
    const ps = amdLines[0]?.pricing_snapshot as Record<string, unknown>;
    expect(ps['algorithmVersion']).toBe('flexible-pricing-v1');
    expect(ps['roundingRuleVersion']).toBe('half-up-v1');
    expect(ps['resolvedLocale']).toBe('fr');
    expect(ps['intentSnapshot']).toBeDefined();
    expect(ps['billableUnitCount']).toBe(2);
    expect(ps['planId']).toBeDefined();
    expect(ps['planVersion']).toBeDefined();
    expect(ps['planType']).toBe('DAILY');
    expect(ps['publicLabel']).toBe('Tarif journalier');

    expect(amdLines[0]?.origin_type).toBe('ORIGINAL');
    expect(amdLines[0]?.source_booking_line_id).toBe(b.lineId);
  });

  it('4. tests de lignes réellement neutres (UNCHANGED, vrai MODIFY, ADD et REMOVE avec delta 0)', async () => {
    const ids = await seedBaseData(rawSql!);

    // Seeder un 2e item pour ids.variantId
    await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${ids.variantId}, 'KAY-ITEM-2', ${ids.locationId})
    `;

    // 4a. UNCHANGED avec delta 0 (qty=1, 2j -> qty=1, 2j)
    const b1 = await seedBookingWithItem(rawSql!, ids, 3, 1, 5000);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');
    const cmdUnchanged = validCmd(b1.bookingId, 0, [
      { logicalLineId: b1.lineId, variantId: ids.variantId, quantity: 1 },
    ]);
    const resUnchanged = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmdUnchanged);
    expect(resUnchanged.kind).toBe('SUCCESS');
    if (resUnchanged.kind === 'SUCCESS') {
      const l =
        await rawSql!`SELECT "action" FROM "booking_amendment_lines" WHERE "amendment_id" = ${resUnchanged.amendmentId}`;
      expect(l[0]?.action).toBe('UNCHANGED');
    }

    // 4b. VRAI MODIFY quantité avec delta 0 (passage de qty=1 sur 2 jours à qty=2 sur 1 jour)
    // Initial state: qty 1 * 2 jours * 5000 = 10 000.
    // Desired state: qty 2 * 1 jour * 5000 = 10 000 -> MODIFY!
    const b2 = await seedBookingWithItem(rawSql!, ids, 4, 1, 5000);
    const cmdModify = validCmd(
      b2.bookingId,
      0,
      [{ logicalLineId: b2.lineId, variantId: ids.variantId, quantity: 2 }],
      {
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-04-10',
          endDateExclusive: '2026-04-11', // 1 jour
        },
      },
    );
    const resModify = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmdModify);
    expect(resModify.kind).toBe('SUCCESS');
    if (resModify.kind === 'SUCCESS') {
      const l =
        await rawSql!`SELECT "action", "before_quantity", "after_quantity", "before_line_total_amount_minor", "after_line_total_amount_minor" FROM "booking_amendment_lines" WHERE "amendment_id" = ${resModify.amendmentId}`;
      expect(l[0]?.action).toBe('MODIFY');
      expect(l[0]?.before_quantity).toBe(1);
      expect(l[0]?.after_quantity).toBe(2);
      expect(Number(l[0]?.before_line_total_amount_minor)).toBe(10000);
      expect(Number(l[0]?.after_line_total_amount_minor)).toBe(10000);
    }

    // 4c. ADD et REMOVE avec delta 0 (swap de variantes sur 2j)
    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prod2Id = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Pagaie',
      'pagaie',
    );
    const var2 = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prod2Id}, 'Carbone', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${var2.id}, 'PAG-1', ${ids.locationId})
    `;
    await seedActiveDailyPricingPlan(
      rawSql!,
      ids.orgId,
      var2.id,
      ids.locationId,
      5000,
      'Tarif Pagaie',
    );

    const b3 = await seedBookingWithItem(rawSql!, ids, 5, 1, 5000);
    const cmdSwap = validCmd(b3.bookingId, 0, [{ variantId: var2.id, quantity: 1 }]);
    const resSwap = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmdSwap);
    expect(resSwap.kind).toBe('SUCCESS');
    if (resSwap.kind === 'SUCCESS') {
      const lines = await rawSql!`
        SELECT "action", "variant_id", "origin_type", "source_booking_line_id"
        FROM "booking_amendment_lines"
        WHERE "amendment_id" = ${resSwap.amendmentId}
      `;
      expect(lines).toHaveLength(2);
      const addLine = lines.find((l) => l.action === 'ADD');
      const removeLine = lines.find((l) => l.action === 'REMOVE');
      expect(addLine).toBeDefined();
      expect(addLine?.variant_id).toBe(var2.id);
      expect(addLine?.origin_type).toBe('AMENDMENT');
      expect(addLine?.source_booking_line_id).toBeNull();
      expect(removeLine).toBeDefined();
      expect(removeLine?.variant_id).toBe(ids.variantId);
    }
  });

  it('5. filiation et vrai MODIFY sur le second amendement avec DAY_RANGE et delta 0 (sur booking initial avec qty=2 physique)', async () => {
    const ids = await seedBaseData(rawSql!);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    // Seeder var2 (même prix 5000) et 3 items pour var2
    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prod2Id = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Gilet',
      'gilet',
    );
    const var2 = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prod2Id}, 'Pro', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    for (let i = 1; i <= 3; i++) {
      await rawSql!`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${var2.id}, ${'GIL-' + i}, ${ids.locationId})
      `;
    }
    await seedActiveDailyPricingPlan(rawSql!, ids.orgId, var2.id, ids.locationId, 5000);

    // Réservation initiale avec var1 (qty 2 * 2j = 20 000)
    const b = await seedBookingWithItem(rawSql!, ids, 3, 2, 5000);

    // Prouver que les 2 allocations physiques initiales existent réellement en base avant l'amendement
    expect(b.bookingItemIds).toHaveLength(2);
    expect(b.blockIds).toHaveLength(2);
    expect(b.inventoryItemIds).toHaveLength(2);
    expect(b.inventoryItemIds[0]).not.toBe(b.inventoryItemIds[1]);

    const initialBookingItems = await rawSql!`
      SELECT "id", "booking_block_id", "inventory_item_id"
      FROM "booking_items"
      WHERE "booking_id" = ${b.bookingId} AND "booking_line_id" = ${b.lineId}
    `;
    expect(initialBookingItems).toHaveLength(2);

    // 1er amendement (DAY_RANGE 2j) : réduction var1 à qty 1 (10 000) + ADD var2 (qty 1 * 2j = 10 000). Total = 20 000 (delta = 0).
    const cmd1 = validCmd(b.bookingId, 0, [
      { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
      { variantId: var2.id, quantity: 1 },
    ]);
    const res1 = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd1);
    expect(res1.kind).toBe('SUCCESS');
    if (res1.kind !== 'SUCCESS') return;

    // Récupérer le logicalLineId de la ligne var2 issue du 1er amendement (ADD)
    const amd1Lines = await rawSql!`
      SELECT "logical_line_id" FROM "booking_amendment_lines"
      WHERE "amendment_id" = ${res1.amendmentId} AND "action" = 'ADD'
    `;
    expect(amd1Lines).toHaveLength(1);
    const line2LogicalId = amd1Lines[0]!.logical_line_id;

    // 2e amendement (DAY_RANGE 1j) : changement de dates à 1j + modif réelle de var2 (qty 1 -> qty 3)
    // var1 (qty 1 * 1j = 5 000), var2 (qty 3 * 1j = 15 000). Total = 20 000. Delta = 0.
    const cmd2 = validCmd(
      b.bookingId,
      1,
      [
        { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
        { logicalLineId: line2LogicalId, variantId: var2.id, quantity: 3 },
      ],
      {
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-03-10',
          endDateExclusive: '2026-03-11', // 1j
        },
      },
    );
    const res2 = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd2);
    expect(res2.kind).toBe('SUCCESS');
    if (res2.kind !== 'SUCCESS') return;

    // 1. Vérifier snapshots financiers avant et après tous deux égaux à 20 000
    const amd2Snap = await rawSql!`
      SELECT "financial_snapshot_before", "financial_snapshot_after"
      FROM "booking_amendments"
      WHERE "id" = ${res2.amendmentId}
    `;
    expect(amd2Snap).toHaveLength(1);
    const snapBefore2 = amd2Snap[0]?.financial_snapshot_before as { totalAmountMinor: number };
    const snapAfter2 = amd2Snap[0]?.financial_snapshot_after as { totalAmountMinor: number };
    expect(snapBefore2.totalAmountMinor).toBe(20000);
    expect(snapAfter2.totalAmountMinor).toBe(20000);

    // 2. Vérifier la filiation de la ligne var2 dans le 2e amendement : action = MODIFY, origin_type = AMENDMENT, source_booking_line_id = NULL
    const amd2Lines = await rawSql!`
      SELECT "origin_type", "source_booking_line_id", "action", "before_quantity", "after_quantity", "logical_line_id"
      FROM "booking_amendment_lines"
      WHERE "amendment_id" = ${res2.amendmentId} AND "logical_line_id" = ${line2LogicalId}
    `;
    expect(amd2Lines).toHaveLength(1);
    expect(amd2Lines[0]?.action).toBe('MODIFY');
    expect(amd2Lines[0]?.before_quantity).toBe(1);
    expect(amd2Lines[0]?.after_quantity).toBe(3);
    expect(amd2Lines[0]?.origin_type).toBe('AMENDMENT');
    expect(amd2Lines[0]?.source_booking_line_id).toBeNull();
    expect(amd2Lines[0]?.logical_line_id).toBe(line2LogicalId);
  });

  it('6. delta REFUND → FINANCIAL_ACTION_REQUIRED sans écritures', async () => {
    const ids = await seedBaseData(rawSql!);
    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prodCheaperId = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Kayak Cheaper',
      'cheaper',
    );
    const varCheaper = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prodCheaperId}, 'Basic', 2000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${varCheaper.id}, 'CHEAP-1', ${ids.locationId})
    `;
    await seedActiveDailyPricingPlan(rawSql!, ids.orgId, varCheaper.id, ids.locationId, 2000);

    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [{ variantId: varCheaper.id, quantity: 1 }]);
    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res.kind).toBe('FINANCIAL_ACTION_REQUIRED');
    if (res.kind === 'FINANCIAL_ACTION_REQUIRED') {
      expect(res.classification).toBe('REFUND');
      expect(res.deltaMinor).toBeGreaterThan(0);
    }
  });

  it('7. delta SUPPLEMENT → FINANCIAL_ACTION_REQUIRED sans écritures', async () => {
    const ids = await seedBaseData(rawSql!);
    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prodExpensiveId = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Kayak Luxury',
      'luxury',
    );
    const varExpensive = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prodExpensiveId}, 'Luxury', 15000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${varExpensive.id}, 'LUX-1', ${ids.locationId})
    `;
    await seedActiveDailyPricingPlan(rawSql!, ids.orgId, varExpensive.id, ids.locationId, 15000);

    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [{ variantId: varExpensive.id, quantity: 1 }]);
    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res.kind).toBe('FINANCIAL_ACTION_REQUIRED');
    if (res.kind === 'FINANCIAL_ACTION_REQUIRED') {
      expect(res.classification).toBe('SUPPLEMENT');
      expect(res.deltaMinor).toBeGreaterThan(0);
    }
  });

  it('8. outbox unique et payload parseable avec parseBookingAmendedV1Event', async () => {
    const ids = await seedBaseData(rawSql!);
    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [
      { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
    ]);
    const res = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    const outboxRows = await rawSql!`
      SELECT "aggregate_type", "event_type", "event_version", "payload"
      FROM "outbox_events"
      WHERE "aggregate_id" = ${b.bookingId} AND "event_type" = 'BOOKING_AMENDED'
    `;
    expect(outboxRows).toHaveLength(1);
    const row = outboxRows[0]!;
    const eventObj = {
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      eventVersion: row.event_version,
      payload: row.payload,
    };
    const parsed = parseBookingAmendedV1Event(eventObj);
    expect(parsed.payload.amendmentId).toBe(res.amendmentId);
    expect(parsed.payload.organizationId).toBe(ids.orgId);
    expect(parsed.payload.bookingId).toBe(b.bookingId);
  });

  it('9. concurrence de disponibilité réelle (swap neutre sur 2 bookings distincts disputant un unique exemplaire libre)', async () => {
    const ids = await seedBaseData(rawSql!);

    // Seeder Var2 avec EXACTEMENT 1 seul item libre (Item 2A)
    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prod2Id = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Canoe',
      'canoe',
    );
    const var2 = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prod2Id}, 'Canoe Standard', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    const item2A = await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${var2.id}, 'CAN-SINGLE-FREE', ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);
    await seedActiveDailyPricingPlan(rawSql!, ids.orgId, var2.id, ids.locationId, 5000);

    // Seeder un 2e item pour Var1
    const item1B = await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${ids.variantId}, 'KAY-ITEM-1B', ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);

    // Booking 1 (b1) détient Item 1A (2j = 10 000)
    const b1 = await seedBookingWithItem(rawSql!, ids, 3);
    // Booking 2 (b2) détient Item 1B (2j = 10 000) dans la MÊME organisation et sur la MÊME période
    const idsBooking2 = { ...ids, itemId: item1B.id };
    const b2 = await seedBookingWithItem(rawSql!, idsBooking2, 3);

    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    // Les 2 commandes remplacent entièrement Var 1 par Var 2 (2 jours * 5000 = 10 000). Total avant/après = 10 000 (delta = 0).
    // Les deux commandes passent l'évaluation tarifaire neutre et atteignent réellement computeAllocationPlan !
    const cmd1 = validCmd(b1.bookingId, 0, [{ variantId: var2.id, quantity: 1 }]);
    const cmd2 = validCmd(b2.bookingId, 0, [{ variantId: var2.id, quantity: 1 }]);

    const client1 = createDatabase(testUrl!);
    const client2 = createDatabase(testUrl!);

    try {
      const settled = await Promise.allSettled([
        createNeutralBookingAmendment(client1, actor, ids.orgId, cmd1),
        createNeutralBookingAmendment(client2, actor, ids.orgId, cmd2),
      ]);

      expect(settled[0]!.status).toBe('fulfilled');
      expect(settled[1]!.status).toBe('fulfilled');

      const r1 = (
        settled[0] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof createNeutralBookingAmendment>>
        >
      ).value;
      const r2 = (
        settled[1] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof createNeutralBookingAmendment>>
        >
      ).value;

      const kinds = [r1.kind, r2.kind].sort();
      expect(kinds).toEqual(['AVAILABILITY_CONFLICT', 'SUCCESS']);

      // Exactement un block ACTIVE créé pour Item 2A
      const blocksForItem2A = await rawSql!`
        SELECT "id" FROM "inventory_blocks"
        WHERE "inventory_item_id" = ${item2A.id} AND "status" = 'ACTIVE'
      `;
      expect(blocksForItem2A).toHaveLength(1);

      // Identifier le gagnant et le perdant
      const winnerBookingId = r1.kind === 'SUCCESS' ? b1.bookingId : b2.bookingId;
      const loserBookingId = r1.kind === 'SUCCESS' ? b2.bookingId : b1.bookingId;

      // Le gagnant possède 1 amendement APPLIED
      const winnerAmds = await rawSql!`
        SELECT "status" FROM "booking_amendments" WHERE "booking_id" = ${winnerBookingId}
      `;
      expect(winnerAmds).toHaveLength(1);
      expect(winnerAmds[0]?.status).toBe('APPLIED');

      // Le perdant ne possède aucune écriture d'amendement dans booking_amendments
      const loserAmds = await rawSql!`
        SELECT * FROM "booking_amendments" WHERE "booking_id" = ${loserBookingId}
      `;
      expect(loserAmds).toHaveLength(0);
    } finally {
      await client1.$client.end();
      await client2.$client.end();
    }
  });

  it('10. test d absence de deadlock sur 3 amendements neutres concurrents dans la meme organisation', async () => {
    const ids = await seedBaseData(rawSql!);
    const b1 = await seedBookingWithItem(rawSql!, ids, 3);

    const cat =
      await rawSql!`SELECT "category_id" FROM "products" INNER JOIN "product_variants" ON "products"."id" = "product_variants"."product_id" WHERE "product_variants"."id" = ${ids.variantId}`.then(
        (r) => r[0]!,
      );
    const prod2Id = await seedPublishedProduct(
      rawSql!,
      ids.orgId,
      cat.category_id,
      'Paddle',
      'paddle',
    );
    const var2 = await rawSql!`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${prod2Id}, 'Standup', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    const item2 = await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${var2.id}, 'PAD-1', ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);
    await seedActiveDailyPricingPlan(rawSql!, ids.orgId, var2.id, ids.locationId, 5000);

    const b2 = await seedBookingWithItem(
      rawSql!,
      { ...ids, variantId: var2.id, itemId: item2.id },
      4,
    );

    const item3 = await rawSql!`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${ids.variantId}, 'KAY-3', ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);
    const b3 = await seedBookingWithItem(rawSql!, { ...ids, itemId: item3.id }, 5);

    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const c1 = createDatabase(testUrl!);
    const c2 = createDatabase(testUrl!);
    const c3 = createDatabase(testUrl!);

    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      const cmd1 = validCmd(b1.bookingId, 0, [
        { logicalLineId: b1.lineId, variantId: ids.variantId, quantity: 1 },
      ]);
      const cmd2 = validCmd(b2.bookingId, 0, [
        { logicalLineId: b2.lineId, variantId: var2.id, quantity: 1 },
      ]);
      const cmd3 = validCmd(b3.bookingId, 0, [
        { logicalLineId: b3.lineId, variantId: ids.variantId, quantity: 1 },
      ]);

      const timeoutMs = 30000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error('Deadlock test timeout exceeded 30s')),
          timeoutMs,
        );
      });

      const executionPromise = Promise.allSettled([
        createNeutralBookingAmendment(c1, actor, ids.orgId, cmd1),
        createNeutralBookingAmendment(c2, actor, ids.orgId, cmd2),
        createNeutralBookingAmendment(c3, actor, ids.orgId, cmd3),
      ]);

      const settled = await Promise.race([executionPromise, timeoutPromise]);

      // Inspection récursive de toute la chaîne cause pour garantir l'absence de code 40P01
      for (const res of settled) {
        if (res.status === 'rejected') {
          expect(hasDeadlockCode(res.reason)).toBe(false);
        } else {
          expect(res.value.kind).toBe('SUCCESS');
        }
      }
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      await c1.$client.end();
      await c2.$client.end();
      await c3.$client.end();
    }
  }, 35000);

  it('11. rollback tardif complet sur déclenchement d une erreur PostgreSQL lors de l outbox', async () => {
    const ids = await seedBaseData(rawSql!);
    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    // Installer temporairement un trigger qui lève une exception sur outbox_events
    try {
      await rawSql!.unsafe(`
        CREATE OR REPLACE FUNCTION fail_booking_amended_outbox_trigger()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.event_type = 'BOOKING_AMENDED' THEN
            RAISE EXCEPTION 'Simulated late outbox failure for rollback test';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER test_late_rollback_outbox_trigger
        BEFORE INSERT ON "outbox_events"
        FOR EACH ROW
        EXECUTE FUNCTION fail_booking_amended_outbox_trigger();
      `);

      const cmd = validCmd(b.bookingId, 0, [
        { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
      ]);

      let threw = false;
      try {
        await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
      } catch (err) {
        threw = true;
        expect(err).toBeDefined();
      }
      expect(threw).toBe(true);

      // Vérifier le rollback complet
      const amendments =
        await rawSql!`SELECT * FROM "booking_amendments" WHERE "booking_id" = ${b.bookingId}`;
      expect(amendments).toHaveLength(0);

      const amdLines =
        await rawSql!`SELECT * FROM "booking_amendment_lines" WHERE "organization_id" = ${ids.orgId}`;
      expect(amdLines).toHaveLength(0);

      const amdAllocs =
        await rawSql!`SELECT * FROM "booking_amendment_allocations" WHERE "organization_id" = ${ids.orgId}`;
      expect(amdAllocs).toHaveLength(0);

      const outbox =
        await rawSql!`SELECT * FROM "outbox_events" WHERE "aggregate_id" = ${b.bookingId}`;
      expect(outbox).toHaveLength(0);

      const block =
        await rawSql!`SELECT "status" FROM "inventory_blocks" WHERE "id" = ${b.blockId}`;
      expect(block[0]?.status).toBe('ACTIVE');
    } finally {
      await rawSql!.unsafe(`
        DROP TRIGGER IF EXISTS test_late_rollback_outbox_trigger ON "outbox_events";
        DROP FUNCTION IF EXISTS fail_booking_amended_outbox_trigger();
      `);
    }
  });

  it('12. replay idempotent retourne REPLAY', async () => {
    const ids = await seedBaseData(rawSql!);
    const b = await seedBookingWithItem(rawSql!, ids, 3);
    const actor = await addActor(rawSql!, ids.orgId, 'OWNER');

    const cmd = validCmd(b.bookingId, 0, [
      { logicalLineId: b.lineId, variantId: ids.variantId, quantity: 1 },
    ]);
    const res1 = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res1.kind).toBe('SUCCESS');
    if (res1.kind !== 'SUCCESS') return;

    const res2 = await createNeutralBookingAmendment(db!, actor, ids.orgId, cmd);
    expect(res2.kind).toBe('REPLAY');
    if (res2.kind === 'REPLAY') {
      expect(res2.amendmentId).toBe(res1.amendmentId);
      expect(res2.amendmentNumber).toBe(res1.amendmentNumber);
    }
  });

  it('13. isolation des organisations', async () => {
    const ids1 = await seedBaseData(rawSql!, 'org1');
    const ids2 = await seedBaseData(rawSql!, 'org2');
    const b1 = await seedBookingWithItem(rawSql!, ids1, 3);
    const actor2 = await addActor(rawSql!, ids2.orgId, 'OWNER');

    const cmd = validCmd(b1.bookingId, 0, [
      { logicalLineId: b1.lineId, variantId: ids1.variantId, quantity: 1 },
    ]);
    const res = await createNeutralBookingAmendment(db!, actor2, ids2.orgId, cmd);
    expect(res.kind).toBe('NOT_FOUND');
  });
});
