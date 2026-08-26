import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  runMigrations,
  createDatabase,
  assertLocalhost,
  type DatabaseClient,
} from '@uttily/database';
import { createRefundBookingAmendment } from './create-refund-booking-amendment';
import { getEffectiveBooking } from './get-effective-booking';
import type { AuthenticatedUser } from '../identity/types';
import { parseBookingAmendedV1Event, parseRefundRequestedV1Event } from '@uttily/contracts';

const TEST_DB_NAME = 'uttily_test_g7m_b2b1_refund';
const shouldSkip = !process.env.DATABASE_URL && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)('createRefundBookingAmendment — intégration PostgreSQL', () => {
  let db: DatabaseClient | null = null;
  let rawSql: postgres.Sql | null = null;

  beforeAll(async () => {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('CI: DATABASE_URL est requise pour le test refund.');
    assertLocalhost(url);

    const adminSql = postgres(url, { max: 1 });
    try {
      await adminSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
      );
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
      await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
    } finally {
      await adminSql.end();
    }

    const testDbUrl = url.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
    await runMigrations(testDbUrl);
    rawSql = postgres(testDbUrl, { max: 10 });
    db = createDatabase(testDbUrl);
  });

  afterAll(async () => {
    if (rawSql) {
      await rawSql.end();
    }
  });

  interface BaseIds {
    orgId: string;
    locationId: string;
    userId: string;
    managerId: string;
    staffId: string;
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

  async function seedBaseData(suffix?: string): Promise<BaseIds> {
    if (!rawSql) throw new Error('rawSql non initialisé');
    const baseSuffix = suffix ?? '';
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const rawFullSuffix = baseSuffix + randomSuffix;
    const fullSuffix = rawFullSuffix.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const org = await rawSql`
      INSERT INTO "organizations" ("legal_name", "slug")
      VALUES (${'Test Org ' + fullSuffix}, ${'org-' + fullSuffix})
      RETURNING "id"
    `.then((r) => r[0]!);

    const location = await rawSql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
      VALUES (${org.id}, 'Annecy', ${'annecy-' + fullSuffix}, 'Europe/Paris', 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);

    const user = await rawSql`
      INSERT INTO "users" ("email")
      VALUES (${'customer-' + fullSuffix + '@example.com'})
      RETURNING "id"
    `.then((r) => r[0]!);

    const manager = await rawSql`
      INSERT INTO "users" ("email")
      VALUES (${'mgr-' + fullSuffix + '@example.com'})
      RETURNING "id"
    `.then((r) => r[0]!);

    const staff = await rawSql`
      INSERT INTO "users" ("email")
      VALUES (${'staff-' + fullSuffix + '@example.com'})
      RETURNING "id"
    `.then((r) => r[0]!);

    await rawSql`
      INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
      VALUES (${org.id}, ${manager.id}, 'MANAGER', 'ACTIVE'),
             (${org.id}, ${staff.id}, 'STAFF', 'ACTIVE')
    `;

    const category =
      await rawSql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
        (r) => r[0]!,
      );

    const productId = await seedPublishedProduct(
      rawSql,
      org.id,
      category.id,
      'Kayak',
      'kayak-' + fullSuffix,
    );

    const variant = await rawSql`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${productId}, 'Standard', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);

    const item = await rawSql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + fullSuffix}, ${location.id})
      RETURNING "id"
    `.then((r) => r[0]!);

    await seedActiveDailyPricingPlan(rawSql, org.id, variant.id, location.id, 5000);

    return {
      orgId: org.id,
      locationId: location.id,
      userId: user.id,
      managerId: manager.id,
      staffId: staff.id,
      variantId: variant.id,
      itemId: item.id,
    };
  }

  interface BookingWithItemIds {
    bookingId: string;
    bookingLineId: string;
    bookingItemIds: string[];
    blockIds: string[];
    inventoryItemIds: string[];
    paymentId: string;
  }

  async function seedBookingWithItem(
    ids: BaseIds,
    opts?: { qty?: number; unitPrice?: number; monthOffset?: number },
  ): Promise<BookingWithItemIds> {
    if (!rawSql) throw new Error('rawSql non initialisé');
    const qty = opts?.qty ?? 1;
    const unitPrice = opts?.unitPrice ?? 5000;
    const lineTotal = qty * unitPrice * 2; // 2 billed days
    const month = String(opts?.monthOffset ?? 3).padStart(2, '0');

    const inventoryItemIds: string[] = [ids.itemId];
    for (let i = 1; i < qty; i++) {
      const itemExtra = await rawSql`
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

    const draft = await rawSql`
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
        ${draftPayload.currency}, ${rawSql.json(draftPayload.cancellation_policy_snapshot)}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    await rawSql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;

    const draftLine = await rawSql`
      INSERT INTO "booking_draft_lines" (
        "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
        "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
      )
      VALUES (${draft.id}, ${ids.variantId}, ${qty}, ${unitPrice}, 2, ${lineTotal}, ${rawSql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);

    const holdBlockIds: string[] = [];
    for (let i = 0; i < qty; i++) {
      const currentItemId = inventoryItemIds[i]!;
      const holdBlock = await rawSql`
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

      await rawSql`
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

    const payment = await rawSql`
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
        ${rawSql.json(paymentPayload.terms_acceptance_snapshot)},
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

    const booking = await rawSql`
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
        'DAY', 2, ${rawSql.json(draftPayload.cancellation_policy_snapshot)}, ${rawSql.json(termsAcceptanceSnapshot)}, now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const bookingLine = await rawSql`
      INSERT INTO "booking_lines" (
        "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
        "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
      )
      VALUES (${booking.id}, ${ids.variantId}, ${qty}, ${unitPrice}, 2, ${lineTotal}, ${rawSql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);

    const bookingBlockIds: string[] = [];
    const bookingItemIds: string[] = [];

    for (let i = 0; i < qty; i++) {
      const currentItemId = inventoryItemIds[i]!;
      const holdBlockId = holdBlockIds[i]!;
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${holdBlockId}`;

      const bookingBlock = await rawSql`
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

      const bookingItem = await rawSql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${bookingLine.id}, ${currentItemId}, ${bookingBlock.id})
        RETURNING "id"
      `.then((r) => r[0]!);

      bookingBlockIds.push(bookingBlock.id);
      bookingItemIds.push(bookingItem.id);
    }

    return {
      bookingId: booking.id,
      bookingLineId: bookingLine.id,
      bookingItemIds,
      blockIds: bookingBlockIds,
      inventoryItemIds,
      paymentId: payment.id,
    };
  }

  function makeActor(userId: string): AuthenticatedUser {
    return {
      id: userId,
      oidcSubject: `sub-${userId}`,
      email: `user-${userId}@example.com`,
      emailVerified: true,
      isPlatformAdmin: false,
    };
  }

  it('1. Vrai REFUND appliqué atomiquement avec allocations physiques, refund PENDING et provider key conforme ADR-023 §10.2', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 2, unitPrice: 5000 }); // total = 20000 cents (200 €)

    const actor = makeActor(ids.managerId);
    const cmd = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [
        {
          logicalLineId: b.bookingLineId,
          variantId: ids.variantId,
          quantity: 1, // Réduction de 2 à 1 exemplaire -> nouveau total 10000 (100 €) -> delta -10000 (refund 100 €)
        },
      ],
      idempotencyKey: `refund_test_key_1_${Math.random().toString(36).slice(2, 8)}`,
    };

    const res = await createRefundBookingAmendment(db, actor, ids.orgId, cmd);

    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    expect(res.amendmentNumber).toBe(1);
    expect(res.refundAmountMinor).toBe(10000);
    expect(res.refundId).toBeDefined();

    // Vérifier la table booking_amendments
    const amendRows = await rawSql`SELECT * FROM booking_amendments WHERE id = ${res.amendmentId}`;
    expect(amendRows).toHaveLength(1);
    expect(amendRows[0]!['type']).toBe('REFUND');
    expect(amendRows[0]!['status']).toBe('APPLIED');

    // Vérifier la table refunds
    const refundRows = await rawSql`SELECT * FROM refunds WHERE id = ${res.refundId}`;
    expect(refundRows).toHaveLength(1);
    const refundRow = refundRows[0]!;
    expect(refundRow['organization_id']).toBe(ids.orgId);
    expect(refundRow['payment_id']).toBe(b.paymentId);
    expect(refundRow['amendment_payment_id']).toBeNull();
    expect(refundRow['reason']).toBe('BOOKING_MODIFICATION');
    expect(refundRow['status']).toBe('PENDING');
    expect(Number(refundRow['amount_minor'])).toBe(10000);
    expect(refundRow['currency']).toBe('EUR');
    expect(refundRow['reverse_transfer']).toBe(true);
    expect(refundRow['refund_application_fee']).toBe(true);

    // Vérification exacte de la clé provider ADR-023 §10.2 (distincte de la clé outbox)
    expect(refundRow['provider_idempotency_key']).toBe(`refund_amendment_${res.refundId}`);

    // Vérifier les outbox events
    const outboxRows =
      await rawSql`SELECT * FROM outbox_events WHERE payload->>'amendmentId' = ${res.amendmentId} ORDER BY created_at ASC`;
    expect(outboxRows.length).toBeGreaterThanOrEqual(2);

    const bookingAmendedRow = outboxRows.find((r) => r['event_type'] === 'BOOKING_AMENDED')!;
    expect(bookingAmendedRow).toBeDefined();
    expect(bookingAmendedRow['idempotency_key']).toBe(`booking_amended_${res.amendmentId}`);
    const parsedAmended = parseBookingAmendedV1Event({
      aggregateType: bookingAmendedRow['aggregate_type'],
      eventType: bookingAmendedRow['event_type'],
      eventVersion: bookingAmendedRow['event_version'],
      payload: bookingAmendedRow['payload'],
    });
    expect(parsedAmended.payload.amendmentId).toBe(res.amendmentId);

    const refundRequestedRow = outboxRows.find((r) => r['event_type'] === 'REFUND_REQUESTED')!;
    expect(refundRequestedRow).toBeDefined();
    expect(refundRequestedRow['idempotency_key']).toBe(`refund_requested_${res.refundId}`);
    expect(refundRow['provider_idempotency_key']).not.toBe(refundRequestedRow['idempotency_key']);
    expect(refundRequestedRow['aggregate_type']).toBe('REFUND');
    expect(refundRequestedRow['aggregate_id']).toBe(res.refundId);
    const parsedRefund = parseRefundRequestedV1Event({
      aggregateType: refundRequestedRow['aggregate_type'],
      eventType: refundRequestedRow['event_type'],
      eventVersion: refundRequestedRow['event_version'],
      aggregateId: refundRequestedRow['aggregate_id'],
      payload: refundRequestedRow['payload'],
    });
    expect(parsedRefund.eventVersion).toBe('v1');
    expect(parsedRefund.payload.refundId).toBe(res.refundId);
    expect(parsedRefund.payload.amendmentId).toBe(res.amendmentId);
  });

  it('2. Replay idempotent retourne REPLAY sans doublon de refund ni outbox', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 2 });
    const actor = makeActor(ids.managerId);
    const idempotencyKey = `refund_replay_key_${Math.random().toString(36).slice(2, 8)}`;

    const cmd = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey,
    };

    const first = await createRefundBookingAmendment(db, actor, ids.orgId, cmd);
    expect(first.kind).toBe('SUCCESS');
    if (first.kind !== 'SUCCESS') return;

    const second = await createRefundBookingAmendment(db, actor, ids.orgId, cmd);
    expect(second.kind).toBe('REPLAY');
    if (second.kind !== 'REPLAY') return;

    expect(second.amendmentId).toBe(first.amendmentId);
    expect(second.refundId).toBe(first.refundId);
    expect(second.refundAmountMinor).toBe(first.refundAmountMinor);

    const refundCount =
      await rawSql`SELECT count(*) FROM refunds WHERE organization_id = ${ids.orgId}`;
    expect(Number(refundCount[0]!['count'])).toBe(1);
  });

  it('3. Même clé idempotente avec payload différent retourne IDEMPOTENCY_CONFLICT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 2 });
    const actor = makeActor(ids.managerId);
    const idempotencyKey = `refund_conflict_key_${Math.random().toString(36).slice(2, 8)}`;

    const cmd1 = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey,
    };

    await createRefundBookingAmendment(db, actor, ids.orgId, cmd1);

    const cmd2 = {
      ...cmd1,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-11',
        endDateExclusive: '2026-03-13',
      },
    };

    const second = await createRefundBookingAmendment(db, actor, ids.orgId, cmd2);
    expect(second.kind).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('4. Rejette delta neutre (= 0) et delta positif (> 0) avec FINANCIAL_ACTION_REQUIRED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 1, unitPrice: 5000 });
    const actor = makeActor(ids.managerId);

    // Delta = 0 (mêmes lignes, même durée)
    const neutralCmd = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: `neutral_in_refund_${Math.random().toString(36).slice(2, 8)}`,
    };

    const neutralRes = await createRefundBookingAmendment(db, actor, ids.orgId, neutralCmd);
    expect(neutralRes.kind).toBe('FINANCIAL_ACTION_REQUIRED');
    if (neutralRes.kind === 'FINANCIAL_ACTION_REQUIRED') {
      expect(neutralRes.classification).toBe('NEUTRAL');
      expect(neutralRes.deltaMinor).toBe(0);
    }

    // Delta > 0 (augmentation de quantité 1 -> 2)
    const suppCmd = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 2 }],
      idempotencyKey: `supp_in_refund_${Math.random().toString(36).slice(2, 8)}`,
    };

    const suppRes = await createRefundBookingAmendment(db, actor, ids.orgId, suppCmd);
    expect(suppRes.kind).toBe('FINANCIAL_ACTION_REQUIRED');
    if (suppRes.kind === 'FINANCIAL_ACTION_REQUIRED') {
      expect(suppRes.classification).toBe('SUPPLEMENT');
      expect(suppRes.deltaMinor).toBeGreaterThan(0);
    }
  });

  it(
    '5. Cap cumulatif des refunds : prouve séparément l inclusion de PENDING, SUBMITTED, SUCCEEDED, FAILED_REQUIRES_MANUAL_ACTION, SETTLED_OFF_PLATFORM et l exclusion de legacy FAILED',
    { timeout: 60000 },
    async () => {
      if (!db || !rawSql) return;

      const statusesToCount = [
        'PENDING',
        'SUBMITTED',
        'SUCCEEDED',
        'FAILED_REQUIRES_MANUAL_ACTION',
        'SETTLED_OFF_PLATFORM',
      ] as const;

      // Pour chaque statut devant être comptabilisé dans le cumul des refunds
      for (let i = 0; i < statusesToCount.length; i++) {
        const st = statusesToCount[i]!;
        const isSettled = st === 'SETTLED_OFF_PLATFORM';
        const isSucceeded = st === 'SUCCEEDED';
        const monthStr = String(i + 3).padStart(2, '0');

        // 1. Réservation initiale : 5 articles physiques x 2 jours x 5000 = 50000 cents au contrat.
        const ids = await seedBaseData(`cap-${st}-`);
        const b = await seedBookingWithItem(ids, { qty: 5, unitPrice: 5000, monthOffset: i + 3 });
        const actor = makeActor(ids.managerId);

        // Le cap de remboursement est volontairement fixé à 30000 cents (300 EUR), indépendamment du contrat à 50000.
        await rawSql`UPDATE payments SET amount_minor = 30000 WHERE id = ${b.paymentId}`;

        // 2. Simuler l'amendement #1 SUPPLEMENT APPLIED (30000 -> 50000 cents) + amendment_payment SUCCEEDED de 20000 cents.
        const amendSuppId = `00000000-0000-4000-a000-${String(i + 1).padStart(12, '0')}`;
        await rawSql`
        INSERT INTO booking_amendments (
          id, organization_id, booking_id, amendment_number, type, status,
          financial_snapshot_before, financial_snapshot_after, created_by,
          new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at, hold_deadline
        )
        VALUES (
          ${amendSuppId}, ${ids.orgId}, ${b.bookingId}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
          ${rawSql.json({ totalAmountMinor: 30000, currency: 'EUR' })},
          ${rawSql.json({ totalAmountMinor: 50000, currency: 'EUR' })},
          ${ids.managerId},
          ${`2026-${monthStr}-10 09:00:00+00`}, ${`2026-${monthStr}-12 17:00:00+00`},
          ${`2026-${monthStr}-10 08:30:00+00`}, ${`2026-${monthStr}-12 17:30:00+00`},
          now() + interval '10 minutes'
        )
      `;
        await rawSql`UPDATE booking_amendments SET status = 'READY_TO_APPLY' WHERE id = ${amendSuppId}`;
        await rawSql`UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendSuppId}`;

        const amendSuppLineId = `00000000-0000-4000-e000-${String(i + 1).padStart(12, '0')}`;
        await rawSql`
        INSERT INTO booking_amendment_lines (
          id, amendment_id, organization_id, origin_type, action, logical_line_id,
          source_booking_line_id, variant_id, before_quantity, after_quantity,
          before_unit_price_amount_minor, after_unit_price_amount_minor,
          before_line_total_amount_minor, after_line_total_amount_minor,
          pricing_snapshot, variant_snapshot
        )
        VALUES (
          ${amendSuppLineId}, ${amendSuppId}, ${ids.orgId}, 'ORIGINAL', 'MODIFY', ${b.bookingLineId},
          ${b.bookingLineId}, ${ids.variantId}, 3, 5,
          5000, 5000,
          30000, 50000,
          ${rawSql.json({ billableUnitCount: 2 })}, ${rawSql.json({ name: 'Standard' })}
        )
      `;

        for (let k = 0; k < 5; k++) {
          const inventoryItemId = b.inventoryItemIds[k];
          const sourceBlockId = b.blockIds[k];
          if (typeof inventoryItemId !== 'string' || typeof sourceBlockId !== 'string') {
            throw new Error(
              `Fixture invalide : allocation ${k} sans inventoryItemId ou sourceBlockId`,
            );
          }
          const allocId = `00000000-0000-4000-f000-${String(i + 1).padStart(8, '0')}${String(k).padStart(4, '0')}`;
          await rawSql`
          INSERT INTO booking_amendment_allocations (
            id, amendment_id, amendment_line_id, organization_id, inventory_item_id,
            action, source_booking_block_id, applied_booking_block_id, status,
            effective_customer_start_at, effective_customer_end_at, effective_blocked_start_at, effective_blocked_end_at
          )
          VALUES (
            ${allocId}, ${amendSuppId}, ${amendSuppLineId}, ${ids.orgId}, ${inventoryItemId},
            'RETAIN', ${sourceBlockId}, NULL, 'PROPOSED',
            ${`2026-${monthStr}-10 09:00:00+00`}, ${`2026-${monthStr}-12 17:00:00+00`},
            ${`2026-${monthStr}-10 08:30:00+00`}, ${`2026-${monthStr}-12 17:30:00+00`}
          )
        `;
        }
        await rawSql`UPDATE booking_amendment_allocations SET status = 'CONVERTED', applied_booking_block_id = source_booking_block_id WHERE amendment_id = ${amendSuppId}`;

        const amendPayId = `00000000-0000-4000-b000-${String(i + 1).padStart(12, '0')}`;
        await rawSql`
        INSERT INTO amendment_payments (
          id, organization_id, booking_id, amendment_id, customer_user_id, status, amount_minor, currency,
          connected_account_id, charge_model, settlement_merchant_mode, environment
        )
        VALUES (
          ${amendPayId}, ${ids.orgId}, ${b.bookingId}, ${amendSuppId}, ${ids.userId}, 'PENDING_PROVIDER', 20000, 'EUR',
          'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST'
        )
      `;
        await rawSql`UPDATE amendment_payments SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = ${amendPayId}`;

        // 3. REFUND #1 : contrat 50000 → 30000 cents (5 → 3 articles sur 2 jours), soit 20000 cents demandés.
        const cmdRefund1 = {
          bookingId: b.bookingId,
          expectedLastAppliedAmendmentNumber: 1,
          intent: {
            kind: 'DAY_RANGE' as const,
            startDate: `2026-${monthStr}-10`,
            endDateExclusive: `2026-${monthStr}-12`,
          },
          desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 3 }],
          idempotencyKey: `cap_refund1_key_${st}_${Math.random().toString(36).slice(2, 8)}`,
        };

        const resRefund1 = await createRefundBookingAmendment(db, actor, ids.orgId, cmdRefund1);
        expect(resRefund1.kind).toBe('SUCCESS');
        if (resRefund1.kind !== 'SUCCESS') return;

        // 4. Mettre à jour le refund #1 au statut à tester `st`
        if (isSettled) {
          await rawSql`UPDATE refunds SET status = 'FAILED_REQUIRES_MANUAL_ACTION' WHERE id = ${resRefund1.refundId}`;
          await rawSql`
          UPDATE refunds
          SET status = 'SETTLED_OFF_PLATFORM',
              settled_off_platform_at = now(),
              settled_off_platform_by = ${ids.managerId},
              settlement_notes = 'manual settlement'
          WHERE id = ${resRefund1.refundId}
        `;
        } else if (isSucceeded) {
          await rawSql`
          UPDATE refunds
          SET status = ${st},
              succeeded_at = '2026-01-01 12:25:00+00'
          WHERE id = ${resRefund1.refundId}
        `;
        } else {
          await rawSql`
          UPDATE refunds
          SET status = ${st}
          WHERE id = ${resRefund1.refundId}
        `;
        }

        // 5. Appeler createRefundBookingAmendment pour réduire de 3 articles (30000 cents) à 1 article (10000 cents) -> nouveau refund demandé = 20000 cents.
        // Cumul engagé = 20000 + 20000 = 40000 cents > cap du paiement initial (30000) -> INVALID_INPUT.
        const cmdExceed = {
          bookingId: b.bookingId,
          expectedLastAppliedAmendmentNumber: 2,
          intent: {
            kind: 'DAY_RANGE' as const,
            startDate: `2026-${monthStr}-10`,
            endDateExclusive: `2026-${monthStr}-12`,
          },
          desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
          idempotencyKey: `cap_exceed_key_${st}_${Math.random().toString(36).slice(2, 8)}`,
        };

        const resExceed = await createRefundBookingAmendment(db, actor, ids.orgId, cmdExceed);

        // 6. Le cap est dépassé (40000 engagés > 30000 capturés) : INVALID_INPUT.
        expect(resExceed.kind).toBe('INVALID_INPUT');
        if (resExceed.kind === 'INVALID_INPUT') {
          expect(resExceed.message).toContain('Dépassement du montant du paiement initial');
        }

        // 7. Vérifier qu'aucun amendement ni refund supplémentaire n'a été créé par la tentative rejetée
        const amendCount =
          await rawSql`SELECT count(*) FROM booking_amendments WHERE booking_id = ${b.bookingId}`;
        expect(Number(amendCount[0]!['count'])).toBe(2);

        const refundCount =
          await rawSql`SELECT count(*) FROM refunds WHERE payment_id = ${b.paymentId}`;
        expect(Number(refundCount[0]!['count'])).toBe(1);
      }

      // Cas séparé : legacy FAILED est EXCLU du cumul
      const idsFailed = await seedBaseData('cap-failed-');
      const bFailed = await seedBookingWithItem(idsFailed, {
        qty: 5,
        unitPrice: 5000,
        monthOffset: 9,
      });
      const actorFailed = makeActor(idsFailed.managerId);

      // 1. REFUND #1 de 20000 cents (contrat 50000 → 30000 cents, soit 3 articles x 2 jours).
      const cmdFailedInitial = {
        bookingId: bFailed.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-09-10',
          endDateExclusive: '2026-09-12',
        },
        desiredLines: [
          { logicalLineId: bFailed.bookingLineId, variantId: idsFailed.variantId, quantity: 3 },
        ],
        idempotencyKey: `cap_failed_initial_${Math.random().toString(36).slice(2, 8)}`,
      };

      const resFailedInitial = await createRefundBookingAmendment(
        db,
        actorFailed,
        idsFailed.orgId,
        cmdFailedInitial,
      );
      expect(resFailedInitial.kind).toBe('SUCCESS');
      if (resFailedInitial.kind !== 'SUCCESS') return;

      // Fixer ensuite le cap du paiement initial à 30000 cents (300 EUR) et basculer le refund #1 au statut FAILED (legacy).
      await rawSql`UPDATE payments SET amount_minor = 30000 WHERE id = ${bFailed.paymentId}`;
      await rawSql`UPDATE refunds SET status = 'FAILED', failed_at = now() WHERE id = ${resFailedInitial.refundId}`;

      // 3. Deuxième demande de refund de 20000 cents (réduction de 30000 à 10000 cents, soit 1 article x 2 jours)
      // Puisque FAILED est exclu du cumul, cumul existant = 0, et 0 + 20000 = 20000 <= 30000 -> Succès !
      const validCmd = {
        bookingId: bFailed.bookingId,
        expectedLastAppliedAmendmentNumber: 1,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-09-10',
          endDateExclusive: '2026-09-12',
        },
        desiredLines: [
          { logicalLineId: bFailed.bookingLineId, variantId: idsFailed.variantId, quantity: 1 },
        ],
        idempotencyKey: `cap_test_failed_excluded_${Math.random().toString(36).slice(2, 8)}`,
      };

      const validRes = await createRefundBookingAmendment(
        db,
        actorFailed,
        idsFailed.orgId,
        validCmd,
      );
      expect(validRes.kind).toBe('SUCCESS');
      if (validRes.kind !== 'SUCCESS') return;

      // 4. Vérifier que le nouveau refund créé a la valeur 20000 et le statut PENDING
      const newRefundRows = await rawSql`SELECT * FROM refunds WHERE id = ${validRes.refundId}`;
      expect(newRefundRows).toHaveLength(1);
      expect(newRefundRows[0]!['status']).toBe('PENDING');
      expect(Number(newRefundRows[0]!['amount_minor'])).toBe(20000);
    },
  );

  it(
    '6. Concurrence réelle sur la MÊME réservation et le MÊME paiement',
    { timeout: 30000 },
    async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const b = await seedBookingWithItem(ids, { qty: 2, unitPrice: 5000 }); // total 20000 (200 €)
      const actor = makeActor(ids.managerId);

      const cmdA = {
        bookingId: b.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-03-10',
          endDateExclusive: '2026-03-12',
        },
        desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: `conc_same_payment_key_A_${Math.random().toString(36).slice(2, 8)}`,
      };

      const cmdB = {
        bookingId: b.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-03-10',
          endDateExclusive: '2026-03-12',
        },
        desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: `conc_same_payment_key_B_${Math.random().toString(36).slice(2, 8)}`,
      };

      const [resA, resB] = await Promise.all([
        createRefundBookingAmendment(db, actor, ids.orgId, cmdA),
        createRefundBookingAmendment(db, actor, ids.orgId, cmdB),
      ]);

      const successRes = resA.kind === 'SUCCESS' ? resA : resB;
      const failedRes = resA.kind === 'SUCCESS' ? resB : resA;

      expect(successRes.kind).toBe('SUCCESS');
      expect(failedRes).toEqual({
        kind: 'STALE_EFFECTIVE_BOOKING',
        expected: 0,
        actual: 1,
      });

      const appliedAmendments =
        await rawSql`SELECT count(*) FROM booking_amendments WHERE booking_id = ${b.bookingId} AND status = 'APPLIED'`;
      expect(Number(appliedAmendments[0]!['count'])).toBe(1);

      const refundCount =
        await rawSql`SELECT count(*) FROM refunds WHERE payment_id = ${b.paymentId}`;
      expect(Number(refundCount[0]!['count'])).toBe(1);

      const refundSum =
        await rawSql`SELECT sum(amount_minor) as total FROM refunds WHERE payment_id = ${b.paymentId}`;
      expect(Number(refundSum[0]!['total'])).toBe(10000);
    },
  );

  it('7. Refunds séquentiels successifs sur la même réservation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 3, unitPrice: 5000 }); // total 30000 (300 €)
    const actor = makeActor(ids.managerId);

    // 1er amendement : réduction de 3 à 2 exemplaires (refund 100 € / 10000 cents)
    const cmd1 = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 2 }],
      idempotencyKey: `seq_refund_key_1_${Math.random().toString(36).slice(2, 8)}`,
    };

    const res1 = await createRefundBookingAmendment(db, actor, ids.orgId, cmd1);
    expect(res1.kind).toBe('SUCCESS');
    if (res1.kind !== 'SUCCESS') return;

    expect(res1.amendmentNumber).toBe(1);
    expect(res1.refundAmountMinor).toBe(10000);

    // 2ème amendement : réduction de 2 à 1 exemplaire avec expectedLastAppliedAmendmentNumber = 1 (refund 100 € / 10000 cents)
    const cmd2 = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 1,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: `seq_refund_key_2_${Math.random().toString(36).slice(2, 8)}`,
    };

    const res2 = await createRefundBookingAmendment(db, actor, ids.orgId, cmd2);
    expect(res2.kind).toBe('SUCCESS');
    if (res2.kind !== 'SUCCESS') return;

    expect(res2.amendmentNumber).toBe(2);
    expect(res2.refundAmountMinor).toBe(10000);
    expect(res2.amendmentId).not.toBe(res1.amendmentId);
    expect(res2.refundId).not.toBe(res1.refundId);

    // Vérifier les 2 refunds distincts et leurs clés provider ADR-023 §10.2
    const refundsList =
      await rawSql`SELECT * FROM refunds WHERE payment_id = ${b.paymentId} ORDER BY requested_at ASC`;
    expect(refundsList).toHaveLength(2);
    expect(refundsList[0]!['provider_idempotency_key']).toBe(`refund_amendment_${res1.refundId}`);
    expect(refundsList[1]!['provider_idempotency_key']).toBe(`refund_amendment_${res2.refundId}`);

    // Verification getEffectiveBooking & invariant financier
    const effRes = await getEffectiveBooking(db, ids.orgId, b.bookingId);
    expect(effRes.kind).toBe('FOUND');
    if (effRes.kind !== 'FOUND') return;

    expect(effRes.booking.effectiveTotalAmountMinor).toBe(10000); // 30000 - 10000 - 10000 = 10000
    expect(effRes.booking.lastAppliedAmendmentNumber).toBe(2);

    const fin = effRes.booking.financials;
    expect(fin.contractualTotalAmountMinor).toBe(10000);
    expect(fin.grossCollectedAmountMinor).toBe(30000);
    expect(fin.successfulRefundedAmountMinor).toBe(0);
    expect(fin.refundStillOwedAmountMinor).toBe(20000); // 2 x 10000 PENDING

    // ADR-023 §11.2 : grossCollected (30000) - successful (0) - settled (0) - owed (20000) = contractualTotal (10000)
    expect(
      fin.grossCollectedAmountMinor -
        fin.successfulRefundedAmountMinor -
        fin.settledOffPlatformAmountMinor -
        fin.refundStillOwedAmountMinor,
    ).toBe(fin.contractualTotalAmountMinor);
  });

  it('8. Tenant isolation et autorisation de rôle', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 2 });
    const managerActor = makeActor(ids.managerId);
    const staffActor = makeActor(ids.staffId);

    // Seeder une seconde organisation où managerActor est également MANAGER
    const otherOrg = await seedBaseData('other-');
    await rawSql`
      INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
      VALUES (${otherOrg.orgId}, ${ids.managerId}, 'MANAGER', 'ACTIVE')
    `;

    // 1. Clé idempotente 1 : managerActor requérant otherOrg.orgId pour b.bookingId -> NOT_FOUND tenant-safe
    const cmd1 = {
      bookingId: b.bookingId, // booking appartenant à ids.orgId
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey: `tenant_auth_key_1_${Math.random().toString(36).slice(2, 8)}`,
    };

    const notFoundRes = await createRefundBookingAmendment(db, managerActor, otherOrg.orgId, cmd1);
    expect(notFoundRes.kind).toBe('NOT_FOUND');

    // 2. Clé idempotente 2 : Rôle STAFF sur ids.orgId -> FORBIDDEN
    const cmd2 = {
      ...cmd1,
      idempotencyKey: `tenant_auth_key_2_${Math.random().toString(36).slice(2, 8)}`,
    };
    const staffRes = await createRefundBookingAmendment(db, staffActor, ids.orgId, cmd2);
    expect(staffRes.kind).toBe('FORBIDDEN');

    // 3. Clé idempotente 3 : Acteur inconnu sans membership -> FORBIDDEN
    const cmd3 = {
      ...cmd1,
      idempotencyKey: `tenant_auth_key_3_${Math.random().toString(36).slice(2, 8)}`,
    };
    const unknownActor = makeActor('88888888-8888-8888-8888-888888888888');
    const forbiddenRes = await createRefundBookingAmendment(db, unknownActor, ids.orgId, cmd3);
    expect(forbiddenRes.kind).toBe('FORBIDDEN');

    // Verification globale de non-pollution DB et outbox
    const amendCount =
      await rawSql`SELECT count(*) FROM booking_amendments WHERE booking_id = ${b.bookingId}`;
    expect(Number(amendCount[0]!['count'])).toBe(0);

    const refundCount =
      await rawSql`SELECT count(*) FROM refunds WHERE payment_id = ${b.paymentId}`;
    expect(Number(refundCount[0]!['count'])).toBe(0);

    const outboxAmendedCount =
      await rawSql`SELECT count(*) FROM outbox_events WHERE event_type = 'BOOKING_AMENDED' AND organization_id = ${ids.orgId}`;
    expect(Number(outboxAmendedCount[0]!['count'])).toBe(0);

    const outboxRefundCount =
      await rawSql`SELECT count(*) FROM outbox_events WHERE event_type = 'REFUND_REQUESTED' AND organization_id = ${ids.orgId}`;
    expect(Number(outboxRefundCount[0]!['count'])).toBe(0);
  });

  it('9. Rollback tardif atomique et vérification exacte du statut idempotency PENDING après défaillance outbox', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const b = await seedBookingWithItem(ids, { qty: 2 });
    const actor = makeActor(ids.managerId);

    const initialBlocks =
      await rawSql`SELECT id, inventory_item_id, status, source_id, customer_start_at, customer_end_at FROM inventory_blocks WHERE source_id = ${b.bookingId} ORDER BY id ASC`;

    await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION fail_refund_requested_outbox()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'REFUND_REQUESTED' THEN
          RAISE EXCEPTION 'Simulated outbox failure for REFUND_REQUESTED';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await rawSql.unsafe(`
      CREATE TRIGGER fail_refund_requested_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION fail_refund_requested_outbox();
    `);

    const idempotencyKey = `rollback_test_key_${Math.random().toString(36).slice(2, 8)}`;
    const cmd = {
      bookingId: b.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-12',
      },
      desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
      idempotencyKey,
    };

    await expect(createRefundBookingAmendment(db, actor, ids.orgId, cmd)).rejects.toThrow(
      'Simulated outbox failure for REFUND_REQUESTED',
    );

    await rawSql.unsafe(`
      DROP TRIGGER IF EXISTS fail_refund_requested_trigger ON outbox_events;
      DROP FUNCTION IF EXISTS fail_refund_requested_outbox();
    `);

    // 0 booking_amendments
    const amendCount =
      await rawSql`SELECT count(*) FROM booking_amendments WHERE booking_id = ${b.bookingId}`;
    expect(Number(amendCount[0]!['count'])).toBe(0);

    // 0 booking_amendment_lines
    const linesCount =
      await rawSql`SELECT count(*) FROM booking_amendment_lines WHERE organization_id = ${ids.orgId}`;
    expect(Number(linesCount[0]!['count'])).toBe(0);

    // 0 booking_amendment_allocations
    const allocsCount =
      await rawSql`SELECT count(*) FROM booking_amendment_allocations WHERE organization_id = ${ids.orgId}`;
    expect(Number(allocsCount[0]!['count'])).toBe(0);

    // 0 refunds
    const refundCount =
      await rawSql`SELECT count(*) FROM refunds WHERE payment_id = ${b.paymentId}`;
    expect(Number(refundCount[0]!['count'])).toBe(0);

    // 0 outbox events pour cette tentative
    const outboxCount =
      await rawSql`SELECT count(*) FROM outbox_events WHERE organization_id = ${ids.orgId}`;
    expect(Number(outboxCount[0]!['count'])).toBe(0);

    // Blocs d'inventaire strictly identiques au snapshot initial
    const postBlocks =
      await rawSql`SELECT id, inventory_item_id, status, source_id, customer_start_at, customer_end_at FROM inventory_blocks WHERE source_id = ${b.bookingId} ORDER BY id ASC`;
    expect(postBlocks).toEqual(initialBlocks);

    // État idempotency : le protocole reserveKey s'étant committé avant la transaction métier, l'enregistrement idempotency reste PENDING jusqu'à expiration
    const keyRows =
      await rawSql`SELECT * FROM idempotency_records WHERE organization_id = ${ids.orgId} AND key = ${idempotencyKey}`;
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!['status']).toBe('PENDING');
  });

  it('10. Test d absence de deadlock sur multi-réservations concurrentes dans la même organisation', async () => {
    if (!db || !rawSql) return;
    const dbClient = db;
    const ids = await seedBaseData();
    const bookingsList = await Promise.all([
      seedBookingWithItem(ids, { qty: 2, monthOffset: 3 }),
      seedBookingWithItem(ids, { qty: 2, monthOffset: 4 }),
      seedBookingWithItem(ids, { qty: 2, monthOffset: 5 }),
    ]);

    const actor = makeActor(ids.managerId);

    const tasks = bookingsList.map((b, i) => {
      const cmd = {
        bookingId: b.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: `2026-0${i + 3}-10`,
          endDateExclusive: `2026-0${i + 3}-12`,
        },
        desiredLines: [{ logicalLineId: b.bookingLineId, variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: `deadlock_refund_key_${i}_${Math.random().toString(36).slice(2, 8)}`,
      };
      return createRefundBookingAmendment(dbClient, actor, ids.orgId, cmd);
    });

    const results = await Promise.all(tasks);
    for (const r of results) {
      expect(r.kind).toBe('SUCCESS');
    }
  });
});
