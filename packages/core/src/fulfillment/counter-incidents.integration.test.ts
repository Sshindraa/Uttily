import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { recordBookingNoShow } from './record-booking-no-show';
import { listSubstitutionCandidates, substituteBookingItem } from './substitute-booking-item';
import { FulfillmentError } from './fulfillment-errors';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('fulfillment_counter_incidents');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
  }
});

afterAll(async () => {
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db) return;
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

interface SeedIds {
  organizationId: string;
  locationId: string;
  customerUserId: string;
  operatorUserId: string;
  variantId: string;
  itemId: string;
  bookingId: string;
  bookingItemId: string;
  bookingBlockId: string;
  paymentId: string;
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);
const PAST_START = '2026-02-10 09:00:00+00';
const PAST_END = '2026-02-12 17:00:00+00';
const PAST_BLOCKED_START = '2026-02-10 08:30:00+00';
const PAST_BLOCKED_END = '2026-02-12 17:30:00+00';

async function seedBooking(suffix = SUFFIX()): Promise<SeedIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const organization = await sql`
    INSERT INTO organizations (legal_name, slug, default_cancellation_policy_code)
    VALUES (${'Incident Org ' + suffix}, ${'incident-' + suffix}, 'FLEXIBLE')
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await sql`
    INSERT INTO locations (organization_id, name, slug, time_zone, prep_buffer_minutes, cleanup_buffer_minutes, operating_currency)
    VALUES (${organization.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const customer = await sql`
    INSERT INTO users (email) VALUES (${'customer-' + suffix + '@example.com'}) RETURNING id
  `.then((rows) => rows[0]!);
  const operator = await sql`
    INSERT INTO users (email) VALUES (${'operator-' + suffix + '@example.com'}) RETURNING id
  `.then((rows) => rows[0]!);
  await sql`
    INSERT INTO organization_memberships (organization_id, user_id, role, status)
    VALUES (${organization.id}, ${operator.id}, 'STAFF', 'ACTIVE')
  `;
  const category = await sql`
    SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1
  `.then((rows) => rows[0]!);
  const product = await sql`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${organization.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING id
  `.then((rows) => rows[0]!);
  for (let index = 0; index < 3; index += 1) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key, content_type, byte_size,
        width_px, height_px, checksum_sha256, sort_order, file_state
      ) VALUES (
        ${organization.id}, ${product.id}, ${'product-photos/incident-' + suffix + '-' + index},
        'image/jpeg', 102400, 800, 600, ${('001' + index).repeat(16).slice(0, 64)},
        ${index}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${product.id}`;
  const variant = await sql`
    INSERT INTO product_variants (product_id, name, is_active, daily_price_amount_minor, currency)
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const item = await sql`
    INSERT INTO inventory_items (
      organization_id, product_variant_id, internal_sku, current_location_id, condition, status
    ) VALUES (${organization.id}, ${variant.id}, ${'KAY-' + suffix}, ${location.id}, 'GOOD', 'ACTIVE')
    RETURNING id
  `.then((rows) => rows[0]!);

  const draft = await sql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, customer_start_at, customer_end_at,
      blocked_start_at, blocked_end_at, timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, commission_amount_minor, billable_unit, billable_unit_count,
      currency, cancellation_policy_snapshot, status, expires_at
    ) VALUES (
      ${organization.id}, ${location.id}, ${customer.id}, ${PAST_START}, ${PAST_END},
      ${PAST_BLOCKED_START}, ${PAST_BLOCKED_END}, 'Europe/Paris', 30, 30,
      10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 'DAY', 2, 'EUR',
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      'CONVERTED', null
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const payment = await sql`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status, amount_minor, currency,
      tax_status, tax_amount_minor, commission_amount_minor, financial_terms_version,
      legal_terms_version, terms_acceptance_snapshot, connected_account_id, charge_model,
      settlement_merchant_mode, environment, succeeded_at
    ) VALUES (
      ${organization.id}, ${draft.id}, ${customer.id}, 'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 500, '1', '1',
      ${sql.json({ version: '1', user_id: customer.id, accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_test_incident', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST', '2026-01-01 12:00:00+00'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await sql`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, tax_status, tax_amount_minor,
      commission_amount_minor, total_amount_minor, cancellation_policy_snapshot,
      terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${organization.id}, ${location.id}, ${customer.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
      ${PAST_START}, ${PAST_END}, ${PAST_BLOCKED_START}, ${PAST_BLOCKED_END},
      'Europe/Paris', 30, 30, 'EUR', 10000, 0, 'NOT_APPLICABLE', 0,
      500, 10000,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: '1', user_id: customer.id, accepted_at: '2026-01-01T00:00:00Z' })},
      '2026-01-01 12:00:00+00'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const line = await sql`
    INSERT INTO booking_lines (
      booking_id, variant_id, quantity, unit_price_amount_minor,
      billable_unit_count, line_total_amount_minor, variant_snapshot
    ) VALUES (${booking.id}, ${variant.id}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING id
  `.then((rows) => rows[0]!);
  const block = await sql`
    INSERT INTO inventory_blocks (
      organization_id, inventory_item_id, type, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
    ) VALUES (
      ${organization.id}, ${item.id}, 'BOOKING', 'ACTIVE',
      ${PAST_START}, ${PAST_END}, ${PAST_BLOCKED_START}, ${PAST_BLOCKED_END}, ${booking.id}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const bookingItem = await sql`
    INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, booking_block_id)
    VALUES (${booking.id}, ${line.id}, ${item.id}, ${block.id})
    RETURNING id
  `.then((rows) => rows[0]!);

  return {
    organizationId: organization.id,
    locationId: location.id,
    customerUserId: customer.id,
    operatorUserId: operator.id,
    variantId: variant.id,
    itemId: item.id,
    bookingId: booking.id,
    bookingItemId: bookingItem.id,
    bookingBlockId: block.id,
    paymentId: payment.id,
  };
}

async function insertCandidate(
  ids: SeedIds,
  sku: string,
  overrides: { locationId?: string; condition?: string; status?: string } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    INSERT INTO inventory_items (
      organization_id, product_variant_id, internal_sku, current_location_id, condition, status
    ) VALUES (
      ${ids.organizationId}, ${ids.variantId}, ${sku}, ${overrides.locationId ?? ids.locationId},
      ${overrides.condition ?? 'GOOD'}, ${overrides.status ?? 'ACTIVE'}
    ) RETURNING id
  `;
  return rows[0]!.id;
}

