import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { searchPublicOffers as searchPublicOffersImpl } from './search-offers';
import { createPublicSearchCursorCodec, PUBLIC_SEARCH_CONTRACT_VERSION } from './cursor';
import { PublicSearchError } from './errors';
import type {
  PublicSearchIntent,
  SearchPublicOffersInput,
  PublicProductPublicationGate,
} from './types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

const testCursorCodec = createPublicSearchCursorCodec(
  'test-secret-for-public-search-tests-only-not-for-production',
);

const fakePublicationGate: PublicProductPublicationGate = {
  async filterEligibleProductIds(_db: DatabaseClient, productIds: readonly string[]) {
    return new Set(productIds);
  },
};

async function testSearch(
  db: DatabaseClient,
  input: SearchPublicOffersInput,
): Promise<ReturnType<typeof searchPublicOffersImpl>> {
  return searchPublicOffersImpl(db, input, {
    publicationGate: fakePublicationGate,
    cursorCodec: testCursorCodec,
  });
}

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('public_search');
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
      .sql`TRUNCATE TABLE destination_translations, destinations, inventory_blocks, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

async function seedCountry(): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
    VALUES ('FR', true, 'EUR', 'fr')
    ON CONFLICT ("country_code") DO UPDATE SET "is_active" = true
  `;
}

async function seedDestination(suffix = SUFFIX()) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await seedCountry();
  const dest = await sql`
    INSERT INTO "destinations" (
      "public_id", "slug", "country_code", "place_type",
      "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east", "is_active"
    )
    VALUES (
      gen_random_uuid(), ${'annecy-' + suffix}, 'FR', 'CITY',
      ST_SetSRID(ST_MakePoint(6.12, 45.89), 4326),
      45.88, 6.10, 45.90, 6.14, false
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "destination_translations" ("destination_id", "locale", "label")
    VALUES
      (${dest.id}, 'fr', 'Annecy'),
      (${dest.id}, 'en', 'Annecy')
  `;
  await sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${dest.id}`;
  return { id: dest.id, publicId: dest.public_id };
}

async function seedOrg(suffix = SUFFIX()) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "public_display_name", "default_cancellation_policy_code", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, ${'Test Org ' + suffix}, 'FLEXIBLE', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return { orgId: org.id };
}

async function seedLocation(
  orgId: string,
  suffix = SUFFIX(),
  overrides: { lat?: number; lon?: number } = {},
) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const lat = overrides.lat ?? 45.89;
  const lon = overrides.lon ?? 6.12;
  const loc = await sql`
    INSERT INTO "locations" (
      "organization_id", "name", "slug", "time_zone",
      "address_line1", "address_line2", "city", "postal_code", "country_code",
      "geo_point", "pickup_enabled", "is_publicly_listed", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency"
    )
    VALUES (
      ${orgId}, ${'Magasin ' + suffix}, ${'mag-' + suffix}, 'Europe/Paris',
      '1 rue du lac', null, 'Annecy', '74000', 'FR',
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
      true, true, 30, 30, 'EUR'
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);
  return { locationId: loc.id, publicLocationId: loc.public_id };
}

async function seedProduct(orgId: string, categoryId: string, suffix = SUFFIX()) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const product = await sql`
    INSERT INTO "products" (
      "organization_id", "category_id", "name", "slug", "publication_status", "public_id"
    )
    VALUES (
      ${orgId}, ${categoryId}, ${'Kayak ' + suffix}, ${'kayak-' + suffix}, 'DRAFT', gen_random_uuid()
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${orgId}, ${product.id}, ${'product-photos/' + suffix + '-' + i},
        'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
        ${i}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  return { productId: product.id, publicProductId: product.public_id };
}

async function seedVariant(productId: string, _suffix = SUFFIX()) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "currency")
    VALUES (${productId}, 'Standard', true, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return { variantId: variant.id };
}

async function seedInventory(
  orgId: string,
  variantId: string,
  locationId: string,
  suffix = SUFFIX(),
) {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const item = await sql`
    INSERT INTO "inventory_items" (
      "organization_id", "product_variant_id", "internal_sku", "condition", "status", "current_location_id"
    )
    VALUES (${orgId}, ${variantId}, ${'SKU-' + suffix}, 'NEW', 'ACTIVE', ${locationId})
    RETURNING "id"
  `.then((r) => r[0]!);
  return { inventoryItemId: item.id };
}

async function seedCategory() {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const cat = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  return { categoryId: cat.id };
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

async function activatePlan(planId: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
}

async function seedTranslations(planId: string, fr: string, en: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${planId}, 'fr', ${fr}), (${planId}, 'en', ${en})
  `;
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

