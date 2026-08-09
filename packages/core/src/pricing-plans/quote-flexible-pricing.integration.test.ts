import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { quoteFlexiblePricing } from './quote-flexible-pricing';
import { FlexiblePricingError } from './errors';
import type { QuoteFlexiblePricingInput, FlexiblePricingIntent } from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('pricing_plans');
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
      .sql`TRUNCATE TABLE pricing_plan_translations, multi_day_discount_tiers, pricing_plan_windows, pricing_plans, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SeedIds {
  orgId: string;
  locationId: string;
  productId: string;
  variantId: string;
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

async function seedOrg(suffix = SUFFIX()): Promise<{ orgId: string }> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return { orgId: org.id };
}

async function seedLocation(orgId: string, suffix = SUFFIX()): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${orgId}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return location.id;
}

async function seedProductAndVariant(
  orgId: string,
  suffix = SUFFIX(),
): Promise<{ productId: string; variantId: string }> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${orgId}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
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
        ${orgId}, ${product.id}, ${'product-photos/' + suffix + '-' + _pi},
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
  return { productId: product.id, variantId: variant.id };
}

interface PlanSeedInput {
  orgId: string;
  variantId: string;
  locationId: string | null;
  planType: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
  currency: string;
  priceAmountMinor: number;
  minDurationMinutes?: number | null;
  maxDurationMinutes?: number | null;
  billingIncrementMinutes?: number | null;
  includedDurationMinutes?: number | null;
  priority?: number;
  version?: number;
}

async function seedPlan(input: PlanSeedInput): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const plan = await sql`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "location_id", "plan_type",
      "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes",
      "billing_increment_minutes", "included_duration_minutes", "priority", "lifecycle_state", "version"
    )
    VALUES (
      ${input.orgId}, ${input.variantId}, ${input.locationId}, ${input.planType},
      ${input.currency}, ${input.priceAmountMinor},
      ${input.minDurationMinutes ?? null}, ${input.maxDurationMinutes ?? null},
      ${input.billingIncrementMinutes ?? null}, ${input.includedDurationMinutes ?? null},
      ${input.priority ?? 0}, 'DRAFT', ${input.version ?? 1}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return plan.id;
}

async function seedTranslations(planId: string, fr: string, en: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${planId}, 'fr', ${fr}), (${planId}, 'en', ${en})
  `;
}

async function activatePlan(planId: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
}

async function seedWindow(
  planId: string,
  locationId: string,
  weekdayMask: number,
  startTime: string,
  endTime: string,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${planId}, ${locationId}, ${weekdayMask}, ${startTime}, ${endTime})
  `;
}

async function seedTier(
  planId: string,
  thresholdDays: number,
  discountPercent: number,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
    VALUES (${planId}, ${thresholdDays}, ${discountPercent})
  `;
}

async function seedOpeningHours(
  locationId: string,
  weekday: number,
  openTime: string,
  closeTime: string,
): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
    VALUES (${locationId}, ${weekday}, ${openTime}, ${closeTime})
  `;
}

async function seedFullSetup(suffix = SUFFIX()): Promise<SeedIds> {
  const { orgId } = await seedOrg(suffix);
  const locationId = await seedLocation(orgId, suffix);
  const { productId, variantId } = await seedProductAndVariant(orgId, suffix);
  return { orgId, locationId, productId, variantId };
}

function makeInput(
  ids: SeedIds,
  overrides: Partial<QuoteFlexiblePricingInput> = {},
): QuoteFlexiblePricingInput {
  return {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    locale: 'fr',
    intent: {
      kind: 'TIME_RANGE',
      startAt: '2026-02-10T09:00:00',
      endAt: '2026-02-10T11:00:00',
    },
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    ...overrides,
  };
}

// 2026-02-10 is a Tuesday (weekday=1 in 0=Monday system).
// Local times are in Europe/Paris (CET, UTC+1 in February).
// 09:00 Paris = 08:00 UTC.

const TWO_HOURS: FlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T11:00:00',
};

const FOUR_HOURS: FlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T13:00:00',
};

const FIVE_HOURS: FlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T14:00:00',
};

const SIX_HOURS: FlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T15:00:00',
};

