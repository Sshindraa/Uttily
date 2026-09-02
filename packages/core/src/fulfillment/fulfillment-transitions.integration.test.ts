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
import { closeBooking } from './close-booking';
import { createDamageReport } from './create-damage-report';
import { FulfillmentError } from './fulfillment-errors';
import { computeFulfillmentFingerprint } from './fingerprint';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('fulfillment_transitions');
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
    await rawSql`DROP TRIGGER IF EXISTS test_block_fulfillment_insert ON booking_fulfillment_events`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_fulfillment_before_insert()`;
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

async function getBookingStatus(bookingId: string): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`SELECT status FROM bookings WHERE id = ${bookingId}`;
  return rows[0]!.status;
}

async function countFulfillmentEvents(bookingId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM booking_fulfillment_events WHERE booking_id = ${bookingId}`;
  return rows[0]!.cnt;
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

async function getIdempotencyRecordStatus(key: string): Promise<string | null> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
  return rows.length > 0 ? rows[0]!.status : null;
}

async function expectNoMutation(bookingId: string, key: string): Promise<void> {
  expect(await countFulfillmentEvents(bookingId)).toBe(0);
  expect(await countAuditEntries(bookingId)).toBe(0);
  expect(await countOutboxEvents(bookingId)).toBe(0);
  const idemStatus = await getIdempotencyRecordStatus(key);
  expect(idemStatus).toBe('FAILED');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'transitions fulfillment — intégration PostgreSQL',
  () => {
    // ─────────────────────────────────────────────────────────────────────
    // Nominal
    // ─────────────────────────────────────────────────────────────────────
    describe('Nominal', () => {
      it('prepareBooking : CONFIRMED → READY_FOR_PICKUP, APPLIED, 1 fulfillment_event, 1 audit, 1 outbox', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'prepare-nominal-' + SUFFIX();

        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
        });

        expect(result.kind).toBe('APPLIED');
        if (result.kind !== 'APPLIED') return;
        expect(result.previousStatus).toBe('CONFIRMED');
        expect(result.nextStatus).toBe('READY_FOR_PICKUP');
        expect(result.bookingId).toBe(booking.bookingId);
        expect(result.fulfillmentEventId).toBeDefined();

        expect(await getBookingStatus(booking.bookingId)).toBe('READY_FOR_PICKUP');
        expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
        expect(await countAuditEntries(booking.bookingId)).toBe(1);
        expect(await countOutboxEvents(booking.bookingId)).toBe(1);
        expect(await getIdempotencyRecordStatus(key)).toBe('COMPLETED');

        const evt =
          await rawSql`SELECT * FROM booking_fulfillment_events WHERE booking_id = ${booking.bookingId}`;
        expect(evt[0]!.event_type).toBe('PREPARED');
        expect(evt[0]!.previous_status).toBe('CONFIRMED');
        expect(evt[0]!.next_status).toBe('READY_FOR_PICKUP');
        expect(evt[0]!.actor_user_id).toBe(staffId);
        expect(evt[0]!.idempotency_key).toBe(key);

        const audit = await rawSql`SELECT * FROM audit_log WHERE target_id = ${booking.bookingId}`;
        expect(audit[0]!.action).toBe('BOOKING_PREPARED');
        expect(audit[0]!.target_type).toBe('BOOKING');
        expect(audit[0]!.actor_user_id).toBe(staffId);

        const outbox =
          await rawSql`SELECT * FROM outbox_events WHERE aggregate_id = ${booking.bookingId}`;
        expect(outbox[0]!.event_type).toBe('BOOKING_PREPARED');
        expect(outbox[0]!.event_version).toBe('v1');
        expect(outbox[0]!.aggregate_type).toBe('BOOKING');
        expect(outbox[0]!.status).toBe('PENDING');
      });

      it('pickupBooking : READY_FOR_PICKUP → ACTIVE, APPLIED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key1 = 'prepare-before-pickup-' + SUFFIX();
        const key2 = 'pickup-nominal-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key1,
        });

        const result = await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key2,
        });

        expect(result.kind).toBe('APPLIED');
        if (result.kind !== 'APPLIED') return;
        expect(result.previousStatus).toBe('READY_FOR_PICKUP');
        expect(result.nextStatus).toBe('ACTIVE');

        expect(await getBookingStatus(booking.bookingId)).toBe('ACTIVE');
        expect(await countFulfillmentEvents(booking.bookingId)).toBe(2);
        expect(await countAuditEntries(booking.bookingId)).toBe(2);
        expect(await countOutboxEvents(booking.bookingId)).toBe(2);
      });

      it('returnBooking : ACTIVE → RETURNED, APPLIED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ret-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ret-pickup-' + SUFFIX(),
        });

        const result = await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'return-nominal-' + SUFFIX(),
        });

        expect(result.kind).toBe('APPLIED');
        if (result.kind !== 'APPLIED') return;
        expect(result.previousStatus).toBe('ACTIVE');
        expect(result.nextStatus).toBe('RETURNED');
        expect(await getBookingStatus(booking.bookingId)).toBe('RETURNED');
      });

      it('closeBooking : RETURNED → CLOSED, APPLIED', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'close-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'close-pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'close-return-' + SUFFIX(),
        });

        const result = await closeBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'close-nominal-' + SUFFIX(),
        });

        expect(result.kind).toBe('APPLIED');
        if (result.kind !== 'APPLIED') return;
        expect(result.previousStatus).toBe('RETURNED');
        expect(result.nextStatus).toBe('CLOSED');
        expect(await getBookingStatus(booking.bookingId)).toBe('CLOSED');
      });

      it('les 4 transitions successives : statut final CLOSED, 4 fulfillment_events, 4 audits, 4 outbox', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'full-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'full-pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'full-return-' + SUFFIX(),
        });
        await closeBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'full-close-' + SUFFIX(),
        });

        expect(await getBookingStatus(booking.bookingId)).toBe('CLOSED');
        expect(await countFulfillmentEvents(booking.bookingId)).toBe(4);
        expect(await countAuditEntries(booking.bookingId)).toBe(4);
        expect(await countOutboxEvents(booking.bookingId)).toBe(4);
      });

      it('réponse APPLIED contient bookingId, previousStatus, nextStatus, fulfillmentEventId', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'resp-shape-' + SUFFIX(),
        });

        expect(result.kind).toBe('APPLIED');
        if (result.kind !== 'APPLIED') return;
        expect(result).toHaveProperty('bookingId');
        expect(result).toHaveProperty('previousStatus');
        expect(result).toHaveProperty('nextStatus');
        expect(result).toHaveProperty('fulfillmentEventId');
        expect(typeof result.fulfillmentEventId).toBe('string');
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Autorisation et multi-tenant
    // ─────────────────────────────────────────────────────────────────────
    describe('Autorisation et multi-tenant', () => {
      it('OWNER autorisé — prepareBooking réussit', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const ownerId = await seedStaffUser(ids, 'OWNER');
        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: ownerId,
          idempotencyKey: 'owner-' + SUFFIX(),
        });
        expect(result.kind).toBe('APPLIED');
      });

      it('ADMIN autorisé — prepareBooking réussit', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const adminId = await seedStaffUser(ids, 'ADMIN');
        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: adminId,
          idempotencyKey: 'admin-' + SUFFIX(),
        });
        expect(result.kind).toBe('APPLIED');
      });

      it('MANAGER autorisé — prepareBooking réussit', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const managerId = await seedStaffUser(ids, 'MANAGER');
        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: managerId,
          idempotencyKey: 'manager-' + SUFFIX(),
        });
        expect(result.kind).toBe('APPLIED');
      });

      it('STAFF autorisé — prepareBooking réussit', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids, 'STAFF');
        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'staff-' + SUFFIX(),
        });
        expect(result.kind).toBe('APPLIED');
      });

      it('membership absente refusée — FulfillmentError FORBIDDEN, 0 mutation', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const otherUser = await rawSql`
          INSERT INTO "users" ("email") VALUES (${'no-membership-' + SUFFIX() + '@example.com'}) RETURNING "id"
        `.then((r) => r[0]!);
        const key = 'no-membership-' + SUFFIX();

        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: otherUser.id,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: otherUser.id,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await getBookingStatus(booking.bookingId)).toBe('CONFIRMED');
        await expectNoMutation(booking.bookingId, key);
      });

      it('membership SUSPENDED refusée — FORBIDDEN, 0 mutation', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const suspendedId = await seedStaffUser(ids, 'STAFF', 'SUSPENDED');
        const key = 'suspended-' + SUFFIX();

        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: suspendedId,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: suspendedId,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await getBookingStatus(booking.bookingId)).toBe('CONFIRMED');
        await expectNoMutation(booking.bookingId, key);
      });

      it('membership REMOVED refusée — FORBIDDEN, 0 mutation', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const removedId = await seedStaffUser(ids, 'STAFF', 'REMOVED');
        const key = 'removed-' + SUFFIX();

        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: removedId,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: removedId,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await getBookingStatus(booking.bookingId)).toBe('CONFIRMED');
        await expectNoMutation(booking.bookingId, key);
      });

      it("booking d'une autre organisation refusé — ORGANIZATION_MISMATCH, 0 mutation", async () => {
        if (!db) return;
        const idsA = await seedBaseData();
        const bookingA = await seedConfirmedBooking(idsA);
        const idsB = await seedSecondOrg();
        const staffB = await seedStaffUser(idsB);
        const key = 'cross-org-booking-' + SUFFIX();

        await expect(
          prepareBooking(db, {
            organizationId: idsB.orgId,
            bookingId: bookingA.bookingId,
            actorUserId: staffB,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: idsB.orgId,
            bookingId: bookingA.bookingId,
            actorUserId: staffB,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('ORGANIZATION_MISMATCH');
        }

        expect(await getBookingStatus(bookingA.bookingId)).toBe('CONFIRMED');
        await expectNoMutation(bookingA.bookingId, key);
      });

      it("actor d'une autre organisation refusé — FORBIDDEN, 0 mutation", async () => {
        if (!db) return;
        const idsA = await seedBaseData();
        const bookingA = await seedConfirmedBooking(idsA);
        const idsB = await seedSecondOrg();
        const staffB = await seedStaffUser(idsB);
        const key = 'cross-org-actor-' + SUFFIX();

        await expect(
          prepareBooking(db, {
            organizationId: idsA.orgId,
            bookingId: bookingA.bookingId,
            actorUserId: staffB,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: idsA.orgId,
            bookingId: bookingA.bookingId,
            actorUserId: staffB,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await getBookingStatus(bookingA.bookingId)).toBe('CONFIRMED');
        await expectNoMutation(bookingA.bookingId, key);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Idempotence
    // ─────────────────────────────────────────────────────────────────────
    describe('Idempotence', () => {
      it('même clé + même payload → même réponse APPLIED, aucune ligne supplémentaire', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'idem-same-key-' + SUFFIX();

        const input = {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
        };

        const r1 = await prepareBooking(db, input);
        const r2 = await prepareBooking(db, input);

        expect(r1.kind).toBe('APPLIED');
        expect(r2.kind).toBe('APPLIED');
        if (r1.kind !== 'APPLIED' || r2.kind !== 'APPLIED') return;
        expect(r2.fulfillmentEventId).toBe(r1.fulfillmentEventId);

        expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
        expect(await countAuditEntries(booking.bookingId)).toBe(1);
        expect(await countOutboxEvents(booking.bookingId)).toBe(1);
      });

      it('même clé + payload différent → conflit', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'idem-conflict-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
        });

        const booking2 = await seedConfirmedBooking(ids, 3);
        const staff2 = await seedStaffUser(ids);

        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking2.bookingId,
            actorUserId: staff2,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking2.bookingId,
            actorUserId: staff2,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_CONFLICT');
        }
      });

      it('nouvelle clé après transition déjà appliquée → NOOP', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'noop-first-' + SUFFIX(),
        });

        const result = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'noop-second-' + SUFFIX(),
        });

        expect(result.kind).toBe('NOOP');
        if (result.kind !== 'NOOP') return;
        expect(result.currentStatus).toBe('READY_FOR_PICKUP');

        expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
        expect(await countAuditEntries(booking.bookingId)).toBe(1);
        expect(await countOutboxEvents(booking.bookingId)).toBe(1);
      });

      it('clés identiques autorisées dans deux organisations', async () => {
        if (!db) return;
        const idsA = await seedBaseData();
        const bookingA = await seedConfirmedBooking(idsA);
        const staffA = await seedStaffUser(idsA);

        const idsB = await seedSecondOrg();
        const bookingB = await seedConfirmedBooking(idsB);
        const staffB = await seedStaffUser(idsB);

        const key = 'shared-key-' + SUFFIX();

        const r1 = await prepareBooking(db, {
          organizationId: idsA.orgId,
          bookingId: bookingA.bookingId,
          actorUserId: staffA,
          idempotencyKey: key,
        });
        const r2 = await prepareBooking(db, {
          organizationId: idsB.orgId,
          bookingId: bookingB.bookingId,
          actorUserId: staffB,
          idempotencyKey: key,
        });

        expect(r1.kind).toBe('APPLIED');
        expect(r2.kind).toBe('APPLIED');
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Transitions invalides
    // ─────────────────────────────────────────────────────────────────────
    describe('Transitions invalides', () => {
      it("saut d'étape : prepareBooking sur booking ACTIVE → INVALID_TRANSITION", async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'skip-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'skip-pickup-' + SUFFIX(),
        });

        const key = 'skip-invalid-' + SUFFIX();
        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('INVALID_TRANSITION');
        }
      });

      it('régression : pickupBooking sur booking RETURNED → INVALID_TRANSITION', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'reg-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'reg-pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'reg-return-' + SUFFIX(),
        });

        const key = 'reg-invalid-' + SUFFIX();
        await expect(
          pickupBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await pickupBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('INVALID_TRANSITION');
        }
      });

      it('transition depuis état terminal : prepareBooking sur booking CLOSED → TERMINAL_STATE', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'term-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'term-pickup-' + SUFFIX(),
        });
        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'term-return-' + SUFFIX(),
        });
        await closeBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'term-close-' + SUFFIX(),
        });

        const key = 'term-invalid-' + SUFFIX();
        await expect(
          prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          }),
        ).rejects.toThrow(FulfillmentError);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key + '-retry',
          });
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('TERMINAL_STATE');
        }
      });

      it('erreur typée contient fromStatus et toStatus', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'typed-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'typed-pickup-' + SUFFIX(),
        });

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: 'typed-invalid-' + SUFFIX(),
          });
          expect.fail('devrait lever une erreur');
        } catch (e) {
          const err = e as FulfillmentError;
          expect(err.fromStatus).toBe('ACTIVE');
          expect(err.toStatus).toBe('READY_FOR_PICKUP');
        }
      });

      it('aucune mutation partielle après transition invalide', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'partial-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'partial-pickup-' + SUFFIX(),
        });

        const eventsBefore = await countFulfillmentEvents(booking.bookingId);
        const key = 'partial-invalid-' + SUFFIX();

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever une erreur');
        } catch {
          // attendu
        }

        expect(await getBookingStatus(booking.bookingId)).toBe('ACTIVE');
        expect(await countFulfillmentEvents(booking.bookingId)).toBe(eventsBefore);
        expect(await countAuditEntries(booking.bookingId)).toBe(eventsBefore);
        expect(await countOutboxEvents(booking.bookingId)).toBe(eventsBefore);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Concurrence
    // ─────────────────────────────────────────────────────────────────────
    describe('Concurrence', () => {
      it('deux appels simultanés avec la même clé : une seule application', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'conc-meme-cle-' + SUFFIX();

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          const [r1, r2] = await Promise.allSettled([
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: key,
            }),
            prepareBooking(db2, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: key,
            }),
          ]);

          const results = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value : null));
          const fulfilled = results.filter((r) => r !== null);
          expect(fulfilled.length).toBe(2);

          expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
        } finally {
          await db2.$client.end();
        }
      });

      it('deux appels simultanés avec des clés différentes sur le même booking : une seule transition APPLIED', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          const [r1, r2] = await Promise.allSettled([
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: 'conc-diff-a-' + SUFFIX(),
            }),
            prepareBooking(db2, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: 'conc-diff-b-' + SUFFIX(),
            }),
          ]);

          const results = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value : null));
          const fulfilled = results.filter((r) => r !== null);
          expect(fulfilled.length).toBe(2);

          expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
        } finally {
          await db2.$client.end();
        }
      });

      it('aucun deadlock — le test ne doit pas timeout', async () => {
        if (!ctx || !db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          await Promise.all([
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: 'deadlock-a-' + SUFFIX(),
            }).catch(() => {}),
            prepareBooking(db2, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: 'deadlock-b-' + SUFFIX(),
            }).catch(() => {}),
          ]);
        } finally {
          await db2.$client.end();
        }
      });

      it("rollback forcé : statut et écritures reviennent à l'état initial", async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'rollback-' + SUFFIX();

        await rawSql`
          CREATE OR REPLACE FUNCTION test_block_fulfillment_before_insert()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'rollback force';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_block_fulfillment_insert
          BEFORE INSERT ON booking_fulfillment_events
          FOR EACH ROW
          EXECUTE FUNCTION test_block_fulfillment_before_insert()
        `;

        try {
          await expect(
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: key,
            }),
          ).rejects.toThrow();

          expect(await getBookingStatus(booking.bookingId)).toBe('CONFIRMED');
          expect(await countFulfillmentEvents(booking.bookingId)).toBe(0);
          expect(await countAuditEntries(booking.bookingId)).toBe(0);
          expect(await countOutboxEvents(booking.bookingId)).toBe(0);
          expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_block_fulfillment_insert ON booking_fulfillment_events`;
          await rawSql`DROP FUNCTION IF EXISTS test_block_fulfillment_before_insert()`;
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Replay d'erreurs FAILED
    // ─────────────────────────────────────────────────────────────────────
    describe("Replay d'erreurs FAILED", () => {
      it('même clé après FORBIDDEN → même FulfillmentError FORBIDDEN', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        // staff user sans membership → FORBIDDEN
        const outsiderId = randomUUID();
        const key = 'replay-forbidden-' + SUFFIX();

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: outsiderId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever FORBIDDEN');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        // Re-appeler avec la même clé et le même actor → même erreur
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: outsiderId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever FORBIDDEN au replay');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('FORBIDDEN');
        }

        expect(await countFulfillmentEvents(booking.bookingId)).toBe(0);
        expect(await countAuditEntries(booking.bookingId)).toBe(0);
        expect(await countOutboxEvents(booking.bookingId)).toBe(0);
      });

      it('même clé après BOOKING_NOT_FOUND → même erreur', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const staffId = await seedStaffUser(ids);
        const fakeBookingId = randomUUID();
        const key = 'replay-notfound-' + SUFFIX();

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: fakeBookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever BOOKING_NOT_FOUND');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('BOOKING_NOT_FOUND');
        }

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: fakeBookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever BOOKING_NOT_FOUND au replay');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('BOOKING_NOT_FOUND');
        }
      });

      it('même clé après INVALID_TRANSITION → même code et mêmes fromStatus/toStatus', async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'replay-invalid-trans-' + SUFFIX();

        // pickupBooking sur CONFIRMED → INVALID_TRANSITION (CONFIRMED → ACTIVE)
        try {
          await pickupBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever INVALID_TRANSITION');
        } catch (e) {
          const err = e as FulfillmentError;
          expect(err.code).toBe('INVALID_TRANSITION');
          expect(err.fromStatus).toBe('CONFIRMED');
          expect(err.toStatus).toBe('ACTIVE');
        }

        // Replay → même code et mêmes fromStatus/toStatus
        try {
          await pickupBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever INVALID_TRANSITION au replay');
        } catch (e) {
          const err = e as FulfillmentError;
          expect(err.code).toBe('INVALID_TRANSITION');
          expect(err.fromStatus).toBe('CONFIRMED');
          expect(err.toStatus).toBe('ACTIVE');
        }

        expect(await countFulfillmentEvents(booking.bookingId)).toBe(0);
        expect(await countAuditEntries(booking.bookingId)).toBe(0);
        expect(await countOutboxEvents(booking.bookingId)).toBe(0);
      });

      it("replay d'un FAILED ne crée aucun fulfillment_event, audit ou outbox", async () => {
        if (!db) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const outsiderId = randomUUID();
        const key = 'replay-no-mutation-' + SUFFIX();

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: outsiderId,
            idempotencyKey: key,
          });
        } catch {
          // attendu
        }

        const eventsBefore = await countFulfillmentEvents(booking.bookingId);
        const auditBefore = await countAuditEntries(booking.bookingId);
        const outboxBefore = await countOutboxEvents(booking.bookingId);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: outsiderId,
            idempotencyKey: key,
          });
        } catch {
          // attendu
        }

        expect(await countFulfillmentEvents(booking.bookingId)).toBe(eventsBefore);
        expect(await countAuditEntries(booking.bookingId)).toBe(auditBefore);
        expect(await countOutboxEvents(booking.bookingId)).toBe(outboxBefore);
      });

      it('replay FAILED concurrent après attente sur lockKey', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const outsiderId = randomUUID();
        const key = 'replay-concurrent-' + SUFFIX();

        const db2 = createDatabase(ctx.databaseUrl);
        try {
          const [r1, r2] = await Promise.allSettled([
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: outsiderId,
              idempotencyKey: key,
            }),
            prepareBooking(db2, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: outsiderId,
              idempotencyKey: key,
            }),
          ]);

          // Les deux doivent échouer (FORBIDDEN ou replay de FORBIDDEN)
          expect(r1.status).toBe('rejected');
          expect(r2.status).toBe('rejected');
          if (r1.status === 'rejected') {
            expect((r1.reason as FulfillmentError).code).toBe('FORBIDDEN');
          }
          if (r2.status === 'rejected') {
            expect((r2.reason as FulfillmentError).code).toBe('FORBIDDEN');
          }

          expect(await countFulfillmentEvents(booking.bookingId)).toBe(0);
          expect(await countAuditEntries(booking.bookingId)).toBe(0);
          expect(await countOutboxEvents(booking.bookingId)).toBe(0);
        } finally {
          await db2.$client.end();
        }
      });

      it('responseBody FAILED malformé → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'replay-malformed-failed-' + SUFFIX();

        // Insérer manuellement une ligne idempotency_records FAILED avec responseBody malformé
        const fakeFingerprint = computeFulfillmentFingerprint({
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          operation: 'prepare_booking',
        });
        await rawSql`
          INSERT INTO "idempotency_records" (
            "id", "organization_id", "operation", "key", "request_fingerprint",
            "status", "resource_id", "response_status_code", "response_body",
            "created_at", "completed_at", "pending_timeout_at"
          )
          VALUES (
            ${randomUUID()}, ${ids.orgId}, 'prepare_booking', ${key}, ${fakeFingerprint},
            'FAILED', null, 403,
            ${rawSql.json({ code: 'INVALID_CODE', message: 'x' })},
            now(), now(), null
          )
        `;

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('responseBody COMPLETED malformé → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'replay-malformed-completed-' + SUFFIX();

        // Insérer manuellement une ligne idempotency_records COMPLETED avec responseBody malformé
        const fakeFingerprint = computeFulfillmentFingerprint({
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          operation: 'prepare_booking',
        });
        await rawSql`
          INSERT INTO "idempotency_records" (
            "id", "organization_id", "operation", "key", "request_fingerprint",
            "status", "resource_id", "response_status_code", "response_body",
            "created_at", "completed_at", "pending_timeout_at"
          )
          VALUES (
            ${randomUUID()}, ${ids.orgId}, 'prepare_booking', ${key}, ${fakeFingerprint},
            'COMPLETED', ${booking.bookingId}, 200,
            ${rawSql.json({ kind: 'INVALID' })},
            now(), now(), null
          )
        `;

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Outbox
    // ─────────────────────────────────────────────────────────────────────
    describe('Outbox', () => {
      it('collision outbox → rollback complet, clé FAILED', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'outbox-collision-' + SUFFIX();

        // Créer un trigger qui lève une exception sur INSERT outbox.
        await rawSql`
          CREATE OR REPLACE FUNCTION test_block_outbox_insert()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'test_outbox_collision';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_block_outbox_before_insert
          BEFORE INSERT ON outbox_events
          FOR EACH ROW EXECUTE FUNCTION test_block_outbox_insert()
        `;

        try {
          await expect(
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: key,
            }),
          ).rejects.toThrow();

          // Vérifier : booking inchangé
          expect(await getBookingStatus(booking.bookingId)).toBe('CONFIRMED');
          // Vérifier : 0 fulfillment_event, 0 audit, 0 outbox
          expect(await countFulfillmentEvents(booking.bookingId)).toBe(0);
          expect(await countAuditEntries(booking.bookingId)).toBe(0);
          expect(await countOutboxEvents(booking.bookingId)).toBe(0);
          // Vérifier : clé FAILED
          expect(await getIdempotencyRecordStatus(key)).toBe('FAILED');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_block_outbox_before_insert ON outbox_events`;
          await rawSql`DROP FUNCTION IF EXISTS test_block_outbox_insert()`;
        }
      });

      it('occurredAt du payload outbox === occurred_at du fulfillment_event', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'outbox-timestamp-' + SUFFIX();

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
        });

        const evt =
          await rawSql`SELECT id, occurred_at FROM booking_fulfillment_events WHERE booking_id = ${booking.bookingId}`;
        expect(evt.length).toBe(1);
        const occurredAt = evt[0]!.occurred_at as Date;

        const outbox =
          await rawSql`SELECT payload FROM outbox_events WHERE aggregate_id = ${booking.bookingId}`;
        expect(outbox.length).toBe(1);
        const payload = outbox[0]!.payload as { occurredAt: string };
        expect(payload.occurredAt).toBe(occurredAt.toISOString());
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Lot 21-U2-AB — Incidents de retour
    // ─────────────────────────────────────────────────────────────────────
    describe('21-U2-AB — maintenance automatique au retour', () => {
      it('pose un bloc borné, libère le bloc BOOKING et ne modifie aucun snapshot financier', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-pickup-' + SUFFIX(),
        });

        const financialBefore = await rawSql`
          SELECT total_amount_minor, commission_amount_minor,
                 cancellation_policy_snapshot, terms_acceptance_snapshot,
                 payment_id
          FROM bookings WHERE id = ${booking.bookingId}
        `.then((rows) => rows[0]!);

        const damage = await createDamageReport(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          bookingItemId: booking.bookingItemId,
          actorUserId: staffId,
          idempotencyKey: 'ab-damage-' + SUFFIX(),
          description: 'Frein arrière inutilisable',
        });
        expect(damage.kind).toBe('APPLIED');
        if (damage.kind !== 'APPLIED') return;

        const key = 'ab-return-maintenance-' + SUFFIX();
        const result = await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
          maintenance: {
            bookingItemId: booking.bookingItemId,
            durationMinutes: 48 * 60,
            sourceDamageReportId: damage.reportId,
          },
        });

        expect(result).toMatchObject({
          kind: 'APPLIED',
          bookingId: booking.bookingId,
          previousStatus: 'ACTIVE',
          nextStatus: 'RETURNED',
        });
        expect(await getBookingStatus(booking.bookingId)).toBe('RETURNED');

        const blocks = await rawSql`
          SELECT id, type, status, source_id,
                 (EXTRACT(EPOCH FROM (blocked_end_at - blocked_start_at)) / 60)::int AS duration_minutes
          FROM inventory_blocks
          WHERE inventory_item_id = ${ids.itemId}
          ORDER BY created_at ASC, id ASC
        `;
        const bookingBlock = blocks.find((block) => block.type === 'BOOKING');
        const maintenanceBlock = blocks.find((block) => block.type === 'MAINTENANCE');
        expect(bookingBlock?.status).toBe('RELEASED');
        expect(maintenanceBlock).toMatchObject({
          type: 'MAINTENANCE',
          status: 'ACTIVE',
          source_id: damage.reportId,
          duration_minutes: 48 * 60,
        });

        const item = await rawSql`
          SELECT condition FROM inventory_items WHERE id = ${ids.itemId}
        `.then((rows) => rows[0]!);
        expect(item.condition).toBe('BROKEN');

        const maintenanceCase = await rawSql`
          SELECT id, status, source_damage_report_id, maintenance_block_id
          FROM maintenance_cases WHERE inventory_item_id = ${ids.itemId}
        `.then((rows) => rows[0]!);
        expect(maintenanceCase).toMatchObject({
          status: 'OPEN',
          source_damage_report_id: damage.reportId,
          maintenance_block_id: maintenanceBlock?.id,
        });

        const financialAfter = await rawSql`
          SELECT total_amount_minor, commission_amount_minor,
                 cancellation_policy_snapshot, terms_acceptance_snapshot,
                 payment_id
          FROM bookings WHERE id = ${booking.bookingId}
        `.then((rows) => rows[0]!);
        expect(financialAfter).toEqual(financialBefore);

        const maintenanceAudit = await rawSql`
          SELECT action, metadata FROM audit_log
          WHERE target_id = ${ids.itemId} AND action = 'RETURN_MAINTENANCE_BLOCKED'
        `.then((rows) => rows[0]!);
        expect(maintenanceAudit.action).toBe('RETURN_MAINTENANCE_BLOCKED');
        expect(maintenanceAudit.metadata).toMatchObject({
          bookingId: booking.bookingId,
          durationMinutes: 48 * 60,
          financialSnapshotUntouched: true,
        });

        const allMaintenanceOutbox = await rawSql`
          SELECT event_type, payload FROM outbox_events
          WHERE event_type = 'MAINTENANCE_OPENED' AND aggregate_id = ${maintenanceCase.id}
        `.then((rows) => rows[0]!);
        expect(allMaintenanceOutbox.event_type).toBe('MAINTENANCE_OPENED');
        expect(allMaintenanceOutbox.payload).toMatchObject({
          bookingId: booking.bookingId,
          maintenanceBlockId: maintenanceBlock?.id,
          durationMinutes: 48 * 60,
        });

        const replay = await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
          maintenance: {
            bookingItemId: booking.bookingItemId,
            durationMinutes: 48 * 60,
            sourceDamageReportId: damage.reportId,
          },
        });
        expect(replay).toEqual(result);
        expect(
          await rawSql`SELECT count(*)::int AS count FROM inventory_blocks WHERE inventory_item_id = ${ids.itemId} AND type = 'MAINTENANCE'`.then(
            (rows) => rows[0]!.count,
          ),
        ).toBe(1);
      });

      it('en cas de chevauchement futur, valide le retour et émet CONFLICT_DETECTED sans bloc incompatible', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-conflict-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-conflict-pickup-' + SUFFIX(),
        });

        await rawSql`
          INSERT INTO inventory_blocks (
            organization_id, inventory_item_id, type, status,
            customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
          )
          VALUES (
            ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
            now() + interval '12 hours', now() + interval '36 hours',
            now() + interval '12 hours', now() + interval '36 hours', ${randomUUID()}
          )
        `;

        const key = 'ab-return-conflict-' + SUFFIX();
        const result = await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
          maintenance: {
            bookingItemId: booking.bookingItemId,
            durationMinutes: 48 * 60,
          },
        });

        expect(result.kind).toBe('APPLIED');
        expect(await getBookingStatus(booking.bookingId)).toBe('RETURNED');
        expect(
          await rawSql`SELECT status FROM inventory_blocks WHERE id = ${booking.blockId}`.then(
            (rows) => rows[0]!.status,
          ),
        ).toBe('RELEASED');
        expect(
          await rawSql`SELECT count(*)::int AS count FROM inventory_blocks WHERE inventory_item_id = ${ids.itemId} AND type = 'MAINTENANCE'`.then(
            (rows) => rows[0]!.count,
          ),
        ).toBe(0);
        expect(
          await rawSql`SELECT condition FROM inventory_items WHERE id = ${ids.itemId}`.then(
            (rows) => rows[0]!.condition,
          ),
        ).toBe('BROKEN');

        const conflictAudit = await rawSql`
          SELECT action, metadata FROM audit_log
          WHERE target_id = ${ids.itemId} AND action = 'CONFLICT_DETECTED'
        `.then((rows) => rows[0]!);
        expect(conflictAudit.action).toBe('CONFLICT_DETECTED');
        expect(conflictAudit.metadata).toMatchObject({
          bookingId: booking.bookingId,
          conflictType: 'RETURN_MAINTENANCE_VS_FUTURE_BOOKING',
          requiresProactiveSubstitution: true,
          financialSnapshotUntouched: true,
        });

        const conflictOutbox = await rawSql`
          SELECT event_type, aggregate_type, aggregate_id, payload
          FROM outbox_events WHERE event_type = 'CONFLICT_DETECTED'
        `.then((rows) => rows[0]!);
        expect(conflictOutbox).toMatchObject({
          event_type: 'CONFLICT_DETECTED',
          aggregate_type: 'INVENTORY_ITEM',
          aggregate_id: ids.itemId,
        });
        expect(conflictOutbox.payload).toMatchObject({
          bookingId: booking.bookingId,
          requiresProactiveSubstitution: true,
        });
      });

      it('un exemplaire déjà BROKEN déclenche automatiquement la maintenance par défaut', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-broken-prep-' + SUFFIX(),
        });
        await pickupBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-broken-pickup-' + SUFFIX(),
        });
        await rawSql`UPDATE inventory_items SET condition = 'BROKEN' WHERE id = ${ids.itemId}`;

        await returnBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: 'ab-broken-return-' + SUFFIX(),
        });

        const maintenance = await rawSql`
          SELECT (EXTRACT(EPOCH FROM (blocked_end_at - blocked_start_at)) / 60)::int AS duration_minutes
          FROM inventory_blocks
          WHERE inventory_item_id = ${ids.itemId} AND type = 'MAINTENANCE'
        `.then((rows) => rows[0]!);
        expect(maintenance.duration_minutes).toBe(24 * 60);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Sanitization UNKNOWN
    // ─────────────────────────────────────────────────────────────────────
    describe('Sanitization UNKNOWN', () => {
      it('erreur DB forcée ne persiste pas de chaîne sensible dans response_body', async () => {
        if (!ctx || !db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'sanitization-' + SUFFIX();

        await rawSql`
          CREATE OR REPLACE FUNCTION test_leak_sensitive_detail()
          RETURNS TRIGGER AS $$
          BEGIN
            RAISE EXCEPTION 'SECRET_INTERNAL_DETAIL_12345';
          END;
          $$ LANGUAGE plpgsql
        `;
        await rawSql`
          CREATE TRIGGER test_block_booking_update
          BEFORE UPDATE ON bookings
          FOR EACH ROW EXECUTE FUNCTION test_leak_sensitive_detail()
        `;

        try {
          await expect(
            prepareBooking(db, {
              organizationId: ids.orgId,
              bookingId: booking.bookingId,
              actorUserId: staffId,
              idempotencyKey: key,
            }),
          ).rejects.toThrow();

          const rows = await rawSql`
            SELECT response_body FROM idempotency_records WHERE key = ${key}
          `;
          expect(rows.length).toBe(1);
          const body = rows[0]!.response_body as { code: string; message: string };
          expect(body.code).toBe('UNKNOWN');
          expect(body.message).toBe('Erreur inattendue lors de la transition fulfillment.');
          expect(body.message).not.toContain('SECRET_INTERNAL_DETAIL_12345');
          expect(JSON.stringify(body)).not.toContain('SECRET_INTERNAL_DETAIL_12345');
        } finally {
          await rawSql`DROP TRIGGER IF EXISTS test_block_booking_update ON bookings`;
          await rawSql`DROP FUNCTION IF EXISTS test_leak_sensitive_detail()`;
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Non-régression G3A — replays corrompus
    // ─────────────────────────────────────────────────────────────────────
    describe('Non-régression G3A — replays corrompus', () => {
      async function insertCorruptedIdempotencyRecord(
        ids: BaseIds,
        booking: BookingIds,
        staffId: string,
        key: string,
        responseBody: Record<string, string>,
        status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
        responseStatusCode = 200,
      ): Promise<void> {
        if (!rawSql) throw new Error('rawSql not initialized');
        const fakeFingerprint = computeFulfillmentFingerprint({
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          operation: 'prepare_booking',
        });
        // Pour les FAILED, resource_id doit être NULL (contrainte DB).
        const resourceId = status === 'COMPLETED' ? booking.bookingId : null;
        await rawSql`
          INSERT INTO "idempotency_records" (
            "id", "organization_id", "operation", "key", "request_fingerprint",
            "status", "resource_id", "response_status_code", "response_body",
            "created_at", "completed_at", "pending_timeout_at"
          )
          VALUES (
            ${randomUUID()}, ${ids.orgId}, 'prepare_booking', ${key}, ${fakeFingerprint},
            ${status}, ${resourceId}, ${responseStatusCode},
            ${rawSql.json(responseBody)},
            now(), now(), null
          )
        `;
      }

      it('APPLIED avec bookingId non-UUID → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-applied-bookingid-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'APPLIED',
          bookingId: 'not-a-uuid',
          previousStatus: 'CONFIRMED',
          nextStatus: 'READY_FOR_PICKUP',
          fulfillmentEventId: '00000000-0000-0000-0000-000000000000',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('APPLIED avec previousStatus invalide → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-applied-prev-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'APPLIED',
          bookingId: booking.bookingId,
          previousStatus: 'INVALID_STATUS',
          nextStatus: 'READY_FOR_PICKUP',
          fulfillmentEventId: '00000000-0000-0000-0000-000000000000',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('APPLIED avec nextStatus invalide → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-applied-next-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'APPLIED',
          bookingId: booking.bookingId,
          previousStatus: 'CONFIRMED',
          nextStatus: 'INVALID_STATUS',
          fulfillmentEventId: '00000000-0000-0000-0000-000000000000',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('APPLIED avec fulfillmentEventId non-UUID → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-applied-eventid-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'APPLIED',
          bookingId: booking.bookingId,
          previousStatus: 'CONFIRMED',
          nextStatus: 'READY_FOR_PICKUP',
          fulfillmentEventId: 'not-a-uuid',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('NOOP avec bookingId non-UUID → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-noop-bookingid-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'NOOP',
          bookingId: 'not-a-uuid',
          currentStatus: 'CONFIRMED',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('NOOP avec currentStatus invalide → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-noop-current-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(ids, booking, staffId, key, {
          kind: 'NOOP',
          bookingId: booking.bookingId,
          currentStatus: 'INVALID_STATUS',
        });
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('FAILED avec fromStatus invalide → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-failed-from-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(
          ids,
          booking,
          staffId,
          key,
          {
            code: 'INVALID_TRANSITION',
            message: 'test',
            fromStatus: 'INVALID_STATUS',
          },
          'FAILED',
          409,
        );
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });

      it('FAILED avec toStatus invalide → IDEMPOTENCY_REPLAY_INVALID', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'corrupt-failed-to-' + SUFFIX();
        await insertCorruptedIdempotencyRecord(
          ids,
          booking,
          staffId,
          key,
          {
            code: 'INVALID_TRANSITION',
            message: 'test',
            toStatus: 'INVALID_STATUS',
          },
          'FAILED',
          409,
        );
        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: key,
          });
          expect.fail('devrait lever IDEMPOTENCY_REPLAY_INVALID');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('IDEMPOTENCY_REPLAY_INVALID');
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Normalisation des clés d'idempotence (G3B)
    // ─────────────────────────────────────────────────────────────────────
    describe('Normalisation des clés d"idempotence (G3B)', () => {
      it('" key " et "key" produisent le meme comportement idempotent (prepareBooking)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);
        const key = 'trim-prepare-' + SUFFIX();

        const result1 = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: ` ${key} `,
        });
        expect(result1.kind).toBe('APPLIED');

        // Rejouer avec la clé trimee doit retourner le meme resultat (REPLAY COMPLETED)
        const result2 = await prepareBooking(db, {
          organizationId: ids.orgId,
          bookingId: booking.bookingId,
          actorUserId: staffId,
          idempotencyKey: key,
        });
        expect(result2.kind).toBe('APPLIED');
        if (result2.kind !== 'APPLIED') return;
        expect(result2.bookingId).toBe(result1.kind === 'APPLIED' ? result1.bookingId : '');

        expect(await getBookingStatus(booking.bookingId)).toBe('READY_FOR_PICKUP');
        expect(await countFulfillmentEvents(booking.bookingId)).toBe(1);
      });

      it('chaine vide apres trim -> VALIDATION (prepareBooking)', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        const booking = await seedConfirmedBooking(ids);
        const staffId = await seedStaffUser(ids);

        try {
          await prepareBooking(db, {
            organizationId: ids.orgId,
            bookingId: booking.bookingId,
            actorUserId: staffId,
            idempotencyKey: '   ',
          });
          expect.fail('devrait lever VALIDATION');
        } catch (e) {
          expect((e as FulfillmentError).code).toBe('VALIDATION');
        }
      });
    });
  },
);