async function seedWeekdayOpeningHours(locationId: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  for (let weekday = 0; weekday <= 4; weekday++) {
    await sql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES (${locationId}, ${weekday}, '07:00:00', '21:00:00')
    `;
  }
}

async function fullSetup(suffix = SUFFIX(), overrides: { lat?: number; lon?: number } = {}) {
  const { publicId: destinationPublicId } = await seedDestination(suffix);
  const { orgId } = await seedOrg(suffix);
  const { locationId, publicLocationId } = await seedLocation(orgId, suffix, overrides);
  const { categoryId } = await seedCategory();
  const { productId, publicProductId } = await seedProduct(orgId, categoryId, suffix);
  const { variantId } = await seedVariant(productId, suffix);
  const { inventoryItemId } = await seedInventory(orgId, variantId, locationId, suffix);
  return {
    destinationPublicId,
    orgId,
    locationId,
    publicLocationId,
    categoryId,
    productId,
    publicProductId,
    variantId,
    inventoryItemId,
  };
}

function searchInput(
  destinationPublicId: string,
  intent: PublicSearchIntent,
  overrides: Partial<SearchPublicOffersInput> = {},
): SearchPublicOffersInput {
  return {
    destinationPublicId,
    locale: 'fr',
    intent,
    ...overrides,
  };
}

async function seedOfferGroup(
  orgId: string,
  categoryId: string,
  overrides: { lat?: number; lon?: number; withPlan?: boolean } = {},
): Promise<{
  locationId: string;
  publicLocationId: string;
  productId: string;
  publicProductId: string;
  variantId: string;
}> {
  const loc = await seedLocation(orgId, SUFFIX(), {
    lat: overrides.lat ?? 45.89,
    lon: overrides.lon ?? 6.12,
  });
  const prod = await seedProduct(orgId, categoryId);
  const variant = await seedVariant(prod.productId);
  await seedInventory(orgId, variant.variantId, loc.locationId);
  if (overrides.withPlan) {
    const planId = await seedPlan({
      orgId,
      variantId: variant.variantId,
      locationId: loc.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, `Tarif ${SUFFIX()}`, `Rate ${SUFFIX()}`);
    await seedWindow(planId, loc.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(loc.locationId);
    await activatePlan(planId);
  }
  return { ...loc, ...prod, ...variant };
}

// 2026-02-10 is a Tuesday (weekday=1 in 0=Monday system).
const TIME_RANGE_9_11: PublicSearchIntent = {
  kind: 'TIME_RANGE',
  startAt: '2026-02-10T09:00:00',
  endAt: '2026-02-10T11:00:00',
};

const DAY_RANGE_10_12: PublicSearchIntent = {
  kind: 'DAY_RANGE',
  startDate: '2026-02-10',
  endDateExclusive: '2026-02-12',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('searchPublicOffers — intégration PostgreSQL', () => {
  it('retourne une offre pour un TIME_RANGE simple (plan DAILY)', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();

    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00'); // Mon-Fri
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    const result = await testSearch(db, searchInput(ids.destinationPublicId, TIME_RANGE_9_11));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.publicProductId).toBe(ids.publicProductId);
    expect(result.items[0]!.publicLocationId).toBe(ids.publicLocationId);
    expect(result.items[0]!.isAvailable).toBe(true);
    expect(result.items[0]!.price.currency).toBe('EUR');
    expect(result.items[0]!.price.totalAmountMinor).toBe(5000);
    expect(result.items[0]!.price.planType).toBe('DAILY');
  });

  it('ne retourne rien quand le produit est bloqué par une réservation ACTIVE', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();

    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    // Bloquer l'exemplaire exactement sur la plage client
    await rawSql`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at"
      )
      VALUES (
        ${ids.orgId}, ${ids.inventoryItemId}, 'BOOKING', 'ACTIVE',
        '2026-02-10T08:00:00.000Z', '2026-02-10T12:00:00.000Z',
        '2026-02-10T07:30:00.000Z', '2026-02-10T12:30:00.000Z'
      )
    `;

    const result = await testSearch(db, searchInput(ids.destinationPublicId, TIME_RANGE_9_11));
    expect(result.items.length).toBe(0);
    expect(result.nextCursor).toBeNull();
  });

  it.each([
    [
      'destinationPublicId manquant',
      { destinationPublicId: '', locale: 'fr', intent: TIME_RANGE_9_11 },
    ],
    [
      'locale manquante',
      { destinationPublicId: randomUUID(), locale: '', intent: TIME_RANGE_9_11 },
    ],
    [
      'pageSize hors bornes',
      { destinationPublicId: randomUUID(), locale: 'fr', intent: TIME_RANGE_9_11, pageSize: 0 },
    ],
    [
      'intent invalide',
      {
        destinationPublicId: randomUUID(),
        locale: 'fr',
        intent: { kind: 'UNKNOWN' } as unknown as PublicSearchIntent,
      },
    ],
    [
      'curseur corrompu',
      {
        destinationPublicId: randomUUID(),
        locale: 'fr',
        intent: TIME_RANGE_9_11,
        cursor: 'not-a-cursor',
      },
    ],
  ])('lève une erreur typée si %s', async (label, input) => {
    void label;
    if (!db) return;
    await expect(testSearch(db, input as SearchPublicOffersInput)).rejects.toThrow(
      PublicSearchError,
    );
  });

  it('retourne une offre HOURLY de 2 heures', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'HOURLY',
      currency: 'EUR',
      priceAmountMinor: 2500,
      minDurationMinutes: 60,
      maxDurationMinutes: 240,
      billingIncrementMinutes: 60,
    });
    await seedTranslations(planId, 'Tarif horaire', 'Hourly rate');
    await seedWindow(planId, ids.locationId, 31, '07:00:00', '21:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    const result = await testSearch(db, searchInput(ids.destinationPublicId, TIME_RANGE_9_11));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.price.planType).toBe('HOURLY');
    expect(result.items[0]!.price.totalAmountMinor).toBe(5000);
    expect(result.items[0]!.price.billedDurationMinutes).toBe(120);
  });

  it('retourne une offre DAY_RANGE de 2 jours avec DAILY', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    const result = await testSearch(db, searchInput(ids.destinationPublicId, DAY_RANGE_10_12));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.price.planType).toBe('DAILY');
    expect(result.items[0]!.price.totalAmountMinor).toBe(10000);
    expect(result.items[0]!.price.billedDays).toBe(2);
  });

  it('applique une remise DAILY sur 4 jours', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await rawSql`INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent") VALUES (${planId}, 3, 10)`;
    await activatePlan(planId);

    const dayRange4: PublicSearchIntent = {
      kind: 'DAY_RANGE',
      startDate: '2026-02-10',
      endDateExclusive: '2026-02-14',
    };
    const result = await testSearch(db, searchInput(ids.destinationPublicId, dayRange4));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.price.totalAmountMinor).toBe(18000);
    expect(result.items[0]!.price.billedDays).toBe(4);
    expect(result.items[0]!.price.discountPercent).toBe(10);
  });

  it('lève INVALID_LOCAL_TIME pour une heure inexistante (DST)', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    const spring: PublicSearchIntent = {
      kind: 'TIME_RANGE',
      startAt: '2026-03-29T02:30:00',
      endAt: '2026-03-29T03:00:00',
    };
    await expect(testSearch(db, searchInput(ids.destinationPublicId, spring))).rejects.toThrow(
      PublicSearchError,
    );
  });

  it('pagine avec un curseur opaque sur 2 offres', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planA = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planA, 'A', 'A');
    await seedWindow(planA, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planA);

    const suffix = SUFFIX();
    const productB = await seedProduct(ids.orgId, ids.categoryId, suffix);
    const variantB = await seedVariant(productB.productId, suffix);
    await seedInventory(ids.orgId, variantB.variantId, ids.locationId, suffix + 'b');
    const planB = await seedPlan({
      orgId: ids.orgId,
      variantId: variantB.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 7000,
    });
    await seedTranslations(planB, 'B', 'B');
    await seedWindow(planB, ids.locationId, 31, '08:00:00', '20:00:00');
    await activatePlan(planB);

    const page1 = await testSearch(db, {
      destinationPublicId: ids.destinationPublicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
    });
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await testSearch(db, {
      destinationPublicId: ids.destinationPublicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('lève INVALID_CURSOR quand le curseur est lié à une autre destination (D2)', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();

    const planA = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planA, 'A', 'A');
    await seedWindow(planA, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planA);

    const productB = await seedProduct(ids.orgId, ids.categoryId, SUFFIX());
    const variantB = await seedVariant(productB.productId);
    await seedInventory(ids.orgId, variantB.variantId, ids.locationId, SUFFIX());
    const planB = await seedPlan({
      orgId: ids.orgId,
      variantId: variantB.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 7000,
    });
    await seedTranslations(planB, 'B', 'B');
    await seedWindow(planB, ids.locationId, 31, '08:00:00', '20:00:00');
    await activatePlan(planB);

    const page1 = await testSearch(
      db,
      searchInput(ids.destinationPublicId, TIME_RANGE_9_11, { pageSize: 1 }),
    );
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).toBeTypeOf('string');

    const dest2 = await seedDestination(SUFFIX());

    let caught: unknown;
    try {
      await testSearch(db, {
        destinationPublicId: dest2.publicId,
        locale: 'fr',
        intent: TIME_RANGE_9_11,
        pageSize: 1,
        cursor: page1.nextCursor!,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PublicSearchError);
    expect((caught as PublicSearchError).code).toBe('INVALID_CURSOR');
  });

  it('ne fuite jamais dID internes ni de données sensibles', async () => {
    if (!db || !rawSql) return;
    const ids = await fullSetup();
    const planId = await seedPlan({
      orgId: ids.orgId,
      variantId: ids.variantId,
      locationId: ids.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, ids.locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(ids.locationId);
    await activatePlan(planId);

    const result = await testSearch(db, searchInput(ids.destinationPublicId, TIME_RANGE_9_11));
    expect(result.items.length).toBe(1);
    const item = result.items[0]!;
    expect(item.isAvailable).toBe(true);
    for (const key of [
      'organizationId',
      'locationId',
      'productId',
      'variantId',
      'pricingPlanId',
      'legalName',
      'sku',
      'quantity',
      'serialNumber',
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P2 — Géo et batching
  // ─────────────────────────────────────────────────────────────────────────────

  it('P2-1 : bbox traversant lantiméridien inclut une location à lon=175°', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`
      UPDATE "destinations"
      SET center = ST_SetSRID(ST_MakePoint(${177}, ${-17}), 4326),
          bbox_south = -20, bbox_west = 170, bbox_north = -15, bbox_east = -170
      WHERE id = ${dest.id}
    `;

    const { orgId } = await seedOrg();
    const { locationId, publicLocationId } = await seedLocation(orgId, SUFFIX(), {
      lat: -17,
      lon: 175,
    });
    const { categoryId } = await seedCategory();
    const { productId, publicProductId } = await seedProduct(orgId, categoryId);
    const { variantId } = await seedVariant(productId);
    await seedInventory(orgId, variantId, locationId);
    const planId = await seedPlan({
      orgId,
      variantId,
      locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    await seedTranslations(planId, 'Tarif journalier', 'Daily rate');
    await seedWindow(planId, locationId, 31, '08:00:00', '20:00:00');
    await seedWeekdayOpeningHours(locationId);
    await activatePlan(planId);

    const result = await testSearch(db, searchInput(dest.publicId, DAY_RANGE_10_12));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.publicProductId).toBe(publicProductId);
    expect(result.items[0]!.publicLocationId).toBe(publicLocationId);
  });

  it('G7E-B : le viewport filtre SQL et sépare exact et alternative géographique', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const exact = await seedOfferGroup(orgId, categoryId, {
      lon: 6.12,
      lat: 45.89,
      withPlan: true,
    });
    const alternative = await seedOfferGroup(orgId, categoryId, {
      lon: 6.2,
      lat: 45.89,
      withPlan: true,
    });

    const exactSearch = await testSearch(db, searchInput(dest.publicId, DAY_RANGE_10_12));
    expect(exactSearch.items.map((item) => item.publicProductId)).toEqual([exact.publicProductId]);
    expect(exactSearch.items[0]!.geographicMatch).toBe('EXACT');

    const viewportSearch = await testSearch(
      db,
      searchInput(dest.publicId, DAY_RANGE_10_12, {
        viewport: {
          kind: 'VIEWPORT',
          south: 45.85,
          west: 6.1,
          north: 45.95,
          east: 6.25,
        },
      }),
    );
    expect(viewportSearch.items.map((item) => item.publicProductId)).toEqual(
      expect.arrayContaining([exact.publicProductId, alternative.publicProductId]),
    );
    expect(viewportSearch.items).toHaveLength(2);
    expect(
      viewportSearch.items.find((item) => item.publicProductId === exact.publicProductId)
        ?.geographicMatch,
    ).toBe('EXACT');
    expect(
      viewportSearch.items.find((item) => item.publicProductId === alternative.publicProductId)
        ?.geographicMatch,
    ).toBe('VIEWPORT_ALTERNATIVE');
  });

  it.each([1, 2, 5])(
    'appels directs db.execute (pricing et disponibilité batchés) avec %s lieux distincts',
    async (n) => {
      if (!db || !rawSql) return;
      const dest = await seedDestination();
      await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
      const { orgId } = await seedOrg();
      const { categoryId } = await seedCategory();

      const locs: { locationId: string; publicLocationId: string }[] = [];
      for (let i = 0; i < n; i++) {
        const loc = await seedLocation(orgId, SUFFIX(), { lat: 45.89, lon: 6.12 + i * 0.01 });
        const prod = await seedProduct(orgId, categoryId);
        const variant = await seedVariant(prod.productId);
        await seedInventory(orgId, variant.variantId, loc.locationId);
        const planId = await seedPlan({
          orgId,
          variantId: variant.variantId,
          locationId: loc.locationId,
          planType: 'DAILY',
          currency: 'EUR',
          priceAmountMinor: 5000 + i * 100,
        });
        await seedTranslations(planId, `Tarif ${i}`, `Rate ${i}`);
        await seedWindow(planId, loc.locationId, 31, '08:00:00', '20:00:00');
        await seedWeekdayOpeningHours(loc.locationId);
        await activatePlan(planId);
        locs.push(loc);
      }

      // Ce test compte UNIQUEMENT les appels directs à db.execute (requêtes
      // SQL brutes via template sql``). Il ne compte PAS les appels db.select()
      // (query builder Drizzle) qui exécutent également des requêtes SQL réelles.
      //
      // Preuve structurelle du batching (lecture du code source) :
      // - loadPricingContextsBatch : 1 seul db.execute (CROSS JOIN LATERAL
      //   resolve_effective_pricing_plans pour toutes les locations), puis
      //   db.select batched pour fenêtres/paliers/traductions/horaires.
      // - checkAvailabilityBatch : 1 seul db.execute (CTE params avec
      //   jsonb_array_elements pour toutes les candidates).
      // - Pricing et disponibilité sont chacun batchés en une seule requête
      //   par lot, pas une requête par lieu.
      // - La borne maximale par appel est 5 lots × (requêtes par lot) lorsque
      //   MAX_SCAN_BATCHES est atteint.
      //
      // Les 5 appels db.execute pour un seul lot sont :
      // 1. loadDestination (ST_X/ST_Y centre)
      // 2. loadCandidateGroups (CTE candidates)
      // 3. loadCandidateVariantRows (CTE groups)
      // 4. loadPricingContextsBatch (CROSS JOIN LATERAL)
      // 5. checkAvailabilityBatch (CTE params)
      const originalExecute = db.execute.bind(db);
      let executeCalls = 0;
      const dbWithExecute = db as { execute: typeof originalExecute };
      dbWithExecute.execute = (query) => {
        executeCalls++;
        return originalExecute(query);
      };

      try {
        const result = await testSearch(db, searchInput(dest.publicId, TIME_RANGE_9_11));
        expect(result.items.length).toBe(n);
        expect(result.items.map((i) => i.publicLocationId).sort()).toEqual(
          locs.map((l) => l.publicLocationId).sort(),
        );
        // Le nombre d'appels db.execute reste constant (5) indépendamment du
        // nombre de lieux, prouvant le batching de pricing et disponibilité.
        expect(executeCalls).toBe(5);
      } finally {
        dbWithExecute.execute = originalExecute;
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // P3 — Pagination inéligibles et curseurs checkpoints
  // ─────────────────────────────────────────────────────────────────────────────

  it('P3-1 : 10 lots inéligibles suivis d un candidat valide (3 pages de scan)', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    for (let i = 0; i < 10; i++) {
      await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan: false });
    }
    const valid = await seedOfferGroup(orgId, categoryId, { lon: 6.22, withPlan: true });

    // Avec scanCapacity = pageSize = 1 et MAX_SCAN_BATCHES = 5, chaque page
    // scanne au plus 5 groupes. 10 inéligibles nécessitent 2 pages de scan
    // vide, puis une 3e page retourne le candidat valide.
    const page1 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
    });
    expect(page1.items.length).toBe(0);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(0);
    expect(page2.nextCursor).toBeTypeOf('string');

    const page3 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.length).toBe(1);
    expect(page3.items[0]!.publicProductId).toBe(valid.publicProductId);
    expect(page3.nextCursor).toBeNull();
  });

  it('P3-2 : page partielle au seuil MAX_SCAN_BATCHES', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const groups: { publicProductId: string }[] = [];
    for (let i = 0; i < 17; i++) {
      const withPlan = i === 4 || i === 15 || i === 16;
      const group = await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan });
      groups.push(group);
    }

    const page1 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 2 }),
    );
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 2, cursor: page1.nextCursor! }),
    );
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    const returnedIds = [
      page1.items[0]!.publicProductId,
      ...page2.items.map((i) => i.publicProductId),
    ];
    expect(new Set(returnedIds).size).toBe(3);
    expect(returnedIds).toContain(groups[4]!.publicProductId);
    expect(returnedIds).toContain(groups[15]!.publicProductId);
    expect(returnedIds).toContain(groups[16]!.publicProductId);
  });

  it('P3-3 : source épuisée retourne nextCursor null', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    await seedOfferGroup(orgId, categoryId, { lon: 6.12, withPlan: true });
    await seedOfferGroup(orgId, categoryId, { lon: 6.13, withPlan: true });

    const result = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 3 }),
    );
    expect(result.items.length).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('P3-4 : continuations successives sans doublon ni perte', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const valids: { publicProductId: string }[] = [];
    for (let i = 0; i < 5; i++) {
      valids.push(
        await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan: true }),
      );
    }

    const seen = new Set<string>();
    const allIds: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await testSearch(
        db,
        searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1, ...(cursor ? { cursor } : {}) }),
      );
      for (const item of result.items) {
        expect(seen.has(item.publicProductId)).toBe(false);
        seen.add(item.publicProductId);
        allIds.push(item.publicProductId);
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    expect(allIds.length).toBe(5);
    for (const v of valids) {
      expect(allIds).toContain(v.publicProductId);
    }
  });

  it('P3-5 : curseur checkpoint est signé et lié à la recherche', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const ineligibles: { publicProductId: string }[] = [];
    for (let i = 0; i < 10; i++) {
      ineligibles.push(
        await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan: false }),
      );
    }
    const valid = await seedOfferGroup(orgId, categoryId, { lon: 6.22, withPlan: true });

    const page1 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1 }),
    );
    expect(page1.items.length).toBe(0);
    expect(page1.nextCursor).toBeTypeOf('string');

    const cursor = page1.nextCursor!;
    const decoded = testCursorCodec.decode(cursor, {
      destinationPublicId: dest.publicId,
      canonicalLocale: 'fr',
      canonicalIntent: TIME_RANGE_9_11,
      categoryId: null,
      viewport: null,
      contractVersion: PUBLIC_SEARCH_CONTRACT_VERSION,
    });
    // Avec scanCapacity = 1 et MAX_SCAN_BATCHES = 5, la première page scanne
    // les groupes 0-4. Le curseur checkpoint pointe sur le 5e groupe traité
    // (ineligibles[4]), pas sur le 10e.
    expect(decoded.publicProductId).toBe(ineligibles[4]!.publicProductId);

    const tampered = cursor.slice(0, -4) + 'XXXX';
    expect(() =>
      testCursorCodec.decode(tampered, {
        destinationPublicId: dest.publicId,
        canonicalLocale: 'fr',
        canonicalIntent: TIME_RANGE_9_11,
        categoryId: null,
        viewport: null,
        contractVersion: PUBLIC_SEARCH_CONTRACT_VERSION,
      }),
    ).toThrow(PublicSearchError);

    const dest2 = await seedDestination();
    await expect(
      searchPublicOffersImpl(
        db,
        searchInput(dest2.publicId, TIME_RANGE_9_11, { pageSize: 1, cursor }),
        {
          publicationGate: fakePublicationGate,
          cursorCodec: testCursorCodec,
        },
      ),
    ).rejects.toThrow(PublicSearchError);

    // Le curseur permet de continuer le scan. La 2e page scanne les groupes 5-9.
    const page2 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1, cursor }),
    );
    expect(page2.items.length).toBe(0);
    expect(page2.nextCursor).toBeTypeOf('string');

    // La 3e page récupère l'élément valide.
    const page3 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1, cursor: page2.nextCursor! }),
    );
    expect(page3.items.length).toBe(1);
    expect(page3.items[0]!.publicProductId).toBe(valid.publicProductId);
    expect(page3.nextCursor).toBeNull();
  });

  it('P3-6 : CURSOR_CODEC_UNAVAILABLE empêche tout accès DB', async () => {
    if (!db) return;
    const destinationPublicId = randomUUID();

    const originalExecute = db.execute.bind(db);
    let executeCalls = 0;
    const dbWithExecute = db as { execute: typeof originalExecute };
    dbWithExecute.execute = (query) => {
      executeCalls++;
      return originalExecute(query);
    };

    let caught: unknown;
    try {
      await searchPublicOffersImpl(db, searchInput(destinationPublicId, TIME_RANGE_9_11), {
        publicationGate: fakePublicationGate,
      } as unknown as Parameters<typeof searchPublicOffersImpl>[2]);
    } catch (e) {
      caught = e;
    } finally {
      dbWithExecute.execute = originalExecute;
    }

    expect(caught).toBeInstanceOf(PublicSearchError);
    expect((caught as PublicSearchError).code).toBe('CURSOR_CODEC_UNAVAILABLE');
    expect(executeCalls).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P4 — Lookahead SQL et cas limites de pagination
  // ─────────────────────────────────────────────────────────────────────────────

  it('P4-1 : exactement 5 lots inéligibles sans aucun groupe après → nextCursor null', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // Exactement 5 * pageSize = 5 groupes inéligibles (pas de plan).
    for (let i = 0; i < 5; i++) {
      await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan: false });
    }

    const result = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
    });
    expect(result.items.length).toBe(0);
    expect(result.nextCursor).toBeNull();
  });

  it('P4-2 : 5 lots inéligibles + 1 groupe valide après → checkpoint puis récupération', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // 5 groupes inéligibles + 1 groupe valide (6 groupes au total).
    for (let i = 0; i < 5; i++) {
      await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan: false });
    }
    const valid = await seedOfferGroup(orgId, categoryId, { lon: 6.17, withPlan: true });

    const page1 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
    });
    expect(page1.items.length).toBe(0);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.items[0]!.publicProductId).toBe(valid.publicProductId);
    expect(page2.nextCursor).toBeNull();
  });

  it('P4-3 : exactement pageSize résultats valides et aucune autre donnée → nextCursor null', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // Exactement 2 groupes valides, pageSize = 2.
    const g1 = await seedOfferGroup(orgId, categoryId, { lon: 6.12, withPlan: true });
    const g2 = await seedOfferGroup(orgId, categoryId, { lon: 6.13, withPlan: true });

    const result = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 2,
    });
    expect(result.items.length).toBe(2);
    expect(result.nextCursor).toBeNull();
    const ids = result.items.map((i) => i.publicProductId);
    expect(ids).toContain(g1.publicProductId);
    expect(ids).toContain(g2.publicProductId);
  });

  it('P4-4 : page pleine avec un autre groupe après le dernier élément retourné', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // 2 groupes valides, pageSize = 1.
    const g1 = await seedOfferGroup(orgId, categoryId, { lon: 6.12, withPlan: true });
    const g2 = await seedOfferGroup(orgId, categoryId, { lon: 6.13, withPlan: true });

    const page1 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
    });
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeNull();

    // Pas de doublon, pas de perte.
    const allIds = [page1.items[0]!.publicProductId, page2.items[0]!.publicProductId];
    expect(new Set(allIds).size).toBe(2);
    expect(allIds).toContain(g1.publicProductId);
    expect(allIds).toContain(g2.publicProductId);
  });

  it('P4-5 : page partielle au plafond de scan avec vrai lookahead', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // pageSize = 2, scanCapacity = 2, MAX_SCAN_BATCHES = 5.
    // 5 batches × 2 groupes = 10 groupes scannés au maximum.
    // 11 groupes (0-10) : seul le groupe 7 est valide parmi les 10 premiers.
    // Le groupe 10 est valide (après le 5e batch, lookahead).
    // La page 1 sera partielle (1 résultat) au plafond de scan avec vrai lookahead.
    const groups: { publicProductId: string }[] = [];
    for (let i = 0; i < 11; i++) {
      const withPlan = i === 7 || i === 10;
      groups.push(await seedOfferGroup(orgId, categoryId, { lon: 6.12 + i * 0.01, withPlan }));
    }

    const page1 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 2,
    });
    // Page partielle (1 résultat) avec vrai lookahead → nextCursor non nul.
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0]!.publicProductId).toBe(groups[7]!.publicProductId);

    // Continuation récupère la suite.
    const page2 = await testSearch(db, {
      destinationPublicId: dest.publicId,
      locale: 'fr',
      intent: TIME_RANGE_9_11,
      pageSize: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.items[0]!.publicProductId).toBe(groups[10]!.publicProductId);
    expect(page2.nextCursor).toBeNull();
  });

  it('P4-6 : plusieurs checkpoints successifs jusqu à terminaison', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.30 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    // ≥ 12 groupes avec un pattern d'inéligibilité qui force plusieurs
    // checkpoints. pageSize = 1, scanCapacity = 1, MAX_SCAN_BATCHES = 5.
    // 12 groupes : inéligibles sauf les indices 5, 8, 11 (valides).
    const valids: { publicProductId: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const withPlan = i === 5 || i === 8 || i === 11;
      const group = await seedOfferGroup(orgId, categoryId, {
        lon: 6.12 + i * 0.01,
        withPlan,
      });
      if (withPlan) valids.push(group);
    }

    // Parcourir toutes les pages jusqu'à terminaison.
    const seen = new Set<string>();
    const allIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      expect(pageCount).toBeLessThan(20); // garde-fou anti-boucle infinie
      pageCount++;
      const result = await testSearch(
        db,
        searchInput(dest.publicId, TIME_RANGE_9_11, {
          pageSize: 1,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const item of result.items) {
        expect(seen.has(item.publicProductId)).toBe(false);
        seen.add(item.publicProductId);
        allIds.push(item.publicProductId);
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    // Terminaison : aucun doublon, aucune omission.
    expect(allIds.length).toBe(3);
    for (const v of valids) {
      expect(allIds).toContain(v.publicProductId);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // P1-4 — Pagination keyset SQL
  // ─────────────────────────────────────────────────────────────────────────────

  it('P1-4 : pagination keyset SQL complète sur 2 pages sans duplication ni omission', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const locA = await seedLocation(orgId, SUFFIX(), { lat: 45.89, lon: 6.12 });
    const locB = await seedLocation(orgId, SUFFIX(), { lat: 45.89, lon: 6.13 });

    const prodA = await seedProduct(orgId, categoryId);
    const prodB = await seedProduct(orgId, categoryId);

    const varA = await seedVariant(prodA.productId);
    const varB = await seedVariant(prodB.productId);

    await seedInventory(orgId, varA.variantId, locA.locationId);
    await seedInventory(orgId, varB.variantId, locB.locationId);

    const planA = await seedPlan({
      orgId,
      variantId: varA.variantId,
      locationId: locA.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 5000,
    });
    const planB = await seedPlan({
      orgId,
      variantId: varB.variantId,
      locationId: locB.locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 6000,
    });

    await seedTranslations(planA, 'Tarif A', 'Rate A');
    await seedTranslations(planB, 'Tarif B', 'Rate B');
    await seedWindow(planA, locA.locationId, 31, '07:00:00', '21:00:00');
    await seedWindow(planB, locB.locationId, 31, '07:00:00', '21:00:00');
    await seedWeekdayOpeningHours(locA.locationId);
    await seedWeekdayOpeningHours(locB.locationId);
    await activatePlan(planA);
    await activatePlan(planB);

    const page1 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1 }),
    );
    expect(page1.items.length).toBe(1);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 1, cursor: page1.nextCursor! }),
    );
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeNull();

    const ids = new Set([page1.items[0]!.publicProductId, page2.items[0]!.publicProductId]);
    expect(ids.size).toBe(2);
    expect(ids.has(prodA.publicProductId) && ids.has(prodB.publicProductId)).toBe(true);
  });

  it('P1-4 : plusieurs variantes du même produit occupent une seule place', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    const { orgId } = await seedOrg();
    const { locationId, publicLocationId } = await seedLocation(orgId);
    const { categoryId } = await seedCategory();
    const { productId, publicProductId } = await seedProduct(orgId, categoryId);

    const varA = await seedVariant(productId);
    const varB = await seedVariant(productId);

    await seedInventory(orgId, varA.variantId, locationId);
    await seedInventory(orgId, varB.variantId, locationId);

    const planA = await seedPlan({
      orgId,
      variantId: varA.variantId,
      locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 4000,
    });
    const planB = await seedPlan({
      orgId,
      variantId: varB.variantId,
      locationId,
      planType: 'DAILY',
      currency: 'EUR',
      priceAmountMinor: 8000,
    });

    await seedTranslations(planA, 'Tarif A', 'Rate A');
    await seedTranslations(planB, 'Tarif B', 'Rate B');
    await seedWindow(planA, locationId, 31, '07:00:00', '21:00:00');
    await seedWindow(planB, locationId, 31, '07:00:00', '21:00:00');
    await seedWeekdayOpeningHours(locationId);
    await activatePlan(planA);
    await activatePlan(planB);

    const result = await testSearch(db, searchInput(dest.publicId, TIME_RANGE_9_11));
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.publicProductId).toBe(publicProductId);
    expect(result.items[0]!.publicLocationId).toBe(publicLocationId);
    expect(result.items[0]!.price.totalAmountMinor).toBe(4000);
  });

  it('P1-4 : pageSize respecté sur un volume de 5 groupes', async () => {
    if (!db || !rawSql) return;
    const dest = await seedDestination();
    await rawSql`UPDATE "destinations" SET bbox_east = 6.20 WHERE id = ${dest.id}`;
    const { orgId } = await seedOrg();
    const { categoryId } = await seedCategory();

    const publicProductIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { locationId } = await seedLocation(orgId, SUFFIX(), {
        lat: 45.89,
        lon: 6.12 + i * 0.01,
      });
      const { productId, publicProductId } = await seedProduct(orgId, categoryId);
      const { variantId } = await seedVariant(productId);
      await seedInventory(orgId, variantId, locationId);
      const planId = await seedPlan({
        orgId,
        variantId,
        locationId,
        planType: 'DAILY',
        currency: 'EUR',
        priceAmountMinor: 5000 + i * 100,
      });
      await seedTranslations(planId, `Tarif ${i}`, `Rate ${i}`);
      await seedWindow(planId, locationId, 31, '07:00:00', '21:00:00');
      await seedWeekdayOpeningHours(locationId);
      await activatePlan(planId);
      publicProductIds.push(publicProductId);
    }

    const page1 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, { pageSize: 3 }),
    );
    expect(page1.items.length).toBe(3);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await testSearch(
      db,
      searchInput(dest.publicId, TIME_RANGE_9_11, {
        pageSize: 3,
        cursor: page1.nextCursor!,
      }),
    );
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((i) => i.publicProductId);
    expect(new Set(allIds).size).toBe(5);
    for (const id of publicProductIds) {
      expect(allIds).toContain(id);
    }
  });
});

describe('search-offers — assertions unitaires', () => {
  it('ne contient aucun OFFSET, findKeysetIndex ni slice() de pagination des résultats', async () => {
    const source = await readFile(new URL('./search-offers.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/function\s+findKeysetIndex/);
    // Le seul slice autorisé est dans loadCandidates : groups.slice(0, scanCapacity)
    // segmente le lot SQL (lookahead), ne pagine pas les résultats finaux.
    expect(source).not.toMatch(/candidates\.slice\(/);
    expect(source).not.toMatch(/selected\.slice\(/);
    expect(source).not.toMatch(/batchValid\.slice\(/);
    expect(source).not.toMatch(/groupedOffers\.slice\(/);
    expect(source).toContain('groups.slice(0, scanCapacity)');
    expect(source).not.toContain(' OFFSET ');
    expect(source).toContain('LIMIT ${limit}');
  });
});
