import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import { createSupplementBookingAmendment } from './create-supplement-booking-amendment';
import { previewBookingAmendment } from './preview-booking-amendment';
import { createNeutralBookingAmendment } from './create-neutral-booking-amendment';
import { createRefundBookingAmendment } from './create-refund-booking-amendment';
import { getEffectiveBooking } from './get-effective-booking';
import type { AuthenticatedUser } from '../identity/types';
import type { PreviewBookingAmendmentCommand } from './types-amendment';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('previewBookingAmendment — intégration PostgreSQL', () => {
  let db: DatabaseClient;
  let rawSql: Sql;

  beforeAll(async () => {
    if (!url) return;
    db = createDatabase(url);
    rawSql = postgres(url);
    await rawSql`SELECT 1`;
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

  async function seedActiveHourlyPricingPlan(
    sql: postgres.Sql,
    orgId: string,
    variantId: string,
    locationId: string,
    priceAmountMinor = 2000,
    label = 'Tarif horaire',
  ): Promise<string> {
    const plan = await sql`
      INSERT INTO "pricing_plans" (
        "organization_id", "product_variant_id", "location_id", "plan_type", "currency",
        "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes",
        "lifecycle_state", "version"
      )
      VALUES (
        ${orgId}, ${variantId}, ${locationId}, 'HOURLY', 'EUR',
        ${priceAmountMinor}, 60, 1440, 60,
        'DRAFT', 1
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
    const category =
      await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
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

    await seedActiveDailyPricingPlan(sql, org.id, variant.id, location.id, 5000);
    await seedActiveHourlyPricingPlan(sql, org.id, variant.id, location.id, 2000);

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

  it('1. NEUTRAL preview réussit et parité stricte avec mutation NEUTRAL', async () => {
    const baseIds = await seedBaseData(rawSql, 'neu-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 3, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-03-15',
        endDateExclusive: '2026-03-17',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    const preview = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(preview.kind).toBe('SUCCESS');
    if (preview.kind !== 'SUCCESS') return;

    expect(preview.classification).toBe('NEUTRAL');
    expect(preview.deltaAmountMinor).toBe(0);
    expect(preview.previousContractualTotalAmountMinor).toBe(10000);
    expect(preview.nextContractualTotalAmountMinor).toBe(10000);
    expect(preview.supplementCommissionAmountMinor).toBeNull();
    expect(preview.supplementNetAmountMinor).toBeNull();

    const mutation = await createNeutralBookingAmendment(db, actor, baseIds.orgId, {
      idempotencyKey: crypto.randomUUID(),
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: command.intent,
      desiredLines: command.desiredLines,
    });
    expect(mutation.kind).toBe('SUCCESS');

    const effectiveAfter = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveAfter.kind).toBe('FOUND');
    if (effectiveAfter.kind !== 'FOUND') return;

    expect(effectiveAfter.booking.effectiveCustomerStartAt.toISOString()).toBe(
      preview.nextCustomerStartAt.toISOString(),
    );
    expect(effectiveAfter.booking.effectiveCustomerEndAt.toISOString()).toBe(
      preview.nextCustomerEndAt.toISOString(),
    );
    expect(effectiveAfter.booking.effectiveTotalAmountMinor).toBe(
      preview.nextContractualTotalAmountMinor,
    );
  });

  it('2. REFUND preview réussit et parité stricte avec mutation REFUND', async () => {
    const baseIds = await seedBaseData(rawSql, 'ref-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 4, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-04-10',
        endDateExclusive: '2026-04-11',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    const preview = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(preview.kind).toBe('SUCCESS');
    if (preview.kind !== 'SUCCESS') return;

    expect(preview.classification).toBe('REFUND');
    expect(preview.deltaAmountMinor).toBe(-5000);
    expect(preview.previousContractualTotalAmountMinor).toBe(10000);
    expect(preview.nextContractualTotalAmountMinor).toBe(5000);
    expect(preview.supplementCommissionAmountMinor).toBeNull();
    expect(preview.supplementNetAmountMinor).toBeNull();

    const mutation = await createRefundBookingAmendment(db, actor, baseIds.orgId, {
      idempotencyKey: crypto.randomUUID(),
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: command.intent,
      desiredLines: command.desiredLines,
    });
    expect(mutation.kind).toBe('SUCCESS');
    if (mutation.kind === 'SUCCESS') {
      expect(mutation.refundAmountMinor).toBe(Math.abs(preview.deltaAmountMinor));
      const refundRows = await rawSql`
        SELECT amount_minor FROM refunds WHERE id = ${mutation.refundId}
      `;
      expect(refundRows.length).toBe(1);
      expect(Number(refundRows[0]!.amount_minor)).toBe(Math.abs(preview.deltaAmountMinor));
    }
  });

  it('3. SUPPLEMENT preview réussit et parité stricte avec mutation SUPPLEMENT', async () => {
    const baseIds = await seedBaseData(rawSql, 'sup-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 5, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-05-10',
        endDateExclusive: '2026-05-13',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    const preview = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(preview.kind).toBe('SUCCESS');
    if (preview.kind !== 'SUCCESS') return;

    expect(preview.classification).toBe('SUPPLEMENT');
    expect(preview.deltaAmountMinor).toBe(5000);
    expect(preview.previousContractualTotalAmountMinor).toBe(10000);
    expect(preview.nextContractualTotalAmountMinor).toBe(15000);
    expect(preview.supplementCommissionAmountMinor).toBe(250);
    expect(preview.supplementNetAmountMinor).toBe(4750);

    const mutation = await createSupplementBookingAmendment(db, actor, baseIds.orgId, {
      idempotencyKey: crypto.randomUUID(),
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: command.intent,
      desiredLines: command.desiredLines,
    });
    expect(mutation.kind).toBe('SUCCESS');
    if (mutation.kind !== 'SUCCESS') return;

    const paymentRows = await rawSql`
      SELECT amount_minor
      FROM amendment_payments
      WHERE amendment_id = ${mutation.amendmentId}
    `;
    expect(paymentRows.length).toBe(1);
    expect(Number(paymentRows[0]!.amount_minor)).toBe(preview.deltaAmountMinor);
  });

  it('4. TIME_RANGE preview réussit et parité avec réservation horaire', async () => {
    const baseIds = await seedBaseData(rawSql, 'time-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 6, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'TIME_RANGE',
        startAt: '2026-06-10T10:00:00',
        endAt: '2026-06-10T14:00:00',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    const preview = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(preview.kind).toBe('SUCCESS');
    if (preview.kind !== 'SUCCESS') return;

    expect(preview.nextCustomerStartAt.toISOString()).toBe(
      new Date('2026-06-10T08:00:00Z').toISOString(),
    );
    expect(preview.nextCustomerEndAt.toISOString()).toBe(
      new Date('2026-06-10T12:00:00Z').toISOString(),
    );
  });

  it('5. Preuve stricte d absence d écriture en base (tenant-scoped)', async () => {
    const baseIds = await seedBaseData(rawSql, 'zero-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 7, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const countBefore = await rawSql`
      SELECT
        (SELECT count(*) FROM booking_amendments WHERE organization_id = ${baseIds.orgId}) as amendments,
        (SELECT count(*) FROM booking_amendment_lines WHERE organization_id = ${baseIds.orgId}) as lines,
        (SELECT count(*) FROM booking_amendment_allocations WHERE organization_id = ${baseIds.orgId}) as allocations,
        (SELECT count(*) FROM booking_amendment_segments WHERE organization_id = ${baseIds.orgId}) as segments,
        (SELECT count(*) FROM amendment_payments WHERE organization_id = ${baseIds.orgId}) as payments,
        (SELECT count(*) FROM amendment_payment_attempts WHERE organization_id = ${baseIds.orgId}) as attempts,
        (SELECT count(*) FROM refunds WHERE organization_id = ${baseIds.orgId}) as refunds,
        (SELECT count(*) FROM inventory_blocks WHERE organization_id = ${baseIds.orgId}) as blocks,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${bookingIds.bookingId}) as outbox,
        (SELECT count(*) FROM idempotency_records WHERE organization_id = ${baseIds.orgId}) as idempotency
    `;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-07-10',
        endDateExclusive: '2026-07-12',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    const preview = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(preview.kind).toBe('SUCCESS');

    const countAfter = await rawSql`
      SELECT
        (SELECT count(*) FROM booking_amendments WHERE organization_id = ${baseIds.orgId}) as amendments,
        (SELECT count(*) FROM booking_amendment_lines WHERE organization_id = ${baseIds.orgId}) as lines,
        (SELECT count(*) FROM booking_amendment_allocations WHERE organization_id = ${baseIds.orgId}) as allocations,
        (SELECT count(*) FROM booking_amendment_segments WHERE organization_id = ${baseIds.orgId}) as segments,
        (SELECT count(*) FROM amendment_payments WHERE organization_id = ${baseIds.orgId}) as payments,
        (SELECT count(*) FROM amendment_payment_attempts WHERE organization_id = ${baseIds.orgId}) as attempts,
        (SELECT count(*) FROM refunds WHERE organization_id = ${baseIds.orgId}) as refunds,
        (SELECT count(*) FROM inventory_blocks WHERE organization_id = ${baseIds.orgId}) as blocks,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${bookingIds.bookingId}) as outbox,
        (SELECT count(*) FROM idempotency_records WHERE organization_id = ${baseIds.orgId}) as idempotency
    `;

    expect(countAfter[0]).toEqual(countBefore[0]);
  });

  it('6. Incohérence bloc source fail-closed : jamais SUCCESS', async () => {
    const baseIds = await seedBaseData(rawSql, 'fc-src-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 8, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    // Passer le statut du bloc source à RELEASED pour forcer l'échec de findSourceBlockId
    await rawSql`
      UPDATE inventory_blocks SET status = 'RELEASED' WHERE id = ${bookingIds.blockId}
    `;

    // Déplacer les dates pour forcer la recherche de bloc source dans previewBookingAmendment
    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-08-15',
        endDateExclusive: '2026-08-17',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 1,
        },
      ],
    };

    await expect(previewBookingAmendment(db, actor, baseIds.orgId, command)).rejects.toThrow();
  });

  it('7. Tenant isolation : une autre organisation retourne NOT_FOUND sans fuite', async () => {
    const baseA = await seedBaseData(rawSql, 't-a-');
    const baseB = await seedBaseData(rawSql, 't-b-');
    const bookingIds = await seedBookingWithItem(rawSql, baseA, 9, 1, 5000);
    const actorB = await addActor(rawSql, baseB.orgId, 'MANAGER');

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-09-10',
        endDateExclusive: '2026-09-12',
      },
      desiredLines: [
        {
          variantId: baseA.variantId,
          quantity: 1,
        },
      ],
    };

    const res = await previewBookingAmendment(db, actorB, baseB.orgId, command);
    expect(res.kind).toBe('NOT_FOUND');
  });

  it('8. Autorisation : STAFF et non-membres sont rejetés avec FORBIDDEN', async () => {
    const baseIds = await seedBaseData(rawSql, 'perm-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 10, 1, 5000);
    const staffActor = await addActor(rawSql, baseIds.orgId, 'STAFF');

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-10-10',
        endDateExclusive: '2026-10-12',
      },
      desiredLines: [{ variantId: baseIds.variantId, quantity: 1 }],
    };

    const res = await previewBookingAmendment(db, staffActor, baseIds.orgId, command);
    expect(res.kind).toBe('FORBIDDEN');
  });

  it('9. Rejet si statut non CONFIRMED', async () => {
    const baseIds = await seedBaseData(rawSql, 'status-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 11, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    await rawSql`
      UPDATE bookings SET status = 'CANCELLED' WHERE id = ${bookingIds.bookingId}
    `;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-11-10',
        endDateExclusive: '2026-11-12',
      },
      desiredLines: [{ variantId: baseIds.variantId, quantity: 1 }],
    };

    const res = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(res.kind).toBe('BOOKING_NOT_CONFIRMED');
  });

  it('10. Rejet si amendement actif existant', async () => {
    const baseIds = await seedBaseData(rawSql, 'act-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 12, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    await rawSql`
      INSERT INTO booking_amendments (
        id, booking_id, organization_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at,
        hold_deadline, created_by
      ) VALUES (
        ${crypto.randomUUID()}, ${bookingIds.bookingId}, ${baseIds.orgId}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
        '{}'::jsonb, '{}'::jsonb,
        now() + interval '1 day', now() + interval '2 days', now() + interval '1 day', now() + interval '2 days',
        now() + interval '10 minutes', ${baseIds.userId}
      )
    `;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-12-10',
        endDateExclusive: '2026-12-12',
      },
      desiredLines: [{ variantId: baseIds.variantId, quantity: 1 }],
    };

    const res = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(res.kind).toBe('ACTIVE_AMENDMENT_EXISTS');
  });

  it('11. Rejet STALE_EFFECTIVE_BOOKING si expectedLastAppliedAmendmentNumber mismatch', async () => {
    const baseIds = await seedBaseData(rawSql, 'stale-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 1, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 5,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2027-01-10',
        endDateExclusive: '2027-01-12',
      },
      desiredLines: [{ variantId: baseIds.variantId, quantity: 1 }],
    };

    const res = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(res.kind).toBe('STALE_EFFECTIVE_BOOKING');
    if (res.kind === 'STALE_EFFECTIVE_BOOKING') {
      expect(res.expected).toBe(5);
      expect(res.actual).toBe(0);
    }
  });

  it('12. AVAILABILITY_CONFLICT si stock insuffisant pour un ajout de quantité', async () => {
    const baseIds = await seedBaseData(rawSql, 'stock-');
    const bookingIds = await seedBookingWithItem(rawSql, baseIds, 2, 1, 5000);
    const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

    const effectiveBefore = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
    expect(effectiveBefore.kind).toBe('FOUND');
    if (effectiveBefore.kind !== 'FOUND') return;

    const command: PreviewBookingAmendmentCommand = {
      bookingId: bookingIds.bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE',
        startDate: '2026-02-10',
        endDateExclusive: '2026-02-12',
      },
      desiredLines: [
        {
          logicalLineId: effectiveBefore.booking.lines[0]!.logicalLineId,
          variantId: baseIds.variantId,
          quantity: 2, // Demande 2 alors que le stock physique total est de 1
        },
      ],
    };

    const res = await previewBookingAmendment(db, actor, baseIds.orgId, command);
    expect(res.kind).toBe('AVAILABILITY_CONFLICT');
  });
});
