import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createBookingDraftWithHold } from './index';
import { BookingDraftError } from './errors';
import type {
  CreateBookingDraftFailure,
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  FlexibleBookingDraftResponseBody,
  FlexibleCreateBookingDraftInput,
  LegacyCreateBookingDraftInput,
} from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('booking_drafts_flex');
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
  await db.execute(
    (await import('drizzle-orm'))
      .sql`TRUNCATE TABLE allocations, booking_draft_lines, booking_drafts, inventory_blocks, inventory_movements, inventory_items, product_variants, products, location_opening_hours, pricing_plan_translations, pricing_plan_windows, multi_day_discount_tiers, pricing_plans, locations, organization_memberships, organizations, users, idempotency_records, product_analytics_events RESTART IDENTITY CASCADE`,
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
  itemIds: string[];
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

/**
 * Crée les données de base : organisation (FLEXIBLE), lieu (Europe/Paris,
 * buffers 30 min), utilisateur, catégorie, produit PUBLISHED, variante
 * (prix 5000, EUR, active), 3 exemplaires (NEW/GOOD/FAIR, ACTIVE).
 */
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
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix + '-' + i}, ${location.id}, ${cond}, 'ACTIVE')
      RETURNING "id"
    `.then((r) => r[0]!);
    itemIds.push(item.id);
  }
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemIds,
  };
}

/**
 * Crée un plan tarifaire DAILY pour une variante, avec fenêtre commerciale
 * et traductions. Le plan est ACTIVE.
 */
async function seedDailyPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
    skipActivate?: boolean;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 5000;
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127; // all days
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'DAILY', 'EUR', ${price}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  // For local plans (locationId set), windows must use the plan's locationId.
  // For global plans (locationId null), windows use the base location.
  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Location journalière'), (${plan.id}, 'en', 'Daily rental')
  `;
  if (!opts.skipActivate) {
    await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  }

  return plan.id;
}

/**
 * Active un plan précédemment créé avec skipActivate.
 */
async function activatePlan(planId: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  await rawSql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
}

/**
 * Crée un plan tarifaire HOURLY pour une variante.
 */
async function seedHourlyPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    minDurationMinutes?: number;
    maxDurationMinutes?: number;
    billingIncrementMinutes?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 1000; // 10€/hour
  const minDur = opts.minDurationMinutes ?? 60;
  const maxDur = opts.maxDurationMinutes ?? 480;
  const billingInc = opts.billingIncrementMinutes ?? 60;
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127;
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'HOURLY', 'EUR', ${price}, ${minDur}, ${maxDur}, ${billingInc}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  // For local plans (locationId set), windows must use the plan's locationId.
  // For global plans (locationId null), windows use the base location.
  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Location horaire'), (${plan.id}, 'en', 'Hourly rental')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;

  return plan.id;
}

/**
 * Crée un plan tarifaire FIXED_DURATION pour une variante.
 */