const EIGHT_HOURS: FlexiblePricingIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T17:00:00',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'quoteFlexiblePricing — intégration PostgreSQL',
  () => {
    // 1. 2h TIME_RANGE with HOURLY plan
    it('1. 2h TIME_RANGE HOURLY → 4 increments × 500 = 2000', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const planId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(planId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }));
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.planType).toBe('HOURLY');
      expect(result.lines[0]!.billedDurationMinutes).toBe(120);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(2000);
      expect(result.totalAmountMinor).toBe(2000);
      expect(result.currency).toBe('EUR');
      expect(result.algorithmVersion).toBe('flexible-pricing-v1');
    });

    // 2. 4h TIME_RANGE: HOURLY vs FIXED_DURATION 4h → FIXED cheaper
    it('2. 4h TIME_RANGE: HOURLY (4000) vs FIXED 4h (3000) → FIXED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const hourlyId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(hourlyId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(hourlyId);

      const fixedId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'FIXED_DURATION',
        currency: 'EUR',
        priceAmountMinor: 3000,
        includedDurationMinutes: 240,
      });
      await seedTranslations(fixedId, 'Forfait 4h', '4-hour package');
      await activatePlan(fixedId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: FOUR_HOURS }));
      expect(result.lines[0]!.planType).toBe('FIXED_DURATION');
      expect(result.lines[0]!.pricingPlanId).toBe(fixedId);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(3000);
    });

    // 3. 5h TIME_RANGE: FIXED 4h (ineligible) + FIXED 6h → FIXED 6h
    it('3. 5h TIME_RANGE: FIXED 4h (ineligible) + FIXED 6h → FIXED 6h', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const fixed4hId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'FIXED_DURATION',
        currency: 'EUR',
        priceAmountMinor: 3000,
        includedDurationMinutes: 240,
      });
      await seedTranslations(fixed4hId, 'Forfait 4h', '4-hour package');
      await activatePlan(fixed4hId);

      const fixed6hId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'FIXED_DURATION',
        currency: 'EUR',
        priceAmountMinor: 4000,
        includedDurationMinutes: 360,
      });
      await seedTranslations(fixed6hId, 'Forfait 6h', '6-hour package');
      await activatePlan(fixed6hId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: FIVE_HOURS }));
      expect(result.lines[0]!.planType).toBe('FIXED_DURATION');
      expect(result.lines[0]!.pricingPlanId).toBe(fixed6hId);
      expect(result.lines[0]!.coveredDurationMinutes).toBe(360);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(4000);
    });

    // 4. 6h TIME_RANGE with FIXED 6h
    it('4. 6h TIME_RANGE: FIXED 6h → exact match', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const fixed6hId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'FIXED_DURATION',
        currency: 'EUR',
        priceAmountMinor: 4000,
        includedDurationMinutes: 360,
      });
      await seedTranslations(fixed6hId, 'Forfait 6h', '6-hour package');
      await activatePlan(fixed6hId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: SIX_HOURS }));
      expect(result.lines[0]!.planType).toBe('FIXED_DURATION');
      expect(result.lines[0]!.coveredDurationMinutes).toBe(360);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(4000);
    });

    // 5. 8h TIME_RANGE: DAILY with window 09:00–17:00
    it('5. 8h TIME_RANGE: DAILY with window → 1 day', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const dailyId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'DAILY',
        currency: 'EUR',
        priceAmountMinor: 8000,
      });
      await seedTranslations(dailyId, 'Journée', 'Day rate');
      // weekdayMask: Mon-Fri = 0b11111 = 31
      await seedWindow(dailyId, ids.locationId, 31, '09:00:00', '17:00:00');
      await activatePlan(dailyId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: EIGHT_HOURS }));
      expect(result.lines[0]!.planType).toBe('DAILY');
      expect(result.lines[0]!.billedDays).toBe(1);
      expect(result.lines[0]!.selectedWindow).not.toBeNull();
      expect(result.lines[0]!.selectedWindow!.startTime).toBe('09:00:00');
      expect(result.lines[0]!.selectedWindow!.endTime).toBe('17:00:00');
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(8000);
    });

    // 6. Default/local override: local plan replaces default
    it('6. local plan v2 replaces default plan v1 → local selected', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      // Default plan (location_id NULL) — price 500
      const defaultId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
        version: 1,
      });
      await seedTranslations(defaultId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(defaultId);

      // Local plan (location_id = ids.locationId) — price 400, replaces default
      const localId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: ids.locationId,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 400,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
        version: 2,
      });
      await seedTranslations(localId, 'Tarif local', 'Local rate');
      await activatePlan(localId);

      const result = await quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }));
      expect(result.lines[0]!.pricingPlanId).toBe(localId);
      expect(result.lines[0]!.planVersion).toBe(2);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(1600); // 400 * 4 * 1
    });

    // 7. Two organizations: no cross-org leak
    it('7. two orgs: org-A plan not visible to org-B', async () => {
      if (!db || !rawSql) return;
      // Org A with plan
      const idsA = await seedFullSetup('a');
      const planIdA = await seedPlan({
        orgId: idsA.orgId,
        variantId: idsA.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planIdA, 'Tarif A', 'Rate A');
      await activatePlan(planIdA);

      // Org B with its own location but no plan
      const { orgId: orgIdB } = await seedOrg('b');
      const locationIdB = await seedLocation(orgIdB, 'b');
      const { variantId: variantIdB } = await seedProductAndVariant(orgIdB, 'b');

      // Query org B → should get NO_ELIGIBLE_PLAN (no plan for org B's variant)
      await expect(
        quoteFlexiblePricing(db, {
          organizationId: orgIdB,
          locationId: locationIdB,
          locale: 'fr',
          intent: TWO_HOURS,
          lines: [{ variantId: variantIdB, quantity: 1 }],
        }),
      ).rejects.toThrow(FlexiblePricingError);
    });

    // 8. Location deleted → LOCATION_NOT_FOUND
    it('8. soft-deleted location → LOCATION_NOT_FOUND', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const planId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(planId);

      // Soft-delete the location
      await rawSql!`UPDATE "locations" SET "deleted_at" = now() WHERE "id" = ${ids.locationId}`;

      await expect(quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }))).rejects.toThrow(
        FlexiblePricingError,
      );
      try {
        await quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }));
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('LOCATION_NOT_FOUND');
      }
    });

    // 9. Wrong org for location → LOCATION_NOT_FOUND (fail-closed, no leak)
    it('9. location from different org → LOCATION_NOT_FOUND', async () => {
      if (!db || !rawSql) return;
      const idsA = await seedFullSetup('a');
      const { orgId: orgIdB } = await seedOrg('b');
      const locationIdB = await seedLocation(orgIdB, 'b');
      const { variantId: variantIdB } = await seedProductAndVariant(orgIdB, 'b');
      const planIdB = await seedPlan({
        orgId: orgIdB,
        variantId: variantIdB,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planIdB, 'Tarif B', 'Rate B');
      await activatePlan(planIdB);

      // Query org A using org B's location → LOCATION_NOT_FOUND
      await expect(
        quoteFlexiblePricing(db, {
          organizationId: idsA.orgId,
          locationId: locationIdB,
          locale: 'fr',
          intent: TWO_HOURS,
          lines: [{ variantId: idsA.variantId, quantity: 1 }],
        }),
      ).rejects.toThrow(FlexiblePricingError);
      try {
        await quoteFlexiblePricing(db, {
          organizationId: idsA.orgId,
          locationId: locationIdB,
          locale: 'fr',
          intent: TWO_HOURS,
          lines: [{ variantId: idsA.variantId, quantity: 1 }],
        });
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('LOCATION_NOT_FOUND');
      }
    });

    // 10. DAY_RANGE 3 days with DAILY + discount tiers
    it('10. DAY_RANGE 3 days with DAILY + tiers 2@10%, 3@15% → 15%', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const dailyId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'DAILY',
        currency: 'EUR',
        priceAmountMinor: 5000,
      });
      await seedTranslations(dailyId, 'Journée', 'Day rate');
      await seedTier(dailyId, 2, 10);
      await seedTier(dailyId, 3, 15);
      // G7P-B2-B : window required for DAY_RANGE (findDayRangeWindow)
      await seedWindow(dailyId, ids.locationId, 127, '08:00:00', '18:00:00');
      await activatePlan(dailyId);

      const result = await quoteFlexiblePricing(
        db,
        makeInput(ids, {
          intent: {
            kind: 'DAY_RANGE',
            startDate: '2026-02-10',
            endDateExclusive: '2026-02-13',
          },
        }),
      );
      expect(result.lines[0]!.planType).toBe('DAILY');
      expect(result.lines[0]!.billedDays).toBe(3);
      expect(result.lines[0]!.discountPercent).toBe(15);
      expect(result.lines[0]!.amountBeforeDiscountMinor).toBe(15000);
      // halfUpRound(15000, 15) = 15000 - 2250 = 12750
      expect(result.lines[0]!.amountAfterDiscountMinor).toBe(12750);
      expect(result.lines[0]!.lineTotalAmountMinor).toBe(12750);
      expect(result.totalAmountMinor).toBe(12750);
      // G7P-B2-B : dayRangeBoundaries populated
      const dailyLine = result.lines[0]! as Extract<
        (typeof result.lines)[0],
        { planType: 'DAILY' }
      >;
      expect(dailyLine.dayRangeBoundaries).not.toBeNull();
      expect(dailyLine.dayRangeBoundaries!.firstDay.localDate).toBe('2026-02-10');
      expect(dailyLine.dayRangeBoundaries!.lastDay.localDate).toBe('2026-02-12');
      expect(dailyLine.dayRangeBoundaries!.firstDay.startTime).toBe('08:00:00');
      expect(dailyLine.dayRangeBoundaries!.firstDay.endTime).toBe('18:00:00');
    });

    // 11. EN locale resolves correctly
    it('11. EN locale → EN label', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const planId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(planId);

      const result = await quoteFlexiblePricing(
        db,
        makeInput(ids, { intent: TWO_HOURS, locale: 'en' }),
      );
      expect(result.lines[0]!.publicLabel).toBe('Hourly rate');
    });

    // 12. Opening hours violation
    it('12. TIME_RANGE outside opening hours → OUTSIDE_OPENING_HOURS', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const planId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(planId);

      // Opening hours: 09:00–18:00 Mon–Fri (weekday 0-4)
      for (let i = 0; i < 5; i++) {
        await seedOpeningHours(ids.locationId, i, '09:00:00', '18:00:00');
      }

      // 07:00–09:00 Paris → before opening (09:00)
      const earlyIntent: FlexiblePricingIntent = {
        kind: 'TIME_RANGE',
        startAt: '2026-02-10T07:00:00',
        endAt: '2026-02-10T09:00:00',
      };

      await expect(
        quoteFlexiblePricing(db, makeInput(ids, { intent: earlyIntent })),
      ).rejects.toThrow(FlexiblePricingError);
      try {
        await quoteFlexiblePricing(db, makeInput(ids, { intent: earlyIntent }));
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('OUTSIDE_OPENING_HOURS');
      }
    });

    // 13. Concurrent read during atomic version replacement
    it('13. concurrent reads during version replacement return consistent results', async () => {
      if (!db || !rawSql || !ctx) return;
      const ids = await seedFullSetup();

      // v1: DAILY plan ACTIVE with window 09:00–17:00 and translations.
      const v1Id = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'DAILY',
        currency: 'EUR',
        priceAmountMinor: 8000,
        version: 1,
      });
      await seedTranslations(v1Id, 'Tarif v1', 'Rate v1');
      // weekdayMask: Mon–Fri = 0b11111 = 31; 2026-02-10 is a Tuesday.
      await seedWindow(v1Id, ids.locationId, 31, '09:00:00', '17:00:00');
      await activatePlan(v1Id);

      // v2: DAILY plan DRAFT with different price, window 08:00–18:00, translations.
      // Same business key (variant + plan_type + location_id NULL), different version.
      const v2Id = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'DAILY',
        currency: 'EUR',
        priceAmountMinor: 9000,
        version: 2,
      });
      await seedTranslations(v2Id, 'Tarif v2', 'Rate v2');
      await seedWindow(v2Id, ids.locationId, 31, '08:00:00', '18:00:00');

      // Two separate connections for true concurrency:
      // - Connection A (Drizzle db): quoteFlexiblePricing (read-only).
      // - Connection B (raw postgres): atomic version replacement in a transaction.
      const replaceSql = postgres(ctx.databaseUrl, { max: 1 });
      const input = makeInput(ids, { intent: EIGHT_HOURS });

      // Connection B: RETIRE v1 + ACTIVATE v2 atomically (version replacement).
      const versionReplacement = async () => {
        await replaceSql.begin(async (tx) => {
          await tx`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1Id}`;
          await tx`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${v2Id}`;
        });
      };

      // Launch both operations concurrently.
      const results = await Promise.allSettled([
        quoteFlexiblePricing(db, input), // Connection A: read
        versionReplacement(), // Connection B: atomic write
      ]);
      await replaceSql.end();

      // No deadlock: both operations must settle.
      expect(results).toHaveLength(2);

      // The version replacement must succeed.
      const replacementResult = results[1]!;
      expect(replacementResult.status).toBe('fulfilled');

      // The quote must succeed (not error, not deadlock).
      const quoteResult = results[0]!;
      expect(quoteResult.status).toBe('fulfilled');
      if (quoteResult.status !== 'fulfilled') return; // type narrowing
      const result = quoteResult.value;

      expect(result.lines).toHaveLength(1);
      const line = result.lines[0]!;
      expect(line.planType).toBe('DAILY');
      expect(line.billedDays).toBe(1);

      // The quote must see a consistent state: either v1 (read before the
      // replacement committed) or v2 (read after), never a mix — no plan,
      // both plans, or v1's price with v2's window.
      const isV1 = line.pricingPlanId === v1Id;
      const isV2 = line.pricingPlanId === v2Id;
      expect(isV1 || isV2).toBe(true);

      if (isV1) {
        // Read happened BEFORE the version replacement committed → v1's price + window.
        expect(line.planVersion).toBe(1);
        expect(line.lineTotalAmountMinor).toBe(8000);
        expect(line.selectedWindow).not.toBeNull();
        expect(line.selectedWindow!.startTime).toBe('09:00:00');
        expect(line.selectedWindow!.endTime).toBe('17:00:00');
      } else {
        // Read happened AFTER the version replacement committed → v2's price + window.
        expect(line.planVersion).toBe(2);
        expect(line.lineTotalAmountMinor).toBe(9000);
        expect(line.selectedWindow).not.toBeNull();
        expect(line.selectedWindow!.startTime).toBe('08:00:00');
        expect(line.selectedWindow!.endTime).toBe('18:00:00');
      }

      // Verify final state: v1 RETIRED, v2 ACTIVE (exactly one active plan).
      const activePlans = await rawSql!`
        SELECT "id", "version" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `;
      expect(activePlans).toHaveLength(1);
      expect(activePlans[0]!.id).toBe(v2Id);
      expect(activePlans[0]!.version).toBe(2);
    });

    // 14. No eligible plan — seed an ACTIVE plan for a different variant so
    // translations exist (locale resolves), but no plan for the requested variant.
    it('14. no active plan for requested variant → NO_ELIGIBLE_PLAN', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      // Create a second product/variant with an active plan (so translations exist)
      const { variantId: otherVariantId } = await seedProductAndVariant(ids.orgId, 'other');
      const otherPlanId = await seedPlan({
        orgId: ids.orgId,
        variantId: otherVariantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(otherPlanId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(otherPlanId);

      // Query for ids.variantId which has no active plan
      await expect(quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }))).rejects.toThrow(
        FlexiblePricingError,
      );
      try {
        await quoteFlexiblePricing(db, makeInput(ids, { intent: TWO_HOURS }));
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('NO_ELIGIBLE_PLAN');
      }
    });

    // 15. Variant not found
    it('15. non-existent variant → VARIANT_NOT_FOUND', async () => {
      if (!db || !rawSql) return;
      const ids = await seedFullSetup();
      const planId = await seedPlan({
        orgId: ids.orgId,
        variantId: ids.variantId,
        locationId: null,
        planType: 'HOURLY',
        currency: 'EUR',
        priceAmountMinor: 500,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
        billingIncrementMinutes: 30,
      });
      await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
      await activatePlan(planId);

      const fakeVariantId = randomUUID();
      await expect(
        quoteFlexiblePricing(
          db,
          makeInput(ids, {
            intent: TWO_HOURS,
            lines: [{ variantId: fakeVariantId, quantity: 1 }],
          }),
        ),
      ).rejects.toThrow(FlexiblePricingError);
      try {
        await quoteFlexiblePricing(
          db,
          makeInput(ids, {
            intent: TWO_HOURS,
            lines: [{ variantId: fakeVariantId, quantity: 1 }],
          }),
        );
      } catch (err) {
        expect((err as FlexiblePricingError).code).toBe('VARIANT_NOT_FOUND');
      }
    });
  },
);
