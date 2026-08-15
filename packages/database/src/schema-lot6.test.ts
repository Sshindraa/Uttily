import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 6 groupe G2 (ADR-012).
 *
 * Vérifie les contraintes CHECK, UNIQUE, les triggers multi-tenant,
 * les triggers append-only et la migration des tables
 * booking_fulfillment_events, condition_reports et damage_reports.
 *
 * Reprend la stratégie de setup de schema-lot5.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot6';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  if (!url) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(dbUrl: string): Promise<boolean> {
  try {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

let testUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 6.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
});

afterAll(async () => {
  if (!url || !testUrl) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    await cleanupSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  } finally {
    await cleanupSql.end();
  }
});

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  variantId: string;
  itemId: string;
  blockId: string;
}

/**
 * Crée les données de base (organisation, établissement, utilisateur, catégorie,
 * produit, variante, exemplaire, bloc d'inventaire) et retourne leurs IDs.
 * Le suffixe garantit l'unicité des slugs/emails entre les tests.
 */
async function seedBaseData(
  sql: postgres.Sql,
  suffix = Math.random().toString(36).slice(2, 10),
): Promise<BaseIds> {
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 'EUR')
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
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name")
    VALUES (${product.id}, 'Standard')
    RETURNING "id"
  `.then((r) => r[0]!);
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${location.id})
    RETURNING "id"
  `.then((r) => r[0]!);
  const block = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at"
    )
    VALUES (
      ${org.id}, ${item.id}, 'HOLD', 'ACTIVE',
      '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00', '2026-01-09 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    variantId: variant.id,
    itemId: item.id,
    blockId: block.id,
  };
}

interface DraftPayload {
  customer_start_at: string;
  customer_end_at: string;
  blocked_start_at: string;
  blocked_end_at: string;
  timezone: string;
  prep_buffer_minutes: number;
  cleanup_buffer_minutes: number;
  subtotal_amount_minor: number;
  mandatory_fees_amount_minor: number;
  total_amount_minor: number;
  tax_status: string;
  tax_amount_minor: number | null;
  tax_rate_bps: number | null;
  commission_amount_minor: number | null;
  billable_unit: string;
  billable_unit_count: number;
  currency: string;
  cancellation_policy_snapshot: { policy_code: string; policy_version: string; timezone: string };
}

function validDraftPayload(overrides: Partial<DraftPayload> = {}): DraftPayload {
  return {
    customer_start_at: '2026-01-10 09:00:00+00',
    customer_end_at: '2026-01-12 17:00:00+00',
    blocked_start_at: '2026-01-10 08:30:00+00',
    blocked_end_at: '2026-01-12 17:30:00+00',
    timezone: 'Europe/Paris',
    prep_buffer_minutes: 30,
    cleanup_buffer_minutes: 30,
    subtotal_amount_minor: 10000,
    mandatory_fees_amount_minor: 0,
    total_amount_minor: 10000,
    tax_status: 'UNDETERMINED',
    tax_amount_minor: null,
    tax_rate_bps: null,
    commission_amount_minor: null,
    billable_unit: 'DAY',
    billable_unit_count: 2,
    currency: 'EUR',
    cancellation_policy_snapshot: {
      policy_code: 'FLEXIBLE',
      policy_version: '1',
      timezone: 'Europe/Paris',
    },
    ...overrides,
  };
}

async function insertDraft(sql: postgres.Sql, ids: BaseIds, p: DraftPayload) {
  return sql`
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
      ${p.customer_start_at}, ${p.customer_end_at},
      ${p.blocked_start_at}, ${p.blocked_end_at},
      ${p.timezone}, ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
      ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor}, ${p.total_amount_minor},
      ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps}, ${p.commission_amount_minor},
      ${p.billable_unit}, ${p.billable_unit_count},
      ${p.currency}, ${sql.json(p.cancellation_policy_snapshot)}
    )
    RETURNING "id", "status"
  `;
}

interface PaymentPayload {
  status: string;
  amount_minor: number;
  currency: string;
  tax_status: string;
  tax_amount_minor: number | null;
  tax_rate_bps: number | null;
  commission_amount_minor: number;
  financial_terms_version: string;
  legal_terms_version: string;
  terms_acceptance_snapshot: { version: string; user_id: string; accepted_at: string };
  connected_account_id: string;
  charge_model: string;
  settlement_merchant_mode: string;
  environment: 'TEST' | 'LIVE';
  succeeded_at?: string | null;
}

