import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  createDatabase,
  runMigrations,
  assertLocalhost,
  type DatabaseClient,
} from '@uttily/database';
import { createSupplementBookingAmendment } from './create-supplement-booking-amendment';
import { SupplementAmendmentError } from './types-amendment';
import type { AuthenticatedUser } from '../identity/types';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = 'uttily_test_g7m_c1';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

let db: DatabaseClient | null = null;
let sql: postgres.Sql | null = null;
let testUrl: string | null = null;

interface Fixture {
  orgId: string;
  userId: string;
  actor: AuthenticatedUser;
  bookingId: string;
  productId: string;
  locationId: string;
  variantId: string;
  logicalLineId: string;
  itemId: string;
  availableItemIds: string[];
  paymentId: string;
  bookingBlockId: string;
}

async function seedFixture(
  client: postgres.Sql,
  suffix: string,
  dailyPriceAmountMinor = 5000,
  coverDayRangeOpening = false,
  additionalItemCount = 0,
): Promise<Fixture> {
  const org = await client`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'C1 Org ' + suffix}, ${'c1-org-' + suffix}) RETURNING id
  `.then((rows) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Annecy', ${'c1-location-' + suffix}, 'UTC', 'EUR') RETURNING id
  `.then((rows) => rows[0]!);
  const user = await client`
    INSERT INTO users (email) VALUES (${'c1-' + suffix + '@example.com'}) RETURNING id, email
  `.then((rows) => rows[0]!);
  await client`
    INSERT INTO organization_memberships (organization_id, user_id, role, status)
    VALUES (${org.id}, ${user.id}, 'OWNER', 'ACTIVE')
  `;
  const category = await client`SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1`.then(
    (rows) => rows[0]!,
  );
  const product = await client`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${org.id}, ${category.id}, 'C1 Product', ${'c1-product-' + suffix}, 'DRAFT') RETURNING id
  `.then((rows) => rows[0]!);
  for (let index = 0; index < 3; index++) {
    await client`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key, content_type, byte_size,
        width_px, height_px, checksum_sha256, sort_order, file_state
      ) VALUES (
        ${org.id}, ${product.id}, ${'product-photos/c1-' + suffix + '-' + index},
        'image/jpeg', 1000, 800, 600, ${String(index).repeat(64)}, ${index}, 'AVAILABLE'
      )
    `;
  }
  await client`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${product.id}`;
  const variant = await client`
    INSERT INTO product_variants (product_id, name, daily_price_amount_minor, currency)
    VALUES (${product.id}, 'Standard', 5000, 'EUR') RETURNING id
  `.then((rows) => rows[0]!);
  const item = await client`
    INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id)
    VALUES (${org.id}, ${variant.id}, ${'C1-SKU-' + suffix}, ${location.id}) RETURNING id
  `.then((rows) => rows[0]!);
  const availableItemIds = [item.id as string];
  for (let index = 0; index < additionalItemCount; index++) {
    const extraItem = await client`
      INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id)
      VALUES (${org.id}, ${variant.id}, ${'C1-SKU-' + suffix + '-extra-' + index}, ${location.id}) RETURNING id
    `.then((rows) => rows[0]!);
    availableItemIds.push(extraItem.id as string);
  }
  const plan = await client`
    INSERT INTO pricing_plans (organization_id, product_variant_id, location_id, plan_type, currency, price_amount_minor, lifecycle_state, version)
    VALUES (${org.id}, ${variant.id}, ${location.id}, 'DAILY', 'EUR', ${dailyPriceAmountMinor}, 'DRAFT', 1) RETURNING id
  `.then((rows) => rows[0]!);
  await client`
    INSERT INTO pricing_plan_windows (pricing_plan_id, location_id, weekday_mask, start_time, end_time)
    VALUES (${plan.id}, ${location.id}, 127, '00:00:00', '23:59:59')
  `;
  await client`
    INSERT INTO pricing_plan_translations (pricing_plan_id, locale, public_label)
    VALUES (${plan.id}, 'fr', 'C1'), (${plan.id}, 'en', 'C1')
  `;
  await client`UPDATE pricing_plans SET lifecycle_state = 'ACTIVE' WHERE id = ${plan.id}`;

  const draft = await client`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, timezone,
      prep_buffer_minutes, cleanup_buffer_minutes, currency, subtotal_amount_minor,
      mandatory_fees_amount_minor, total_amount_minor, tax_status, tax_amount_minor,
      commission_amount_minor, billable_unit, billable_unit_count, cancellation_policy_snapshot
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, 'DRAFT',
      '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
      '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', 'UTC',
      30, 30, 'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0,
      500, 'DAY', 2, ${client.json({ code: 'C1' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  await client`UPDATE booking_drafts SET status = 'HELD', expires_at = now() + interval '10 minutes' WHERE id = ${draft.id}`;
  const draftLine = await client`
    INSERT INTO booking_draft_lines (draft_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
    VALUES (${draft.id}, ${variant.id}, 1, 5000, 2, 10000, ${client.json({ name: 'Standard' })}) RETURNING id
  `.then((rows) => rows[0]!);
  const hold = await client`
    INSERT INTO inventory_blocks (
      organization_id, inventory_item_id, type, status, customer_start_at, customer_end_at,
      blocked_start_at, blocked_end_at, expires_at, source_id
    ) VALUES (
      ${org.id}, ${item.id}, 'HOLD', 'ACTIVE', '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
      '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', now() + interval '10 minutes', ${draft.id}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  await client`INSERT INTO allocations (draft_line_id, inventory_block_id) VALUES (${draftLine.id}, ${hold.id})`;
  await client`UPDATE inventory_blocks SET status = 'RELEASED' WHERE id = ${hold.id}`;
  const payment = await client`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status, amount_minor, currency,
      tax_status, tax_amount_minor, commission_amount_minor, financial_terms_version,
      legal_terms_version, terms_acceptance_snapshot, connected_account_id,
      charge_model, settlement_merchant_mode, environment, succeeded_at
    ) VALUES (
      ${org.id}, ${draft.id}, ${user.id}, 'SUCCEEDED', 10000, 'EUR', 'NOT_APPLICABLE', 0, 500,
      'v1', 'v1', ${client.json({ accepted: true })}, 'acct_c1', 'DESTINATION',
      'CONNECTED_ACCOUNT', 'TEST', now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await client`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, timezone,
      prep_buffer_minutes, cleanup_buffer_minutes, currency, subtotal_amount_minor,
      mandatory_fees_amount_minor, total_amount_minor, tax_status, tax_amount_minor,
      commission_amount_minor, billable_unit, billable_unit_count, cancellation_policy_snapshot,
      terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
      '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00', '2026-03-10 08:30:00+00',
      '2026-03-12 17:30:00+00', 'UTC', 30, 30, 'EUR', 10000, 0, 10000,
      'NOT_APPLICABLE', 0, 500, 'DAY', 2, ${client.json({ code: 'C1' })},
      ${client.json({ accepted: true })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const line = await client`
    INSERT INTO booking_lines (booking_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count, line_total_amount_minor, variant_snapshot)
    VALUES (${booking.id}, ${variant.id}, 1, 5000, 2, 10000, ${client.json({ name: 'Standard' })}) RETURNING id
  `.then((rows) => rows[0]!);
  const bookingBlockedStartAt = coverDayRangeOpening
    ? '2026-03-09 23:00:00+00'
    : '2026-03-10 08:30:00+00';
  const block = await client`
    INSERT INTO inventory_blocks (
      organization_id, inventory_item_id, type, status, customer_start_at, customer_end_at,
      blocked_start_at, blocked_end_at, source_id
    ) VALUES (
      ${org.id}, ${item.id}, 'BOOKING', 'ACTIVE', '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
      ${bookingBlockedStartAt}, '2026-03-12 17:30:00+00', ${booking.id}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  await client`
    INSERT INTO booking_items (booking_id, booking_line_id, inventory_item_id, source_hold_block_id, booking_block_id)
    VALUES (${booking.id}, ${line.id}, ${item.id}, ${hold.id}, ${block.id})
  `;
  return {
    orgId: org.id,
    userId: user.id,
    actor: {
      id: user.id,
      oidcSubject: 'c1_' + user.id,
      email: user.email,
      emailVerified: true,
      isPlatformAdmin: false,
    },
    bookingId: booking.id,
    productId: product.id,
    locationId: location.id,
    variantId: variant.id,
    logicalLineId: line.id,
    itemId: item.id,
    availableItemIds,
    paymentId: payment.id,
    bookingBlockId: block.id,
  };
}

describe.skipIf(shouldSkip)('createSupplementBookingAmendment — PostgreSQL réel', () => {
  beforeAll(async () => {
    if (!sourceUrl) return;
    assertLocalhost(sourceUrl);
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
    await admin.end();
    const parsed = new URL(sourceUrl);
    parsed.pathname = `/${testDatabase}`;
    testUrl = parsed.toString();
    await runMigrations(testUrl);
    db = createDatabase(testUrl);
    sql = postgres(testUrl, { max: 10 });
  }, 600000);

  afterAll(async () => {
    await db?.$client.end();
    await sql?.end();
    if (!sourceUrl || !testUrl) return;
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.end();
  });

  it('persiste atomiquement le supplément, les holds delta, payment/attempt et outbox', async () => {
    const fixture = await seedFixture(sql!, 'happy');
    const now = new Date('2026-03-01T10:00:00.000Z');
    const result = await createSupplementBookingAmendment(
      db!,
      fixture.actor,
      fixture.orgId,
      {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
        ],
        idempotencyKey: 'c1-happy',
      },
      { now },
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    expect(result.supplementAmountMinor).toBe(5000);
    expect(result.holdDeadline).toBe('2026-03-01T10:10:00.000Z');

    const amendment = await sql!`SELECT * FROM booking_amendments WHERE id = ${result.amendmentId}`;
    const lines = await sql!`
      SELECT logical_line_id, action, before_quantity, after_quantity,
        before_line_total_amount_minor, after_line_total_amount_minor,
        pricing_snapshot, variant_snapshot
      FROM booking_amendment_lines
      WHERE amendment_id = ${result.amendmentId}
    `;
    const allocations = await sql!`
      SELECT a.status, a.action, a.inventory_item_id, l.logical_line_id
      FROM booking_amendment_allocations a
      JOIN booking_amendment_lines l ON l.id = a.amendment_line_id
      WHERE a.amendment_id = ${result.amendmentId}
      ORDER BY a.inventory_item_id
    `;
    const payment =
      await sql!`SELECT * FROM amendment_payments WHERE id = ${result.amendmentPaymentId}`;
    const attempt =
      await sql!`SELECT * FROM amendment_payment_attempts WHERE id = ${result.amendmentPaymentAttemptId}`;
    const segments =
      await sql!`SELECT s.*, s.status AS segment_status, b.type, b.status AS block_status, b.expires_at FROM booking_amendment_segments s JOIN inventory_blocks b ON b.id = s.hold_block_id WHERE s.organization_id = ${fixture.orgId}`;
    const outbox =
      await sql!`SELECT organization_id, aggregate_type, aggregate_id, event_type, event_version, payload, idempotency_key FROM outbox_events WHERE idempotency_key = ${'booking_amendment_requested_' + result.amendmentId}`;
    expect(amendment[0]).toMatchObject({ type: 'SUPPLEMENT', status: 'HOLD_PENDING' });
    expect(new Date(amendment[0]!.hold_deadline as string).toISOString()).toBe(result.holdDeadline);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      logical_line_id: fixture.logicalLineId,
      action: 'MODIFY',
      before_quantity: 1,
      after_quantity: 1,
      before_line_total_amount_minor: '10000',
      after_line_total_amount_minor: '15000',
    });
    expect(lines[0]!.pricing_snapshot).toMatchObject({
      intentSnapshot: {
        kind: 'DAY_RANGE',
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-13',
      },
      billedDays: 3,
    });
    expect(lines[0]!.variant_snapshot).toMatchObject({
      productName: 'C1 Product',
      variantName: 'Standard',
    });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      status: 'PROPOSED',
      action: 'REPLACE',
      inventory_item_id: fixture.itemId,
      logical_line_id: fixture.logicalLineId,
    });
    expect(payment[0]).toMatchObject({
      organization_id: fixture.orgId,
      booking_id: fixture.bookingId,
      amendment_id: result.amendmentId,
      amount_minor: '5000',
      status: 'PENDING_PROVIDER',
      environment: 'TEST',
      currency: 'EUR',
      connected_account_id: 'acct_c1',
      charge_model: 'DESTINATION',
      settlement_merchant_mode: 'CONNECTED_ACCOUNT',
    });
    expect(attempt[0]).toMatchObject({
      organization_id: fixture.orgId,
      amendment_payment_id: result.amendmentPaymentId,
      attempt_number: 1,
      status: 'PENDING_PROVIDER',
      provider_idempotency_key: `pi_amendment_${result.amendmentPaymentId}_1`,
    });
    expect(segments).toHaveLength(2);
    expect(
      segments.map((segment) => [
        (segment.delta_start_at as Date).toISOString(),
        (segment.delta_end_at as Date).toISOString(),
      ]),
    ).toEqual([
      ['2026-03-09T23:30:00.000Z', '2026-03-10T08:30:00.000Z'],
      ['2026-03-12T17:30:00.000Z', '2026-03-13T00:29:59.000Z'],
    ]);
    for (const segment of segments) {
      expect(segment).toMatchObject({
        segment_status: 'PROPOSED',
        type: 'HOLD',
        block_status: 'ACTIVE',
      });
      expect(new Date(segment.expires_at as string).toISOString()).toBe(result.holdDeadline);
    }
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      organization_id: fixture.orgId,
      aggregate_type: 'BOOKING',
      aggregate_id: fixture.bookingId,
      event_type: 'BOOKING_AMENDMENT_REQUESTED',
      event_version: 'v1',
      idempotency_key: `booking_amendment_requested_${result.amendmentId}`,
    });
    expect(outbox[0]!.payload).toEqual({
      organizationId: fixture.orgId,
      bookingId: fixture.bookingId,
      amendmentId: result.amendmentId,
    });
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendments WHERE booking_id = ${fixture.bookingId}`
      )[0]!.count,
    ).toBe(1);

    const replay = await createSupplementBookingAmendment(
      db!,
      fixture.actor,
      fixture.orgId,
      {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
        ],
        idempotencyKey: 'c1-happy',
      },
      { now: new Date('2026-03-01T11:00:00.000Z') },
    );
    expect(replay).toMatchObject({
      kind: 'REPLAY',
      amendmentId: result.amendmentId,
      amendmentPaymentId: result.amendmentPaymentId,
    });
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM amendment_payments WHERE amendment_id = ${result.amendmentId}`
      )[0]!.count,
    ).toBe(1);
    const replayCounts = await sql!`
      SELECT
        (SELECT count(*)::int FROM booking_amendments WHERE booking_id = ${fixture.bookingId}) AS amendments,
        (SELECT count(*)::int FROM booking_amendment_lines WHERE amendment_id = ${result.amendmentId}) AS lines,
        (SELECT count(*)::int FROM booking_amendment_allocations WHERE amendment_id = ${result.amendmentId}) AS allocations,
        (SELECT count(*)::int FROM booking_amendment_segments WHERE allocation_id IN (SELECT id FROM booking_amendment_allocations WHERE amendment_id = ${result.amendmentId})) AS segments,
        (SELECT count(*)::int FROM inventory_blocks WHERE source_id = ${result.amendmentId}) AS holds,
        (SELECT count(*)::int FROM amendment_payments WHERE amendment_id = ${result.amendmentId}) AS payments,
        (SELECT count(*)::int FROM amendment_payment_attempts WHERE amendment_payment_id = ${result.amendmentPaymentId}) AS attempts,
        (SELECT count(*)::int FROM outbox_events WHERE idempotency_key = ${'booking_amendment_requested_' + result.amendmentId}) AS outbox
    `;
    expect(replayCounts[0]).toEqual({
      amendments: 1,
      lines: 1,
      allocations: 1,
      segments: 2,
      holds: 2,
      payments: 1,
      attempts: 1,
      outbox: 1,
    });
  });

  it('reste isolé par organisation et ne persiste aucun appel provider', async () => {
    const fixture = await seedFixture(sql!, 'tenant');
    const other = await seedFixture(sql!, 'other');
    const result = await createSupplementBookingAmendment(db!, other.actor, other.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
      desiredLines: [{ variantId: fixture.variantId, quantity: 1 }],
      idempotencyKey: 'c1-cross-tenant',
    });
    expect(result).toEqual({ kind: 'NOT_FOUND' });
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendments WHERE booking_id = ${fixture.bookingId}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM amendment_payment_attempts WHERE organization_id = ${other.orgId}`
      )[0]!.count,
    ).toBe(0);
  });

  it('lève SupplementAmendmentError si le bloc source est introuvable', async () => {
    const fixture = await seedFixture(sql!, 'missing-source');
    await sql!`
      UPDATE inventory_blocks
      SET status = 'RELEASED'
      WHERE id = ${fixture.bookingBlockId}
    `;

    await expect(
      createSupplementBookingAmendment(
        db!,
        fixture.actor,
        fixture.orgId,
        {
          bookingId: fixture.bookingId,
          expectedLastAppliedAmendmentNumber: 0,
          intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
          desiredLines: [
            { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
          ],
          idempotencyKey: 'c1-missing-source',
        },
        { now: new Date('2026-03-01T11:30:00.000Z') },
      ),
    ).rejects.toBeInstanceOf(SupplementAmendmentError);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendments WHERE booking_id = ${fixture.bookingId}`
      )[0]!.count,
    ).toBe(0);
  });

  it('refuse les classifications NEUTRAL/REFUND et les snapshots effectifs périmés', async () => {
    const fixture = await seedFixture(sql!, 'classifications');
    const neutral = await createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-12' },
      desiredLines: [
        { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
      ],
      idempotencyKey: 'c1-neutral-rejected',
    });
    expect(neutral).toEqual({
      kind: 'FINANCIAL_ACTION_REQUIRED',
      classification: 'NEUTRAL',
      deltaMinor: 0,
    });

    const refund = await createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-11' },
      desiredLines: [
        { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
      ],
      idempotencyKey: 'c1-refund-rejected',
    });
    expect(refund).toEqual({
      kind: 'FINANCIAL_ACTION_REQUIRED',
      classification: 'REFUND',
      deltaMinor: 5000,
    });

    const stale = await createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 1,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
      desiredLines: [
        { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
      ],
      idempotencyKey: 'c1-stale',
    });
    expect(stale).toEqual({ kind: 'STALE_EFFECTIVE_BOOKING', expected: 1, actual: 0 });
  });

  it('accepte un supplément financier sans créer de hold lorsque la période physique ne change pas', async () => {
    const fixture = await seedFixture(sql!, 'repriced', 6000, true);

    const result = await createSupplementBookingAmendment(
      db!,
      fixture.actor,
      fixture.orgId,
      {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-12' },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
        ],
        idempotencyKey: 'c1-repriced',
      },
      { now: new Date('2026-03-01T12:00:00.000Z') },
    );

    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    expect(result.supplementAmountMinor).toBe(2000);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM inventory_blocks WHERE source_id = ${result.amendmentId}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendment_segments WHERE allocation_id IN (SELECT id FROM booking_amendment_allocations WHERE amendment_id = ${result.amendmentId})`
      )[0]!.count,
    ).toBe(0);
  });

  it('ajoute la quantité avec des items déterministes et des holds sur la plage complète', async () => {
    const fixture = await seedFixture(sql!, 'quantity', 5000, false, 2);
    const result = await createSupplementBookingAmendment(
      db!,
      fixture.actor,
      fixture.orgId,
      {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 3 },
        ],
        idempotencyKey: 'c1-quantity',
      },
      { now: new Date('2026-03-01T12:30:00.000Z') },
    );
    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;

    const allocations = await sql!`
      SELECT a.action, a.inventory_item_id
      FROM booking_amendment_allocations a
      WHERE a.amendment_id = ${result.amendmentId}
      ORDER BY a.inventory_item_id
    `;
    expect(allocations).toHaveLength(3);
    expect(allocations.filter((row) => row.action === 'REPLACE')).toEqual([
      { action: 'REPLACE', inventory_item_id: fixture.itemId },
    ]);
    expect(
      allocations.filter((row) => row.action === 'ADD').map((row) => row.inventory_item_id),
    ).toEqual(fixture.availableItemIds.slice(1).sort());

    const addedSegments = await sql!`
      SELECT s.delta_start_at, s.delta_end_at
      FROM booking_amendment_segments s
      JOIN booking_amendment_allocations a ON a.id = s.allocation_id
      WHERE a.amendment_id = ${result.amendmentId} AND a.action = 'ADD'
      ORDER BY a.inventory_item_id
    `;
    expect(addedSegments).toHaveLength(2);
    expect(
      addedSegments.map((segment) => ({
        delta_start_at: (segment.delta_start_at as Date).toISOString(),
        delta_end_at: (segment.delta_end_at as Date).toISOString(),
      })),
    ).toEqual([
      { delta_start_at: '2026-03-09T23:30:00.000Z', delta_end_at: '2026-03-13T00:29:59.000Z' },
      { delta_start_at: '2026-03-09T23:30:00.000Z', delta_end_at: '2026-03-13T00:29:59.000Z' },
    ]);
  });

  it('déplace partiellement une allocation et ne crée qu’un segment hors de l’ancien bloc', async () => {
    const fixture = await seedFixture(sql!, 'partial-move', 6000);
    const result = await createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-11', endDateExclusive: '2026-03-14' },
      desiredLines: [
        { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
      ],
      idempotencyKey: 'c1-partial-move',
    });
    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    const allocation = await sql!`
      SELECT action, inventory_item_id
      FROM booking_amendment_allocations
      WHERE amendment_id = ${result.amendmentId}
    `;
    expect(allocation).toEqual([{ action: 'REPLACE', inventory_item_id: fixture.itemId }]);
    const segments = await sql!`
      SELECT delta_start_at, delta_end_at
      FROM booking_amendment_segments
      WHERE allocation_id IN (SELECT id FROM booking_amendment_allocations WHERE amendment_id = ${result.amendmentId})
    `;
    expect(
      segments.map((segment) => ({
        delta_start_at: (segment.delta_start_at as Date).toISOString(),
        delta_end_at: (segment.delta_end_at as Date).toISOString(),
      })),
    ).toEqual([
      { delta_start_at: '2026-03-12T17:30:00.000Z', delta_end_at: '2026-03-14T00:29:59.000Z' },
    ]);
  });

  it('retire l’ancien item sans hold et ajoute le nouvel item sur la plage complète', async () => {
    const fixture = await seedFixture(sql!, 'remove-add');
    const alternateVariant = await sql!`
      INSERT INTO product_variants (product_id, name, daily_price_amount_minor, currency)
      VALUES (${fixture.productId}, 'Alternate', 6000, 'EUR') RETURNING id
    `.then((rows) => rows[0]!);
    const alternateItem = await sql!`
      INSERT INTO inventory_items (organization_id, product_variant_id, internal_sku, current_location_id)
      SELECT organization_id, ${alternateVariant.id}, ${'C1-ALT-SKU-remove-add'}, ${fixture.locationId}
      FROM inventory_items WHERE id = ${fixture.itemId}
      RETURNING id
    `.then((rows) => rows[0]!);
    const alternatePlan = await sql!`
      INSERT INTO pricing_plans (organization_id, product_variant_id, location_id, plan_type, currency, price_amount_minor, lifecycle_state, version)
      SELECT organization_id, ${alternateVariant.id}, ${fixture.locationId}, 'DAILY', 'EUR', 6000, 'DRAFT', 1
      FROM inventory_items WHERE id = ${fixture.itemId}
      RETURNING id
    `.then((rows) => rows[0]!);
    await sql!`
      INSERT INTO pricing_plan_windows (pricing_plan_id, location_id, weekday_mask, start_time, end_time)
      VALUES (${alternatePlan.id}, ${fixture.locationId}, 127, '00:00:00', '23:59:59')
    `;
    await sql!`
      INSERT INTO pricing_plan_translations (pricing_plan_id, locale, public_label)
      VALUES (${alternatePlan.id}, 'fr', 'Alternate'), (${alternatePlan.id}, 'en', 'Alternate')
    `;
    await sql!`UPDATE pricing_plans SET lifecycle_state = 'ACTIVE' WHERE id = ${alternatePlan.id}`;

    const result = await createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
      bookingId: fixture.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-12' },
      desiredLines: [{ variantId: alternateVariant.id, quantity: 1 }],
      idempotencyKey: 'c1-remove-add',
    });
    expect(result.kind).toBe('SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    expect(result.supplementAmountMinor).toBe(2000);
    const allocations = await sql!`
      SELECT action, inventory_item_id
      FROM booking_amendment_allocations
      WHERE amendment_id = ${result.amendmentId}
      ORDER BY action, inventory_item_id
    `;
    expect(allocations).toEqual([
      { action: 'ADD', inventory_item_id: alternateItem.id },
      { action: 'REMOVE', inventory_item_id: fixture.itemId },
    ]);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendment_segments s JOIN booking_amendment_allocations a ON a.id = s.allocation_id WHERE a.amendment_id = ${result.amendmentId} AND a.action = 'REMOVE'`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendment_segments s JOIN booking_amendment_allocations a ON a.id = s.allocation_id WHERE a.amendment_id = ${result.amendmentId} AND a.action = 'ADD'`
      )[0]!.count,
    ).toBe(1);
  });

  it('rollback atomique sur conflit externe ne laisse aucun amendment, hold, payment, attempt ou outbox', async () => {
    const fixture = await seedFixture(sql!, 'rollback');
    await sql!`
      INSERT INTO inventory_blocks (
        organization_id, inventory_item_id, type, status, customer_start_at, customer_end_at,
        blocked_start_at, blocked_end_at, source_id
      ) VALUES (
        ${fixture.orgId}, ${fixture.itemId}, 'BOOKING', 'ACTIVE',
        '2026-03-12 18:00:00+00', '2026-03-13 17:00:00+00',
        '2026-03-12 17:30:00+00', '2026-03-13 17:30:00+00', ${randomUUID()}
      )
    `;

    const result = await createSupplementBookingAmendment(
      db!,
      fixture.actor,
      fixture.orgId,
      {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'DAY_RANGE', startDate: '2026-03-10', endDateExclusive: '2026-03-13' },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
        ],
        idempotencyKey: 'c1-rollback',
      },
      { now: new Date('2026-03-01T13:00:00.000Z') },
    );

    expect(result.kind).toBe('AVAILABILITY_CONFLICT');
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM booking_amendments WHERE booking_id = ${fixture.bookingId}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM amendment_payments WHERE booking_id = ${fixture.bookingId}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM amendment_payment_attempts WHERE organization_id = ${fixture.orgId}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM outbox_events WHERE organization_id = ${fixture.orgId} AND event_type = 'BOOKING_AMENDMENT_REQUESTED'`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await sql!`SELECT count(*)::int AS count FROM inventory_blocks WHERE organization_id = ${fixture.orgId} AND type = 'HOLD' AND status = 'ACTIVE'`
      )[0]!.count,
    ).toBe(0);
  });

  it('sérialise deux créations concurrentes et ne conserve qu’un seul amendment', async () => {
    const fixture = await seedFixture(sql!, 'concurrent');
    const db2 = createDatabase(testUrl!);
    try {
      const command = {
        bookingId: fixture.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-03-10',
          endDateExclusive: '2026-03-13',
        },
        desiredLines: [
          { logicalLineId: fixture.logicalLineId, variantId: fixture.variantId, quantity: 1 },
        ],
      };
      const [first, second] = await Promise.all([
        createSupplementBookingAmendment(db!, fixture.actor, fixture.orgId, {
          ...command,
          idempotencyKey: 'c1-concurrent-a',
        }),
        createSupplementBookingAmendment(db2, fixture.actor, fixture.orgId, {
          ...command,
          idempotencyKey: 'c1-concurrent-b',
        }),
      ]);

      expect([first.kind, second.kind].sort()).toEqual(['ACTIVE_AMENDMENT_EXISTS', 'SUCCESS']);
      expect(
        (
          await sql!`SELECT count(*)::int AS count FROM booking_amendments WHERE booking_id = ${fixture.bookingId}`
        )[0]!.count,
      ).toBe(1);
    } finally {
      await db2.$client.end();
    }
  });
});
