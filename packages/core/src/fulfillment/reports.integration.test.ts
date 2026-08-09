import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { prepareBooking } from './prepare-booking';
import { pickupBooking } from './pickup-booking';
import { returnBooking } from './return-booking';
import { createConditionReport } from './create-condition-report';
import { createDamageReport } from './create-damage-report';
import { FulfillmentError } from './fulfillment-errors';
import { computeConditionReportFingerprint } from './report-fingerprints';
import { computeDamageReportFingerprint } from './report-fingerprints';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('fulfillment_reports');
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
    await rawSql`DROP TRIGGER IF EXISTS test_block_outbox_insert ON outbox_events`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_outbox_insert()`;
    await rawSql`DROP TRIGGER IF EXISTS test_block_condition_report_insert ON condition_reports`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_condition_report_insert()`;
    await rawSql`DROP TRIGGER IF EXISTS test_block_damage_report_insert ON damage_reports`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_damage_report_insert()`;
    await rawSql`DROP TRIGGER IF EXISTS test_leak_condition_report ON condition_reports`;
    await rawSql`DROP FUNCTION IF EXISTS test_leak_condition_report()`;
    await rawSql`DROP TRIGGER IF EXISTS test_leak_damage_report ON damage_reports`;
    await rawSql`DROP FUNCTION IF EXISTS test_leak_damage_report()`;
  }
  await db.execute(
    sql`TRUNCATE TABLE
      condition_reports, damage_reports,
      booking_fulfillment_events, outbox_events, audit_log,
      booking_items, booking_lines, inventory_blocks,
      payments, bookings, booking_draft_lines, booking_drafts,
      allocations, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships,
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
  itemId: string;
}

interface BookingIds {
  bookingId: string;
  bookingItemId: string;
  lineId: string;
  blockId: string;
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
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${location.id}, 'GOOD', 'ACTIVE')
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemId: item.id,
  };
}

async function seedConfirmedBooking(ids: BaseIds, monthOffset = 2): Promise<BookingIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const month = String(monthOffset).padStart(2, '0');

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
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`},
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;

  const draftLine = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  const holdBlock = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${`2026-${month}-09 12:00:00+00`}, ${draft.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
    VALUES (${draftLine.id}, ${holdBlock.id})
  `;

  const payment = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id",
      "charge_model", "settlement_merchant_mode",
      "environment",
      "succeeded_at"
    )
    VALUES (
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, null,
      500,
      '1', '1',
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_test123',
      'DESTINATION', 'CONNECTED_ACCOUNT',
      'TEST',
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const booking = await sql`
    INSERT INTO "bookings" (
      "organization_id", "location_id", "customer_user_id",
      "draft_id", "payment_id", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "prep_buffer_minutes", "cleanup_buffer_minutes",
      "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor", "total_amount_minor",
      "cancellation_policy_snapshot", "terms_acceptance_snapshot",
      "confirmed_at"
    )
    VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${draft.id}, ${payment.id}, 'CONFIRMED',
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`},
      30, 30,
      'EUR', 10000, 0,
      'NOT_APPLICABLE', 0, null,
      500, 10000,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlock.id}`;

  const bookingBlock = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "source_id"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${booking.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const bookingItem = await sql`
    INSERT INTO "booking_items" (
      "booking_id", "booking_line_id", "inventory_item_id",
      "source_hold_block_id", "booking_block_id"
    )
    VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlock.id}, ${bookingBlock.id})
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    bookingId: booking.id,
    bookingItemId: bookingItem.id,
    lineId: line.id,
    blockId: bookingBlock.id,
  };
}

async function seedStaffUser(
  ids: BaseIds,
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF' = 'STAFF',
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED' = 'ACTIVE',
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const suffix = SUFFIX();
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'staff-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
    VALUES (${ids.orgId}, ${user.id}, ${role}, ${status})
  `;
  return user.id;
}

async function seedSecondOrg(): Promise<BaseIds> {
  return seedBaseData();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de vérification
// ─────────────────────────────────────────────────────────────────────────────

async function setBookingStatus(bookingId: string, status: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  await rawSql`UPDATE bookings SET status = ${status} WHERE id = ${bookingId}`;
}

async function countAuditEntries(targetId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM audit_log WHERE target_id = ${targetId}`;
  return rows[0]!.cnt;
}

async function countOutboxEvents(aggregateId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM outbox_events WHERE aggregate_id = ${aggregateId}`;
  return rows[0]!.cnt;
}

async function countConditionReports(bookingId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM condition_reports WHERE booking_id = ${bookingId}`;
  return rows[0]!.cnt;
}