function validPaymentPayload(overrides: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    status: 'PENDING_PROVIDER',
    amount_minor: 10000,
    currency: 'EUR',
    tax_status: 'NOT_APPLICABLE',
    tax_amount_minor: 0,
    tax_rate_bps: null,
    commission_amount_minor: 500,
    financial_terms_version: '1',
    legal_terms_version: '1',
    terms_acceptance_snapshot: {
      version: '1',
      user_id: 'test',
      accepted_at: '2026-01-01T00:00:00Z',
    },
    connected_account_id: 'acct_test123',
    charge_model: 'DESTINATION',
    settlement_merchant_mode: 'CONNECTED_ACCOUNT',
    environment: 'TEST',
    succeeded_at: null,
    ...overrides,
  };
}

async function insertPayment(sql: postgres.Sql, ids: BaseIds, draftId: string, p: PaymentPayload) {
  return sql`
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
      ${ids.orgId}, ${draftId}, ${ids.userId},
      ${p.status}, ${p.amount_minor}, ${p.currency},
      ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
      ${p.commission_amount_minor},
      ${p.financial_terms_version}, ${p.legal_terms_version},
      ${sql.json(p.terms_acceptance_snapshot)},
      ${p.connected_account_id},
      ${p.charge_model}, ${p.settlement_merchant_mode},
      ${p.environment},
      ${p.succeeded_at ?? null}
    )
    RETURNING "id"
  `;
}

interface BookingPayload {
  status: string;
  customer_start_at: string;
  customer_end_at: string;
  blocked_start_at: string;
  blocked_end_at: string;
  prep_buffer_minutes: number;
  cleanup_buffer_minutes: number;
  currency: string;
  subtotal_amount_minor: number;
  mandatory_fees_amount_minor: number;
  tax_status: string;
  tax_amount_minor: number | null;
  tax_rate_bps: number | null;
  commission_amount_minor: number;
  total_amount_minor: number;
  cancellation_policy_snapshot: { policy_code: string; policy_version: string; timezone: string };
  terms_acceptance_snapshot: { version: string; user_id: string; accepted_at: string };
  confirmed_at: string;
}

function validBookingPayload(overrides: Partial<BookingPayload> = {}): BookingPayload {
  return {
    status: 'CONFIRMED',
    customer_start_at: '2026-01-10 09:00:00+00',
    customer_end_at: '2026-01-12 17:00:00+00',
    blocked_start_at: '2026-01-10 08:30:00+00',
    blocked_end_at: '2026-01-12 17:30:00+00',
    prep_buffer_minutes: 30,
    cleanup_buffer_minutes: 30,
    currency: 'EUR',
    subtotal_amount_minor: 10000,
    mandatory_fees_amount_minor: 0,
    tax_status: 'NOT_APPLICABLE',
    tax_amount_minor: 0,
    tax_rate_bps: null,
    commission_amount_minor: 500,
    total_amount_minor: 10000,
    cancellation_policy_snapshot: {
      policy_code: 'FLEXIBLE',
      policy_version: '1',
      timezone: 'Europe/Paris',
    },
    terms_acceptance_snapshot: {
      version: '1',
      user_id: 'test',
      accepted_at: '2026-01-01T00:00:00Z',
    },
    confirmed_at: '2026-01-01 12:00:00+00',
    ...overrides,
  };
}

async function insertBooking(
  sql: postgres.Sql,
  ids: BaseIds,
  draftId: string,
  paymentId: string,
  p: BookingPayload,
) {
  return sql`
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
      ${draftId}, ${paymentId}, ${p.status},
      ${p.customer_start_at}, ${p.customer_end_at},
      ${p.blocked_start_at}, ${p.blocked_end_at},
      ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
      ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
      ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
      ${p.commission_amount_minor}, ${p.total_amount_minor},
      ${sql.json(p.cancellation_policy_snapshot)}, ${sql.json(p.terms_acceptance_snapshot)},
      ${p.confirmed_at}
    )
    RETURNING "id"
  `;
}