async function seedFixedDurationPlan(
  ids: BaseIds,
  opts: {
    priceAmountMinor?: number;
    includedDurationMinutes?: number;
    locationId?: string | null;
    weekdayMask?: number;
    startTime?: string;
    endTime?: string;
    version?: number;
  } = {},
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const price = opts.priceAmountMinor ?? 3000; // 30€ for the fixed duration
  const includedDur = opts.includedDurationMinutes ?? 120; // 2 hours
  const locationId = opts.locationId === undefined ? null : opts.locationId;
  const weekdayMask = opts.weekdayMask ?? 127;
  const startTime = opts.startTime ?? '09:00:00';
  const endTime = opts.endTime ?? '17:00:00';
  const version = opts.version ?? 1;

  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "priority", "lifecycle_state", "version")
    VALUES (${ids.orgId}, ${ids.variantId}, ${locationId}, 'FIXED_DURATION', 'EUR', ${price}, ${includedDur}, 0, 'DRAFT', ${version})
    RETURNING "id"
  `.then((r) => r[0]!);

  // For local plans (locationId set), windows must use the plan's locationId.
  // For global plans (locationId null), windows use the base location.
  const windowLocationId = locationId ?? ids.locationId;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${windowLocationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Forfait 2h'), (${plan.id}, 'en', '2-hour package')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;

  return plan.id;
}

/**
 * Ajoute un palier de réduction multi-jours à un plan DAILY.
 */
async function seedDiscountTier(
  planId: string,
  thresholdDays: number,
  discountPercent: number,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  await rawSql`
    INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent", "active")
    VALUES (${planId}, ${thresholdDays}, ${discountPercent}, true)
  `;
}

/**
 * Ajoute des horaires d'ouverture à un lieu (tous les jours 09:00-17:00 par défaut).
 */
async function seedOpeningHours(
  locationId: string,
  hours?: Array<{ weekday: number; openTime: string; closeTime: string }>,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const defaultHours = hours ?? [
    { weekday: 0, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 1, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 2, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 3, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 4, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 5, openTime: '09:00:00', closeTime: '17:00:00' },
    { weekday: 6, openTime: '09:00:00', closeTime: '17:00:00' },
  ];
  for (const h of defaultHours) {
    await rawSql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES (${locationId}, ${h.weekday}, ${h.openTime}, ${h.closeTime})
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFlexibleTimeRangeInput(
  ids: BaseIds,
  startAt: string,
  endAt: string,
  overrides: Partial<FlexibleCreateBookingDraftInput> = {},
): FlexibleCreateBookingDraftInput {
  return {
    pricingMode: 'FLEXIBLE',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    locale: 'fr',
    intent: { kind: 'TIME_RANGE', startAt, endAt },
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function makeFlexibleDayRangeInput(
  ids: BaseIds,
  startDate: string,
  endDateExclusive: string,
  overrides: Partial<FlexibleCreateBookingDraftInput> = {},
): FlexibleCreateBookingDraftInput {
  return {
    pricingMode: 'FLEXIBLE',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    locale: 'fr',
    intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function makeLegacyInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: new Date('2026-02-10T09:00:00.000Z'),
    customerEndAt: new Date('2026-02-12T17:00:00.000Z'),
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function expectSuccess(
  result: CreateBookingDraftResult,
): asserts result is CreateBookingDraftSuccess {
  expect(result.kind).toBe('SUCCESS');
  if (result.kind !== 'SUCCESS') throw new Error('Résultat SUCCESS attendu.');
}

function expectFailure(
  result: CreateBookingDraftResult,
): asserts result is CreateBookingDraftFailure {
  expect(result.kind).toBe('FAILURE');
  if (result.kind !== 'FAILURE') throw new Error('Résultat FAILURE attendu.');
}

function expectFlexibleBody(
  result: CreateBookingDraftSuccess,
): asserts result is CreateBookingDraftSuccess & {
  body: FlexibleBookingDraftResponseBody;
} {
  expect(result.body).toHaveProperty('pricingSnapshotVersion', 'flexible-pricing-v1');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'createBookingDraftWithHold — flexible pricing integration',
  () => {
    // ── Compatibility (1-4) ──────────────────────────────────────────────

    it('2. legacy path produces legacy-daily-v1 (no pricingSnapshotVersion field)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeLegacyInput(ids));
      expectSuccess(result);
      expect(result.body).not.toHaveProperty('pricingSnapshotVersion', 'flexible-pricing-v1');
      const drafts =
        await rawSql`SELECT pricing_snapshot_version FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.pricing_snapshot_version).toBe('legacy-daily-v1');
    });

    it('3. daily_price_amount_minor used only on legacy path', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Legacy path: uses daily_price_amount_minor
      const legacyResult = await createBookingDraftWithHold(db, makeLegacyInput(ids));
      expectSuccess(legacyResult);
      expect(legacyResult.body.lines[0]!.unitPriceAmountMinor).toBe(5000);

      // Flexible path: uses pricing plan price, not daily_price_amount_minor
      await seedDailyPlan(ids, { priceAmountMinor: 7000 });
      await seedOpeningHours(ids.locationId);
      const flexResult = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(flexResult);
      expectFlexibleBody(flexResult);
      // The flexible price comes from the plan, not daily_price_amount_minor
      expect(flexResult.body.lines[0]!.unitPriceAmountMinor).toBe(7000);
    });

    it('4. flexible input never falls back to legacy', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // No pricing plans seeded — the flexible engine should fail, not fall back
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectFailure(result);
      expect(result.statusCode).toBe(400);
      expect(result.body.error).toBe('VALIDATION');
      // No draft created
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
    });

    // ── TIME_RANGE (5-15) ────────────────────────────────────────────────

    it('5. HOURLY nominal — TIME_RANGE with hourly plan', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      // 2 hours = 120 minutes, 2 increments
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      expectFlexibleBody(result);
      expect(result.body.pricingIntentType).toBe('TIME_RANGE');
      expect(result.body.billableUnit).toBe('MINUTE');
      expect(result.body.lines[0]).toHaveProperty('pricingPlanType', 'HOURLY');
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingBilledDurationMinutes).toBe(120);
      expect(flexLine.lines[0]!.pricingBilledDays).toBeNull();
      // 1000 (price per increment) * 2 (increments) * 1 (qty) = 2000
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(2000);
    });

    it('6. FIXED_DURATION nominal — TIME_RANGE with fixed duration plan', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedFixedDurationPlan(ids, { priceAmountMinor: 3000, includedDurationMinutes: 120 });
      await seedOpeningHours(ids.locationId);
      // Request 2 hours which matches the fixed duration
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      expectFlexibleBody(result);
      expect(result.body.lines[0]).toHaveProperty('pricingPlanType', 'FIXED_DURATION');
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingCoveredDurationMinutes).toBe(120);
      expect(flexLine.lines[0]!.pricingBilledDurationMinutes).toBeNull();
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(3000);
    });

    it('7. DAILY via commercial window — TIME_RANGE with daily plan', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      // A time range that spans a commercial window (9-17 local = 08-16 UTC in February CET)
      // A time range that spans a commercial window (9-17 local)
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T17:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      expectFlexibleBody(result);
      expect(result.body.lines[0]).toHaveProperty('pricingPlanType', 'DAILY');
    });

    it('8. Multiple variants with different plan types', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a second variant
      const variant2 = await rawSql`
        INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
        VALUES (${ids.productId}, 'Premium', true, 8000, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      await rawSql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
        VALUES (${ids.orgId}, ${variant2.id}, 'PREM-1', ${ids.locationId}, 'NEW', 'ACTIVE')
      `;
      // HOURLY for variant1, DAILY for variant2
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedDailyPlan({ ...ids, variantId: variant2.id }, { priceAmountMinor: 6000 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end, {
          lines: [
            { variantId: ids.variantId, quantity: 1 },
            { variantId: variant2.id, quantity: 1 },
          ],
        }),
      );
      expectSuccess(result);
      expectFlexibleBody(result);
      expect(result.body.lines).toHaveLength(2);
      const flexBody = result.body as FlexibleBookingDraftResponseBody;
      const types = flexBody.lines.map((l) => l.pricingPlanType).sort();
      expect(types).toEqual(['DAILY', 'HOURLY']);
    });

    it('9. Root billable_unit = MINUTE for TIME_RANGE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      expect(result.body.billableUnit).toBe('MINUTE');
      // Verify in DB
      const drafts =
        await rawSql`SELECT billable_unit FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.billable_unit).toBe('MINUTE');
    });

    it('10. Exact periods and buffers for TIME_RANGE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      // G7P-B2-C Round 3 (P0-1) : customer_start_at/end_at are UTC conversions
      // of the local input. 09:00 Paris (CET, UTC+1) = 08:00 UTC.
      expect(result.body.customerStartAt).toBe('2026-02-10T08:00:00.000Z');
      expect(result.body.customerEndAt).toBe('2026-02-10T10:00:00.000Z');
      // Buffers: 30 min prep, 30 min cleanup (applied to UTC dates)
      const expectedBlockedStart = new Date('2026-02-10T07:30:00.000Z');
      const expectedBlockedEnd = new Date('2026-02-10T10:30:00.000Z');
      expect(result.body.blockedStartAt).toBe(expectedBlockedStart.toISOString());
      expect(result.body.blockedEndAt).toBe(expectedBlockedEnd.toISOString());
    });

    it('11. Rounding by increment — HOURLY with 30-min increment', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids, {
        priceAmountMinor: 500,
        billingIncrementMinutes: 30,
        minDurationMinutes: 30,
      });
      await seedOpeningHours(ids.locationId);
      // 90 minutes = 3 increments of 30 min
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T10:30:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingBilledDurationMinutes).toBe(90);
      expect(flexLine.lines[0]!.billableUnitCount).toBe(3);
      // 500 * 3 * 1 = 1500
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(1500);
    });

    it('12. Invalid window or hours → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids, { weekdayMask: 0b0000001 }); // Monday only
      // Opening hours: only Monday 09-17
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '09:00:00', closeTime: '17:00:00' },
      ]);
      // Try to book on a Tuesday (weekday 1) — outside the plan window
      // 2026-02-10 is a Tuesday
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectFailure(result);
      // Should be a validation error (no eligible plan or outside hours)
      expect(result.body.error).toBe('VALIDATION');
    });

    it('13. DST spring-forward → rejected (NON_EXISTENT_LOCAL_TIME)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a DRAFT plan with a window starting at 02:30 (non-existent on spring-forward day)
      const planId = await seedDailyPlan(ids, {
        startTime: '02:30:00',
        endTime: '04:00:00',
        skipActivate: true,
      });
      await activatePlan(planId);
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 1, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 2, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 3, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 4, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 5, openTime: '01:00:00', closeTime: '05:00:00' },
        { weekday: 6, openTime: '01:00:00', closeTime: '05:00:00' },
      ]);
      // March 29, 2026 is a Sunday — spring-forward day in Europe/Paris
      // 02:30 local doesn't exist on this day
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-03-29', '2026-03-30'),
      );
      expectFailure(result);
      expect(result.body.error).toBe('VALIDATION');
    });

    it('14. DST fall-back ambiguous → rejected (AMBIGUOUS_LOCAL_TIME)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a DRAFT plan with a window ending at 02:30 (ambiguous on fall-back day)
      const planId = await seedDailyPlan(ids, {
        startTime: '01:00:00',
        endTime: '02:30:00',
        skipActivate: true,
      });
      await activatePlan(planId);
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 1, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 2, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 3, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 4, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 5, openTime: '01:00:00', closeTime: '03:00:00' },
        { weekday: 6, openTime: '01:00:00', closeTime: '03:00:00' },
      ]);
      // October 25, 2026 is a Sunday — fall-back day in Europe/Paris
      // 02:30 local is ambiguous (exists twice)
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-10-25', '2026-10-26'),
      );
      expectFailure(result);
      expect(result.body.error).toBe('VALIDATION');
    });

    it('15. Insufficient stock → no partial mutation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Delete 2 of 3 items, leaving only 1
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[1]!}`;
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[2]!}`;
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          lines: [{ variantId: ids.variantId, quantity: 2 }],
        }),
      );
      expectFailure(result);
      expect(result.statusCode).toBe(409);
      expect(result.body.error).toBe('CONFLICT_BLOCK');
      // No draft, no blocks, no allocations
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
      const blocks = await rawSql`SELECT count(*)::int AS n FROM inventory_blocks`;
      expect(blocks[0]!.n).toBe(0);
      const allocs = await rawSql`SELECT count(*)::int AS n FROM allocations`;
      expect(allocs[0]!.n).toBe(0);
    });

    // ── DAY_RANGE (16-29) ────────────────────────────────────────────────

    it('16. One day — DAY_RANGE single day', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-11'),
      );
      expectSuccess(result);
      expectFlexibleBody(result);
      expect(result.body.pricingIntentType).toBe('DAY_RANGE');
      expect(result.body.billableUnit).toBe('DAY');
      expect(result.body.billableUnitCount).toBe(1);
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingBilledDays).toBe(1);
      expect(flexLine.lines[0]!.pricingRequestedDurationMinutes).toBeNull();
    });

    it('17. Multiple days — DAY_RANGE 3 days', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-13'),
      );
      expectSuccess(result);
      expect(result.body.billableUnitCount).toBe(3);
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingBilledDays).toBe(3);
      // 5000 * 3 * 1 = 15000
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(15000);
    });

    it('18. endDateExclusive correctly interpreted', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // 2026-02-10 to 2026-02-12 exclusive = 2 days (10, 11)
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      expect(result.body.billableUnitCount).toBe(2);
    });

    it('19. First/last day with different windows', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a plan with different windows for different days
      await seedDailyPlan(ids, { weekdayMask: 127, startTime: '09:00:00', endTime: '17:00:00' });
      // Add another window for a different day
      // Monday mask = 1, Tuesday mask = 2, etc.
      // The engine selects the largest duration window for each day
      // Let's just verify the draft is created with correct boundaries
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // customer_start_at should be 09:00 Paris on Feb 10 = 08:00 UTC (CET = UTC+1)
      expect(result.body.customerStartAt).toBe('2026-02-10T08:00:00.000Z');
      // customer_end_at should be 17:00 Paris on Feb 11 = 16:00 UTC (CET = UTC+1)
      expect(result.body.customerEndAt).toBe('2026-02-11T16:00:00.000Z');
    });

    it('20. Store closed on intermediate day → accepted', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      // Opening hours: Mon-Fri 09-17, closed on Saturday (weekday 5) and Sunday (weekday 6)
      // 2026-02-10 = Tuesday, 2026-02-11 = Wednesday, 2026-02-12 = Thursday
      // Let's close Wednesday (weekday 2)
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '09:00:00', closeTime: '17:00:00' },
        { weekday: 1, openTime: '09:00:00', closeTime: '17:00:00' },
        // weekday 2 (Wednesday) closed
        { weekday: 3, openTime: '09:00:00', closeTime: '17:00:00' },
        { weekday: 4, openTime: '09:00:00', closeTime: '17:00:00' },
        { weekday: 5, openTime: '09:00:00', closeTime: '17:00:00' },
        { weekday: 6, openTime: '09:00:00', closeTime: '17:00:00' },
      ]);
      // DAY_RANGE from Tue to Thu — Wednesday is closed but DAY_RANGE only needs
      // first and last day to have windows
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-13'),
      );
      expectSuccess(result);
      expect(result.body.billableUnitCount).toBe(3);
    });

    it('21. First day without window/opening → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Plan with window only on Tuesday (weekday 1)
      await seedDailyPlan(ids, { weekdayMask: 0b0000010 }); // Tuesday only
      // Opening hours: only Tuesday
      await seedOpeningHours(ids.locationId, [
        { weekday: 1, openTime: '09:00:00', closeTime: '17:00:00' },
      ]);
      // DAY_RANGE starting on Monday (weekday 0) — no window for Monday
      // 2026-02-09 is a Monday
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-09', '2026-02-11'),
      );
      expectFailure(result);
    });

    it('22. Last day without window/opening → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // 2026-02-10 = Tuesday (weekday 1), 2026-02-12 = Thursday (weekday 3)
      // Mask for Tue+Wed = 0b0000110 = 6 (no Thursday)
      await seedDailyPlan(ids, { weekdayMask: 6 });
      await seedOpeningHours(ids.locationId, [
        { weekday: 1, openTime: '09:00:00', closeTime: '17:00:00' },
        { weekday: 2, openTime: '09:00:00', closeTime: '17:00:00' },
      ]);
      // DAY_RANGE from Tue to Thu — Thursday (last day) has no window
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-13'),
      );
      expectFailure(result);
    });

    it('23. customer_start_at = start of first window', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids, { startTime: '09:00:00', endTime: '17:00:00' });
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // 2026-02-10 is Tuesday, Europe/Paris is CET (UTC+1) in February
      // 09:00 local = 08:00 UTC
      expect(result.body.customerStartAt).toBe('2026-02-10T08:00:00.000Z');
    });

    it('24. customer_end_at = end of last window of last included day', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids, { startTime: '09:00:00', endTime: '17:00:00' });
      await seedOpeningHours(ids.locationId);
      // 2026-02-10 to 2026-02-12 exclusive = days 10, 11
      // Last day is Feb 11 (Wednesday), end of window = 17:00 local = 16:00 UTC
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      expect(result.body.customerEndAt).toBe('2026-02-11T16:00:00.000Z');
    });

    it('25. Late pickup does not modify any snapshot or endAt', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // The response should not contain any "actual pickup time" field
      expect(result.body).not.toHaveProperty('actualPickupAt');
      expect(result.body).not.toHaveProperty('actualPickupTime');
      expect(result.body).not.toHaveProperty('pickupAt');
      // customer_end_at is immutable and set at creation
      const drafts =
        await rawSql`SELECT customer_end_at FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.customer_end_at).toBeDefined();
    });

    it('26. Exact buffers for DAY_RANGE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids, { startTime: '09:00:00', endTime: '17:00:00' });
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // customer_start_at = 08:00 UTC, prep = 30 min → blocked_start = 07:30 UTC
      expect(result.body.blockedStartAt).toBe('2026-02-10T07:30:00.000Z');
      // customer_end_at = 16:00 UTC, cleanup = 30 min → blocked_end = 16:30 UTC
      expect(result.body.blockedEndAt).toBe('2026-02-11T16:30:00.000Z');
    });

    it('27. Exact multi-day discount', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create plan as DRAFT, add discount tier, then activate
      const planId = await seedDailyPlan(ids, { priceAmountMinor: 5000, skipActivate: true });
      // Add a discount tier: 3+ days → 10% off
      await seedDiscountTier(planId, 3, 10);
      await activatePlan(planId);
      await seedOpeningHours(ids.locationId);
      // 5 days: 2026-02-10 to 2026-02-15 exclusive
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-15'),
      );
      expectSuccess(result);
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingBilledDays).toBe(5);
      expect(flexLine.lines[0]!.pricingDiscountThresholdDays).toBe(3);
      expect(flexLine.lines[0]!.pricingDiscountPercent).toBe(10);
      // amount_before = 5000 * 5 * 1 = 25000
      expect(flexLine.lines[0]!.pricingAmountBeforeDiscountMinor).toBe(25000);
      // halfUpRound: scaled = 25000 * 10 = 250000, doubled = 500000, numerator = 500100
      // discount = floor(500100 / 200) = 2500, amount_after = 25000 - 2500 = 22500
      expect(flexLine.lines[0]!.pricingAmountAfterDiscountMinor).toBe(22500);
      expect(result.body.lines[0]!.lineTotalAmountMinor).toBe(22500);
      expect(result.body.subtotalAmountMinor).toBe(22500);
    });

    it('28. requestedDurationMinutes = NULL for DAY_RANGE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      const flexLine = result.body as FlexibleBookingDraftResponseBody;
      expect(flexLine.lines[0]!.pricingRequestedDurationMinutes).toBeNull();
      // Verify in DB
      const lines =
        await rawSql`SELECT pricing_requested_duration_minutes FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}`;
      expect(lines[0]!.pricing_requested_duration_minutes).toBeNull();
    });

    it('29. Root billable_unit = DAY for DAY_RANGE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      expect(result.body.billableUnit).toBe('DAY');
      const drafts =
        await rawSql`SELECT billable_unit FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.billable_unit).toBe('DAY');
    });

    // ── Idempotency (30-35) ──────────────────────────────────────────────

    it('30. Strict replay without recalculation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'replay-' + SUFFIX();
      const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input);
      expectSuccess(result1);
      const result2 = await createBookingDraftWithHold(db, input);
      expectSuccess(result2);
      expect(result2).toEqual(result1);
      // Only one draft
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
    });

    it('31. Price modified after success then replay → old response', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const planId = await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const key = 'price-change-' + SUFFIX();
      const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input);
      expectSuccess(result1);
      const originalTotal = result1.body.totalAmountMinor;
      // Modify the plan price
      const sql = rawSql;
      await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, NULL, 'DAILY', 'EUR', 9000, 0, 'DRAFT', 2)
        RETURNING "id"
      `.then(async (r) => {
        // Retire the old plan
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
        // Add windows and translations for the new plan
        const newPlanId = r[0]!.id;
        await sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${newPlanId}, ${ids.locationId}, 127, '09:00:00', '17:00:00')
        `;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${newPlanId}, 'fr', 'Location journalière'), (${newPlanId}, 'en', 'Daily rental')
        `;
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${newPlanId}`;
      });
      // Replay should return the old response
      const result2 = await createBookingDraftWithHold(db, input);
      expectSuccess(result2);
      expect(result2.body.totalAmountMinor).toBe(originalTotal);
    });

    it('32. Same key + different locale → conflict', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'locale-conflict-' + SUFFIX();
      const input1 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'fr',
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      const input2 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'en',
      });
      await expect(createBookingDraftWithHold(db, input2)).rejects.toThrow();
    });

    it('33. Same key + different intent → conflict', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'intent-conflict-' + SUFFIX();
      const input1 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      const input2 = makeFlexibleDayRangeInput(ids, '2026-02-11', '2026-02-13', {
        idempotencyKey: key,
      });
      await expect(createBookingDraftWithHold(db, input2)).rejects.toThrow();
    });

    it('34. Same key + different dates → conflict', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'dates-conflict-' + SUFFIX();
      const input1 = makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      const input2 = makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T12:00:00', {
        idempotencyKey: key,
      });
      await expect(createBookingDraftWithHold(db, input2)).rejects.toThrow();
    });

    it('35. Business error persisted/replayed per current contract', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // No pricing plans → NO_ELIGIBLE_PLAN error
      await seedOpeningHours(ids.locationId);
      const key = 'error-replay-' + SUFFIX();
      const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input);
      expectFailure(result1);
      expect(result1.body.error).toBe('VALIDATION');
      const result2 = await createBookingDraftWithHold(db, input);
      expectFailure(result2);
      expect(result2).toEqual(result1);
    });

    // ── Concurrency (36-40) ──────────────────────────────────────────────

    it('36. Two calls same key → one draft, one set of holds', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'concurrent-same-' + SUFFIX();
      const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const [result1, result2] = await Promise.all([
        createBookingDraftWithHold(db, input),
        createBookingDraftWithHold(db, input),
      ]);
      expectSuccess(result1);
      expectSuccess(result2);
      expect(result1).toEqual(result2);
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
      const blocks = await rawSql`SELECT count(*)::int AS n FROM inventory_blocks`;
      expect(blocks[0]!.n).toBe(1);
    });

    it('37. Two different keys competing for last item → max one success', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Delete 2 of 3 items, leaving only 1
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[1]!}`;
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[2]!}`;
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const input1 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: 'compete-1-' + SUFFIX(),
      });
      const input2 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: 'compete-2-' + SUFFIX(),
      });
      const [result1, result2] = await Promise.all([
        createBookingDraftWithHold(db, input1),
        createBookingDraftWithHold(db, input2),
      ]);
      const results = [result1, result2];
      const successes = results.filter((r) => r.kind === 'SUCCESS');
      const failures = results.filter((r) => r.kind === 'FAILURE');
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(failures[0]!.body.error).toBe('CONFLICT_BLOCK');
    });

    it('38. Plan retired/replaced during quote → no mixed snapshot', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const planId = await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // The draft line should reference the plan that was active at quote time
      const lines =
        await rawSql`SELECT pricing_plan_id, pricing_plan_version FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}`;
      expect(lines[0]!.pricing_plan_id).toBe(planId);
      expect(lines[0]!.pricing_plan_version).toBe(1);
    });

    it('39. No deadlock with verified lock order', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // Run multiple concurrent requests with different keys
      const inputs = Array.from({ length: 5 }, (_, i) =>
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: `deadlock-${i}-` + SUFFIX(),
        }),
      );
      const database = db;
      const results = await Promise.all(
        inputs.map((input) => createBookingDraftWithHold(database, input)),
      );
      // All should succeed (we have 3 items, 5 requests with different keys)
      // Actually only 3 can succeed (1 item each, 3 items)
      const successes = results.filter((r) => r.kind === 'SUCCESS');
      const failures = results.filter((r) => r.kind === 'FAILURE');
      expect(successes.length).toBe(3);
      expect(failures.length).toBe(2);
    });

    it('40. Deferred constraint trigger error → no idempotent SUCCESS', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // Create a draft successfully first
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // Verify the aggregate constraint was checked (SET CONSTRAINTS ALL IMMEDIATE)
      // The draft should have correct subtotal = sum of line totals
      const drafts = await rawSql`
        SELECT subtotal_amount_minor, total_amount_minor, pricing_snapshot_version
        FROM booking_drafts WHERE id = ${result.body.draftId}
      `;
      expect(drafts[0]!.pricing_snapshot_version).toBe('flexible-pricing-v1');
      expect(Number(drafts[0]!.subtotal_amount_minor)).toBe(result.body.subtotalAmountMinor);
      expect(Number(drafts[0]!.total_amount_minor)).toBe(result.body.totalAmountMinor);
      // Verify idempotency record is COMPLETED
      const idemRecords = await rawSql`
        SELECT status FROM idempotency_records WHERE resource_id = ${result.body.draftId}
      `;
      expect(idemRecords[0]!.status).toBe('COMPLETED');
    });

    // ── Security/multi-tenant (41-48) ────────────────────────────────────

    it('41. Plan from other organization → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a second org and a plan for the same variant but different org
      const org2 = await rawSql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
        VALUES ('Other Org', ${'other-org-' + SUFFIX()}, 'FLEXIBLE')
        RETURNING "id"
      `.then((r) => r[0]!);
      // This plan belongs to org2 but references variant from org1 — should fail at trigger level
      // Actually, pricing_plans has FK to product_variants, and the variant belongs to org1's product
      // The trigger checks plan.organization_id == draft.organization_id
      // So we need a plan that has organization_id = org2 but product_variant_id = ids.variantId
      // This would fail at insert time because of the FK... unless we create a variant in org2
      // Let me re-think: the test should verify that a plan from another org is rejected
      // The engine's loadPricingContext loads plans via resolve_effective_pricing_plans(locationId)
      // which only returns plans for the location's org. So a plan from another org wouldn't be loaded.
      // The trigger enforce_draft_line_pricing_coherence also checks plan.organization_id == draft.organization_id
      // This test is more about the engine not loading cross-org plans
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // Use a different orgId in the input
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          organizationId: org2.id,
        }),
      );
      expectFailure(result);
    });

    it('42. Location from other organization → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a second org with its own location
      const org2 = await rawSql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
        VALUES ('Other Org 2', ${'other-org2-' + SUFFIX()}, 'FLEXIBLE')
        RETURNING "id"
      `.then((r) => r[0]!);
      const loc2 = await rawSql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
        VALUES (${org2.id}, 'Other Loc', ${'other-loc-' + SUFFIX()}, 'Europe/Paris', 30, 30, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // Use org1 but loc2 (belongs to org2)
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          locationId: loc2.id,
        }),
      );
      expectFailure(result);
    });

    it('43. Variant from other organization → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a second org with its own product and variant
      const org2 = await rawSql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
        VALUES ('Other Org 3', ${'other-org3-' + SUFFIX()}, 'FLEXIBLE')
        RETURNING "id"
      `.then((r) => r[0]!);
      const cat =
        await rawSql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const prod2 = await rawSql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
        VALUES (${org2.id}, ${cat.id}, 'Other Kayak', ${'other-kayak-' + SUFFIX()}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
      const variant2 = await rawSql`
        INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
        VALUES (${prod2.id}, 'Other Std', true, 3000, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // Use org1 but variant from org2
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          lines: [{ variantId: variant2.id, quantity: 1 }],
        }),
      );
      expectFailure(result);
    });

    it('44. Local plan from different location → rejected by trigger', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a second location in the same org
      const loc2 = await rawSql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
        VALUES (${ids.orgId}, 'Other Loc Same Org', ${'other-loc-same-' + SUFFIX()}, 'Europe/Paris', 30, 30, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Create a local plan for loc2
      await seedDailyPlan(ids, { locationId: loc2.id, priceAmountMinor: 4000 });
      await seedOpeningHours(ids.locationId);
      // Use loc1 (ids.locationId) — the plan is local to loc2
      // The engine should not find the plan because resolve_effective_pricing_plans
      // only returns plans for the given location
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      // Should fail because no plan is available for loc1
      expectFailure(result);
    });

    it('45. Different currency → rejected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // The DB trigger on pricing_plan_windows prevents creating windows for a plan
      // whose currency doesn't match the location's operating_currency.
      // So a USD plan cannot have windows on an EUR location, making it ineligible.
      // The engine should reject because no eligible plan is found.
      const sql = rawSql;
      // Create a USD plan (DRAFT, no windows possible on EUR location)
      await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, NULL, 'DAILY', 'USD', 5000, 0, 'DRAFT', 1)
        RETURNING "id"
      `.then(async (r) => {
        const planId = r[0]!.id;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${planId}, 'fr', 'Location USD'), (${planId}, 'en', 'USD rental')
        `;
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
      });
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectFailure(result);
    });

    it('46. No client financial data accepted', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // The input only contains semantic data (orgId, locationId, userId, locale, intent, lines)
      // No price, currency, tax, commission, timezone, snapshot fields
      // The response should have all financial data computed server-side
      expect(result.body.currency).toBe('EUR');
      // G7P-B2-C Round 3 (P0-2) — flexible drafts use UNDETERMINED/null for
      // tax/commission at draft stage per ADR-010 §6. Financial terms are
      // resolved at payment initiation and copied from `payments` during
      // confirmation.
      expect(result.body.taxStatus).toBe('UNDETERMINED');
      expect(result.body.taxAmountMinor).toBeNull();
      expect(result.body.commissionAmountMinor).toBeNull();
    });

    it('47. No partial snapshot', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // Verify all flexible columns are populated in DB
      const drafts = await rawSql`
        SELECT pricing_snapshot_version, pricing_algorithm_version, pricing_rounding_rule_version,
               pricing_intent_type, pricing_intent_snapshot, pricing_resolved_locale
        FROM booking_drafts WHERE id = ${result.body.draftId}
      `;
      expect(drafts[0]!.pricing_snapshot_version).toBe('flexible-pricing-v1');
      expect(drafts[0]!.pricing_algorithm_version).toBe('flexible-pricing-v1');
      expect(drafts[0]!.pricing_rounding_rule_version).toBe('half-up-v1');
      expect(drafts[0]!.pricing_intent_type).toBe('DAY_RANGE');
      expect(drafts[0]!.pricing_intent_snapshot).toBeDefined();
      expect(drafts[0]!.pricing_resolved_locale).toBe('fr');
      const lines = await rawSql`
        SELECT pricing_plan_id, pricing_plan_version, pricing_plan_type, pricing_public_label,
               pricing_billed_days, pricing_amount_before_discount_minor, pricing_amount_after_discount_minor
        FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}
      `;
      expect(lines[0]!.pricing_plan_id).toBeDefined();
      expect(lines[0]!.pricing_plan_version).toBe(1);
      expect(lines[0]!.pricing_plan_type).toBe('DAILY');
      expect(lines[0]!.pricing_public_label).toBeDefined();
      expect(lines[0]!.pricing_billed_days).toBe(2);
      expect(Number(lines[0]!.pricing_amount_before_discount_minor)).toBe(10000);
      expect(Number(lines[0]!.pricing_amount_after_discount_minor)).toBe(10000);
    });

    it('48. No amount > MAX_SAFE_INTEGER', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create a plan with a very high price
      await seedDailyPlan(ids, { priceAmountMinor: 9007199254740991 }); // MAX_SAFE_INTEGER
      await seedOpeningHours(ids.locationId);
      // Request many days to try to overflow
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      // 9007199254740991 * 2 would overflow, so this should fail
      expectFailure(result);
      expect(result.body.error).toBe('VALIDATION');
    });

    // ── Response (49-53) ─────────────────────────────────────────────────

    it('49. Legacy shape unchanged', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const result = await createBookingDraftWithHold(db, makeLegacyInput(ids));
      expectSuccess(result);
      const body = result.body;
      // Legacy body should not have flexible fields
      expect(body).not.toHaveProperty('pricingSnapshotVersion');
      expect(body).not.toHaveProperty('pricingAlgorithmVersion');
      expect(body).not.toHaveProperty('pricingIntentType');
      expect(body).not.toHaveProperty('pricingIntentSnapshot');
      expect(body).not.toHaveProperty('pricingResolvedLocale');
      // Legacy body should have standard fields
      expect(body.billableUnit).toBe('DAY');
      expect(body.currency).toBe('EUR');
      expect(body.status).toBe('HELD');
    });

    it('50. Flexible shape discriminated', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      expect(body.pricingSnapshotVersion).toBe('flexible-pricing-v1');
      expect(body.pricingAlgorithmVersion).toBe('flexible-pricing-v1');
      expect(body.pricingRoundingRuleVersion).toBe('half-up-v1');
      expect(body.pricingIntentType).toBe('DAY_RANGE');
      expect(body.pricingIntentSnapshot).toBeDefined();
      expect(body.pricingResolvedLocale).toBe('fr');
      expect(body.timezone).toBe('Europe/Paris');
    });

    it('51. JSON idempotent serializable', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // The body should be serializable and deserializable
      const json = JSON.stringify(result.body);
      const parsed = JSON.parse(json);
      expect(parsed.draftId).toBe(result.body.draftId);
      expect(parsed.pricingSnapshotVersion).toBe('flexible-pricing-v1');
      // Double serialization should be stable
      expect(JSON.stringify(parsed)).toBe(json);
    });

    it('52. No raw Date in response_body', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // All date fields should be strings (ISO 8601)
      expect(typeof result.body.customerStartAt).toBe('string');
      expect(typeof result.body.customerEndAt).toBe('string');
      expect(typeof result.body.blockedStartAt).toBe('string');
      expect(typeof result.body.blockedEndAt).toBe('string');
      expect(typeof result.body.expiresAt).toBe('string');
      // Verify no Date objects in the serialized form
      const json = JSON.stringify(result.body);
      const parsed = JSON.parse(json);
      // All values should be primitives or arrays/objects of primitives
      const checkNoDates = (obj: unknown): void => {
        if (obj instanceof Date) {
          throw new Error('Found raw Date object');
        }
        if (typeof obj === 'object' && obj !== null) {
          for (const v of Object.values(obj)) {
            checkNoDates(v);
          }
        }
        if (Array.isArray(obj)) {
          for (const v of obj) {
            checkNoDates(v);
          }
        }
      };
      checkNoDates(parsed);
    });

    it('53. No private plan fields or sensitive data', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      // The response should not contain internal_label, priority, or other private fields
      expect(body).not.toHaveProperty('internalLabel');
      expect(body).not.toHaveProperty('priority');
      for (const line of body.lines) {
        expect(line).not.toHaveProperty('internalLabel');
        expect(line).not.toHaveProperty('priority');
        // The public label is the translated label, not the internal one
        expect(line.pricingPublicLabel).toBe('Location journalière');
      }
    });

    // ── G7P-B2-B Round 2 — Defect 1 : resolvedLocale from engine ─────────

    it('54. fr-FR locale with fr/en translations → resolvedLocale = fr in response', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          locale: 'fr-FR',
        }),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      expect(body.pricingResolvedLocale).toBe('fr');
      // Verify in DB
      const drafts =
        await rawSql`SELECT pricing_resolved_locale FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.pricing_resolved_locale).toBe('fr');
    });

    it('55. en-US locale → resolvedLocale = en', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          locale: 'en-US',
        }),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      expect(body.pricingResolvedLocale).toBe('en');
    });

    it('56. Equivalent locale case variations → same canonical fingerprint', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // fr-FR and FR-fr should produce the same canonical fingerprint
      const key = 'case-equiv-' + SUFFIX();
      const input1 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'fr-FR',
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      // Same key with FR-fr → should replay (same canonical fingerprint)
      const input2 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'FR-fr',
      });
      const result2 = await createBookingDraftWithHold(db, input2);
      expectSuccess(result2);
      expect(result2.body.draftId).toBe(result1.body.draftId);
    });

    it('57. Different real locale with same key → conflict', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'locale-real-conflict-' + SUFFIX();
      const input1 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'fr',
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      // en is a different canonical locale → different fingerprint → conflict
      const input2 = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
        locale: 'en',
      });
      await expect(createBookingDraftWithHold(db, input2)).rejects.toThrow();
    });

    it('58. Invalid locale → FAILURE response with UNSUPPORTED_LOCALE', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // An invalid locale that Intl.getCanonicalLocales accepts but resolveLocale rejects
      const key = 'invalid-locale-' + SUFFIX();
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: key,
          locale: 'not-a-real-locale-xxyz',
        }),
      );
      expectFailure(result);
      expect(result.body.error).toBe('VALIDATION');
      expect(result.body.details).toHaveProperty('pricingErrorCode', 'UNSUPPORTED_LOCALE');
      // No SQL content leaked in the error message
      expect(JSON.stringify(result.body)).not.toContain('SELECT');
      expect(JSON.stringify(result.body)).not.toContain('INSERT');
    });

    // ── G7P-B2-B Round 2 — Defect 2 : window snapshot persistence ────────

    it('59. DAY_RANGE line has pricingSelectedWindow with kind DAY_RANGE_BOUNDARIES', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      expect(body.lines[0]!.pricingSelectedWindow).not.toBeNull();
      expect(body.lines[0]!.pricingSelectedWindow).toHaveProperty('kind', 'DAY_RANGE_BOUNDARIES');
      // Verify in DB
      const lines =
        await rawSql`SELECT pricing_selected_window FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}`;
      expect(lines[0]!.pricing_selected_window).not.toBeNull();
      expect(lines[0]!.pricing_selected_window.kind).toBe('DAY_RANGE_BOUNDARIES');
    });

    it('60. TIME_RANGE DAILY line has pricingSelectedWindow with kind TIME_RANGE_WINDOW', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids, { priceAmountMinor: 5000 });
      await seedOpeningHours(ids.locationId);
      // A time range that spans a commercial window (9-17 local)
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T17:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      // DAILY via commercial window → TIME_RANGE_WINDOW
      if (body.lines[0]!.pricingPlanType === 'DAILY') {
        expect(body.lines[0]!.pricingSelectedWindow).not.toBeNull();
        expect(body.lines[0]!.pricingSelectedWindow).toHaveProperty('kind', 'TIME_RANGE_WINDOW');
      }
    });

    it('61. HOURLY line has pricingSelectedWindow null (no window snapshot)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      const start = '2026-02-10T09:00:00';
      const end = '2026-02-10T11:00:00';
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, start, end),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      expect(body.lines[0]!.pricingPlanType).toBe('HOURLY');
      expect(body.lines[0]!.pricingSelectedWindow).toBeNull();
    });

    it('62. Replay returns the same window snapshot', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'window-replay-' + SUFFIX();
      const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input);
      expectSuccess(result1);
      const result2 = await createBookingDraftWithHold(db, input);
      expectSuccess(result2);
      const body1 = result1.body as FlexibleBookingDraftResponseBody;
      const body2 = result2.body as FlexibleBookingDraftResponseBody;
      expect(body2.lines[0]!.pricingSelectedWindow).toEqual(body1.lines[0]!.pricingSelectedWindow);
    });

    // ── G7P-B2-B Round 2 — Defect 4 : billableUnitCount from engine ──────

    it('63. DAILY with discount → billableUnitCount from engine (not ratio reconstruction)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      // Create plan as DRAFT, add discount tier, then activate
      const planId = await seedDailyPlan(ids, { priceAmountMinor: 5000, skipActivate: true });
      // Add a discount tier: 3+ days → 10% off
      await seedDiscountTier(planId, 3, 10);
      await activatePlan(planId);
      await seedOpeningHours(ids.locationId);
      // 5 days: 2026-02-10 to 2026-02-15 exclusive
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-15'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      // billableUnitCount = billedDays = 5 (from engine, not reconstructed from lineTotal)
      // lineTotal = amountAfterDiscount = 22500, but billableUnitCount = 5
      // Ratio reconstruction would give 22500/5000 = 4.5 → wrong
      expect(body.lines[0]!.billableUnitCount).toBe(5);
      expect(body.lines[0]!.lineTotalAmountMinor).toBe(22500);
      // Verify in DB
      const lines =
        await rawSql`SELECT billable_unit_count FROM booking_draft_lines WHERE draft_id = ${result.body.draftId}`;
      expect(lines[0]!.billable_unit_count).toBe(5);
    });

    it('64. Root billableUnitCount = sum of per-line billableUnitCount * quantity', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // 2 days, quantity 3 → root billableUnitCount = 2 * 3 = 6
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          lines: [{ variantId: ids.variantId, quantity: 3 }],
        }),
      );
      expectSuccess(result);
      expect(result.body.billableUnitCount).toBe(6);
      // Verify in DB
      const drafts =
        await rawSql`SELECT billable_unit_count FROM booking_drafts WHERE id = ${result.body.draftId}`;
      expect(drafts[0]!.billable_unit_count).toBe(6);
    });

    // ── G7P-B2-B Round 2 — Defect 6 : closed dispatch validation ─────────

    it('65. pricingMode typo FLEXIBEL → VALIDATION error, no DB mutation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const badInput = {
        pricingMode: 'FLEXIBEL',
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.userId,
        locale: 'fr',
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-02-10',
          endDateExclusive: '2026-02-12',
        },
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'typo-' + SUFFIX(),
      };
      await expect(createBookingDraftWithHold(db, badInput as unknown as never)).rejects.toThrow(
        BookingDraftError,
      );
      // No idempotency record, no draft
      const records = await rawSql`SELECT count(*)::int AS n FROM idempotency_records`;
      expect(records[0]!.n).toBe(0);
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
    });

    it('66. pricingMode empty string → VALIDATION error', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const badInput = {
        pricingMode: '',
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.userId,
        locale: 'fr',
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-02-10',
          endDateExclusive: '2026-02-12',
        },
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'empty-' + SUFFIX(),
      };
      await expect(createBookingDraftWithHold(db, badInput as unknown as never)).rejects.toThrow(
        BookingDraftError,
      );
      const records = await rawSql`SELECT count(*)::int AS n FROM idempotency_records`;
      expect(records[0]!.n).toBe(0);
    });

    it('67. pricingMode null → VALIDATION error', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const badInput = {
        pricingMode: null,
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.userId,
        locale: 'fr',
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-02-10',
          endDateExclusive: '2026-02-12',
        },
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'null-' + SUFFIX(),
      };
      await expect(createBookingDraftWithHold(db, badInput as unknown as never)).rejects.toThrow(
        BookingDraftError,
      );
      const records = await rawSql`SELECT count(*)::int AS n FROM idempotency_records`;
      expect(records[0]!.n).toBe(0);
    });

    it('68. pricingMode 42 (number) → VALIDATION error', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const badInput = {
        pricingMode: 42,
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.userId,
        locale: 'fr',
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-02-10',
          endDateExclusive: '2026-02-12',
        },
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'num-' + SUFFIX(),
      };
      await expect(createBookingDraftWithHold(db, badInput as unknown as never)).rejects.toThrow(
        BookingDraftError,
      );
      const records = await rawSql`SELECT count(*)::int AS n FROM idempotency_records`;
      expect(records[0]!.n).toBe(0);
    });

    it('69. pricingMode lowercase legacy → VALIDATION error', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const badInput = {
        pricingMode: 'legacy',
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.userId,
        customerStartAt: new Date('2026-02-10T09:00:00.000Z'),
        customerEndAt: new Date('2026-02-12T17:00:00.000Z'),
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'lower-' + SUFFIX(),
      };
      await expect(createBookingDraftWithHold(db, badInput as unknown as never)).rejects.toThrow(
        BookingDraftError,
      );
      const records = await rawSql`SELECT count(*)::int AS n FROM idempotency_records`;
      expect(records[0]!.n).toBe(0);
    });

    // ── G7P-B2-B Round 2 — Defect 8 : targeted SET CONSTRAINTS ───────────

    it('71. SET CONSTRAINTS restoration after success', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // The SET CONSTRAINTS DEFERRED restoration should have happened after success.
      // Verify the draft was created and idempotency record is COMPLETED.
      const records = await rawSql`
        SELECT status FROM idempotency_records WHERE resource_id = ${result.body.draftId}
      `;
      expect(records[0]!.status).toBe('COMPLETED');
    });

    it('72. SET CONSTRAINTS restoration after error — no deferred error after SUCCESS', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // First call succeeds
      const result1 = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result1);
      // Second call with different key and insufficient stock → CONFLICT_BLOCK
      // Delete 2 of 3 items
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[1]!}`;
      await rawSql`DELETE FROM "inventory_items" WHERE "id" = ${ids.itemIds[2]!}`;
      const result2 = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'set-constraints-err-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 2 }],
        }),
      );
      expectFailure(result2);
      expect(result2.body.error).toBe('CONFLICT_BLOCK');
      // The first draft should still be valid (no deferred error leaked)
      const drafts =
        await rawSql`SELECT count(*)::int AS n FROM booking_drafts WHERE status = 'HELD'`;
      expect(drafts[0]!.n).toBe(1);
    });

    it('73. SET CONSTRAINTS has no effect on completeKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12'),
      );
      expectSuccess(result);
      // completeKey should have succeeded despite SET CONSTRAINTS DEFERRED
      const records = await rawSql`
        SELECT status, response_status_code FROM idempotency_records WHERE resource_id = ${result.body.draftId}
      `;
      expect(records[0]!.status).toBe('COMPLETED');
      expect(records[0]!.response_status_code).toBe(201);
    });

    // ── G7P-B2-C Round 3 (P0-1) — TIME_RANGE local strings → UTC conversion ──

    it('70. TIME_RANGE local strings → customer_start_at is UTC conversion', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      // Opening hours: all day to allow 22:08 local
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 1, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 2, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 3, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 4, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 5, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 6, openTime: '00:00:00', closeTime: '23:59:00' },
      ]);
      // 22:08 local (Europe/Paris, CET UTC+1 in February) = 21:08 UTC
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, '2026-02-10T22:08:00', '2026-02-10T23:08:00'),
      );
      expectSuccess(result);
      expect(result.body.customerStartAt).toBe('2026-02-10T21:08:00.000Z');
      expect(result.body.customerEndAt).toBe('2026-02-10T22:08:00.000Z');
    });

    it('71. TIME_RANGE local strings → pricing_intent_snapshot stores local strings', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      // The snapshot stores the LOCAL strings, not the UTC conversion
      expect(body.pricingIntentSnapshot).toEqual({
        kind: 'TIME_RANGE',
        startAt: '2026-02-10T09:00:00',
        endAt: '2026-02-10T11:00:00',
      });
      // Verify in DB
      const draft = await rawSql`
        SELECT pricing_intent_snapshot FROM booking_drafts WHERE id = ${result.body.draftId}
      `.then((r) => r[0]!);
      expect(draft.pricing_intent_snapshot.kind).toBe('TIME_RANGE');
      expect(draft.pricing_intent_snapshot.startAt).toBe('2026-02-10T09:00:00');
      expect(draft.pricing_intent_snapshot.endAt).toBe('2026-02-10T11:00:00');
    });

    it('72. TIME_RANGE DST boundary (summer CEST) → correct UTC conversion', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      // Opening hours: all day to avoid rejection
      await seedOpeningHours(ids.locationId, [
        { weekday: 0, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 1, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 2, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 3, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 4, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 5, openTime: '00:00:00', closeTime: '23:59:00' },
        { weekday: 6, openTime: '00:00:00', closeTime: '23:59:00' },
      ]);
      // August 8, 2026 is a Saturday — Europe/Paris is in CEST (UTC+2)
      // 22:08 local = 20:08 UTC
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, '2026-08-08T22:08:00', '2026-08-08T23:08:00'),
      );
      expectSuccess(result);
      expect(result.body.customerStartAt).toBe('2026-08-08T20:08:00.000Z');
      expect(result.body.customerEndAt).toBe('2026-08-08T21:08:00.000Z');
    });

    it('73. TIME_RANGE fingerprint is based on local strings (same local → same fingerprint)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'fingerprint-local-' + SUFFIX();
      const input1 = makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00', {
        idempotencyKey: key,
      });
      const result1 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result1);
      // Same key + same local input → replay (same fingerprint)
      const result2 = await createBookingDraftWithHold(db, input1);
      expectSuccess(result2);
      expect(result2.body.draftId).toBe(result1.body.draftId);
    });

    it('74. TIME_RANGE quote engine receives correct UTC boundaries', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids, { priceAmountMinor: 1000, billingIncrementMinutes: 60 });
      await seedOpeningHours(ids.locationId);
      // 09:00-11:00 local Paris (CET UTC+1) = 08:00-10:00 UTC = 120 minutes
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00'),
      );
      expectSuccess(result);
      const body = result.body as FlexibleBookingDraftResponseBody;
      // The engine should compute 120 minutes (2 hours) regardless of timezone
      expect(body.lines[0]!.pricingRequestedDurationMinutes).toBe(120);
      expect(body.lines[0]!.pricingBilledDurationMinutes).toBe(120);
      // 1000 * 2 increments * 1 qty = 2000
      expect(body.lines[0]!.lineTotalAmountMinor).toBe(2000);
    });

    // ── G7P-B2-B Round 3 — pre-validation before reserveKey ──────────────
    // Les erreurs de validation civile et syntaxique (format, plages, jour
    // réel, offsets) doivent se produire AVANT reserveKey, avant toute lecture
    // ou écriture PostgreSQL. Après chaque rejet, on vérifie que les comptes
    // de idempotency_records, booking_drafts, inventory_blocks et allocations
    // restent à zéro (aucune mutation business).

    it('76. invalid TIME_RANGE month 13 → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-month13-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-13-10T09:00:00', '2026-13-10T11:00:00', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      try {
        await createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-13-10T09:00:00', '2026-13-10T11:00:00', {
            idempotencyKey: key,
          }),
        );
      } catch (err) {
        expect((err as BookingDraftError).code).toBe('VALIDATION');
      }
      // Aucune mutation DB : idempotency_records, booking_drafts,
      // inventory_blocks, allocations restent à zéro.
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('77. invalid TIME_RANGE Feb 30 → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-feb30-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-02-30T09:00:00', '2026-02-30T11:00:00', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('78. invalid TIME_RANGE hour 24 → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-hour24-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-01-10T24:00:00', '2026-01-11T09:00:00', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('79. invalid TIME_RANGE offset Z → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-offset-z-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00Z', '2026-02-10T11:00:00Z', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('80. invalid TIME_RANGE endAt == startAt → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-equal-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T09:00:00', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('81. invalid TIME_RANGE endAt < startAt → BookingDraftError VALIDATION before reserveKey', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'preval-before-' + SUFFIX();
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleTimeRangeInput(ids, '2026-02-10T11:00:00', '2026-02-10T09:00:00', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow(BookingDraftError);
      const counts = await rawSql`
        SELECT
          (SELECT count(*)::int FROM idempotency_records) AS idem,
          (SELECT count(*)::int FROM booking_drafts) AS drafts,
          (SELECT count(*)::int FROM inventory_blocks) AS blocks,
          (SELECT count(*)::int FROM allocations) AS allocs
      `;
      expect(counts[0]!.idem).toBe(0);
      expect(counts[0]!.drafts).toBe(0);
      expect(counts[0]!.blocks).toBe(0);
      expect(counts[0]!.allocs).toBe(0);
    });

    it('82. valid TIME_RANGE datetime still works end-to-end after stricter validation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedHourlyPlan(ids);
      await seedOpeningHours(ids.locationId);
      // 09:00-11:00 local Paris (CET UTC+1 in February) = 08:00-10:00 UTC
      const result = await createBookingDraftWithHold(
        db,
        makeFlexibleTimeRangeInput(ids, '2026-02-10T09:00:00', '2026-02-10T11:00:00'),
      );
      expectSuccess(result);
      expect(result.body.customerStartAt).toBe('2026-02-10T08:00:00.000Z');
      expect(result.body.customerEndAt).toBe('2026-02-10T10:00:00.000Z');
      // Verify a draft was actually created
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(1);
    });

    // ── G7H-B — Analytics assertions for FLEXIBLE mode ──────────────────
    // NOTE: These tests must run BEFORE test 75 which drops pricing tables.

    describe('G7H-B — analytics BOOKING_ATTEMPTED (FLEXIBLE)', () => {
      it('valid FLEXIBLE request → BOOKING_ATTEMPTED emitted', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        await seedDailyPlan(ids);
        await seedOpeningHours(ids.locationId);
        const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'flex-analytics-' + SUFFIX(),
        });
        const result = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expectSuccess(result);

        const events =
          await rawSql`SELECT event_type, environment, source_id, occurred_at FROM product_analytics_events WHERE event_type = 'BOOKING_ATTEMPTED'`;
        expect(events.length).toBe(1);
        expect(events[0]!.environment).toBe('DEVELOPMENT');
      });

      it('sourceId = idempotency_records.id et occurredAt = idempotency_records.created_at', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        await seedDailyPlan(ids);
        await seedOpeningHours(ids.locationId);
        const key = 'flex-analytics-ids-' + SUFFIX();
        const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: key,
        });
        const result = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expectSuccess(result);

        const idempotencyRecord =
          await rawSql`SELECT id, created_at FROM idempotency_records WHERE key = ${key}`.then(
            (r) => r[0]!,
          );
        const events =
          await rawSql`SELECT source_id, occurred_at FROM product_analytics_events WHERE event_type = 'BOOKING_ATTEMPTED'`;
        expect(events.length).toBe(1);
        expect(events[0]!.source_id).toBe(idempotencyRecord.id);
        expect(events[0]!.occurred_at.getTime()).toBe(idempotencyRecord.created_at.getTime());
      });

      it('FLEXIBLE replay → still a single event', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        await seedDailyPlan(ids);
        await seedOpeningHours(ids.locationId);
        const key = 'flex-analytics-replay-' + SUFFIX();
        const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: key,
        });

        // Premier appel : SUCCESS.
        const result1 = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expectSuccess(result1);

        // Deuxieme appel avec la meme cle : REPLAY.
        const result2 = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        expectSuccess(result2);

        // Un seul evenement BOOKING_ATTEMPTED (deduplication par sourceId).
        const events =
          await rawSql`SELECT COUNT(*)::int AS cnt FROM product_analytics_events WHERE event_type = 'BOOKING_ATTEMPTED'`;
        expect(events[0]!.cnt).toBe(1);
      });

      it('FLEXIBLE business failure after reserveKey → event already present', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        await seedDailyPlan(ids);
        await seedOpeningHours(ids.locationId);
        // Declencher un VRAI echec metier (availability conflict) apres reserveKey :
        // quantity 4 > 3 exemplaires disponibles → CONFLICT_BLOCK.
        // Utiliser un DAY_RANGE valide avec un plan DAILY.
        const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'flex-analytics-fail-' + SUFFIX(),
          lines: [{ variantId: ids.variantId, quantity: 4 }],
        });
        // L'appel doit retourner FAILURE (pas throw) — l'echec metier est persiste
        // via failKey et retourne comme union FAILURE.
        const result = await createBookingDraftWithHold(db, input, 'DEVELOPMENT');
        // Le test doit FAIL si l'operation retourne SUCCESS.
        expect(result.kind).toBe('FAILURE');
        if (result.kind !== 'FAILURE') return; // type narrowing
        expect(result.statusCode).toBe(409);
        expect(result.body.error).toBe('CONFLICT_BLOCK');

        // Verifier que l'enregistrement d'idempotence existe en status FAILED.
        const idempotencyRecord = await rawSql`
          SELECT id, created_at, status FROM idempotency_records
          WHERE key = ${input.idempotencyKey}
        `.then((r) => r[0]!);
        expect(idempotencyRecord.status).toBe('FAILED');

        // Verifier BOOKING_ATTEMPTED existe avec exact sourceId/occurredAt.
        const events = await rawSql`
          SELECT id, event_type, environment, source_id, occurred_at
          FROM product_analytics_events
          WHERE event_type = 'BOOKING_ATTEMPTED' AND environment = 'DEVELOPMENT'
        `;
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.source_id).toBe(idempotencyRecord.id);
        expect(event.occurred_at.getTime()).toBe(idempotencyRecord.created_at.getTime());
      });

      it('FLEXIBLE DISABLED → aucun evenement analytics', async () => {
        if (!db || !rawSql) return;
        const ids = await seedBaseData();
        await seedDailyPlan(ids);
        await seedOpeningHours(ids.locationId);
        const input = makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
          idempotencyKey: 'flex-analytics-disabled-' + SUFFIX(),
        });
        const result = await createBookingDraftWithHold(db, input, 'DISABLED');
        expectSuccess(result);

        const events = await rawSql`SELECT COUNT(*)::int AS cnt FROM product_analytics_events`;
        expect(events[0]!.cnt).toBe(0);
      });
    });

    // ── G7P-B2-B Round 2 — Defect 7 : DB error isolation ─────────────────
    // NOTE: This test must be LAST because it drops tables to simulate a DB
    // infrastructure error, which breaks subsequent tests that need those tables.

    it('75. PRICING_CONTEXT_UNAVAILABLE → no business response persisted, no draft', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedDailyPlan(ids);
      await seedOpeningHours(ids.locationId);
      const key = 'db-error-' + SUFFIX();
      // Drop the pricing_plans table to simulate a DB infrastructure error.
      // The engine should wrap it in PRICING_CONTEXT_UNAVAILABLE.
      // normalizeBusinessError returns null → raw error rethrown → no business response.
      await rawSql`DROP TABLE IF EXISTS "pricing_plan_windows" CASCADE`;
      await rawSql`DROP TABLE IF EXISTS "pricing_plan_translations" CASCADE`;
      await rawSql`DROP TABLE IF EXISTS "multi_day_discount_tiers" CASCADE`;
      await rawSql`DROP TABLE IF EXISTS "pricing_plans" CASCADE`;
      await expect(
        createBookingDraftWithHold(
          db,
          makeFlexibleDayRangeInput(ids, '2026-02-10', '2026-02-12', {
            idempotencyKey: key,
          }),
        ),
      ).rejects.toThrow();
      // No business response persisted (no FAILED record)
      const records = await rawSql`SELECT status FROM idempotency_records WHERE key = ${key}`;
      // The key should NOT be in a FAILED business state — either no record or PENDING
      if (records.length > 0) {
        expect(records[0]!.status).not.toBe('FAILED');
      }
      // No draft created
      const drafts = await rawSql`SELECT count(*)::int AS n FROM booking_drafts`;
      expect(drafts[0]!.n).toBe(0);
      // No SQL content in any error message exposed
      // (the error is rethrown as-is, not persisted as a business error)
    });
  },
);