async function countDamageReports(bookingId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM damage_reports WHERE booking_id = ${bookingId}`;
  return rows[0]!.cnt;
}

async function getIdempotencyRecordStatus(key: string): Promise<string | null> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
  return rows.length > 0 ? rows[0]!.status : null;
}

async function seedBookingItemForOtherBooking(ids: BaseIds): Promise<{
  booking: BookingIds;
  otherBookingItem: string;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const booking = await seedConfirmedBooking(ids);

  // Crée un second booking + booking_item pour tester BOOKING_ITEM_MISMATCH
  const month = '04';
  const draft2 = await sql`
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
      ${`2026-${month}-20 09:00:00+00`}, ${`2026-${month}-22 17:00:00+00`},
      ${`2026-${month}-20 08:30:00+00`}, ${`2026-${month}-22 17:30:00+00`},
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft2.id}`;

  const draftLine2 = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${draft2.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  const holdBlock2 = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
      ${`2026-${month}-20 09:00:00+00`}, ${`2026-${month}-22 17:00:00+00`},
      ${`2026-${month}-20 08:30:00+00`}, ${`2026-${month}-22 17:30:00+00`}, ${`2026-${month}-19 12:00:00+00`}, ${draft2.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
    VALUES (${draftLine2.id}, ${holdBlock2.id})
  `;

  const payment2 = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id",
      "charge_model", "settlement_merchant_mode",
      "environment",
      "succeeded_at"
    )
    VALUES (
      ${ids.orgId}, ${draft2.id}, ${ids.userId},
      'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, null,
      500,
      '1', '1',
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_test123',
      'DESTINATION', 'CONNECTED_ACCOUNT',
      'TEST',
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const booking2 = await sql`
    INSERT INTO "bookings" (
      "organization_id", "location_id", "customer_user_id",
      "draft_id", "payment_id", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "prep_buffer_minutes", "cleanup_buffer_minutes",
      "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor", "total_amount_minor",
      "cancellation_policy_snapshot", "terms_acceptance_snapshot",
      "confirmed_at"
    )
    VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${draft2.id}, ${payment2.id}, 'READY_FOR_PICKUP',
      ${`2026-${month}-20 09:00:00+00`}, ${`2026-${month}-22 17:00:00+00`},
      ${`2026-${month}-20 08:30:00+00`}, ${`2026-${month}-22 17:30:00+00`},
      30, 30,
      'EUR', 10000, 0,
      'NOT_APPLICABLE', 0, null,
      500, 10000,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const line2 = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking2.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlock2.id}`;

  const bookingBlock2 = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "source_id"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
      ${`2026-${month}-20 09:00:00+00`}, ${`2026-${month}-22 17:00:00+00`},
      ${`2026-${month}-20 08:30:00+00`}, ${`2026-${month}-22 17:30:00+00`}, ${booking2.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const bookingItem2 = await sql`
    INSERT INTO "booking_items" (
      "booking_id", "booking_line_id", "inventory_item_id",
      "source_hold_block_id", "booking_block_id"
    )
    VALUES (${booking2.id}, ${line2.id}, ${ids.itemId}, ${holdBlock2.id}, ${bookingBlock2.id})
    RETURNING "id"
  `.then((r) => r[0]!);

  return { booking, otherBookingItem: bookingItem2.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'rapports fulfillment (G3B) — intégration PostgreSQL',
  () => {
    // ─────────────────────────────────────────────────────────────────────
    // Condition reports
    // ─────────────────────────────────────────────────────────────────────
    describe('Condition reports', () => {
      it('PICKUP valide en READY_FOR_PICKUP', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-pickup-valid-' + SUFFIX();

        // Préparer le booking → READY_FOR_PICKUP
        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        expect(result.kind).toBe('APPLIED');
        expect(result.reportId).toBeDefined();
        expect(result.bookingId).toBe(booking.bookingId);
        expect(result.bookingItemId).toBe(booking.bookingItemId);
        expect(result.inventoryItemId).toBe(ids.itemId);
        expect(result.phase).toBe('PICKUP');
        expect(result.condition).toBe('GOOD');

        expect(await countConditionReports(booking.bookingId)).toBe(1);
        expect(await countAuditEntries(result.reportId)).toBe(1);
        expect(await countOutboxEvents(result.reportId)).toBe(1);
        expect(await getIdempotencyRecordStatus(key)).toBe('COMPLETED');
      });

      it('RETURN valide en ACTIVE', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-return-valid-' + SUFFIX();

        // Préparer + pickup → ACTIVE
        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'RETURN',
          condition: 'FAIR',
        });

        expect(result.kind).toBe('APPLIED');
        expect(result.phase).toBe('RETURN');
        expect(result.condition).toBe('FAIR');
        expect(await countConditionReports(booking.bookingId)).toBe(1);
      });

      it('PICKUP refusé en CONFIRMED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-pickup-confirmed-' + SUFFIX();

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }

        expect(await countConditionReports(booking.bookingId)).toBe(0);
        expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
      });

      it('PICKUP refusé en ACTIVE', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-pickup-active-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('PICKUP refusé en RETURNED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-pickup-returned-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'return-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('PICKUP refusé en CLOSED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-pickup-closed-' + SUFFIX();

        await setBookingStatus(booking.bookingId, 'CLOSED');

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('RETURN refusé en READY_FOR_PICKUP', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-return-rfp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'RETURN',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('RETURN refusé en CONFIRMED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-return-confirmed-' + SUFFIX();

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'RETURN',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('RETURN refusé en RETURNED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-return-returned-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'return-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'RETURN',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it('RETURN refusé en CLOSED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-return-closed-' + SUFFIX();

        await setBookingStatus(booking.bookingId, 'CLOSED');

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'RETURN',
            condition: 'GOOD',
          });
          expect.fail('devrait lever REPORT_PHASE_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('REPORT_PHASE_NOT_ALLOWED');
        }
      });

      it("booking_item d'un autre booking refusé", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const { booking, otherBookingItem } = await seedBookingItemForOtherBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-mismatch-item-' + SUFFIX();

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: otherBookingItem,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever BOOKING_ITEM_MISMATCH');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('BOOKING_ITEM_MISMATCH');
        }
      });

      it("booking_item d'une autre organisation refusé", async () => {
        if (!db || !rawSql) return;
        const ids1 = await seedBaseData();
        const ids2 = await seedSecondOrg();
        const booking1 = await seedConfirmedBooking(ids1);
        const booking2 = await seedConfirmedBooking(ids2);
        const staffId = await seedStaffUser(ids1);
        const key = 'cr-cross-org-' + SUFFIX();

        try {
          await createConditionReport(db, {
            organizationId: ids1.orgId,
            bookingId: booking1.bookingId,
            bookingItemId: booking2.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever BOOKING_ITEM_NOT_FOUND ou BOOKING_ITEM_MISMATCH');
        } catch (e) {
          const code = (e as FulfillmentError).code;
          expect([
            'BOOKING_ITEM_NOT_FOUND',
            'BOOKING_ITEM_MISMATCH',
            'ORGANIZATION_MISMATCH',
          ]).toContain(code);
        }
      });

      it('membership absente refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const outsiderId = randomUUID();
        const key = 'cr-no-membership-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: await seedStaffUser(ids),
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: outsiderId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever FORBIDDEN');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }
      });

      it('membership SUSPENDED refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const suspendedStaffId = await seedStaffUser(ids, 'STAFF', 'SUSPENDED');
        const activeStaffId = await seedStaffUser(ids);
        const key = 'cr-suspended-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: activeStaffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: suspendedStaffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever FORBIDDEN');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }
      });

      it('quatre rôles actifs autorisés', async () => {
        if (!db || !rawSql) return;
        const roles = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'] as const;
        for (const role of roles) {
          const ids = await seedBaseData();
          const booking = await seedConfirmedBooking(ids);
          const staffId = await seedStaffUser(ids, role);
          const key = 'cr-role-' + role + '-' + SUFFIX();

          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: 'prepare-' + SUFFIX(),
          });

          const result = await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });

          expect(result.kind).toBe('APPLIED');
        }
      });

      it('notes trimées, vide → null', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-notes-null-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: '   ',
        });

        const rows =
          await rawSql`SELECT notes FROM condition_reports WHERE id = ${result.reportId}`;
        expect(rows[0]!.notes).toBeNull();
      });

      it('notes limite appliquée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-notes-limit-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
            notes: 'x'.repeat(5001),
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('condition invalide refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-bad-condition-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'INVALID' as never,
          });
          expect.fail('devrait lever INVALID_CONDITION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('INVALID_CONDITION');
        }
      });

      it('phase invalide refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-bad-phase-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'INVALID' as never,
            condition: 'GOOD',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('rapport + audit + outbox atomiques', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-atomic-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        const audit = await rawSql`SELECT * FROM audit_log WHERE target_id = ${result.reportId}`;
        expect(audit[0]!.action).toBe('CONDITION_REPORT_CREATED');
        expect(audit[0]!.target_type).toBe('CONDITION_REPORT');

        const outbox =
          await rawSql`SELECT * FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        expect(outbox[0]!.event_type).toBe('CONDITION_REPORT_CREATED');
        expect(outbox[0]!.aggregate_type).toBe('CONDITION_REPORT');
        expect(outbox[0]!.event_version).toBe('v1');
        expect(outbox[0]!.status).toBe('PENDING');
      });

      it("notes absente de l'audit", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-audit-no-notes-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Note secrète',
        });

        const audit =
          await rawSql`SELECT metadata FROM audit_log WHERE target_id = ${result.reportId}`;
        const metadata = audit[0]!.metadata as Record<string, unknown>;
        expect(metadata).not.toHaveProperty('notes');
      });

      it("notes absente de l'outbox", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-outbox-no-notes-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Note secrète',
        });

        const outbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        const payload = outbox[0]!.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('notes');
      });

      it('notes absente de la réponse idempotente', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-idem-no-notes-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Note secrète',
        });

        const rows = await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
        const body = rows[0]!.response_body as Record<string, unknown>;
        expect(body).not.toHaveProperty('notes');
      });

      it('inventoryItemId dérivé du booking_item', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-derived-item-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        const bookingItemRows =
          await rawSql`SELECT inventory_item_id FROM booking_items WHERE id = ${booking.bookingItemId}`;
        expect(result.inventoryItemId).toBe(bookingItemRows[0]!.inventory_item_id);
      });

      it('timestamp outbox === createdAt PostgreSQL', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-timestamp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        const reportRows =
          await rawSql`SELECT created_at FROM condition_reports WHERE id = ${result.reportId}`;
        const createdAt = reportRows[0]!.created_at as Date;

        const outbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        const payload = outbox[0]!.payload as { createdAt: string };
        expect(payload.createdAt).toBe(createdAt.toISOString());
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Damage reports
    // ─────────────────────────────────────────────────────────────────────
    describe('Damage reports', () => {
      it('valide en ACTIVE', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-active-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure sur la coque',
        });

        expect(result.kind).toBe('APPLIED');
        expect(result.reportId).toBeDefined();
        expect(result.bookingId).toBe(booking.bookingId);
        expect(result.bookingItemId).toBe(booking.bookingItemId);
        expect(result.inventoryItemId).toBe(ids.itemId);
        expect(await countDamageReports(booking.bookingId)).toBe(1);
        expect(await countAuditEntries(result.reportId)).toBe(1);
        expect(await countOutboxEvents(result.reportId)).toBe(1);
        expect(await getIdempotencyRecordStatus(key)).toBe('COMPLETED');
      });

      it('valide en RETURNED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-returned-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'return-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Coque fissurée',
        });

        expect(result.kind).toBe('APPLIED');
        expect(await countDamageReports(booking.bookingId)).toBe(1);
      });

      it('refusé en CONFIRMED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-confirmed-' + SUFFIX();

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }

        expect(await countDamageReports(booking.bookingId)).toBe(0);
        expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
      });

      it('refusé en READY_FOR_PICKUP', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-rfp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }
      });

      it('refusé en CLOSED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-closed-' + SUFFIX();

        await setBookingStatus(booking.bookingId, 'CLOSED');

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }
      });

      it('refusé en CANCELLED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-cancelled-' + SUFFIX();

        await setBookingStatus(booking.bookingId, 'CANCELLED');

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }
      });

      it('refusé en REFUNDED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-refunded-' + SUFFIX();

        await setBookingStatus(booking.bookingId, 'REFUNDED');

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }
      });

      it('description vide refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-empty-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: '',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('description espaces seulement refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-spaces-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: '   ',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('description trop longue refusée', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-long-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'x'.repeat(5001),
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('description trimée en DB', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-trim-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: '  Rayure  ',
        });

        const rows =
          await rawSql`SELECT description FROM damage_reports WHERE id = ${result.reportId}`;
        expect(rows[0]!.description).toBe('Rayure');
      });

      it('aucune description dans audit', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-audit-no-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrète',
        });

        const audit =
          await rawSql`SELECT metadata FROM audit_log WHERE target_id = ${result.reportId}`;
        const metadata = audit[0]!.metadata as Record<string, unknown>;
        expect(metadata).not.toHaveProperty('description');
      });

      it('aucune description dans outbox', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-outbox-no-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrète',
        });

        const outbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        const payload = outbox[0]!.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('description');
      });

      it('aucune description dans réponse idempotente', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-idem-no-desc-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrète',
        });

        const rows = await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
        const body = rows[0]!.response_body as Record<string, unknown>;
        expect(body).not.toHaveProperty('description');
      });

      it('contrôles multi-tenant', async () => {
        if (!db || !rawSql) return;
        const ids1 = await seedBaseData();
        const ids2 = await seedSecondOrg();
        const booking2 = await seedConfirmedBooking(ids2);
        const staffId = await seedStaffUser(ids1);
        const key = 'dr-cross-org-' + SUFFIX();

        try {
          await createDamageReport(db, {
            organizationId: ids1.orgId,
            bookingId: booking2.bookingId,
            bookingItemId: booking2.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever BOOKING_NOT_FOUND ou ORGANIZATION_MISMATCH');
        } catch (e) {
          const code = (e as FulfillmentError).code;
          expect(['BOOKING_NOT_FOUND', 'ORGANIZATION_MISMATCH']).toContain(code);
        }
      });

      it('membership absent refusé', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const outsiderId = randomUUID();
        const activeStaffId = await seedStaffUser(ids);
        const key = 'dr-no-membership-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: activeStaffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: activeStaffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: outsiderId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever FORBIDDEN');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }
      });

      it('rapport + audit + outbox atomiques', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-atomic-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        });

        const audit = await rawSql`SELECT * FROM audit_log WHERE target_id = ${result.reportId}`;
        expect(audit[0]!.action).toBe('DAMAGE_REPORTED');
        expect(audit[0]!.target_type).toBe('DAMAGE_REPORT');

        const outbox =
          await rawSql`SELECT * FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        expect(outbox[0]!.event_type).toBe('DAMAGE_REPORTED');
        expect(outbox[0]!.aggregate_type).toBe('DAMAGE_REPORT');
        expect(outbox[0]!.event_version).toBe('v1');
        expect(outbox[0]!.status).toBe('PENDING');
      });

      it('timestamp outbox === createdAt PostgreSQL', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-timestamp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        });

        const reportRows =
          await rawSql`SELECT created_at FROM damage_reports WHERE id = ${result.reportId}`;
        const createdAt = reportRows[0]!.created_at as Date;

        const outbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        const payload = outbox[0]!.payload as { createdAt: string };
        expect(payload.createdAt).toBe(createdAt.toISOString());
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Idempotence et concurrence
    // ─────────────────────────────────────────────────────────────────────
    describe('Idempotence et concurrence', () => {
      it('replay COMPLETED condition report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-replay-completed-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const input = {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP' as const,
          condition: 'GOOD' as const,
        };

        const result1 = await createConditionReport(db, input);
        const result2 = await createConditionReport(db, input);

        expect(result2).toEqual(result1);
        expect(await countConditionReports(booking.bookingId)).toBe(1);
      });

      it('replay COMPLETED damage report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-replay-completed-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const input = {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        };

        const result1 = await createDamageReport(db, input);
        const result2 = await createDamageReport(db, input);

        expect(result2).toEqual(result1);
        expect(await countDamageReports(booking.bookingId)).toBe(1);
      });

      it('replay FAILED condition report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const outsiderId = randomUUID();
        const key = 'cr-replay-failed-' + SUFFIX();

        const input = {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: outsiderId,
          idempotencyKey: key,
          phase: 'PICKUP' as const,
          condition: 'GOOD' as const,
        };

        try {
          await createConditionReport(db, input);
          expect.fail('devrait lever FORBIDDEN');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        try {
          await createConditionReport(db, input);
          expect.fail('devrait lever FORBIDDEN au replay');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await countConditionReports(booking.bookingId)).toBe(0);
      });

      it('replay FAILED damage report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-replay-failed-' + SUFFIX();

        const input = {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        };

        try {
          await createDamageReport(db, input);
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }

        try {
          await createDamageReport(db, input);
          expect.fail('devrait lever DAMAGE_REPORT_NOT_ALLOWED au replay');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('DAMAGE_REPORT_NOT_ALLOWED');
        }
      });

      it('conflit de payload condition report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-conflict-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'FAIR',
          });
          expect.fail('devrait lever IDEMPOTENCY_CONFLICT');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_CONFLICT');
        }
      });

      it('conflit de payload damage report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-conflict-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Fissure',
          });
          expect.fail('devrait lever IDEMPOTENCY_CONFLICT');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_CONFLICT');
        }
      });

      it('deux appels simultanés même clé condition report', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-concurrent-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          const input = {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP' as const,
            condition: 'GOOD' as const,
          };
          const [r1, r2] = await Promise.allSettled([
            createConditionReport(db, input),
            createConditionReport(db2, input),
          ]);

          const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
          expect(fulfilled.length).toBe(2);
          expect(await countConditionReports(booking.bookingId)).toBe(1);
        } finally {
          await db2.$client.end();
        }
      });

      it('deux appels simultanés même clé damage report', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-concurrent-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          const input = {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          };
          const [r1, r2] = await Promise.allSettled([
            createDamageReport(db, input),
            createDamageReport(db2, input),
          ]);

          const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
          expect(fulfilled.length).toBe(2);
          expect(await countDamageReports(booking.bookingId)).toBe(1);
        } finally {
          await db2.$client.end();
        }
      });

      it('deux clés différentes créent deux rapports condition report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'cr-key-a-' + SUFFIX(),
          phase: 'PICKUP',
          condition: 'GOOD',
        });
        await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'cr-key-b-' + SUFFIX(),
          phase: 'PICKUP',
          condition: 'FAIR',
        });

        expect(await countConditionReports(booking.bookingId)).toBe(2);
      });

      it('deux clés différentes créent deux rapports damage report', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'dr-key-a-' + SUFFIX(),
          description: 'Rayure 1',
        });
        await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'dr-key-b-' + SUFFIX(),
          description: 'Rayure 2',
        });

        expect(await countDamageReports(booking.bookingId)).toBe(2);
      });

      it('collision outbox condition report → rollback', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-outbox-collision-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        await rawSql`
          CREATE OR REPLACE FUNCTION test_block_outbox_insert()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'test_outbox_collision';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_block_outbox_insert
          BEFORE INSERT ON outbox_events
          FOR EACH ROW EXECUTE FUNCTION test_block_outbox_insert()
        `;

        try {
          await expect(
            createConditionReport(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              bookingItemId: booking.bookingItemId,
              actorUserId: staffId,
              idempotencyKey: key,
              phase: 'PICKUP',
              condition: 'GOOD',
            }),
          ).rejects.toThrow();

          expect(await countConditionReports(booking.bookingId)).toBe(0);
          expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_block_outbox_insert ON outbox_events`;
          await rawSql`DROP FUNCTION IF EXISTS test_block_outbox_insert()`;
        }
      });

      it('collision outbox damage report → rollback', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-outbox-collision-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        await rawSql`
          CREATE OR REPLACE FUNCTION test_block_outbox_insert()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'test_outbox_collision';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_block_outbox_insert
          BEFORE INSERT ON outbox_events
          FOR EACH ROW EXECUTE FUNCTION test_block_outbox_insert()
        `;

        try {
          await expect(
            createDamageReport(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              bookingItemId: booking.bookingItemId,
              actorUserId: staffId,
              idempotencyKey: key,
              description: 'Rayure',
            }),
          ).rejects.toThrow();

          expect(await countDamageReports(booking.bookingId)).toBe(0);
          expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_block_outbox_insert ON outbox_events`;
          await rawSql`DROP FUNCTION IF EXISTS test_block_outbox_insert()`;
        }
      });

      it('erreur DB sensible sanitisée condition report', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'cr-sanitize-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });

        await rawSql`
          CREATE OR REPLACE FUNCTION test_leak_condition_report()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'SECRET_INTERNAL_DETAIL_12345';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_leak_condition_report
          BEFORE INSERT ON condition_reports
          FOR EACH ROW EXECUTE FUNCTION test_leak_condition_report()
        `;

        try {
          await expect(
            createConditionReport(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              bookingItemId: booking.bookingItemId,
              actorUserId: staffId,
              idempotencyKey: key,
              phase: 'PICKUP',
              condition: 'GOOD',
            }),
          ).rejects.toThrow();

          const rows =
            await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
          expect(rows.length).toBe(1);
          const body = rows[0]!.response_body as { code: string; message: string };
          expect(body.code).toBe('UNKNOWN');
          expect(body.message).not.toContain('SECRET_INTERNAL_DETAIL_12345');
          expect(JSON.stringify(body)).not.toContain('SECRET_INTERNAL_DETAIL_12345');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_leak_condition_report ON condition_reports`;
          await rawSql`DROP FUNCTION IF EXISTS test_leak_condition_report()`;
        }
      });

      it('erreur DB sensible sanitisée damage report', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'dr-sanitize-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        await rawSql`
          CREATE OR REPLACE FUNCTION test_leak_damage_report()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'SECRET_INTERNAL_DETAIL_12345';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_leak_damage_report
          BEFORE INSERT ON damage_reports
          FOR EACH ROW EXECUTE FUNCTION test_leak_damage_report()
        `;

        try {
          await expect(
            createDamageReport(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              bookingItemId: booking.bookingItemId,
              actorUserId: staffId,
              idempotencyKey: key,
              description: 'Rayure',
            }),
          ).rejects.toThrow();

          const rows =
            await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
          expect(rows.length).toBe(1);
          const body = rows[0]!.response_body as { code: string; message: string };
          expect(body.code).toBe('UNKNOWN');
          expect(body.message).not.toContain('SECRET_INTERNAL_DETAIL_12345');
          expect(JSON.stringify(body)).not.toContain('SECRET_INTERNAL_DETAIL_12345');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_leak_damage_report ON damage_reports`;
          await rawSql`DROP FUNCTION IF EXISTS test_leak_damage_report()`;
        }
      });

      it('timestamps outbox égaux aux created_at PostgreSQL (condition + damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-' + SUFFIX(),
        });

        // Condition report (RETURN phase, booking is ACTIVE)
        const crResult = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'cr-ts-' + SUFFIX(),
          phase: 'RETURN',
          condition: 'GOOD',
        });

        const crRows =
          await rawSql`SELECT created_at FROM condition_reports WHERE id = ${crResult.reportId}`;
        const crCreatedAt = crRows[0]!.created_at as Date;
        const crOutbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${crResult.reportId}`;
        const crPayload = crOutbox[0]!.payload as { createdAt: string };
        expect(crPayload.createdAt).toBe(crCreatedAt.toISOString());

        // Damage report (booking is still ACTIVE)
        const drResult = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'dr-ts-' + SUFFIX(),
          description: 'Rayure',
        });

        const drRows =
          await rawSql`SELECT created_at FROM damage_reports WHERE id = ${drResult.reportId}`;
        const drCreatedAt = drRows[0]!.created_at as Date;
        const drOutbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${drResult.reportId}`;
        const drPayload = drOutbox[0]!.payload as { createdAt: string };
        expect(drPayload.createdAt).toBe(drCreatedAt.toISOString());
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Normalisation des clés d'idempotence (G3B)
    // ─────────────────────────────────────────────────────────────────────
    describe('Normalisation des clés d"idempotence (G3B)', () => {
      it('" key " et "key" produisent le meme comportement idempotent (condition report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-trim-cr-' + SUFFIX(),
        });

        const key = 'trim-cr-' + SUFFIX();
        const result1 = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: ` ${key} `,
          phase: 'PICKUP',
          condition: 'GOOD',
        });
        expect(result1.kind).toBe('APPLIED');

        // Rejouer avec la clé trimee doit retourner le meme resultat (REPLAY COMPLETED)
        const result2 = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });
        expect(result2.kind).toBe('APPLIED');
        expect(result2.reportId).toBe(result1.reportId);

        expect(await countConditionReports(booking.bookingId)).toBe(1);
      });

      it('" key " et "key" produisent le meme comportement idempotent (damage report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-trim-dr-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-trim-dr-' + SUFFIX(),
        });

        const key = 'trim-dr-' + SUFFIX();
        const result1 = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: ` ${key} `,
          description: 'Rayure',
        });
        expect(result1.kind).toBe('APPLIED');

        const result2 = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Rayure',
        });
        expect(result2.kind).toBe('APPLIED');
        expect(result2.reportId).toBe(result1.reportId);

        expect(await countDamageReports(booking.bookingId)).toBe(1);
      });

      it('chaine vide apres trim -> VALIDATION (condition report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-empty-cr-' + SUFFIX(),
        });

        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: '   ',
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });

      it('chaine vide apres trim -> VALIDATION (damage report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-empty-dr-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-empty-dr-' + SUFFIX(),
        });

        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: '   ',
            description: 'Rayure',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Replays corrompus G3B — condition reports
    // ─────────────────────────────────────────────────────────────────────
    describe('Replays corrompus G3B — condition reports', () => {
      async function insertCorruptedConditionReportIdempotency(
        ids: BaseIds,
        booking: BookingIds,
        staffId: string,
        key: string,
        responseBody: Record<string, string>,
        status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
        responseStatusCode = 201,
        resourceId: string | null = null,
      ): Promise<void> {
        if (!rawSql) throw new Error('rawSql not initialized');
        const fakeFingerprint = computeConditionReportFingerprint({
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: null,
        });
        const rid = resourceId ?? (status === 'COMPLETED' ? randomUUID() : null);
        await rawSql`
          INSERT INTO "idempotency_records" (
            "id", "organization_id", "operation", "key", "request_fingerprint",
            "status", "resource_id", "response_status_code", "response_body",
            "created_at", "completed_at", "pending_timeout_at"
          )
          VALUES (
            ${randomUUID()}, ${ids.orgId}, 'create_condition_report', ${key}, ${fakeFingerprint},
            ${status}, ${rid}, ${responseStatusCode},
            ${rawSql.json(responseBody)},
            now(), now(), null
          )
        `;
      }

      async function expectNoConditionMutation(bookingId: string, key: string): Promise<void> {
        if (!rawSql) throw new Error('rawSql not initialized');
        expect(await countConditionReports(bookingId)).toBe(0);
        const idemRows = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
        expect(idemRows.length).toBe(1);
      }

      it('resourceId different du reportId -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-rid-' + SUFFIX();
        const fakeReportId = randomUUID();
        const differentResourceId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'PICKUP',
            condition: 'GOOD',
          },
          'COMPLETED',
          201,
          differentResourceId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('responseStatusCode different de 201 -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-status-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'PICKUP',
            condition: 'GOOD',
          },
          'COMPLETED',
          200,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('inventoryItemId invalide -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-invid-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: 'not-a-uuid',
            phase: 'PICKUP',
            condition: 'GOOD',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('phase valide mais differente de la requete -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-phase-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'RETURN',
            condition: 'GOOD',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('condition valide mais differente de la requete -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-cond-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'PICKUP',
            condition: 'FAIR',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('bookingId different -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-bid-' + SUFFIX();
        const fakeReportId = randomUUID();
        const otherBookingId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: otherBookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'PICKUP',
            condition: 'GOOD',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('bookingItemId different -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-bit-' + SUFFIX();
        const fakeReportId = randomUUID();
        const otherBookingItemId = randomUUID();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: otherBookingItemId,
            inventoryItemId: ids.itemId,
            phase: 'PICKUP',
            condition: 'GOOD',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });

      it('FAILED avec fromStatus invalide -> IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-cr-failed-' + SUFFIX();
        await insertCorruptedConditionReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            code: 'INVALID_TRANSITION',
            message: 'Transition invalide',
            fromStatus: 'INVALID_STATUS',
          },
          'FAILED',
        );
        try {
          await createConditionReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            phase: 'PICKUP',
            condition: 'GOOD',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoConditionMutation(booking.bookingId, key);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Replays corrompus G3B — damage reports
    // ─────────────────────────────────────────────────────────────────────
    describe('Replays corrompus G3B — damage reports', () => {
      async function insertCorruptedDamageReportIdempotency(
        ids: BaseIds,
        booking: BookingIds,
        staffId: string,
        key: string,
        responseBody: Record<string, string>,
        status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
        responseStatusCode = 201,
        resourceId: string | null = null,
      ): Promise<void> {
        if (!rawSql) throw new Error('rawSql not initialized');
        const fakeFingerprint = computeDamageReportFingerprint({
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          description: 'Rayure',
        });
        const rid = resourceId ?? (status === 'COMPLETED' ? randomUUID() : null);
        await rawSql`
          INSERT INTO "idempotency_records" (
            "id", "organization_id", "operation", "key", "request_fingerprint",
            "status", "resource_id", "response_status_code", "response_body",
            "created_at", "completed_at", "pending_timeout_at"
          )
          VALUES (
            ${randomUUID()}, ${ids.orgId}, 'create_damage_report', ${key}, ${fakeFingerprint},
            ${status}, ${rid}, ${responseStatusCode},
            ${rawSql.json(responseBody)},
            now(), now(), null
          )
        `;
      }

      async function expectNoDamageMutation(bookingId: string, key: string): Promise<void> {
        if (!rawSql) throw new Error('rawSql not initialized');
        expect(await countDamageReports(bookingId)).toBe(0);
        const idemRows = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
        expect(idemRows.length).toBe(1);
      }

      it('resourceId different du reportId -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-rid-' + SUFFIX();
        const fakeReportId = randomUUID();
        const differentResourceId = randomUUID();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
          },
          'COMPLETED',
          201,
          differentResourceId,
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });

      it('responseStatusCode different de 201 -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-status-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
          },
          'COMPLETED',
          200,
          fakeReportId,
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });

      it('inventoryItemId invalide -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-invid-' + SUFFIX();
        const fakeReportId = randomUUID();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: 'not-a-uuid',
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });

      it('bookingId different -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-bid-' + SUFFIX();
        const fakeReportId = randomUUID();
        const otherBookingId = randomUUID();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: otherBookingId,
            bookingItemId: booking.bookingItemId,
            inventoryItemId: ids.itemId,
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });

      it('bookingItemId different -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-bit-' + SUFFIX();
        const fakeReportId = randomUUID();
        const otherBookingItemId = randomUUID();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            kind: 'APPLIED',
            reportId: fakeReportId,
            bookingId: booking.bookingId,
            bookingItemId: otherBookingItemId,
            inventoryItemId: ids.itemId,
          },
          'COMPLETED',
          201,
          fakeReportId,
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });

      it('FAILED avec fromStatus invalide -> IDEMPOTENCY_REPLAY_INVALID (damage)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-dr-failed-' + SUFFIX();
        await insertCorruptedDamageReportIdempotency(
          ids,
          booking,
          staffId,
          key,
          {
            code: 'DAMAGE_REPORT_NOT_ALLOWED',
            message: 'Dommage non autorise',
            fromStatus: 'INVALID_STATUS',
          },
          'FAILED',
        );
        try {
          await createDamageReport(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            bookingItemId: booking.bookingItemId,
            actorUserId: staffId,
            idempotencyKey: key,
            description: 'Rayure',
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
        await expectNoDamageMutation(booking.bookingId, key);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Confidentialite persistee (G3B)
    // ─────────────────────────────────────────────────────────────────────
    describe('Confidentialite persistee (G3B)', () => {
      it('notes absente du responseBody idempotent (condition report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-cr-notes-idem-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-cr-' + SUFFIX(),
        });

        await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Notes secretes',
        });

        const rows = await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
        expect(rows.length).toBe(1);
        const bodyStr = JSON.stringify(rows[0]!.response_body);
        expect(bodyStr).not.toContain('Notes secretes');
      });

      it("notes absente de l'audit (condition report)", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-cr-notes-audit-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-cr-audit-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Notes secretes',
        });

        const auditRows =
          await rawSql`SELECT metadata FROM audit_log WHERE target_id = ${result.reportId}`;
        expect(auditRows.length).toBe(1);
        const metadata = auditRows[0]!.metadata as Record<string, unknown>;
        expect(metadata).not.toHaveProperty('notes');
        expect(JSON.stringify(metadata)).not.toContain('Notes secretes');
      });

      it("notes absente de l'outbox (condition report)", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-cr-notes-outbox-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-cr-outbox-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
          notes: 'Notes secretes',
        });

        const outboxRows =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        expect(outboxRows.length).toBe(1);
        const payload = outboxRows[0]!.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('notes');
        expect(JSON.stringify(payload)).not.toContain('Notes secretes');
      });

      it('description absente du responseBody idempotent (damage report)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-dr-desc-idem-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-dr-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-conf-dr-' + SUFFIX(),
        });

        await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrete',
        });

        const rows = await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
        expect(rows.length).toBe(1);
        const bodyStr = JSON.stringify(rows[0]!.response_body);
        expect(bodyStr).not.toContain('Description secrete');
      });

      it("description absente de l'audit (damage report)", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-dr-desc-audit-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-dr-audit-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-conf-dr-audit-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrete',
        });

        const auditRows =
          await rawSql`SELECT metadata FROM audit_log WHERE target_id = ${result.reportId}`;
        expect(auditRows.length).toBe(1);
        const metadata = auditRows[0]!.metadata as Record<string, unknown>;
        expect(metadata).not.toHaveProperty('description');
        expect(JSON.stringify(metadata)).not.toContain('Description secrete');
      });

      it("description absente de l'outbox (damage report)", async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-dr-desc-outbox-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-dr-outbox-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'pickup-conf-dr-outbox-' + SUFFIX(),
        });

        const result = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          description: 'Description secrete',
        });

        const outboxRows =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        expect(outboxRows.length).toBe(1);
        const payload = outboxRows[0]!.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('description');
        expect(JSON.stringify(payload)).not.toContain('Description secrete');
      });

      it('fingerprints jamais stockes dans audit/outbox', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-fingerprint-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-fp-' + SUFFIX(),
        });

        const result = await createConditionReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: key,
          phase: 'PICKUP',
          condition: 'GOOD',
        });

        const auditRows =
          await rawSql`SELECT metadata FROM audit_log WHERE target_id = ${result.reportId}`;
        expect(auditRows.length).toBe(1);
        const auditMetadata = auditRows[0]!.metadata as Record<string, unknown>;
        expect(auditMetadata).not.toHaveProperty('requestFingerprint');
        expect(auditMetadata).not.toHaveProperty('fingerprint');
        expect(JSON.stringify(auditMetadata)).not.toMatch(/[0-9a-f]{64}/);

        const outboxRows =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${result.reportId}`;
        expect(outboxRows.length).toBe(1);
        const outboxPayload = outboxRows[0]!.payload as Record<string, unknown>;
        expect(outboxPayload).not.toHaveProperty('requestFingerprint');
        expect(outboxPayload).not.toHaveProperty('fingerprint');
        expect(JSON.stringify(outboxPayload)).not.toMatch(/[0-9a-f]{64}/);

        const idemRows =
          await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
        expect(idemRows.length).toBe(1);
        const idemBody = JSON.stringify(idemRows[0]!.response_body);
        expect(idemBody).not.toMatch(/[0-9a-f]{64}/);
      });

      it('erreur UNKNOWN ne contient aucun message DB brut ni fingerprint', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conf-sanitize-fp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'prepare-conf-sanitize-' + SUFFIX(),
        });

        await rawSql`
          CREATE OR REPLACE FUNCTION test_leak_condition_report_fp()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'SECRET_INTERNAL_DETAIL_12345';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_leak_condition_report_fp
          BEFORE INSERT ON condition_reports
          FOR EACH ROW EXECUTE FUNCTION test_leak_condition_report_fp()
        `;

        try {
          await expect(
            createConditionReport(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              bookingItemId: booking.bookingItemId,
              actorUserId: staffId,
              idempotencyKey: key,
              phase: 'PICKUP',
              condition: 'GOOD',
            }),
          ).rejects.toThrow();

          const rows =
            await rawSql`SELECT response_body FROM idempotency_records WHERE key = ${key}`;
          expect(rows.length).toBe(1);
          const bodyStr = JSON.stringify(rows[0]!.response_body);
          expect(bodyStr).not.toContain('SECRET_INTERNAL_DETAIL_12345');
          expect(bodyStr).not.toMatch(/[0-9a-f]{64}/);
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_leak_condition_report_fp ON condition_reports`;
          await rawSql`DROP FUNCTION IF EXISTS test_leak_condition_report_fp()`;
        }
      });
    });
  },
);