/**
 * Crée un brouillon HELD avec une ligne et un bloc HOLD lié, puis retourne
 * les IDs nécessaires pour les tests de paiement.
 */
async function seedHeldDraftWithLine(
  sql: postgres.Sql,
  ids: BaseIds,
  monthOffset = 2,
): Promise<{ draftId: string; lineId: string; holdBlockId: string }> {
  const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
  const line = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);
  const month = String(monthOffset).padStart(2, '0');
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
    VALUES (${line.id}, ${holdBlock.id})
  `;
  return { draftId: draft.id, lineId: line.id, holdBlockId: holdBlock.id };
}

interface BookingWithItemIds {
  bookingId: string;
  bookingItemId: string;
  lineId: string;
  blockId: string;
}

/**
 * Crée un booking complet avec booking_line, booking_block (CONVERTED) et
 * booking_item. Retourne les IDs nécessaires pour les tests fulfillment.
 */
async function seedBookingWithItem(
  sql: postgres.Sql,
  ids: BaseIds,
  monthOffset = 2,
): Promise<BookingWithItemIds> {
  const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids, monthOffset);
  const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then((r) => r[0]!);
  const booking = await insertBooking(sql, ids, draftId, payment.id, validBookingPayload()).then(
    (r) => r[0]!,
  );
  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlockId}`;
  const month = String(monthOffset).padStart(2, '0');
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
    VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlockId}, ${bookingBlock.id})
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    bookingId: booking.id,
    bookingItemId: bookingItem.id,
    lineId: line.id,
    blockId: bookingBlock.id,
  };
}

/**
 * Crée un utilisateur staff (member de l'org) pour actor_user_id / reporter_user_id.
 */
