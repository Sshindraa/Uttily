import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { getEffectivePricingIntent } from './get-effective-pricing-intent';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_c5a_prc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)('getEffectivePricingIntent — intégration PostgreSQL', () => {
  let db: DatabaseClient;
  let rawSql: Sql;

  let testUrl: string | null = null;

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
    rawSql = postgres(testUrl, { max: 10 });
  }, 600000);

  afterAll(async () => {
    if (db) {
      await db.$client.end();
    }
    if (rawSql) {
      await rawSql.end();
    }
    if (!sourceUrl || !testUrl) return;
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.end();
  });

  interface BaseIds {
    orgId: string;
    locationId: string;
    userId: string;
    variantId: string;
    variantId2: string;
    dailyPlanId: string;
    hourlyPlanId: string;
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
        (${plan.id}, 'fr-FR', ${label}),
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
        (${plan.id}, 'fr-FR', ${label}),
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

  async function seedOrgAndUser(sql: postgres.Sql, prefix: string): Promise<BaseIds> {
    const fullSuffix = prefix + '-' + Math.random().toString(36).slice(2, 8);
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
    const variant1 = await sql`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${productId}, 'Standard', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    const variant2 = await sql`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${productId}, 'Premium', 7000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);

    const dailyPlanId = await seedActiveDailyPricingPlan(
      sql,
      org.id,
      variant1.id,
      location.id,
      5000,
    );
    const hourlyPlanId = await seedActiveHourlyPricingPlan(
      sql,
      org.id,
      variant1.id,
      location.id,
      2000,
    );

    return {
      orgId: org.id,
      locationId: location.id,
      userId: user.id,
      variantId: variant1.id,
      variantId2: variant2.id,
      dailyPlanId,
      hourlyPlanId,
    };
  }

  function buildDayRangeWindow(startDate: string, endDateExclusive: string) {
    const end = new Date(endDateExclusive + 'T00:00:00Z');
    const last = new Date(end.getTime() - 86400000);
    const lastDate = last.toISOString().slice(0, 10);
    return {
      kind: 'DAY_RANGE_BOUNDARIES',
      firstDay: {
        localDate: startDate,
        weekdayMask: 127,
        startTime: '00:00:00',
        endTime: '23:59:59',
      },
      lastDay: {
        localDate: lastDate,
        weekdayMask: 127,
        startTime: '00:00:00',
        endTime: '23:59:59',
      },
    };
  }

  async function seedBooking(
    sql: postgres.Sql,
    base: BaseIds,
    opts: {
      startAt: Date;
      endAt: Date;
      billableUnit?: 'DAY' | 'MINUTE';
      billableUnitCount?: number;
      unitPriceMinor?: number;
      pricingSnapshotVersion?: string;
      pricingAlgorithmVersion?: string | null;
      pricingRoundingRuleVersion?: string | null;
      pricingIntentType?: string | null;
      pricingIntentSnapshot?: Record<string, unknown> | null;
      pricingResolvedLocale?: string | null;
      variantId?: string;
    },
  ): Promise<{ bookingId: string; lineId: string }> {
    const bookingId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const bookingLineId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const billableUnit = opts.billableUnit ?? 'DAY';
    const billableUnitCount = opts.billableUnitCount ?? 2;
    const unitPrice = opts.unitPriceMinor ?? 5000;
    const lineTotal = unitPrice * billableUnitCount;
    const isLegacy = opts.pricingSnapshotVersion === 'legacy-daily-v1';
    const isHourly = opts.pricingIntentType === 'TIME_RANGE';
    const planId = isHourly ? base.hourlyPlanId : base.dailyPlanId;
    const planType = isHourly ? 'HOURLY' : 'DAILY';
    const planLabel = isHourly ? 'Tarif horaire' : 'Tarif journalier';
    const snap = opts.pricingIntentSnapshot;
    const startDateStr =
      (typeof snap?.startDate === 'string' ? snap.startDate : null) ??
      opts.startAt.toISOString().slice(0, 10);
    const endDateStr =
      (typeof snap?.endDateExclusive === 'string' ? snap.endDateExclusive : null) ??
      opts.endAt.toISOString().slice(0, 10);
    const dayWindow = isHourly ? null : buildDayRangeWindow(startDateStr, endDateStr);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO booking_drafts (
          id, organization_id, location_id, customer_user_id,
          customer_start_at, customer_end_at,
          blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes,
          subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
          tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
          billable_unit, billable_unit_count, currency,
          cancellation_policy_snapshot, expires_at, status,
          pricing_snapshot_version, pricing_algorithm_version, pricing_rounding_rule_version,
          pricing_intent_type, pricing_intent_snapshot, pricing_resolved_locale
        ) VALUES (
          ${draftId}, ${base.orgId}, ${base.locationId}, ${base.userId},
          ${opts.startAt}, ${opts.endAt},
          ${opts.startAt}, ${opts.endAt},
          'Europe/Paris', 30, 30,
          ${lineTotal}, 0, ${lineTotal},
          'NOT_APPLICABLE', 0, null, 500,
          ${billableUnit}, ${billableUnitCount}, 'EUR',
          '{}'::jsonb, ${new Date(Date.now() + 600000)}, 'DRAFT',
          ${isLegacy ? 'legacy-daily-v1' : 'flexible-pricing-v1'},
          ${isLegacy ? null : (opts.pricingAlgorithmVersion ?? 'flexible-pricing-v1')},
          ${isLegacy ? null : (opts.pricingRoundingRuleVersion ?? 'half-up-v1')},
          ${isLegacy ? null : (opts.pricingIntentType ?? 'DAY_RANGE')},
          ${isLegacy ? null : opts.pricingIntentSnapshot ? tx.json(opts.pricingIntentSnapshot as postgres.JSONValue) : null},
          ${isLegacy ? null : (opts.pricingResolvedLocale ?? 'fr-FR')}
        )
      `;

      const draftLineId = crypto.randomUUID();
      if (isLegacy) {
        await tx`
          INSERT INTO booking_draft_lines (
            id, draft_id, variant_id, quantity, unit_price_amount_minor,
            billable_unit_count, line_total_amount_minor, variant_snapshot
          ) VALUES (
            ${draftLineId}, ${draftId}, ${opts.variantId ?? base.variantId}, 1, ${unitPrice},
            ${billableUnitCount}, ${lineTotal}, ${tx.json({ name: 'Standard' })}
          )
        `;
      } else {
        await tx`
          INSERT INTO booking_draft_lines (
            id, draft_id, variant_id, quantity, unit_price_amount_minor,
            billable_unit_count, line_total_amount_minor, variant_snapshot,
            pricing_plan_id, pricing_plan_version, pricing_plan_type, pricing_public_label,
            pricing_requested_duration_minutes,
            pricing_billed_duration_minutes,
            pricing_billed_days,
            pricing_selected_window,
            pricing_amount_before_discount_minor,
            pricing_amount_after_discount_minor
          ) VALUES (
            ${draftLineId}, ${draftId}, ${opts.variantId ?? base.variantId}, 1, ${unitPrice},
            ${billableUnitCount}, ${lineTotal}, ${tx.json({ name: 'Standard' })},
            ${planId}, 1, ${planType}, ${planLabel},
            ${isHourly ? 480 : null},
            ${isHourly ? 480 : null},
            ${isHourly ? null : billableUnitCount},
            ${isHourly ? null : tx.json(dayWindow)},
            ${isHourly ? null : lineTotal},
            ${isHourly ? null : lineTotal}
          )
        `;
      }

      await tx`UPDATE booking_drafts SET status = 'CONVERTED' WHERE id = ${draftId}`;

      await tx`
        INSERT INTO payments (
          id, organization_id, draft_id, customer_user_id,
          status, amount_minor, currency,
          tax_status, tax_amount_minor, tax_rate_bps,
          commission_amount_minor,
          financial_terms_version, legal_terms_version,
          terms_acceptance_snapshot,
          connected_account_id,
          charge_model, settlement_merchant_mode, environment, succeeded_at
        ) VALUES (
          ${paymentId}, ${base.orgId}, ${draftId}, ${base.userId},
          'SUCCEEDED', ${lineTotal}, 'EUR',
          'NOT_APPLICABLE', 0, null,
          500, '1', '1',
          '{}'::jsonb,
          'acct_test123',
          'DESTINATION', 'CONNECTED_ACCOUNT', 'TEST', now()
        )
      `;

      await tx`
        INSERT INTO bookings (
          id, draft_id, payment_id, organization_id, location_id, customer_user_id,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
          subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
          tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
          billable_unit, billable_unit_count,
          cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at, status,
          pricing_snapshot_version, pricing_algorithm_version, pricing_rounding_rule_version,
          pricing_intent_type, pricing_intent_snapshot, pricing_resolved_locale
        ) VALUES (
          ${bookingId}, ${draftId}, ${paymentId}, ${base.orgId}, ${base.locationId}, ${base.userId},
          ${opts.startAt}, ${opts.endAt}, ${opts.startAt}, ${opts.endAt},
          'Europe/Paris', 30, 30, 'EUR',
          ${lineTotal}, 0, ${lineTotal},
          'NOT_APPLICABLE', 0, null, 500,
          ${billableUnit}, ${billableUnitCount},
          '{}'::jsonb, '{}'::jsonb, now(), 'CONFIRMED',
          ${isLegacy ? 'legacy-daily-v1' : 'flexible-pricing-v1'},
          ${isLegacy ? null : (opts.pricingAlgorithmVersion ?? 'flexible-pricing-v1')},
          ${isLegacy ? null : (opts.pricingRoundingRuleVersion ?? 'half-up-v1')},
          ${isLegacy ? null : (opts.pricingIntentType ?? 'DAY_RANGE')},
          ${isLegacy ? null : opts.pricingIntentSnapshot ? tx.json(opts.pricingIntentSnapshot as postgres.JSONValue) : null},
          ${isLegacy ? null : (opts.pricingResolvedLocale ?? 'fr-FR')}
        )
      `;

      if (isLegacy) {
        await tx`
          INSERT INTO booking_lines (
            id, booking_id, variant_id, quantity, unit_price_amount_minor,
            billable_unit_count, line_total_amount_minor, currency, variant_snapshot
          ) VALUES (
            ${bookingLineId}, ${bookingId}, ${opts.variantId ?? base.variantId}, 1, ${unitPrice},
            ${billableUnitCount}, ${lineTotal}, 'EUR', ${tx.json({ name: 'Standard' })}
          )
        `;
      } else {
        await tx`
          INSERT INTO booking_lines (
            id, booking_id, source_draft_line_id, variant_id, quantity, unit_price_amount_minor,
            billable_unit_count, line_total_amount_minor, currency, variant_snapshot,
            pricing_plan_id, pricing_plan_version, pricing_plan_type, pricing_public_label,
            pricing_requested_duration_minutes,
            pricing_billed_duration_minutes,
            pricing_billed_days,
            pricing_selected_window,
            pricing_amount_before_discount_minor,
            pricing_amount_after_discount_minor
          ) VALUES (
            ${bookingLineId}, ${bookingId}, ${draftLineId}, ${opts.variantId ?? base.variantId}, 1, ${unitPrice},
            ${billableUnitCount}, ${lineTotal}, 'EUR', ${tx.json({ name: 'Standard' })},
            ${planId}, 1, ${planType}, ${planLabel},
            ${isHourly ? 480 : null},
            ${isHourly ? 480 : null},
            ${isHourly ? null : billableUnitCount},
            ${isHourly ? null : tx.json(dayWindow)},
            ${isHourly ? null : lineTotal},
            ${isHourly ? null : lineTotal}
          )
        `;
      }
    });

    return { bookingId, lineId: bookingLineId };
  }

  it('1. Résolution de réservation originale TIME_RANGE', async () => {
    const base = await seedOrgAndUser(rawSql, 'orig-tr');
    const startAt = new Date('2026-06-01T08:00:00Z');
    const endAt = new Date('2026-06-01T16:00:00Z');

    const intentSnapshot = {
      kind: 'TIME_RANGE',
      startAt: '2026-06-01T10:00:00',
      endAt: '2026-06-01T18:00:00',
    };

    const { bookingId } = await seedBooking(rawSql, base, {
      startAt,
      endAt,
      billableUnit: 'MINUTE',
      billableUnitCount: 8,
      unitPriceMinor: 2000,
      pricingIntentType: 'TIME_RANGE',
      pricingIntentSnapshot: intentSnapshot,
    });

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      startAt,
      endAt,
    );

    expect(res.kind).toBe('SUCCESS');
    if (res.kind === 'SUCCESS') {
      expect(res.intent.kind).toBe('TIME_RANGE');
      if (res.intent.kind === 'TIME_RANGE') {
        expect(res.intent.startAt).toBe('2026-06-01T10:00');
        expect(res.intent.endAt).toBe('2026-06-01T18:00');
      }
    }
  });

  it('2. Résolution de réservation originale DAY_RANGE', async () => {
    const base = await seedOrgAndUser(rawSql, 'orig-dr');
    const startAt = new Date('2026-06-01T08:00:00Z');
    const endAt = new Date('2026-06-05T18:00:00Z');

    const intentSnapshot = {
      kind: 'DAY_RANGE',
      startDate: '2026-06-01',
      endDateExclusive: '2026-06-05',
    };

    const { bookingId } = await seedBooking(rawSql, base, {
      startAt,
      endAt,
      billableUnit: 'DAY',
      billableUnitCount: 4,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: intentSnapshot,
    });

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      startAt,
      endAt,
    );

    expect(res.kind).toBe('SUCCESS');
    if (res.kind === 'SUCCESS') {
      expect(res.intent.kind).toBe('DAY_RANGE');
      if (res.intent.kind === 'DAY_RANGE') {
        expect(res.intent.startDate).toBe('2026-06-01');
        expect(res.intent.endDateExclusive).toBe('2026-06-05');
      }
    }
  });

  it('3. Dernier amendement APPLIED changeant l intention effective', async () => {
    const base = await seedOrgAndUser(rawSql, 'applied-amend');
    const origStart = new Date('2026-06-01T08:00:00Z');
    const origEnd = new Date('2026-06-05T18:00:00Z');

    const { bookingId, lineId } = await seedBooking(rawSql, base, {
      startAt: origStart,
      endAt: origEnd,
      billableUnit: 'DAY',
      billableUnitCount: 4,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: {
        kind: 'DAY_RANGE',
        startDate: '2026-06-01',
        endDateExclusive: '2026-06-05',
      },
    });

    const amendmentId = crypto.randomUUID();
    const amendedStart = new Date('2026-06-10T08:00:00Z');
    const amendedEnd = new Date('2026-06-10T16:00:00Z');

    const amendedPricingSnapshot = {
      algorithmVersion: 'v1',
      intentSnapshot: {
        kind: 'TIME_RANGE',
        startAt: '2026-06-10T10:00:00',
        endAt: '2026-06-10T18:00:00',
      },
    };

    await rawSql`
      INSERT INTO booking_amendments (
        id, booking_id, organization_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at,
        applied_at, created_by
      ) VALUES (
        ${amendmentId}, ${bookingId}, ${base.orgId}, 1, 'NEUTRAL', 'READY_TO_APPLY',
        '{}'::jsonb, '{}'::jsonb,
        ${amendedStart}, ${amendedEnd}, ${amendedStart}, ${amendedEnd},
        null, ${base.userId}
      )
    `;

    await rawSql`
      INSERT INTO booking_amendment_lines (
        id, amendment_id, organization_id, logical_line_id, origin_type, source_booking_line_id,
        variant_id, action, before_quantity, before_unit_price_amount_minor,
        before_line_total_amount_minor, after_quantity, after_unit_price_amount_minor,
        after_line_total_amount_minor, pricing_snapshot, variant_snapshot
      ) VALUES (
        ${crypto.randomUUID()}, ${amendmentId}, ${base.orgId}, ${lineId}, 'ORIGINAL', ${lineId},
        ${base.variantId}, 'MODIFY', 1, 5000, 5000, 1, 5000, 5000,
        ${rawSql.json(amendedPricingSnapshot)}, '{}'::jsonb
      )
    `;
    await rawSql`UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendmentId}`;

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      amendedStart,
      amendedEnd,
    );

    expect(res.kind).toBe('SUCCESS');
    if (res.kind === 'SUCCESS') {
      expect(res.intent.kind).toBe('TIME_RANGE');
      if (res.intent.kind === 'TIME_RANGE') {
        expect(res.intent.startAt).toBe('2026-06-10T10:00');
        expect(res.intent.endAt).toBe('2026-06-10T18:00');
      }
    }
  });

  it('4. Plusieurs lignes avec snapshots cohérents', async () => {
    const base = await seedOrgAndUser(rawSql, 'multi-coherent');
    const amendmentId = crypto.randomUUID();
    const start = new Date('2026-07-01T08:00:00Z');
    const end = new Date('2026-07-03T18:00:00Z');

    const { bookingId, lineId } = await seedBooking(rawSql, base, {
      startAt: start,
      endAt: end,
      billableUnit: 'DAY',
      billableUnitCount: 2,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: {
        kind: 'DAY_RANGE',
        startDate: '2026-07-01',
        endDateExclusive: '2026-07-03',
      },
    });

    await rawSql`
      INSERT INTO booking_amendments (
        id, booking_id, organization_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at,
        applied_at, created_by
      ) VALUES (
        ${amendmentId}, ${bookingId}, ${base.orgId}, 1, 'NEUTRAL', 'READY_TO_APPLY',
        '{}'::jsonb, '{}'::jsonb,
        ${start}, ${end}, ${start}, ${end},
        null, ${base.userId}
      )
    `;

    await rawSql`
      INSERT INTO booking_amendment_lines (
        id, amendment_id, organization_id, logical_line_id, origin_type, source_booking_line_id,
        variant_id, action, before_quantity, before_unit_price_amount_minor,
        before_line_total_amount_minor, after_quantity, after_unit_price_amount_minor,
        after_line_total_amount_minor, pricing_snapshot, variant_snapshot
      ) VALUES
        (
          ${crypto.randomUUID()}, ${amendmentId}, ${base.orgId}, ${lineId}, 'ORIGINAL', ${lineId},
          ${base.variantId}, 'MODIFY', 1, 10000, 10000, 1, 10000, 10000,
          ${rawSql.json({ intentSnapshot: { kind: 'DAY_RANGE', startDate: '2026-07-01', endDateExclusive: '2026-07-03' } })}, '{}'::jsonb
        ),
        (
          ${crypto.randomUUID()}, ${amendmentId}, ${base.orgId}, ${crypto.randomUUID()}, 'AMENDMENT', null,
          ${base.variantId2}, 'ADD', 0, 0, 0, 1, 10000, 10000,
          ${rawSql.json({ intentSnapshot: { kind: 'DAY_RANGE', startDate: '2026-07-01', endDateExclusive: '2026-07-03' } })}, '{}'::jsonb
        )
    `;
    await rawSql`UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendmentId}`;

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      start,
      end,
    );
    expect(res.kind).toBe('SUCCESS');
    if (res.kind === 'SUCCESS') {
      expect(res.intent.kind).toBe('DAY_RANGE');
      if (res.intent.kind === 'DAY_RANGE') {
        expect(res.intent.startDate).toBe('2026-07-01');
        expect(res.intent.endDateExclusive).toBe('2026-07-03');
      }
    }
  });

  it('5. Snapshots incohérents entre lignes → échec fermé INVALID_INTENT', async () => {
    const base = await seedOrgAndUser(rawSql, 'incoherent');
    const amendmentId = crypto.randomUUID();
    const start = new Date('2026-07-01T08:00:00Z');
    const end = new Date('2026-07-03T18:00:00Z');

    const { bookingId, lineId } = await seedBooking(rawSql, base, {
      startAt: start,
      endAt: end,
      billableUnit: 'DAY',
      billableUnitCount: 2,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: {
        kind: 'DAY_RANGE',
        startDate: '2026-07-01',
        endDateExclusive: '2026-07-03',
      },
    });

    await rawSql`
      INSERT INTO booking_amendments (
        id, booking_id, organization_id, amendment_number, type, status,
        financial_snapshot_before, financial_snapshot_after,
        new_customer_start_at, new_customer_end_at, new_blocked_start_at, new_blocked_end_at,
        applied_at, created_by
      ) VALUES (
        ${amendmentId}, ${bookingId}, ${base.orgId}, 1, 'NEUTRAL', 'READY_TO_APPLY',
        '{}'::jsonb, '{}'::jsonb,
        ${start}, ${end}, ${start}, ${end},
        null, ${base.userId}
      )
    `;

    await rawSql`
      INSERT INTO booking_amendment_lines (
        id, amendment_id, organization_id, logical_line_id, origin_type, source_booking_line_id,
        variant_id, action, before_quantity, before_unit_price_amount_minor,
        before_line_total_amount_minor, after_quantity, after_unit_price_amount_minor,
        after_line_total_amount_minor, pricing_snapshot, variant_snapshot
      ) VALUES
        (
          ${crypto.randomUUID()}, ${amendmentId}, ${base.orgId}, ${lineId}, 'ORIGINAL', ${lineId},
          ${base.variantId}, 'MODIFY', 1, 10000, 10000, 1, 10000, 10000,
          ${rawSql.json({ intentSnapshot: { kind: 'DAY_RANGE', startDate: '2026-07-01', endDateExclusive: '2026-07-03' } })}, '{}'::jsonb
        ),
        (
          ${crypto.randomUUID()}, ${amendmentId}, ${base.orgId}, ${crypto.randomUUID()}, 'AMENDMENT', null,
          ${base.variantId2}, 'ADD', 0, 0, 0, 1, 10000, 10000,
          ${rawSql.json({ intentSnapshot: { kind: 'DAY_RANGE', startDate: '2026-07-05', endDateExclusive: '2026-07-08' } })}, '{}'::jsonb
        )
    `;
    await rawSql`UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendmentId}`;

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      start,
      end,
    );
    expect(res.kind).toBe('INVALID_INTENT');
  });

  it('6. Snapshot flexible malformé → échec fermé INVALID_INTENT', async () => {
    const base = await seedOrgAndUser(rawSql, 'malformed');
    const start = new Date('2026-07-01T08:00:00Z');
    const end = new Date('2026-07-03T18:00:00Z');

    const { bookingId } = await seedBooking(rawSql, base, {
      startAt: start,
      endAt: end,
      billableUnit: 'DAY',
      billableUnitCount: 2,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: { kind: 'INVALID_KIND' },
    });

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      start,
      end,
    );
    expect(res.kind).toBe('INVALID_INTENT');
  });

  it('7. Réservation legacy (sans flexible snapshot) → dérivation DAY_RANGE', async () => {
    const base = await seedOrgAndUser(rawSql, 'legacy');
    const start = new Date('2026-08-01T08:00:00Z');
    const end = new Date('2026-08-05T18:00:00Z');

    const { bookingId } = await seedBooking(rawSql, base, {
      startAt: start,
      endAt: end,
      billableUnit: 'DAY',
      billableUnitCount: 4,
      unitPriceMinor: 5000,
      pricingSnapshotVersion: 'legacy-daily-v1',
    });

    const res = await getEffectivePricingIntent(
      db,
      base.orgId,
      bookingId,
      'Europe/Paris',
      start,
      end,
    );
    expect(res.kind).toBe('SUCCESS');
    if (res.kind === 'SUCCESS') {
      expect(res.intent.kind).toBe('DAY_RANGE');
      if (res.intent.kind === 'DAY_RANGE') {
        expect(res.intent.startDate).toBe('2026-08-01');
        expect(res.intent.endDateExclusive).toBe('2026-08-05');
      }
    }
  });

  it('8. Tenant isolation : une autre organisation retourne NOT_FOUND', async () => {
    const baseA = await seedOrgAndUser(rawSql, 'iso-a');
    const baseB = await seedOrgAndUser(rawSql, 'iso-b');
    const start = new Date('2026-08-01T08:00:00Z');
    const end = new Date('2026-08-05T18:00:00Z');

    const { bookingId } = await seedBooking(rawSql, baseA, {
      startAt: start,
      endAt: end,
      billableUnit: 'DAY',
      billableUnitCount: 4,
      unitPriceMinor: 5000,
      pricingIntentType: 'DAY_RANGE',
      pricingIntentSnapshot: {
        kind: 'DAY_RANGE',
        startDate: '2026-08-01',
        endDateExclusive: '2026-08-05',
      },
    });

    const res = await getEffectivePricingIntent(
      db,
      baseB.orgId,
      bookingId,
      'Europe/Paris',
      start,
      end,
    );
    expect(res.kind).toBe('NOT_FOUND');
  });
});