describe.skipIf(shouldSkipIntegrationTests())(
  '21-U2-AA — incidents de comptoir — intégration PostgreSQL',
  () => {
    it('No-Show : annule, libère les blocs et ne modifie aucun snapshot financier', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBooking();
      const before = await rawSql`
        SELECT total_amount_minor, commission_amount_minor, cancellation_policy_snapshot,
               terms_acceptance_snapshot, payment_id
        FROM bookings WHERE id = ${ids.bookingId}
      `.then((rows) => rows[0]!);
      const key = `no-show-${randomUUID()}`;

      const result = await recordBookingNoShow(db, {
        organizationId: ids.organizationId,
        bookingId: ids.bookingId,
        actorUserId: ids.operatorUserId,
        idempotencyKey: key,
        reason: 'Client absent au départ',
        now: new Date('2026-02-10T09:00:00.000Z'),
      });

      expect(result).toMatchObject({
        kind: 'APPLIED',
        bookingId: ids.bookingId,
        previousStatus: 'CONFIRMED',
        status: 'CANCELLED',
        releasedBlockCount: 1,
      });
      const after = await rawSql`
        SELECT status, total_amount_minor, commission_amount_minor,
               cancellation_policy_snapshot, terms_acceptance_snapshot, payment_id
        FROM bookings WHERE id = ${ids.bookingId}
      `.then((rows) => rows[0]!);
      expect(after.status).toBe('CANCELLED');
      expect(after.total_amount_minor).toBe(before.total_amount_minor);
      expect(after.commission_amount_minor).toBe(before.commission_amount_minor);
      expect(after.cancellation_policy_snapshot).toEqual(before.cancellation_policy_snapshot);
      expect(after.terms_acceptance_snapshot).toEqual(before.terms_acceptance_snapshot);
      expect(after.payment_id).toBe(before.payment_id);

      const block = await rawSql`
        SELECT status FROM inventory_blocks WHERE id = ${ids.bookingBlockId}
      `.then((rows) => rows[0]!);
      expect(block.status).toBe('RELEASED');
      expect(
        await rawSql`SELECT count(*)::int AS count FROM refunds WHERE payment_id = ${ids.paymentId}`.then(
          (rows) => rows[0]!.count,
        ),
      ).toBe(0);
      const audit = await rawSql`
        SELECT action, metadata FROM audit_log WHERE target_id = ${ids.bookingId}
      `.then((rows) => rows[0]!);
      expect(audit.action).toBe('BOOKING_NO_SHOW');
      expect(audit.metadata).toMatchObject({
        eventType: 'NO_SHOW',
        financialSnapshotUntouched: true,
      });
      const outbox = await rawSql`
        SELECT event_type, payload FROM outbox_events
        WHERE aggregate_id = ${ids.bookingId} AND event_type = 'BOOKING_NO_SHOW'
      `.then((rows) => rows[0]!);
      expect(outbox.event_type).toBe('BOOKING_NO_SHOW');
      expect(outbox.payload).toMatchObject({ nextStatus: 'CANCELLED', eventType: 'NO_SHOW' });

      const replay = await recordBookingNoShow(db, {
        organizationId: ids.organizationId,
        bookingId: ids.bookingId,
        actorUserId: ids.operatorUserId,
        idempotencyKey: key,
        reason: 'Client absent au départ',
        now: new Date('2026-02-10T12:00:00.000Z'),
      });
      expect(replay).toEqual(result);
      expect(
        await rawSql`SELECT count(*)::int AS count FROM audit_log WHERE target_id = ${ids.bookingId} AND action = 'BOOKING_NO_SHOW'`.then(
          (rows) => rows[0]!.count,
        ),
      ).toBe(1);
    });

    it('No-Show : refuse avant le départ et laisse la réservation intacte', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBooking();
      const key = `no-show-early-${randomUUID()}`;
      await expect(
        recordBookingNoShow(db, {
          organizationId: ids.organizationId,
          bookingId: ids.bookingId,
          actorUserId: ids.operatorUserId,
          idempotencyKey: key,
          now: new Date('2026-02-10T08:59:59.999Z'),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      expect(
        await rawSql`SELECT status FROM bookings WHERE id = ${ids.bookingId}`.then(
          (r) => r[0]!.status,
        ),
      ).toBe('CONFIRMED');
      expect(
        await rawSql`SELECT status FROM inventory_blocks WHERE id = ${ids.bookingBlockId}`.then(
          (r) => r[0]!.status,
        ),
      ).toBe('ACTIVE');
      expect(
        await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`.then(
          (r) => r[0]!.status,
        ),
      ).toBe('FAILED');
    });

    it('Substitution : garde le bloc, échange booking_items et trace les deux SKU', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBooking();
      const replacementId = await insertCandidate(ids, 'KAY-REPLACEMENT');
      const candidates = await listSubstitutionCandidates(
        db,
        ids.organizationId,
        ids.bookingId,
        ids.bookingItemId,
      );
      expect(candidates.map((candidate) => candidate.internalSku)).toContain('KAY-REPLACEMENT');

      const result = await substituteBookingItem(db, {
        organizationId: ids.organizationId,
        bookingId: ids.bookingId,
        bookingItemId: ids.bookingItemId,
        replacementInventoryItemId: replacementId,
        actorUserId: ids.operatorUserId,
        idempotencyKey: `substitute-${randomUUID()}`,
      });
      expect(result).toMatchObject({
        kind: 'APPLIED',
        bookingId: ids.bookingId,
        bookingItemId: ids.bookingItemId,
        previousInventoryItemId: ids.itemId,
        replacementInventoryItemId: replacementId,
        previousSku: expect.stringMatching(/^KAY-/),
        replacementSku: 'KAY-REPLACEMENT',
      });
      const bookingItem = await rawSql`
        SELECT inventory_item_id FROM booking_items WHERE id = ${ids.bookingItemId}
      `.then((rows) => rows[0]!);
      expect(bookingItem.inventory_item_id).toBe(replacementId);
      const block = await rawSql`
        SELECT inventory_item_id, status FROM inventory_blocks WHERE id = ${ids.bookingBlockId}
      `.then((rows) => rows[0]!);
      expect(block).toMatchObject({ inventory_item_id: replacementId, status: 'ACTIVE' });
      const audit = await rawSql`
        SELECT action, metadata FROM audit_log WHERE target_id = ${ids.bookingItemId}
      `.then((rows) => rows[0]!);
      expect(audit.action).toBe('SUBSTITUTED');
      expect(audit.metadata).toMatchObject({
        previousSku: expect.stringMatching(/^KAY-/),
        replacementSku: 'KAY-REPLACEMENT',
      });
    });

    it('Substitution : refuse un exemplaire qui chevauche le créneau', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBooking();
      const replacementId = await insertCandidate(ids, 'KAY-BLOCKED');
      await rawSql`
        INSERT INTO inventory_blocks (
          organization_id, inventory_item_id, type, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
        ) VALUES (
          ${ids.organizationId}, ${replacementId}, 'MANUAL_BLOCK', 'ACTIVE',
          ${PAST_START}, ${PAST_END}, ${PAST_BLOCKED_START}, ${PAST_BLOCKED_END}, ${randomUUID()}
        )
      `;
      expect(
        await listSubstitutionCandidates(db, ids.organizationId, ids.bookingId, ids.bookingItemId),
      ).toEqual([]);
      await expect(
        substituteBookingItem(db, {
          organizationId: ids.organizationId,
          bookingId: ids.bookingId,
          bookingItemId: ids.bookingItemId,
          replacementInventoryItemId: replacementId,
          actorUserId: ids.operatorUserId,
          idempotencyKey: `substitute-blocked-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      expect(
        await rawSql`SELECT inventory_item_id FROM booking_items WHERE id = ${ids.bookingItemId}`.then(
          (r) => r[0]!.inventory_item_id,
        ),
      ).toBe(ids.itemId);
    });

    it('Substitution : refuse une autre organisation sans mutation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBooking();
      const other = await seedBooking('other');
      await expect(
        substituteBookingItem(db, {
          organizationId: ids.organizationId,
          bookingId: ids.bookingId,
          bookingItemId: ids.bookingItemId,
          replacementInventoryItemId: other.itemId,
          actorUserId: ids.operatorUserId,
          idempotencyKey: `substitute-cross-${randomUUID()}`,
        }),
      ).rejects.toBeInstanceOf(FulfillmentError);
      expect(
        await rawSql`SELECT inventory_item_id FROM booking_items WHERE id = ${ids.bookingItemId}`.then(
          (r) => r[0]!.inventory_item_id,
        ),
      ).toBe(ids.itemId);
    });
  },
);