async function insertStaffUser(sql: postgres.Sql, ids: BaseIds): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'staff-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "organization_memberships" ("organization_id", "user_id", "role")
    VALUES (${ids.orgId}, ${user.id}, 'STAFF')
  `;
  return user.id;
}

interface FulfillmentEventPayload {
  event_type: string;
  previous_status: string;
  next_status: string;
  idempotency_key: string;
  occurred_at?: string;
  metadata?: { [key: string]: string | number | boolean | null } | null;
}

function validFulfillmentEventPayload(
  overrides: Partial<FulfillmentEventPayload> = {},
): FulfillmentEventPayload {
  return {
    event_type: 'PREPARED',
    previous_status: 'CONFIRMED',
    next_status: 'READY_FOR_PICKUP',
    idempotency_key: 'evt-' + Math.random().toString(36).slice(2, 12),
    occurred_at: '2026-01-05 10:00:00+00',
    ...overrides,
  };
}

async function insertFulfillmentEvent(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingId: string,
  actorUserId: string,
  p: FulfillmentEventPayload,
) {
  return sql`
    INSERT INTO "booking_fulfillment_events" (
      "organization_id", "booking_id", "event_type",
      "previous_status", "next_status",
      "actor_user_id", "idempotency_key", "occurred_at", "metadata"
    )
    VALUES (
      ${ids.orgId}, ${bookingId}, ${p.event_type},
      ${p.previous_status}, ${p.next_status},
      ${actorUserId}, ${p.idempotency_key}, ${p.occurred_at ?? null}, ${
        p.metadata != null ? sql.json(p.metadata) : null
      }
    )
    RETURNING "id"
  `;
}

interface ConditionReportPayload {
  phase: string;
  condition: string;
  notes?: string | null;
  idempotency_key: string;
}

function validConditionReportPayload(
  overrides: Partial<ConditionReportPayload> = {},
): ConditionReportPayload {
  return {
    phase: 'PICKUP',
    condition: 'GOOD',
    notes: null,
    idempotency_key: 'cr-' + Math.random().toString(36).slice(2, 12),
    ...overrides,
  };
}

async function insertConditionReport(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingIds: BookingWithItemIds,
  reporterUserId: string,
  p: ConditionReportPayload,
) {
  return sql`
    INSERT INTO "condition_reports" (
      "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
      "phase", "condition", "notes", "reporter_user_id", "idempotency_key"
    )
    VALUES (
      ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${ids.itemId},
      ${p.phase}, ${p.condition}, ${p.notes ?? null}, ${reporterUserId}, ${p.idempotency_key}
    )
    RETURNING "id"
  `;
}

interface DamageReportPayload {
  description: string;
  idempotency_key: string;
}

function validDamageReportPayload(
  overrides: Partial<DamageReportPayload> = {},
): DamageReportPayload {
  return {
    description: 'Rayure sur la coque',
    idempotency_key: 'dr-' + Math.random().toString(36).slice(2, 12),
    ...overrides,
  };
}

async function insertDamageReport(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingIds: BookingWithItemIds,
  reporterUserId: string,
  p: DamageReportPayload,
) {
  return sql`
    INSERT INTO "damage_reports" (
      "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
      "description", "reporter_user_id", "idempotency_key"
    )
    VALUES (
      ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${ids.itemId},
      ${p.description}, ${reporterUserId}, ${p.idempotency_key}
    )
    RETURNING "id"
  `;
}

describe.skipIf(shouldSkipIntegrationTests())('Schéma Lot 6 G2 — contraintes PostgreSQL', () => {
  // -------------------------------------------------------------------------
  // 1. Migration from scratch — toutes les tables Lot 6 existent
  // -------------------------------------------------------------------------
  it('crée les 3 tables Lot 6 et __drizzle_migrations a 38 entrées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const lot6Tables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'booking_fulfillment_events', 'condition_reports', 'damage_reports'
        )
        ORDER BY tablename
      `;
      expect(lot6Tables.length).toBe(3);

      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(38);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Idempotent migration replay
  // -------------------------------------------------------------------------
  it('ne réapplique pas les migrations au rejeu (idempotence)', async () => {
    if (!testUrl) return;
    await runMigrations(testUrl);
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(38);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 3. booking_fulfillment_events — insertions valides
  // -------------------------------------------------------------------------
  it('accepte un événement PREPARED (CONFIRMED → READY_FOR_PICKUP)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload({
          event_type: 'PREPARED',
          previous_status: 'CONFIRMED',
          next_status: 'READY_FOR_PICKUP',
        }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un événement PICKED_UP (READY_FOR_PICKUP → ACTIVE)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload({
          event_type: 'PICKED_UP',
          previous_status: 'READY_FOR_PICKUP',
          next_status: 'ACTIVE',
        }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un événement RETURNED (ACTIVE → RETURNED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload({
          event_type: 'RETURNED',
          previous_status: 'ACTIVE',
          next_status: 'RETURNED',
        }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un événement CLOSED (RETURNED → CLOSED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload({
          event_type: 'CLOSED',
          previous_status: 'RETURNED',
          next_status: 'CLOSED',
        }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 4. booking_fulfillment_events — CHECK constraints
  // -------------------------------------------------------------------------
  it('rejette une combinaison event_type/status incohérente (PREPARED avec ACTIVE → RETURNED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertFulfillmentEvent(
          sql,
          ids,
          bookingIds.bookingId,
          staffId,
          validFulfillmentEventPayload({
            event_type: 'PREPARED',
            previous_status: 'ACTIVE',
            next_status: 'RETURNED',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un événement avec previous_status = next_status', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertFulfillmentEvent(
          sql,
          ids,
          bookingIds.bookingId,
          staffId,
          validFulfillmentEventPayload({
            event_type: 'PREPARED',
            previous_status: 'CONFIRMED',
            next_status: 'CONFIRMED',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un événement avec une clé d'idempotency vide", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertFulfillmentEvent(
          sql,
          ids,
          bookingIds.bookingId,
          staffId,
          validFulfillmentEventPayload({ idempotency_key: '   ' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 5. booking_fulfillment_events — trigger multi-tenant
  // -------------------------------------------------------------------------
  it('rejette un événement si le booking appartient à une autre organisation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        insertFulfillmentEvent(
          sql,
          ids2,
          bookingIds.bookingId,
          staffId,
          validFulfillmentEventPayload(),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 6. booking_fulfillment_events — idempotence
  // -------------------------------------------------------------------------
  it("rejette une clé d'idempotence dupliquée dans la même organisation", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const payload = validFulfillmentEventPayload({ idempotency_key: 'dup-key-001' });
      await insertFulfillmentEvent(sql, ids, bookingIds.bookingId, staffId, payload);
      await expect(
        insertFulfillmentEvent(sql, ids, bookingIds.bookingId, staffId, payload),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("accepte la même clé d'idempotence dans deux organisations différentes", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids1 = await seedBaseData(sql);
      const bookingIds1 = await seedBookingWithItem(sql, ids1);
      const staffId1 = await insertStaffUser(sql, ids1);
      const ids2 = await seedBaseData(sql);
      const bookingIds2 = await seedBookingWithItem(sql, ids2);
      const staffId2 = await insertStaffUser(sql, ids2);
      const key = 'shared-key-001';
      const r1 = await insertFulfillmentEvent(
        sql,
        ids1,
        bookingIds1.bookingId,
        staffId1,
        validFulfillmentEventPayload({ idempotency_key: key }),
      );
      const r2 = await insertFulfillmentEvent(
        sql,
        ids2,
        bookingIds2.bookingId,
        staffId2,
        validFulfillmentEventPayload({ idempotency_key: key }),
      );
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 7. booking_fulfillment_events — append-only
  // -------------------------------------------------------------------------
  it('refuse UPDATE sur booking_fulfillment_events', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const event = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload(),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "booking_fulfillment_events" SET "metadata" = ${sql.json({ foo: 'bar' })} WHERE "id" = ${event.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('refuse DELETE sur booking_fulfillment_events', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const event = await insertFulfillmentEvent(
        sql,
        ids,
        bookingIds.bookingId,
        staffId,
        validFulfillmentEventPayload(),
      ).then((r) => r[0]!);
      await expect(
        sql`DELETE FROM "booking_fulfillment_events" WHERE "id" = ${event.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 8. condition_reports — insertions valides
  // -------------------------------------------------------------------------
  it("accepte un rapport d'état PICKUP valide", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload({ phase: 'PICKUP', condition: 'NEW' }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("accepte un rapport d'état RETURN valide", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload({ phase: 'RETURN', condition: 'GOOD' }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte des notes nulles', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload({ notes: null }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte plusieurs rapports pour la même phase (pas de limite)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const r1 = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload({ phase: 'PICKUP', condition: 'GOOD' }),
      );
      const r2 = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload({ phase: 'PICKUP', condition: 'FAIR' }),
      );
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 9. condition_reports — triggers de cohérence
  // -------------------------------------------------------------------------
  it("rejette un rapport dont le booking_item n'appartient pas au booking", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      // Crée un second booking avec son propre booking_item
      const bookingIds2 = await seedBookingWithItem(sql, ids, 3);
      await expect(
        sql`
          INSERT INTO "condition_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "phase", "condition", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds2.bookingItemId}, ${ids.itemId},
            'PICKUP', 'GOOD', ${staffId}, ${'cr-mismatch-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un rapport dont l'inventory_item ne correspond pas au booking_item", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      // Crée un second inventory_item
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-2-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "condition_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "phase", "condition", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${item2.id},
            'PICKUP', 'GOOD', ${staffId}, ${'cr-inv-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un rapport avec une organisation incohérente (booking d'une autre org)", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "condition_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "phase", "condition", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids2.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${ids.itemId},
            'PICKUP', 'GOOD', ${staffId}, ${'cr-org-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 10. condition_reports — idempotence
  // -------------------------------------------------------------------------
  it("rejette une clé d'idempotence dupliquée", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const payload = validConditionReportPayload({ idempotency_key: 'cr-dup-001' });
      await insertConditionReport(sql, ids, bookingIds, staffId, payload);
      await expect(insertConditionReport(sql, ids, bookingIds, staffId, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une clé d'idempotency vide", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertConditionReport(
          sql,
          ids,
          bookingIds,
          staffId,
          validConditionReportPayload({ idempotency_key: '   ' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 11. condition_reports — append-only
  // -------------------------------------------------------------------------
  it('refuse UPDATE sur condition_reports', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const report = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload(),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "condition_reports" SET "notes" = 'modifié' WHERE "id" = ${report.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('refuse DELETE sur condition_reports', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const report = await insertConditionReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validConditionReportPayload(),
      ).then((r) => r[0]!);
      await expect(
        sql`DELETE FROM "condition_reports" WHERE "id" = ${report.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12. damage_reports — insertions valides
  // -------------------------------------------------------------------------
  it('accepte une déclaration de dommage valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const result = await insertDamageReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validDamageReportPayload(),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 13. damage_reports — CHECK constraints
  // -------------------------------------------------------------------------
  it('rejette une description vide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertDamageReport(
          sql,
          ids,
          bookingIds,
          staffId,
          validDamageReportPayload({ description: '' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une description composée uniquement d'espaces", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertDamageReport(
          sql,
          ids,
          bookingIds,
          staffId,
          validDamageReportPayload({ description: '   ' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une clé d'idempotency vide", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        insertDamageReport(
          sql,
          ids,
          bookingIds,
          staffId,
          validDamageReportPayload({ idempotency_key: '   ' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 14. damage_reports — triggers de cohérence
  // -------------------------------------------------------------------------
  it("rejette un dommage dont le booking_item n'appartient pas au booking", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const bookingIds2 = await seedBookingWithItem(sql, ids, 3);
      await expect(
        sql`
          INSERT INTO "damage_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "description", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds2.bookingItemId}, ${ids.itemId},
            'Rayure', ${staffId}, ${'dr-mismatch-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un dommage dont l'inventory_item ne correspond pas au booking_item", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-3-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "damage_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "description", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${item2.id},
            'Rayure', ${staffId}, ${'dr-inv-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un dommage avec une organisation incohérente', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "damage_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "description", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids2.orgId}, ${bookingIds.bookingId}, ${bookingIds.bookingItemId}, ${ids.itemId},
            'Rayure', ${staffId}, ${'dr-org-' + Math.random().toString(36).slice(2, 8)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 15. damage_reports — idempotence
  // -------------------------------------------------------------------------
  it("rejette une clé d'idempotence dupliquée", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const payload = validDamageReportPayload({ idempotency_key: 'dr-dup-001' });
      await insertDamageReport(sql, ids, bookingIds, staffId, payload);
      await expect(insertDamageReport(sql, ids, bookingIds, staffId, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 16. damage_reports — append-only
  // -------------------------------------------------------------------------
  it('refuse UPDATE sur damage_reports', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const report = await insertDamageReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validDamageReportPayload(),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "damage_reports" SET "description" = 'modifié' WHERE "id" = ${report.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('refuse DELETE sur damage_reports', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const report = await insertDamageReport(
        sql,
        ids,
        bookingIds,
        staffId,
        validDamageReportPayload(),
      ).then((r) => r[0]!);
      await expect(sql`DELETE FROM "damage_reports" WHERE "id" = ${report.id}`).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 17. Concurrence — idempotence sous insertion simultanée
  // -------------------------------------------------------------------------
  it("une seule insertion réussit quand deux connexions utilisent la même clé d'idempotence", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const key = 'concurrent-key-001';
      await sql.end();

      const sql1 = postgres(testUrl!, { max: 1 });
      const sql2 = postgres(testUrl!, { max: 1 });
      try {
        const results = await Promise.allSettled([
          insertFulfillmentEvent(
            sql1,
            ids,
            bookingIds.bookingId,
            staffId,
            validFulfillmentEventPayload({ idempotency_key: key }),
          ),
          insertFulfillmentEvent(
            sql2,
            ids,
            bookingIds.bookingId,
            staffId,
            validFulfillmentEventPayload({ idempotency_key: key }),
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
      } finally {
        await sql1.end();
        await sql2.end();
      }
    } finally {
      if (sql) await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 18. Aucune donnée partielle après rejet d'un trigger
  // -------------------------------------------------------------------------
  it('aucune donnée partielle après un insert rejeté par le trigger de cohérence', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const staffId = await insertStaffUser(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        insertFulfillmentEvent(
          sql,
          ids2,
          bookingIds.bookingId,
          staffId,
          validFulfillmentEventPayload(),
        ),
      ).rejects.toThrow();
      const count =
        await sql`SELECT count(*)::int as cnt FROM "booking_fulfillment_events" WHERE organization_id = ${ids2.orgId}`;
      expect(count[0]!.cnt).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
