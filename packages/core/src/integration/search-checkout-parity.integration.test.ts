/**
 * @uttily/core — Search & Checkout Parity Integration Test (Chantier 15.2.1).
 *
 * Prouve la vraie parité décisionnelle entre le read model de recherche
 * (`searchPublicOffers`) et le write model de réservation
 * (`createBookingDraftWithHold` en pricing FLEXIBLE) sur une vraie base PostgreSQL.
 *
 * Avec la même fixture partagée :
 * - Période standard ouverte : acceptation et montant identique (Search & Checkout).
 * - CLOSED premier jour : refus Search (0 item) et refus Checkout (failure).
 * - CLOSED dernier jour : refus Search (0 item) et refus Checkout (failure).
 * - CLOSED jour intermédiaire uniquement : acceptation Search (1 item) et Checkout (success).
 * - OPEN_INTERVAL incompatible : refus Search (0 item) et refus Checkout (failure).
 * - OPEN_INTERVAL compatible (étendu) : acceptation Search (1 item) et Checkout (success).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';
import { searchPublicOffers } from '../public-search/search-offers';
import { createPublicSearchCursorCodec } from '../public-search/cursor';
import { PostgresPhotoPublicationGate } from '../photos/postgres-publication-gate';
import { createBookingDraftWithHold } from '../booking-drafts';
import type {
  CreateBookingDraftFailure,
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  FlexibleCreateBookingDraftInput,
} from '../booking-drafts/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('search_checkout_parity');
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
      location_schedule_exceptions,
      allocations, booking_draft_lines, booking_drafts, inventory_blocks,
      inventory_movements, inventory_items, product_variants, products,
      location_opening_hours, pricing_plan_translations, pricing_plan_windows,
      multi_day_discount_tiers, pricing_plans, destinations, destination_translations,
      locations, organization_memberships,
      organizations, users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

const testCursorCodec = createPublicSearchCursorCodec(
  'test-secret-for-parity-integration-tests-32-chars-min!',
);
const realPublicationGate = new PostgresPhotoPublicationGate();

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

interface ParityFixtureIds {
  orgId: string;
  locationId: string;
  publicLocationId: string;
  userId: string;
  productId: string;
  publicProductId: string;
  variantId: string;
  publicVariantId: string;
  inventoryItemId: string;
  destinationPublicId: string;
  pricingPlanId: string;
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

function makeFlexibleDayRangeInput(
  ids: ParityFixtureIds,
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

async function seedCountry(): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
    VALUES ('FR', true, 'EUR', 'fr')
    ON CONFLICT ("country_code") DO UPDATE SET "is_active" = true
  `;
}

async function seedDestination(suffix = SUFFIX()): Promise<{ id: string; publicId: string }> {
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

async function seedParityFixture(suffix = SUFFIX()): Promise<ParityFixtureIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;

  const { publicId: destinationPublicId } = await seedDestination(suffix);

  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "public_display_name", "default_cancellation_policy_code", "default_currency")
    VALUES (${'Parity Org ' + suffix}, ${'org-' + suffix}, ${'Parity Org ' + suffix}, 'FLEXIBLE', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);

  const loc = await sql`
    INSERT INTO "locations" (
      "organization_id", "name", "slug", "time_zone",
      "address_line1", "address_line2", "city", "postal_code", "country_code",
      "geo_point", "pickup_enabled", "is_publicly_listed", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency"
    )
    VALUES (
      ${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris',
      '1 rue du lac', null, 'Annecy', '74000', 'FR',
      ST_SetSRID(ST_MakePoint(6.12, 45.89), 4326),
      true, true, 30, 30, 'EUR'
    )
    RETURNING "id", "public_id"
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
    INSERT INTO "products" (
      "organization_id", "category_id", "name", "slug", "publication_status", "public_id"
    )
    VALUES (
      ${org.id}, ${category.id}, 'Kayak Pro', ${'kayak-' + suffix}, 'DRAFT', gen_random_uuid()
    )
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);

  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + i},
        'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
        ${i}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;

  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "pricing_mode", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 'FLEXIBLE', 5000, 'EUR')
    RETURNING "id", "public_id"
  `.then((r) => r[0]!);

  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${loc.id}, 'NEW', 'ACTIVE')
    RETURNING "id"
  `.then((r) => r[0]!);

  // Horaires hebdo lundi-vendredi 09:00:00 - 18:00:00
  for (let weekday = 0; weekday <= 4; weekday++) {
    await sql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES (${loc.id}, ${weekday}, '09:00:00', '18:00:00')
    `;
  }

  // Plan DAILY standard 50€/jour, fenêtre 09:00-18:00
  const plan = await sql`
    INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "priority", "lifecycle_state", "version")
    VALUES (${org.id}, ${variant.id}, ${loc.id}, 'DAILY', 'EUR', 5000, 0, 'DRAFT', 1)
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
    VALUES (${plan.id}, ${loc.id}, 127, '09:00:00', '18:00:00')
  `;
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Tarif Standard'), (${plan.id}, 'en', 'Standard Rate')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;

  return {
    orgId: org.id,
    locationId: loc.id,
    publicLocationId: loc.public_id,
    userId: user.id,
    productId: product.id,
    publicProductId: product.public_id,
    variantId: variant.id,
    publicVariantId: variant.public_id,
    inventoryItemId: item.id,
    destinationPublicId,
    pricingPlanId: plan.id,
  };
}

describe.skipIf(shouldSkipIntegrationTests())(
  'Search & Checkout Parity Integration Tests (Chantier 15.2.1)',
  () => {
    it('1. Période standard ouverte : Search trouve l’offre et Checkout crée le hold au même montant', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      const startDate = '2026-08-24'; // Lundi
      const endDateExclusive = '2026-08-28'; // Vendredi (4 jours)

      // A. Search
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );

      expect(searchRes.items.length).toBe(1);
      const offer = searchRes.items[0]!;
      expect(offer.publicProductId).toBe(ids.publicProductId);
      expect(offer.price.totalAmountMinor).toBe(20000); // 4 * 5000

      // B. Checkout (createBookingDraftWithHold)
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectSuccess(draftRes);
      expect(draftRes.body.totalAmountMinor).toBe(20000);
      expect(draftRes.body.totalAmountMinor).toBe(offer.price.totalAmountMinor);
    });

    it('2. CLOSED premier jour : Search exclut l’offre (0 item) et Checkout refuse la création du hold', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      // Exception CLOSED sur le premier jour
      await rawSql`
        INSERT INTO "location_schedule_exceptions" ("organization_id", "location_id", "local_date", "kind", "reason")
        VALUES (${ids.orgId}, ${ids.locationId}, '2026-08-24', 'CLOSED', 'Fermeture exceptionnelle')
      `;

      const startDate = '2026-08-24';
      const endDateExclusive = '2026-08-28';

      // A. Search -> 0 item
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );
      expect(searchRes.items.length).toBe(0);

      // B. Checkout -> refuse
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectFailure(draftRes);
    });

    it('3. CLOSED dernier jour : Search exclut l’offre et Checkout refuse la création du hold', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      // Exception CLOSED sur le dernier jour de location (2026-08-27)
      await rawSql`
        INSERT INTO "location_schedule_exceptions" ("organization_id", "location_id", "local_date", "kind", "reason")
        VALUES (${ids.orgId}, ${ids.locationId}, '2026-08-27', 'CLOSED', 'Fermeture exceptionnelle')
      `;

      const startDate = '2026-08-24';
      const endDateExclusive = '2026-08-28';

      // A. Search -> 0 item
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );
      expect(searchRes.items.length).toBe(0);

      // B. Checkout -> refuse
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectFailure(draftRes);
    });

    it('4. Jour intermédiaire CLOSED : Search et Checkout acceptent tous les deux avec le même montant', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      // Exception CLOSED sur un jour intermédiaire (2026-08-25)
      await rawSql`
        INSERT INTO "location_schedule_exceptions" ("organization_id", "location_id", "local_date", "kind", "reason")
        VALUES (${ids.orgId}, ${ids.locationId}, '2026-08-25', 'CLOSED', 'Fermeture intermédiaire')
      `;

      const startDate = '2026-08-24';
      const endDateExclusive = '2026-08-28';

      // A. Search -> 1 item
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );
      expect(searchRes.items.length).toBe(1);
      expect(searchRes.items[0]!.price.totalAmountMinor).toBe(20000);

      // B. Checkout -> success
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectSuccess(draftRes);
      expect(draftRes.body.totalAmountMinor).toBe(20000);
    });

    it('5. OPEN_INTERVAL incompatible : Search exclut l’offre et Checkout refuse le hold', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      // Exception OPEN_INTERVAL restrictif (12:00-15:00) incompatible avec la fenêtre (09:00-18:00)
      await rawSql`
        INSERT INTO "location_schedule_exceptions" ("organization_id", "location_id", "local_date", "kind", "open_time", "close_time", "reason")
        VALUES (${ids.orgId}, ${ids.locationId}, '2026-08-24', 'OPEN_INTERVAL', '12:00:00', '15:00:00', 'Horaires restreints')
      `;

      const startDate = '2026-08-24';
      const endDateExclusive = '2026-08-28';

      // A. Search -> 0 item
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );
      expect(searchRes.items.length).toBe(0);

      // B. Checkout -> refuse
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectFailure(draftRes);
    });

    it('6. OPEN_INTERVAL compatible (étendu) : Search trouve l’offre et Checkout crée le hold au même montant', async () => {
      if (!db || !rawSql) return;
      const ids = await seedParityFixture();

      // Exception OPEN_INTERVAL étendu (08:00-20:00) compatible avec la fenêtre (09:00-18:00)
      await rawSql`
        INSERT INTO "location_schedule_exceptions" ("organization_id", "location_id", "local_date", "kind", "open_time", "close_time", "reason")
        VALUES (${ids.orgId}, ${ids.locationId}, '2026-08-24', 'OPEN_INTERVAL', '08:00:00', '20:00:00', 'Journée étendue')
      `;

      const startDate = '2026-08-24';
      const endDateExclusive = '2026-08-28';

      // A. Search -> 1 item
      const searchRes = await searchPublicOffers(
        db,
        {
          destinationPublicId: ids.destinationPublicId,
          locale: 'fr',
          intent: { kind: 'DAY_RANGE', startDate, endDateExclusive },
        },
        { publicationGate: realPublicationGate, cursorCodec: testCursorCodec },
      );
      expect(searchRes.items.length).toBe(1);
      expect(searchRes.items[0]!.price.totalAmountMinor).toBe(20000);

      // B. Checkout -> success
      const draftRes = await createBookingDraftWithHold(
        db,
        makeFlexibleDayRangeInput(ids, startDate, endDateExclusive),
      );

      expectSuccess(draftRes);
      expect(draftRes.body.totalAmountMinor).toBe(20000);
    });
  },
);
