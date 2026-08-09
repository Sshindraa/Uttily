import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { listOperationalBookings, getOperationalBookingDetails } from './read-models';
import { requireFulfillmentOperator } from './permissions';
import { AuthorizationError } from '../identity/permissions';
import type { MembershipRecord } from '../identity/types';
import { FulfillmentError } from './fulfillment-errors';
import { prepareBooking, pickupBooking, createConditionReport, createDamageReport } from './index';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('fulfillment_read_models');
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
// Seed helpers (COPIES depuis reports.integration.test.ts — ne pas importer)
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

async function setBookingStatus(bookingId: string, status: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  await rawSql`UPDATE bookings SET status = ${status} WHERE id = ${bookingId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers d'insertion de rapports/événements (raw SQL direct)
// ─────────────────────────────────────────────────────────────────────────────

async function insertConditionReport(
  ids: BaseIds,
  booking: BookingIds,
  phase: 'PICKUP' | 'RETURN',
  condition: 'NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'BROKEN',
  reporterUserId: string,
  occurredAt = '2026-02-15 10:00:00+00',
  notes: string | null = null,
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const row = await sql`
    INSERT INTO "condition_reports" (
      "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
      "phase", "condition", "notes", "reporter_user_id", "idempotency_key", "created_at"
    )
    VALUES (
      ${ids.orgId}, ${booking.bookingId}, ${booking.bookingItemId}, ${ids.itemId},
      ${phase}, ${condition}, ${notes}, ${reporterUserId}, ${'cr-' + SUFFIX()}, ${occurredAt}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return row.id;
}

async function insertDamageReport(
  ids: BaseIds,
  booking: BookingIds,
  description: string,
  reporterUserId: string,
  occurredAt = '2026-02-15 10:00:00+00',
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const row = await sql`
    INSERT INTO "damage_reports" (
      "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
      "description", "reporter_user_id", "idempotency_key", "created_at"
    )
    VALUES (
      ${ids.orgId}, ${booking.bookingId}, ${booking.bookingItemId}, ${ids.itemId},
      ${description}, ${reporterUserId}, ${'dr-' + SUFFIX()}, ${occurredAt}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return row.id;
}

async function insertFulfillmentEvent(
  ids: BaseIds,
  booking: BookingIds,
  eventType: 'PREPARED' | 'PICKED_UP' | 'RETURNED' | 'CLOSED',
  previousStatus: string,
  nextStatus: string,
  actorUserId: string,
  occurredAt = '2026-02-15 10:00:00+00',
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const row = await sql`
    INSERT INTO "booking_fulfillment_events" (
      "organization_id", "booking_id", "event_type",
      "previous_status", "next_status", "actor_user_id",
      "idempotency_key", "occurred_at"
    )
    VALUES (
      ${ids.orgId}, ${booking.bookingId}, ${eventType},
      ${previousStatus}, ${nextStatus}, ${actorUserId},
      ${'ev-' + SUFFIX()}, ${occurredAt}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const describeIntegration = shouldSkipIntegrationTests() ? describe.skip : describe;

describeIntegration('fulfillment read-models — listOperationalBookings', () => {
  it('liste bornée et ordonnée (customerStartAt asc, id asc)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // Trois bookings sur des mois différents (monthOffset 2, 3, 4).
    const b2 = await seedConfirmedBooking(ids, 2);
    const b3 = await seedConfirmedBooking(ids, 3);
    const b4 = await seedConfirmedBooking(ids, 4);

    const result = await listOperationalBookings(db, ids.orgId);
    expect(result).toHaveLength(3);
    // Ordre ascendant par customerStartAt.
    expect(result[0]!.id).toBe(b2.bookingId);
    expect(result[1]!.id).toBe(b3.bookingId);
    expect(result[2]!.id).toBe(b4.bookingId);
    // customerStartAt croissant.
    expect(result[0]!.customerStartAt.getTime()).toBeLessThan(result[1]!.customerStartAt.getTime());
    expect(result[1]!.customerStartAt.getTime()).toBeLessThan(result[2]!.customerStartAt.getTime());
  });

  it('filtre par statuts (seulement ACTIVE)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedConfirmedBooking(ids, 2);
    const b3 = await seedConfirmedBooking(ids, 3);
    const b4 = await seedConfirmedBooking(ids, 4);
    await setBookingStatus(b3.bookingId, 'ACTIVE');
    await setBookingStatus(b4.bookingId, 'ACTIVE');

    const result = await listOperationalBookings(db, ids.orgId, { statuses: ['ACTIVE'] });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual([b3.bookingId, b4.bookingId].sort());
    expect(result.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('filtre par dates (dateFrom/dateTo)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b2 = await seedConfirmedBooking(ids, 2); // 2026-02-10..12
    const b3 = await seedConfirmedBooking(ids, 3); // 2026-03-10..12
    const b4 = await seedConfirmedBooking(ids, 4); // 2026-04-10..12

    // dateFrom après le début de b2 mais avant b3.
    const from = new Date('2026-03-01T00:00:00Z');
    const resultFrom = await listOperationalBookings(db, ids.orgId, { dateFrom: from });
    expect(resultFrom.map((r) => r.id)).toEqual([b3.bookingId, b4.bookingId]);

    // dateTo avant la fin de b3 mais après b2.
    const to = new Date('2026-03-15T00:00:00Z');
    const resultTo = await listOperationalBookings(db, ids.orgId, { dateTo: to });
    expect(resultTo.map((r) => r.id)).toEqual([b2.bookingId, b3.bookingId]);

    // Combinaison dateFrom + dateTo : seulement b3.
    const resultBoth = await listOperationalBookings(db, ids.orgId, {
      dateFrom: new Date('2026-03-01T00:00:00Z'),
      dateTo: new Date('2026-03-15T00:00:00Z'),
    });
    expect(resultBoth.map((r) => r.id)).toEqual([b3.bookingId]);
  });

  it('limite respectée (limit=2 retourne 2, limit=200 plafonné à 100)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // On crée 3 bookings.
    await seedConfirmedBooking(ids, 2);
    await seedConfirmedBooking(ids, 3);
    await seedConfirmedBooking(ids, 4);

    const result2 = await listOperationalBookings(db, ids.orgId, { limit: 2 });
    expect(result2).toHaveLength(2);

    // limit=200 plafonné à 100 : avec 3 bookings, on récupère 3.
    const result200 = await listOperationalBookings(db, ids.orgId, { limit: 200 });
    expect(result200).toHaveLength(3);
  });

  it('counts corrects (bookingItemCount, conditionReportCount, damageReportCount, lastFulfillmentEventAt)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const booking = await seedConfirmedBooking(ids, 2);
    const staffId = await seedStaffUser(ids);

    // 1 condition report, 1 damage report, 2 fulfillment events.
    await insertConditionReport(ids, booking, 'PICKUP', 'GOOD', staffId, '2026-02-15 10:00:00+00');
    await insertDamageReport(ids, booking, 'Rayure coque', staffId, '2026-02-15 10:05:00+00');
    await insertFulfillmentEvent(
      ids,
      booking,
      'PREPARED',
      'CONFIRMED',
      'READY_FOR_PICKUP',
      staffId,
      '2026-02-15 09:00:00+00',
    );
    await insertFulfillmentEvent(
      ids,
      booking,
      'PICKED_UP',
      'READY_FOR_PICKUP',
      'ACTIVE',
      staffId,
      '2026-02-15 11:00:00+00',
    );

    const result = await listOperationalBookings(db, ids.orgId);
    expect(result).toHaveLength(1);
    const summary = result[0]!;
    // Fuseau du lieu propagé depuis locations.time_zone.
    expect(result[0]!.locationTimeZone).toBe('Europe/Paris');
    expect(summary.bookingItemCount).toBe(1);
    expect(summary.conditionReportCount).toBe(1);
    expect(summary.damageReportCount).toBe(1);
    expect(summary.lastFulfillmentEventAt).not.toBeNull();
    // Le dernier événement est à 11:00.
    expect(summary.lastFulfillmentEventAt!.toISOString()).toContain('2026-02-15T11:00:00');
  });
});

describeIntegration('fulfillment read-models — getOperationalBookingDetails', () => {
  it('détail nominal (tous champs présents, items, reports, events)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const booking = await seedConfirmedBooking(ids, 2);
    const staffId = await seedStaffUser(ids);

    await insertConditionReport(ids, booking, 'PICKUP', 'GOOD', staffId, '2026-02-15 10:00:00+00');
    await insertDamageReport(ids, booking, 'Rayure coque', staffId, '2026-02-15 10:05:00+00');
    await insertFulfillmentEvent(
      ids,
      booking,
      'PREPARED',
      'CONFIRMED',
      'READY_FOR_PICKUP',
      staffId,
      '2026-02-15 09:00:00+00',
    );

    const details = await getOperationalBookingDetails(db, ids.orgId, booking.bookingId);
    expect(details).not.toBeNull();
    expect(details!.id).toBe(booking.bookingId);
    expect(details!.status).toBe('CONFIRMED');
    expect(details!.locationId).toBe(ids.locationId);
    expect(details!.locationName).toBe('Annecy');
    // Fuseau du lieu propagé depuis locations.time_zone.
    expect(details!.locationTimeZone).toBe('Europe/Paris');
    expect(details!.customerStartAt).toBeInstanceOf(Date);
    expect(details!.customerEndAt).toBeInstanceOf(Date);
    expect(details!.customerEmail).toContain('@example.com');

    // Items.
    expect(details!.items).toHaveLength(1);
    const item = details!.items[0]!;
    expect(item.bookingItemId).toBe(booking.bookingItemId);
    expect(item.inventoryItemId).toBe(ids.itemId);
    expect(item.internalSku).toContain('KAY-');
    expect(item.currentCondition).toBe('GOOD');
    expect(item.inventoryStatus).toBe('ACTIVE');

    // Condition reports.
    expect(details!.conditionReports).toHaveLength(1);
    const cr = details!.conditionReports[0]!;
    expect(cr.phase).toBe('PICKUP');
    expect(cr.condition).toBe('GOOD');
    expect(cr.reporterUserId).toBe(staffId);

    // Damage reports.
    expect(details!.damageReports).toHaveLength(1);
    const dr = details!.damageReports[0]!;
    expect(dr.description).toBe('Rayure coque');
    expect(dr.reporterUserId).toBe(staffId);

    // Fulfillment events.
    expect(details!.fulfillmentEvents).toHaveLength(1);
    const ev = details!.fulfillmentEvents[0]!;
    expect(ev.eventType).toBe('PREPARED');
    expect(ev.previousStatus).toBe('CONFIRMED');
    expect(ev.nextStatus).toBe('READY_FOR_PICKUP');
    expect(ev.actorUserId).toBe(staffId);
  });

  it('booking cross-org → null (pas de fuite)', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('aaa1');
    const ids2 = await seedBaseData('bbb2');
    const booking = await seedConfirmedBooking(ids1, 2);

    // Demande le détail depuis l'org 2 : doit retourner null.
    const details = await getOperationalBookingDetails(db, ids2.orgId, booking.bookingId);
    expect(details).toBeNull();
  });

  it("rapports/dommages d'une autre org absents (isolation)", async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('aaa1');
    const ids2 = await seedBaseData('bbb2');
    const booking1 = await seedConfirmedBooking(ids1, 2);
    const booking2 = await seedConfirmedBooking(ids2, 2);
    const staff1 = await seedStaffUser(ids1);
    const staff2 = await seedStaffUser(ids2);

    // Rapports sur booking1 (org1) et booking2 (org2).
    await insertConditionReport(ids1, booking1, 'PICKUP', 'GOOD', staff1, '2026-02-15 10:00:00+00');
    await insertDamageReport(ids1, booking1, 'Rayure org1', staff1, '2026-02-15 10:05:00+00');
    await insertConditionReport(ids2, booking2, 'PICKUP', 'FAIR', staff2, '2026-02-15 10:00:00+00');
    await insertDamageReport(ids2, booking2, 'Fissure org2', staff2, '2026-02-15 10:05:00+00');

    // Détail de booking1 depuis org1 : ne doit contenir que les rapports org1.
    const details1 = await getOperationalBookingDetails(db, ids1.orgId, booking1.bookingId);
    expect(details1).not.toBeNull();
    expect(details1!.conditionReports).toHaveLength(1);
    expect(details1!.conditionReports[0]!.condition).toBe('GOOD');
    expect(details1!.damageReports).toHaveLength(1);
    expect(details1!.damageReports[0]!.description).toBe('Rayure org1');

    // Détail de booking2 depuis org2 : ne doit contenir que les rapports org2.
    const details2 = await getOperationalBookingDetails(db, ids2.orgId, booking2.bookingId);
    expect(details2).not.toBeNull();
    expect(details2!.conditionReports).toHaveLength(1);
    expect(details2!.conditionReports[0]!.condition).toBe('FAIR');
    expect(details2!.damageReports).toHaveLength(1);
    expect(details2!.damageReports[0]!.description).toBe('Fissure org2');
  });

  it('customerEmail présent uniquement sur le détail (pas sur la liste)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedConfirmedBooking(ids, 2);

    const list = await listOperationalBookings(db, ids.orgId);
    expect(list).toHaveLength(1);
    // Le summary ne contient pas customerEmail.
    const summary = list[0]!;
    expect((summary as unknown as Record<string, unknown>).customerEmail).toBeUndefined();

    // Le détail contient customerEmail.
    const details = await getOperationalBookingDetails(db, ids.orgId, list[0]!.id);
    expect(details).not.toBeNull();
    expect(details!.customerEmail).toContain('@example.com');
  });

  it('ordre chronologique déterministe des fulfillmentEvents', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const booking = await seedConfirmedBooking(ids, 2);
    const staffId = await seedStaffUser(ids);

    // Insertion dans le désordre : 11:00, puis 09:00, puis 10:00.
    await insertFulfillmentEvent(
      ids,
      booking,
      'PICKED_UP',
      'READY_FOR_PICKUP',
      'ACTIVE',
      staffId,
      '2026-02-15 11:00:00+00',
    );
    await insertFulfillmentEvent(
      ids,
      booking,
      'PREPARED',
      'CONFIRMED',
      'READY_FOR_PICKUP',
      staffId,
      '2026-02-15 09:00:00+00',
    );
    await insertFulfillmentEvent(
      ids,
      booking,
      'RETURNED',
      'ACTIVE',
      'RETURNED',
      staffId,
      '2026-02-15 10:00:00+00',
    );

    const details = await getOperationalBookingDetails(db, ids.orgId, booking.bookingId);
    expect(details).not.toBeNull();
    const events = details!.fulfillmentEvents;
    expect(events).toHaveLength(3);
    // Ordre ascendant par occurredAt.
    expect(events[0]!.eventType).toBe('PREPARED');
    expect(events[1]!.eventType).toBe('RETURNED');
    expect(events[2]!.eventType).toBe('PICKED_UP');
    // Vérifie que occurredAt est strictement croissant.
    expect(events[0]!.occurredAt.getTime()).toBeLessThan(events[1]!.occurredAt.getTime());
    expect(events[1]!.occurredAt.getTime()).toBeLessThan(events[2]!.occurredAt.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation runtime des read models (G4A — defense in depth).
// ─────────────────────────────────────────────────────────────────────────────

describeIntegration('Validation runtime', () => {
  // Mock db : les erreurs de validation lèvent avant toute query.
  const mockDb = {} as DatabaseClient;

  it('listOperationalBookings — organizationId non-UUID → VALIDATION', async () => {
    await expect(listOperationalBookings(mockDb, 'not-a-uuid')).rejects.toThrow(FulfillmentError);
    await expect(listOperationalBookings(mockDb, 'not-a-uuid')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('listOperationalBookings — limit 0 → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(listOperationalBookings(mockDb, orgId, { limit: 0 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('listOperationalBookings — limit négatif → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(listOperationalBookings(mockDb, orgId, { limit: -5 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('listOperationalBookings — limit NaN → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(listOperationalBookings(mockDb, orgId, { limit: NaN })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('listOperationalBookings — limit Infinity → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(listOperationalBookings(mockDb, orgId, { limit: Infinity })).rejects.toMatchObject(
      { code: 'VALIDATION' },
    );
  });

  it('listOperationalBookings — limit non-entier (1.5) → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(listOperationalBookings(mockDb, orgId, { limit: 1.5 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('listOperationalBookings — limit > 100 → plafonné à 100 (aucune erreur)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedConfirmedBooking(ids, 2);
    await seedConfirmedBooking(ids, 3);
    await seedConfirmedBooking(ids, 4);
    // limit=200 doit être plafonné à 100 : avec 3 bookings, on récupère 3.
    const result = await listOperationalBookings(db, ids.orgId, { limit: 200 });
    expect(result).toHaveLength(3);
  });

  it('listOperationalBookings — status invalide → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      listOperationalBookings(mockDb, orgId, { statuses: ['INVALID_STATUS' as never] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('listOperationalBookings — statuses avec doublons → normalisé (aucune erreur)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    await seedConfirmedBooking(ids, 2);
    const b3 = await seedConfirmedBooking(ids, 3);
    await setBookingStatus(b3.bookingId, 'ACTIVE');
    // Doublon de ACTIVE : doit être normalisé, pas d'erreur SQL.
    const result = await listOperationalBookings(db, ids.orgId, {
      statuses: ['ACTIVE', 'ACTIVE'],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(b3.bookingId);
  });

  it('listOperationalBookings — dateFrom invalide (new Date("invalid")) → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      listOperationalBookings(mockDb, orgId, { dateFrom: new Date('invalid') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('listOperationalBookings — dateTo invalide → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      listOperationalBookings(mockDb, orgId, { dateTo: new Date('not-a-date') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('listOperationalBookings — dateFrom > dateTo → VALIDATION', async () => {
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      listOperationalBookings(mockDb, orgId, {
        dateFrom: new Date('2026-04-01T00:00:00Z'),
        dateTo: new Date('2026-03-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('getOperationalBookingDetails — organizationId non-UUID → VALIDATION', async () => {
    await expect(
      getOperationalBookingDetails(mockDb, 'not-a-uuid', '00000000-0000-0000-0000-000000000001'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('getOperationalBookingDetails — bookingId non-UUID → VALIDATION', async () => {
    await expect(
      getOperationalBookingDetails(mockDb, '00000000-0000-0000-0000-000000000001', 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('getOperationalBookingDetails — UUID valide mais booking absent → null', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const result = await getOperationalBookingDetails(
      db,
      ids.orgId,
      '00000000-0000-0000-0000-000000000099',
    );
    expect(result).toBeNull();
  });

  it('getOperationalBookingDetails — UUID valide mais cross-org → null', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('aaa1');
    const ids2 = await seedBaseData('bbb2');
    const booking = await seedConfirmedBooking(ids1, 2);
    const result = await getOperationalBookingDetails(db, ids2.orgId, booking.bookingId);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Isolation multi-tenant renforcée (G4A).
// ─────────────────────────────────────────────────────────────────────────────

describeIntegration('Isolation multi-tenant renforcée', () => {
  it("les counts et détails d'une org ne contiennent jamais les rapports/events d'une autre org", async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('iso1');
    const ids2 = await seedBaseData('iso2');
    const booking1 = await seedConfirmedBooking(ids1, 2);
    const booking2 = await seedConfirmedBooking(ids2, 2);
    const staff1 = await seedStaffUser(ids1, 'OWNER');
    const staff2 = await seedStaffUser(ids2, 'OWNER');

    // Prepare les deux bookings (CONFIRMED → READY_FOR_PICKUP) via use cases Core.
    await prepareBooking(db, {
      organizationId: ids1.orgId,
      bookingId: booking1.bookingId,
      actorUserId: staff1,
      idempotencyKey: 'iso-prepare-1-' + SUFFIX(),
    });
    await prepareBooking(db, {
      organizationId: ids2.orgId,
      bookingId: booking2.bookingId,
      actorUserId: staff2,
      idempotencyKey: 'iso-prepare-2-' + SUFFIX(),
    });

    // Condition report (phase PICKUP, valide en READY_FOR_PICKUP) sur booking1 (org1).
    await createConditionReport(db, {
      organizationId: ids1.orgId,
      bookingId: booking1.bookingId,
      bookingItemId: booking1.bookingItemId,
      actorUserId: staff1,
      idempotencyKey: 'iso-cr-1-' + SUFFIX(),
      phase: 'PICKUP',
      condition: 'GOOD',
      notes: 'RAS org1',
    });

    // Condition report sur booking2 (org2).
    await createConditionReport(db, {
      organizationId: ids2.orgId,
      bookingId: booking2.bookingId,
      bookingItemId: booking2.bookingItemId,
      actorUserId: staff2,
      idempotencyKey: 'iso-cr-2-' + SUFFIX(),
      phase: 'PICKUP',
      condition: 'FAIR',
      notes: 'RAS org2',
    });

    // Pickup les deux bookings (READY_FOR_PICKUP → ACTIVE) pour autoriser les
    // rapports de dommages (statut requis : ACTIVE ou RETURNED).
    await pickupBooking(db, {
      organizationId: ids1.orgId,
      bookingId: booking1.bookingId,
      actorUserId: staff1,
      idempotencyKey: 'iso-pickup-1-' + SUFFIX(),
    });
    await pickupBooking(db, {
      organizationId: ids2.orgId,
      bookingId: booking2.bookingId,
      actorUserId: staff2,
      idempotencyKey: 'iso-pickup-2-' + SUFFIX(),
    });

    // Damage report (valide en ACTIVE) sur booking1 (org1).
    await createDamageReport(db, {
      organizationId: ids1.orgId,
      bookingId: booking1.bookingId,
      bookingItemId: booking1.bookingItemId,
      actorUserId: staff1,
      idempotencyKey: 'iso-dr-1-' + SUFFIX(),
      description: 'Rayure org1',
    });

    // Damage report sur booking2 (org2).
    await createDamageReport(db, {
      organizationId: ids2.orgId,
      bookingId: booking2.bookingId,
      bookingItemId: booking2.bookingItemId,
      actorUserId: staff2,
      idempotencyKey: 'iso-dr-2-' + SUFFIX(),
      description: 'Fissure org2',
    });

    // listOperationalBookings(db, org1, {}) : les counts ne doivent JAMAIS
    // inclure les rapports/events de org2.
    const list1 = await listOperationalBookings(db, ids1.orgId);
    expect(list1).toHaveLength(1);
    const summary1 = list1[0]!;
    expect(summary1.id).toBe(booking1.bookingId);
    expect(summary1.bookingItemCount).toBe(1);
    expect(summary1.conditionReportCount).toBe(1);
    expect(summary1.damageReportCount).toBe(1);
    // Le fulfillment event du prepare est présent (PREPARED).
    expect(summary1.lastFulfillmentEventAt).not.toBeNull();

    // getOperationalBookingDetails(db, org1, booking1) : items/conditionReports/
    // damageReports/fulfillmentEvents ne contiennent QUE les enregistrements de org1.
    const details1 = await getOperationalBookingDetails(db, ids1.orgId, booking1.bookingId);
    expect(details1).not.toBeNull();
    expect(details1!.items).toHaveLength(1);
    expect(details1!.items[0]!.bookingItemId).toBe(booking1.bookingItemId);
    expect(details1!.conditionReports).toHaveLength(1);
    expect(details1!.conditionReports[0]!.condition).toBe('GOOD');
    expect(details1!.damageReports).toHaveLength(1);
    expect(details1!.damageReports[0]!.description).toBe('Rayure org1');
    expect(details1!.fulfillmentEvents.length).toBeGreaterThanOrEqual(1);
    // Tous les fulfillment events appartiennent au booking1.
    for (const ev of details1!.fulfillmentEvents) {
      expect(ev.eventType).toBeDefined();
    }

    // Vérification structurelle : aucun champ financier n'est présent dans le résultat.
    const forbiddenKeys = [
      'totalAmountMinor',
      'subtotalAmountMinor',
      'mandatoryFeesAmountMinor',
      'taxAmountMinor',
      'commissionAmountMinor',
      'currency',
      'paymentId',
      'draftId',
      'cancellationPolicySnapshot',
      'termsAcceptanceSnapshot',
      'stripeChargeId',
      'connectedAccountId',
    ];
    const detailKeys = Object.keys(details1!);
    for (const key of forbiddenKeys) {
      expect(detailKeys).not.toContain(key);
    }
    // Les items ne portent pas non plus de champ financier.
    for (const item of details1!.items) {
      const itemKeys = Object.keys(item);
      for (const key of forbiddenKeys) {
        expect(itemKeys).not.toContain(key);
      }
    }

    // Les items proviennent uniquement du booking autorisé (bookingItemId correspondant).
    expect(details1!.items.every((i) => i.bookingItemId === booking1.bookingItemId)).toBe(true);

    // Vérification symétrique pour org2.
    const list2 = await listOperationalBookings(db, ids2.orgId);
    expect(list2).toHaveLength(1);
    expect(list2[0]!.id).toBe(booking2.bookingId);
    expect(list2[0]!.conditionReportCount).toBe(1);
    expect(list2[0]!.damageReportCount).toBe(1);

    const details2 = await getOperationalBookingDetails(db, ids2.orgId, booking2.bookingId);
    expect(details2).not.toBeNull();
    expect(details2!.conditionReports).toHaveLength(1);
    expect(details2!.conditionReports[0]!.condition).toBe('FAIR');
    expect(details2!.damageReports).toHaveLength(1);
    expect(details2!.damageReports[0]!.description).toBe('Fissure org2');
  });
});

describeIntegration('fulfillment permissions — requireFulfillmentOperator', () => {
  it('accepte un STAFF actif', () => {
    const membership: MembershipRecord = {
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'STAFF',
      status: 'ACTIVE',
    };
    expect(requireFulfillmentOperator(membership)).toBe(membership);
  });

  it('accepte OWNER, ADMIN, MANAGER actifs', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) {
      const membership: MembershipRecord = {
        organizationId: 'org-1',
        userId: 'user-1',
        role,
        status: 'ACTIVE',
      };
      expect(requireFulfillmentOperator(membership)).toBe(membership);
    }
  });

  it('rejette une membership null', () => {
    expect(() => requireFulfillmentOperator(null)).toThrow(AuthorizationError);
  });

  it('rejette une membership non active (SUSPENDED)', () => {
    const membership: MembershipRecord = {
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'STAFF',
      status: 'SUSPENDED',
    };
    expect(() => requireFulfillmentOperator(membership)).toThrow(AuthorizationError);
  });
});
