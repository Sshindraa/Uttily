import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma G7M-A (ADR-023, migration 0036).
 *
 * Vérifie les contraintes CHECK, UNIQUE, les triggers multi-tenant,
 * les triggers append-only, les transitions d'état et la migration
 * des tables booking_amendments, booking_amendment_lines,
 * booking_amendment_allocations, booking_amendment_segments,
 * amendment_payments et amendment_payment_attempts.
 *
 * Reprend la stratégie de setup de schema-lot6.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_g7m_a';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests de schéma G7M-A.');
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
}, 600000);

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

// ---------------------------------------------------------------------------
// Seed helpers spécifiques G7M-A
// ---------------------------------------------------------------------------

interface AmendmentOpts {
  type?: 'NEUTRAL' | 'SUPPLEMENT' | 'REFUND';
  amendmentNumber?: number;
  status?: string;
}

/**
 * Crée un amendement lié à un booking existant.
 * - NEUTRAL/REFUND → status READY_TO_APPLY, hold_deadline null
 * - SUPPLEMENT → status HOLD_PENDING, hold_deadline = '2026-01-01 12:10:00+00'
 */
async function seedAmendment(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingIds: BookingWithItemIds,
  opts: AmendmentOpts = {},
): Promise<string> {
  const type = opts.type ?? 'NEUTRAL';
  const amendmentNumber = opts.amendmentNumber ?? 1;
  const isSupplement = type === 'SUPPLEMENT';
  const status = opts.status ?? (isSupplement ? 'HOLD_PENDING' : 'READY_TO_APPLY');
  // Pour SUPPLEMENT, hold_deadline doit être created_at + 10 minutes.
  // On fixe created_at et hold_deadline de manière cohérente pour tous les types.
  const createdAt = '2026-01-01 12:00:00+00';
  const holdDeadline = isSupplement ? '2026-01-01 12:10:00+00' : null;

  const amendment = await sql`
    INSERT INTO "booking_amendments" (
      "organization_id", "booking_id", "amendment_number", "type", "status",
      "financial_snapshot_before", "financial_snapshot_after",
      "new_customer_start_at", "new_customer_end_at",
      "new_blocked_start_at", "new_blocked_end_at",
      "hold_deadline", "created_by", "created_at"
    )
    VALUES (
      ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentNumber}, ${type}, ${status},
      ${sql.json({ total: 10000 })}, ${sql.json({ total: 12000, supplementAmountMinor: 2000 })},
      '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
      ${holdDeadline}, ${ids.userId}, ${createdAt}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return amendment.id;
}

interface AmendmentLineOpts {
  originType?: 'ORIGINAL' | 'AMENDMENT';
  action?: 'ADD' | 'MODIFY' | 'REMOVE' | 'UNCHANGED';
  logicalLineId?: string;
  sourceBookingLineId?: string | null;
  beforeQuantity?: number;
  afterQuantity?: number;
  beforeUnitPrice?: number;
  afterUnitPrice?: number;
}

/**
 * Crée une ligne d'amendement.
 * - origin_type ORIGINAL → source_booking_line_id requis (défaut: bookingIds.lineId)
 * - origin_type AMENDMENT → source null, logical_line_id = nouveau UUID
 * - action ADD: before=0, after>0
 * - action MODIFY: before>0, after>0
 * - action REMOVE: before>0, after=0
 * - action UNCHANGED: before=after, mêmes prix
 */
async function seedAmendmentLine(
  sql: postgres.Sql,
  ids: BaseIds,
  amendmentId: string,
  bookingIds: BookingWithItemIds,
  opts: AmendmentLineOpts = {},
): Promise<string> {
  const originType = opts.originType ?? 'ORIGINAL';
  const action = opts.action ?? 'UNCHANGED';
  const sourceBookingLineId =
    opts.sourceBookingLineId !== undefined
      ? opts.sourceBookingLineId
      : originType === 'ORIGINAL'
        ? bookingIds.lineId
        : null;
  const logicalLineId =
    opts.logicalLineId ??
    (originType === 'ORIGINAL' ? bookingIds.lineId : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  let beforeQty: number;
  let afterQty: number;
  let beforePrice: number;
  let afterPrice: number;

  switch (action) {
    case 'ADD':
      beforeQty = opts.beforeQuantity ?? 0;
      afterQty = opts.afterQuantity ?? 1;
      beforePrice = opts.beforeUnitPrice ?? 0;
      afterPrice = opts.afterUnitPrice ?? 5000;
      break;
    case 'MODIFY':
      beforeQty = opts.beforeQuantity ?? 1;
      afterQty = opts.afterQuantity ?? 2;
      beforePrice = opts.beforeUnitPrice ?? 5000;
      afterPrice = opts.afterUnitPrice ?? 5000;
      break;
    case 'REMOVE':
      beforeQty = opts.beforeQuantity ?? 1;
      afterQty = opts.afterQuantity ?? 0;
      beforePrice = opts.beforeUnitPrice ?? 5000;
      afterPrice = opts.afterUnitPrice ?? 0;
      break;
    default:
      // UNCHANGED
      beforeQty = opts.beforeQuantity ?? 1;
      afterQty = opts.afterQuantity ?? 1;
      beforePrice = opts.beforeUnitPrice ?? 5000;
      afterPrice = opts.afterUnitPrice ?? 5000;
      break;
  }

  const beforeTotal = beforeQty * beforePrice;
  const afterTotal = afterQty * afterPrice;

  const line = await sql`
    INSERT INTO "booking_amendment_lines" (
      "amendment_id", "organization_id", "logical_line_id",
      "origin_type", "source_booking_line_id", "variant_id", "action",
      "before_quantity", "before_unit_price_amount_minor", "before_line_total_amount_minor",
      "after_quantity", "after_unit_price_amount_minor", "after_line_total_amount_minor",
      "pricing_snapshot", "variant_snapshot"
    )
    VALUES (
      ${amendmentId}, ${ids.orgId}, ${logicalLineId},
      ${originType}, ${sourceBookingLineId}, ${ids.variantId}, ${action},
      ${beforeQty}, ${beforePrice}, ${beforeTotal},
      ${afterQty}, ${afterPrice}, ${afterTotal},
      ${sql.json({ base: 5000 })}, ${sql.json({ name: 'Standard' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return line.id;
}

interface AmendmentAllocationOpts {
  action?: 'RETAIN' | 'ADD' | 'REMOVE' | 'REPLACE';
  sourceBookingBlockId?: string | null;
  status?: string;
}

/**
 * Crée une allocation d'amendement.
 * - RETAIN/REPLACE → source_booking_block_id requis (défaut: bookingIds.blockId)
 * - ADD → source_booking_block_id null
 * - REMOVE → applied_booking_block_id null
 */
async function seedAmendmentAllocation(
  sql: postgres.Sql,
  ids: BaseIds,
  amendmentId: string,
  amendmentLineId: string,
  bookingIds: BookingWithItemIds,
  opts: AmendmentAllocationOpts = {},
): Promise<string> {
  const action = opts.action ?? 'RETAIN';
  const sourceBookingBlockId =
    opts.sourceBookingBlockId !== undefined
      ? opts.sourceBookingBlockId
      : action === 'ADD'
        ? null
        : bookingIds.blockId;
  const status = opts.status ?? 'PROPOSED';

  const allocation = await sql`
    INSERT INTO "booking_amendment_allocations" (
      "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
      "action", "source_booking_block_id", "applied_booking_block_id", "status",
      "effective_customer_start_at", "effective_customer_end_at",
      "effective_blocked_start_at", "effective_blocked_end_at"
    )
    VALUES (
      ${amendmentId}, ${amendmentLineId}, ${ids.orgId}, ${ids.itemId},
      ${action}, ${sourceBookingBlockId}, ${null}, ${status},
      '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return allocation.id;
}

/**
 * Crée un bloc d'inventaire de type HOLD, status ACTIVE, avec expires_at.
 */
async function seedHOLDBlock(sql: postgres.Sql, ids: BaseIds, monthOffset = 3): Promise<string> {
  const month = String(monthOffset).padStart(2, '0');
  const block = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${`2026-${month}-09 12:00:00+00`}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return block.id;
}

/**
 * Crée un segment d'amendement lié à une allocation et un bloc HOLD.
 */
async function seedAmendmentSegment(
  sql: postgres.Sql,
  ids: BaseIds,
  allocationId: string,
  holdBlockId: string,
  monthOffset = 3,
): Promise<string> {
  const month = String(monthOffset).padStart(2, '0');
  // Les dates du segment doivent correspondre exactement aux blocked_start_at/blocked_end_at du HOLD block.
  const segment = await sql`
    INSERT INTO "booking_amendment_segments" (
      "allocation_id", "organization_id", "inventory_item_id",
      "hold_block_id", "delta_start_at", "delta_end_at"
    )
    VALUES (
      ${allocationId}, ${ids.orgId}, ${ids.itemId},
      ${holdBlockId}, ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return segment.id;
}

/**
 * Crée un paiement de supplément pour un amendement SUPPLEMENT.
 */
async function seedAmendmentPayment(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingIds: BookingWithItemIds,
  amendmentId: string,
): Promise<string> {
  const payment = await sql`
    INSERT INTO "amendment_payments" (
      "organization_id", "booking_id", "amendment_id", "customer_user_id",
      "amount_minor", "currency", "environment",
      "connected_account_id", "charge_model", "settlement_merchant_mode"
    )
    VALUES (
      ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${ids.userId},
      2000, 'EUR', 'TEST',
      'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return payment.id;
}

interface AmendmentPaymentAttemptOpts {
  attemptNumber?: number;
  status?: string;
}

/**
 * Crée un attempt pour un paiement de supplément.
 */
async function seedAmendmentPaymentAttempt(
  sql: postgres.Sql,
  ids: BaseIds,
  amendmentPaymentId: string,
  opts: AmendmentPaymentAttemptOpts = {},
): Promise<string> {
  const attemptNumber = opts.attemptNumber ?? 1;
  const status = opts.status ?? 'PENDING_PROVIDER';
  const key = 'apt-' + Math.random().toString(36).slice(2, 12);
  const attempt = await sql`
    INSERT INTO "amendment_payment_attempts" (
      "organization_id", "amendment_payment_id", "attempt_number",
      "status", "provider_idempotency_key"
    )
    VALUES (
      ${ids.orgId}, ${amendmentPaymentId}, ${attemptNumber},
      ${status}, ${key}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return attempt.id;
}

describe.skipIf(shouldSkipIntegrationTests())('Schéma G7M-A — contraintes PostgreSQL', () => {
  // -------------------------------------------------------------------------
  // 1. Migration from scratch — toutes les tables G7M-A existent
  // -------------------------------------------------------------------------
  it('crée les 6 tables G7M-A et __drizzle_migrations a 52 entrées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const g7mTables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'booking_amendments', 'booking_amendment_lines',
          'booking_amendment_allocations', 'booking_amendment_segments',
          'amendment_payments', 'amendment_payment_attempts'
        )
        ORDER BY tablename
      `;
      expect(g7mTables.length).toBe(6);

      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(52);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Amendements valides
  // -------------------------------------------------------------------------
  it('crée un amendement NEUTRAL valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' });
      expect(amendmentId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('crée un amendement SUPPLEMENT valide avec hold_deadline', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      expect(amendmentId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('crée un amendement REFUND valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'REFUND' });
      expect(amendmentId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Cross-tenant
  // -------------------------------------------------------------------------
  it('rejette un amendement cross-tenant (booking d une autre org)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta1');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const idsB = await seedBaseData(sql, 'ctb1');
      await expect(
        sql`
          INSERT INTO "booking_amendments" (
            "organization_id", "booking_id", "amendment_number", "type", "status",
            "financial_snapshot_before", "financial_snapshot_after",
            "new_customer_start_at", "new_customer_end_at",
            "new_blocked_start_at", "new_blocked_end_at",
            "hold_deadline", "created_by"
          )
          VALUES (
            ${idsB.orgId}, ${bookingIds.bookingId}, 1, 'NEUTRAL', 'READY_TO_APPLY',
            ${sql.json({ total: 10000 })}, ${sql.json({ total: 12000 })},
            '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
            ${null}, ${idsB.userId}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne d amendement cross-tenant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta2');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const idsB = await seedBaseData(sql, 'ctb2');
      await expect(
        sql`
          INSERT INTO "booking_amendment_lines" (
            "amendment_id", "organization_id", "logical_line_id",
            "origin_type", "source_booking_line_id", "variant_id", "action",
            "before_quantity", "before_unit_price_amount_minor", "before_line_total_amount_minor",
            "after_quantity", "after_unit_price_amount_minor", "after_line_total_amount_minor",
            "pricing_snapshot", "variant_snapshot"
          )
          VALUES (
            ${amendmentId}, ${idsB.orgId}, ${bookingIds.lineId},
            'ORIGINAL', ${bookingIds.lineId}, ${idsB.variantId}, 'UNCHANGED',
            1, 5000, 5000,
            1, 5000, 5000,
            ${sql.json({ base: 5000 })}, ${sql.json({ name: 'Standard' })}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation cross-tenant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta3');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const lineId = await seedAmendmentLine(sql, idsA, amendmentId, bookingIds);
      const idsB = await seedBaseData(sql, 'ctb3');
      await expect(
        sql`
          INSERT INTO "booking_amendment_allocations" (
            "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
            "action", "source_booking_block_id", "applied_booking_block_id", "status",
            "effective_customer_start_at", "effective_customer_end_at",
            "effective_blocked_start_at", "effective_blocked_end_at"
          )
          VALUES (
            ${amendmentId}, ${lineId}, ${idsB.orgId}, ${idsB.itemId},
            'RETAIN', ${bookingIds.blockId}, ${null}, 'PROPOSED',
            '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un segment cross-tenant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta4');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const lineId = await seedAmendmentLine(sql, idsA, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        idsA,
        amendmentId,
        lineId,
        bookingIds,
      );
      const holdBlockId = await seedHOLDBlock(sql, idsA);
      const idsB = await seedBaseData(sql, 'ctb4');
      await expect(
        sql`
          INSERT INTO "booking_amendment_segments" (
            "allocation_id", "organization_id", "inventory_item_id",
            "hold_block_id", "delta_start_at", "delta_end_at"
          )
          VALUES (
            ${allocationId}, ${idsB.orgId}, ${idsB.itemId},
            ${holdBlockId}, '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement de supplément cross-tenant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta5');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds, { type: 'SUPPLEMENT' });
      const idsB = await seedBaseData(sql, 'ctb5');
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${idsB.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${idsB.userId},
            2000, 'EUR', 'TEST',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un attempt cross-tenant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cta6');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, idsA, bookingIds, amendmentId);
      const idsB = await seedBaseData(sql, 'ctb6');
      await expect(
        sql`
          INSERT INTO "amendment_payment_attempts" (
            "organization_id", "amendment_payment_id", "attempt_number",
            "status", "provider_idempotency_key"
          )
          VALUES (
            ${idsB.orgId}, ${paymentId}, 1,
            'PENDING_PROVIDER', ${'apt-' + Math.random().toString(36).slice(2, 12)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Unicité
  // -------------------------------------------------------------------------
  it('rejette un numéro d amendement dupliqué pour le même booking', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL', amendmentNumber: 1 });
      await expect(
        seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL', amendmentNumber: 1 }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux amendements actifs pour le même booking', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT', amendmentNumber: 1 });
      await expect(
        seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT', amendmentNumber: 2 }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 5. Lignes d'amendement — contraintes origin_type et action
  // -------------------------------------------------------------------------
  it('rejette une ligne ORIGINAL sans source_booking_line_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'ORIGINAL',
          sourceBookingLineId: null,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne AMENDMENT avec source_booking_line_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'AMENDMENT',
          sourceBookingLineId: bookingIds.lineId,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte une ligne ADD valide (before=0, after>0)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'AMENDMENT',
        action: 'ADD',
      });
      expect(lineId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne ADD avec before>0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'AMENDMENT',
          action: 'ADD',
          beforeQuantity: 1,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte une ligne MODIFY valide (before>0, after>0)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'MODIFY',
      });
      expect(lineId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte une ligne REMOVE valide (before>0, after=0)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'REMOVE',
      });
      expect(lineId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte une ligne UNCHANGED valide (before=after)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      expect(lineId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne UNCHANGED avec quantités différentes', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'ORIGINAL',
          action: 'UNCHANGED',
          beforeQuantity: 1,
          afterQuantity: 2,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('ligne ajoutée puis représentable dans un snapshot suivant', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const logicalLineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

      // Amendment #1: ADD line with logical_line_id X
      const amendment1Id = await seedAmendment(sql, ids, bookingIds, {
        type: 'NEUTRAL',
        amendmentNumber: 1,
      });
      await seedAmendmentLine(sql, ids, amendment1Id, bookingIds, {
        originType: 'AMENDMENT',
        action: 'ADD',
        logicalLineId,
      });

      // Transition amendment #1 to APPLIED (READY_TO_APPLY → APPLIED)
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'APPLIED', "applied_at" = now(), "updated_at" = now()
        WHERE "id" = ${amendment1Id}
      `;

      // Amendment #2: MODIFY line with same logical_line_id X
      const amendment2Id = await seedAmendment(sql, ids, bookingIds, {
        type: 'NEUTRAL',
        amendmentNumber: 2,
      });
      const line2Id = await seedAmendmentLine(sql, ids, amendment2Id, bookingIds, {
        originType: 'AMENDMENT',
        action: 'MODIFY',
        logicalLineId,
        beforeQuantity: 1,
        afterQuantity: 2,
      });
      expect(line2Id).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Allocations — contraintes action
  // -------------------------------------------------------------------------
  it('accepte une allocation RETAIN valide avec source block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      expect(allocationId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte une allocation ADD valide sans source block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'ADD',
        },
      );
      expect(allocationId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte une allocation REMOVE valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'REMOVE',
        },
      );
      expect(allocationId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte une allocation REPLACE valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'REPLACE',
        },
      );
      expect(allocationId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation RETAIN sans source block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      await expect(
        seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds, {
          action: 'RETAIN',
          sourceBookingBlockId: null,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation ADD avec source block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      await expect(
        seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds, {
          action: 'ADD',
          sourceBookingBlockId: bookingIds.blockId,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 7. Segments
  // -------------------------------------------------------------------------
  it('accepte plusieurs delta-segments pour une allocation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlock1 = await seedHOLDBlock(sql, ids, 3);
      const holdBlock2 = await seedHOLDBlock(sql, ids, 4);
      const seg1 = await seedAmendmentSegment(sql, ids, allocationId, holdBlock1, 3);
      const seg2 = await seedAmendmentSegment(sql, ids, allocationId, holdBlock2, 4);
      expect(seg1).toBeDefined();
      expect(seg2).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('rejette un segment pointant vers un block non-HOLD', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      // bookingIds.blockId is a BOOKING type block
      await expect(
        seedAmendmentSegment(sql, ids, allocationId, bookingIds.blockId, 3),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 8. Périodes invalides
  // -------------------------------------------------------------------------
  it('rejette une période d amendement invalide (end <= start)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await expect(
        sql`
          INSERT INTO "booking_amendments" (
            "organization_id", "booking_id", "amendment_number", "type", "status",
            "financial_snapshot_before", "financial_snapshot_after",
            "new_customer_start_at", "new_customer_end_at",
            "new_blocked_start_at", "new_blocked_end_at",
            "hold_deadline", "created_by"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, 1, 'NEUTRAL', 'READY_TO_APPLY',
            ${sql.json({ total: 10000 })}, ${sql.json({ total: 12000 })},
            '2026-01-12 17:00:00+00', '2026-01-10 09:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
            ${null}, ${ids.userId}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une période d allocation invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      await expect(
        sql`
          INSERT INTO "booking_amendment_allocations" (
            "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
            "action", "source_booking_block_id", "applied_booking_block_id", "status",
            "effective_customer_start_at", "effective_customer_end_at",
            "effective_blocked_start_at", "effective_blocked_end_at"
          )
          VALUES (
            ${amendmentId}, ${lineId}, ${ids.orgId}, ${ids.itemId},
            'RETAIN', ${bookingIds.blockId}, ${null}, 'PROPOSED',
            '2026-01-12 17:00:00+00', '2026-01-10 09:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une période de segment invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlockId = await seedHOLDBlock(sql, ids);
      await expect(
        sql`
          INSERT INTO "booking_amendment_segments" (
            "allocation_id", "organization_id", "inventory_item_id",
            "hold_block_id", "delta_start_at", "delta_end_at"
          )
          VALUES (
            ${allocationId}, ${ids.orgId}, ${ids.itemId},
            ${holdBlockId}, '2026-03-12 17:00:00+00', '2026-03-10 09:00:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 9. Append-only et immutabilité
  // -------------------------------------------------------------------------
  it('rejette UPDATE sur booking_amendment_lines (append-only)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      await expect(
        sql`UPDATE "booking_amendment_lines" SET "before_quantity" = 5 WHERE "id" = ${lineId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la modification d une colonne immuable sur booking_amendments', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const bookingIds2 = await seedBookingWithItem(sql, ids, 3);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        sql`UPDATE "booking_amendments" SET "booking_id" = ${bookingIds2.bookingId} WHERE "id" = ${amendmentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 10. Transitions d'état
  // -------------------------------------------------------------------------
  it('autorise la transition HOLD_PENDING → READY_TO_APPLY', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'READY_TO_APPLY', "updated_at" = now()
        WHERE "id" = ${amendmentId}
      `;
      const row = await sql`SELECT "status" FROM "booking_amendments" WHERE "id" = ${amendmentId}`;
      expect(row[0]!.status).toBe('READY_TO_APPLY');
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition HOLD_PENDING → APPLIED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await expect(
        sql`
          UPDATE "booking_amendments"
          SET "status" = 'APPLIED', "applied_at" = now(), "updated_at" = now()
          WHERE "id" = ${amendmentId}
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition READY_TO_APPLY → APPLIED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' });
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'APPLIED', "applied_at" = now(), "updated_at" = now()
        WHERE "id" = ${amendmentId}
      `;
      const row = await sql`SELECT "status" FROM "booking_amendments" WHERE "id" = ${amendmentId}`;
      expect(row[0]!.status).toBe('APPLIED');
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition READY_TO_APPLY → FAILED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' });
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'FAILED', "failed_at" = now(), "updated_at" = now()
        WHERE "id" = ${amendmentId}
      `;
      const row = await sql`SELECT "status" FROM "booking_amendments" WHERE "id" = ${amendmentId}`;
      expect(row[0]!.status).toBe('FAILED');
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition depuis un état terminal (APPLIED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' });
      // Transition to APPLIED first
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'APPLIED', "applied_at" = now(), "updated_at" = now()
        WHERE "id" = ${amendmentId}
      `;
      // Try another transition from APPLIED
      await expect(
        sql`
          UPDATE "booking_amendments"
          SET "status" = 'FAILED', "failed_at" = now(), "updated_at" = now()
          WHERE "id" = ${amendmentId}
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 11. Paiements de supplément
  // -------------------------------------------------------------------------
  it('crée un paiement de supplément valide pour un amendement SUPPLEMENT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      expect(paymentId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('crée un attempt valide pour un paiement de supplément', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      const attemptId = await seedAmendmentPaymentAttempt(sql, ids, paymentId);
      expect(attemptId).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec montant négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${ids.userId},
            -100, 'EUR', 'TEST',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec devise non-EUR', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${ids.userId},
            2000, 'USD', 'TEST',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec environnement invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${ids.userId},
            2000, 'EUR', 'SANDBOX',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux attempts non-terminaux pour le même paiement', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await seedAmendmentPaymentAttempt(sql, ids, paymentId, { attemptNumber: 1 });
      await expect(
        seedAmendmentPaymentAttempt(sql, ids, paymentId, { attemptNumber: 2 }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12. Refunds
  // -------------------------------------------------------------------------
  it('accepte un refund BOOKING_MODIFICATION avec payment_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const result = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'PENDING',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true
        )
        RETURNING "id"
      `;
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un refund AMENDMENT_COMPENSATION avec amendment_payment_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const amendmentPaymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      const result = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee"
        )
        VALUES (
          ${ids.orgId}, ${null}, ${amendmentPaymentId}, 'AMENDMENT_COMPENSATION', 'PENDING',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true
        )
        RETURNING "id"
      `;
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('rejette un refund avec zéro origine (les deux NULL)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${null}, ${null}, 'EXTERNAL_REFUND', 'PENDING',
            1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un refund avec deux origines (les deux non-NULL)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const bookingIds = await seedBookingWithItem(sql, ids, 3);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const amendmentPaymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, ${amendmentPaymentId}, 'BOOKING_MODIFICATION', 'PENDING',
            1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('conservation d un refund historique LATE_PAYMENT_NO_BOOKING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const result = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, ${null}, 'LATE_PAYMENT_NO_BOOKING', 'PENDING',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true
        )
        RETURNING "id"
      `;
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 13. Condition reports sur amendements
  // -------------------------------------------------------------------------
  it('accepte un condition report original (booking_item_id)', async () => {
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
        validConditionReportPayload(),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un condition report sur allocation d amendement', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const staffId = await insertStaffUser(sql, ids);
      const result = await sql`
        INSERT INTO "condition_reports" (
          "organization_id", "booking_id", "booking_item_id", "amendment_allocation_id",
          "inventory_item_id", "phase", "condition", "notes",
          "reporter_user_id", "idempotency_key"
        )
        VALUES (
          ${ids.orgId}, ${bookingIds.bookingId}, ${null}, ${allocationId},
          ${ids.itemId}, 'PICKUP', 'GOOD', ${null},
          ${staffId}, ${'cr-' + Math.random().toString(36).slice(2, 12)}
        )
        RETURNING "id"
      `;
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un damage report original (booking_item_id)', async () => {
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

  it('accepte un damage report sur allocation d amendement', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const staffId = await insertStaffUser(sql, ids);
      const result = await sql`
        INSERT INTO "damage_reports" (
          "organization_id", "booking_id", "booking_item_id", "amendment_allocation_id",
          "inventory_item_id", "description",
          "reporter_user_id", "idempotency_key"
        )
        VALUES (
          ${ids.orgId}, ${bookingIds.bookingId}, ${null}, ${allocationId},
          ${ids.itemId}, 'Rayure sur la coque',
          ${staffId}, ${'dr-' + Math.random().toString(36).slice(2, 12)}
        )
        RETURNING "id"
      `;
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('rejette un condition report cross-tenant avec amendment_allocation_id d une autre org', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'cra1');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const lineId = await seedAmendmentLine(sql, idsA, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        idsA,
        amendmentId,
        lineId,
        bookingIds,
      );
      const staffIdB = await insertStaffUser(sql, idsA);
      const idsB = await seedBaseData(sql, 'crb1');
      await expect(
        sql`
          INSERT INTO "condition_reports" (
            "organization_id", "booking_id", "booking_item_id", "amendment_allocation_id",
            "inventory_item_id", "phase", "condition", "notes",
            "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${idsB.orgId}, ${bookingIds.bookingId}, ${null}, ${allocationId},
            ${idsB.itemId}, 'PICKUP', 'GOOD', ${null},
            ${staffIdB}, ${'cr-' + Math.random().toString(36).slice(2, 12)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un damage report cross-tenant avec amendment_allocation_id d une autre org', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'dra1');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const lineId = await seedAmendmentLine(sql, idsA, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        idsA,
        amendmentId,
        lineId,
        bookingIds,
      );
      const staffIdB = await insertStaffUser(sql, idsA);
      const idsB = await seedBaseData(sql, 'drb1');
      await expect(
        sql`
          INSERT INTO "damage_reports" (
            "organization_id", "booking_id", "booking_item_id", "amendment_allocation_id",
            "inventory_item_id", "description",
            "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${idsB.orgId}, ${bookingIds.bookingId}, ${null}, ${allocationId},
            ${idsB.itemId}, 'Rayure sur la coque',
            ${staffIdB}, ${'dr-' + Math.random().toString(36).slice(2, 12)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 14. Idempotence de la migration
  // -------------------------------------------------------------------------
  it('migration réelle : __drizzle_migrations a 52 entrées après rejeu', async () => {
    if (!testUrl) return;
    await runMigrations(testUrl);
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(52);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 15. Transitions d'état et immutabilité des états terminaux
  // -------------------------------------------------------------------------

  it('rejette un refund AMENDMENT_COMPENSATION cross-tenant (amendment_payment d une autre org)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'a' + Math.random().toString(36).slice(2, 8));
      const idsB = await seedBaseData(sql, 'b' + Math.random().toString(36).slice(2, 8));
      const bookingIdsA = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIdsA, {
        type: 'SUPPLEMENT',
        status: 'HOLD_PENDING',
      });
      const amendmentPaymentId = await seedAmendmentPayment(sql, idsA, bookingIdsA, amendmentId);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${idsB.orgId}, ${null}, ${amendmentPaymentId}, 'AMENDMENT_COMPENSATION', 'PENDING',
            1000, 'EUR', ${'refund-xt-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition d allocation PROPOSED → CONVERTED avec applied block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      const newBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${amendmentId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        UPDATE "booking_amendment_allocations"
        SET "status" = 'CONVERTED', "applied_booking_block_id" = ${newBlock.id}
        WHERE "id" = ${allocationId}
      `;
      const result =
        await sql`SELECT "status", "applied_booking_block_id" FROM "booking_amendment_allocations" WHERE "id" = ${allocationId}`;
      expect(result[0]!.status).toBe('CONVERTED');
      expect(result[0]!.applied_booking_block_id).toBe(newBlock.id);
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition d allocation PROPOSED → RELEASED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      await sql`UPDATE "booking_amendment_allocations" SET "status" = 'RELEASED' WHERE "id" = ${allocationId}`;
      const result =
        await sql`SELECT "status" FROM "booking_amendment_allocations" WHERE "id" = ${allocationId}`;
      expect(result[0]!.status).toBe('RELEASED');
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition depuis un état terminal d allocation (CONVERTED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      const newBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${amendmentId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`UPDATE "booking_amendment_allocations" SET "status" = 'CONVERTED', "applied_booking_block_id" = ${newBlock.id} WHERE "id" = ${allocationId}`;
      await expect(
        sql`UPDATE "booking_amendment_allocations" SET "status" = 'PROPOSED' WHERE "id" = ${allocationId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition de segment PROPOSED → CONVERTED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      const holdBlockId = await seedHOLDBlock(sql, ids);
      const segmentId = await seedAmendmentSegment(sql, ids, allocationId, holdBlockId);
      await sql`UPDATE "booking_amendment_segments" SET "status" = 'CONVERTED' WHERE "id" = ${segmentId}`;
      const result =
        await sql`SELECT "status" FROM "booking_amendment_segments" WHERE "id" = ${segmentId}`;
      expect(result[0]!.status).toBe('CONVERTED');
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition depuis un état terminal de segment (CONVERTED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
        originType: 'ORIGINAL',
        action: 'UNCHANGED',
      });
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'RETAIN',
        },
      );
      const holdBlockId = await seedHOLDBlock(sql, ids);
      const segmentId = await seedAmendmentSegment(sql, ids, allocationId, holdBlockId);
      await sql`UPDATE "booking_amendment_segments" SET "status" = 'CONVERTED' WHERE "id" = ${segmentId}`;
      await expect(
        sql`UPDATE "booking_amendment_segments" SET "status" = 'PROPOSED' WHERE "id" = ${segmentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition de paiement PENDING_PROVIDER → PROCESSING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, {
        type: 'SUPPLEMENT',
        status: 'HOLD_PENDING',
      });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await sql`UPDATE "amendment_payments" SET "status" = 'PROCESSING', "updated_at" = now() WHERE "id" = ${paymentId}`;
      const result = await sql`SELECT "status" FROM "amendment_payments" WHERE "id" = ${paymentId}`;
      expect(result[0]!.status).toBe('PROCESSING');
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition depuis un état terminal de paiement (SUCCEEDED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, {
        type: 'SUPPLEMENT',
        status: 'HOLD_PENDING',
      });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await sql`UPDATE "amendment_payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now(), "updated_at" = now() WHERE "id" = ${paymentId}`;
      await expect(
        sql`UPDATE "amendment_payments" SET "status" = 'PROCESSING', "updated_at" = now() WHERE "id" = ${paymentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 16. Validation INSERT booking_amendments (ADR §5.1)
  // -------------------------------------------------------------------------
  it('rejette un amendement SUPPLEMENT avec status != HOLD_PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await expect(
        seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT', status: 'READY_TO_APPLY' }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un amendement NEUTRAL avec status HOLD_PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await expect(
        seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL', status: 'HOLD_PENDING' }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un amendement REFUND avec status HOLD_PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await expect(
        seedAmendment(sql, ids, bookingIds, { type: 'REFUND', status: 'HOLD_PENDING' }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un amendement sur un booking non-CONFIRMED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      // Passer le booking en READY_FOR_PICKUP
      await sql`UPDATE "bookings" SET "status" = 'READY_FOR_PICKUP' WHERE "id" = ${bookingIds.bookingId}`;
      await expect(seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' })).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un amendement SUPPLEMENT avec hold_deadline != created_at + 10 min', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      await expect(
        sql`
          INSERT INTO "booking_amendments" (
            "organization_id", "booking_id", "amendment_number", "type", "status",
            "financial_snapshot_before", "financial_snapshot_after",
            "new_customer_start_at", "new_customer_end_at",
            "new_blocked_start_at", "new_blocked_end_at",
            "hold_deadline", "created_by", "created_at"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
            ${sql.json({ total: 10000 })}, ${sql.json({ total: 12000, supplementAmountMinor: 2000 })},
            '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
            '2026-01-01 13:00:00+00', ${ids.userId}, '2026-01-01 12:00:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la suppression d un amendement (DELETE interdit)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        sql`DELETE FROM "booking_amendments" WHERE "id" = ${amendmentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la suppression d une allocation (DELETE interdit)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      await expect(
        sql`DELETE FROM "booking_amendment_allocations" WHERE "id" = ${allocationId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la suppression d un segment (DELETE interdit)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlockId = await seedHOLDBlock(sql, ids);
      const segmentId = await seedAmendmentSegment(sql, ids, allocationId, holdBlockId);
      await expect(
        sql`DELETE FROM "booking_amendment_segments" WHERE "id" = ${segmentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un timestamp terminal renseigné dans un état non-terminal (self-transition)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      // Self-transition HOLD_PENDING → HOLD_PENDING avec applied_at renseigné
      await expect(
        sql`
          UPDATE "booking_amendments"
          SET "applied_at" = now(), "updated_at" = now()
          WHERE "id" = ${amendmentId}
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 17. Validation INSERT booking_amendment_lines
  // -------------------------------------------------------------------------
  it('rejette une ligne ORIGINAL dont source_booking_line_id appartient à un autre booking', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds1 = await seedBookingWithItem(sql, ids, 2);
      const bookingIds2 = await seedBookingWithItem(sql, ids, 3);
      const amendmentId = await seedAmendment(sql, ids, bookingIds1);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds1, {
          originType: 'ORIGINAL',
          sourceBookingLineId: bookingIds2.lineId,
          logicalLineId: bookingIds2.lineId,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne ORIGINAL avec logical_line_id != source_booking_line_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'ORIGINAL',
          logicalLineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne ORIGINAL avec une variante différente de la ligne source', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      // Créer une seconde variante
      const variant2 = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (
          (SELECT "product_id" FROM "product_variants" WHERE "id" = ${ids.variantId}),
          'Premium'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        sql`
          INSERT INTO "booking_amendment_lines" (
            "amendment_id", "organization_id", "logical_line_id",
            "origin_type", "source_booking_line_id", "variant_id", "action",
            "before_quantity", "before_unit_price_amount_minor", "before_line_total_amount_minor",
            "after_quantity", "after_unit_price_amount_minor", "after_line_total_amount_minor",
            "pricing_snapshot", "variant_snapshot"
          )
          VALUES (
            ${amendmentId}, ${ids.orgId}, ${bookingIds.lineId},
            'ORIGINAL', ${bookingIds.lineId}, ${variant2.id}, 'UNCHANGED',
            1, 5000, 5000,
            1, 5000, 5000,
            ${sql.json({ base: 5000 })}, ${sql.json({ name: 'Premium' })}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne ADD avec origin_type=ORIGINAL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'ORIGINAL',
          action: 'ADD',
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne avec pricing_snapshot non-objet (tableau)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        sql`
          INSERT INTO "booking_amendment_lines" (
            "amendment_id", "organization_id", "logical_line_id",
            "origin_type", "source_booking_line_id", "variant_id", "action",
            "before_quantity", "before_unit_price_amount_minor", "before_line_total_amount_minor",
            "after_quantity", "after_unit_price_amount_minor", "after_line_total_amount_minor",
            "pricing_snapshot", "variant_snapshot"
          )
          VALUES (
            ${amendmentId}, ${ids.orgId}, ${bookingIds.lineId},
            'ORIGINAL', ${bookingIds.lineId}, ${ids.variantId}, 'UNCHANGED',
            1, 5000, 5000,
            1, 5000, 5000,
            ${sql.json([1, 2, 3])}, ${sql.json({ name: 'Standard' })}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne ADD avec before_unit_price > 0 (CHECK renforcé)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'AMENDMENT',
          action: 'ADD',
          beforeUnitPrice: 100,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne REMOVE avec after_unit_price > 0 (CHECK renforcé)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      await expect(
        seedAmendmentLine(sql, ids, amendmentId, bookingIds, {
          originType: 'ORIGINAL',
          action: 'REMOVE',
          afterUnitPrice: 100,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 18. Validation INSERT booking_amendment_allocations
  // -------------------------------------------------------------------------
  it('rejette une allocation avec status initial != PROPOSED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      await expect(
        seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds, {
          status: 'CONVERTED',
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation avec source block d une autre organisation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql, 'sba1');
      const bookingIds = await seedBookingWithItem(sql, idsA);
      const amendmentId = await seedAmendment(sql, idsA, bookingIds);
      const lineId = await seedAmendmentLine(sql, idsA, amendmentId, bookingIds);
      const idsB = await seedBaseData(sql, 'sbb1');
      // Créer un block BOOKING pour l'org B
      const blockB = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${idsB.orgId}, ${idsB.itemId}, 'BOOKING', 'ACTIVE',
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${idsB.orgId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        seedAmendmentAllocation(sql, idsA, amendmentId, lineId, bookingIds, {
          action: 'RETAIN',
          sourceBookingBlockId: blockB.id,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation avec source block non-BOOKING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      // seedHOLDBlock crée un block HOLD, pas BOOKING
      const holdBlockId = await seedHOLDBlock(sql, ids);
      await expect(
        seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds, {
          action: 'RETAIN',
          sourceBookingBlockId: holdBlockId,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation avec variante d item différente de la ligne', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      // Créer un item avec une variante différente
      const variant2 = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (
          (SELECT "product_id" FROM "product_variants" WHERE "id" = ${ids.variantId}),
          'Premium'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${variant2.id}, ${'PRE-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Avec l'item de même variante (ids.itemId), l'allocation ADD doit réussir
      const allocOk = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds, {
        action: 'ADD',
      });
      expect(allocOk).toBeDefined();
      // Test avec item2 qui a une variante différente
      await expect(
        sql`
          INSERT INTO "booking_amendment_allocations" (
            "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
            "action", "source_booking_block_id", "applied_booking_block_id", "status",
            "effective_customer_start_at", "effective_customer_end_at",
            "effective_blocked_start_at", "effective_blocked_end_at"
          )
          VALUES (
            ${amendmentId}, ${lineId}, ${ids.orgId}, ${item2.id},
            'ADD', ${null}, ${null}, 'PROPOSED',
            '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition REMOVE → CONVERTED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds);
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(
        sql,
        ids,
        amendmentId,
        lineId,
        bookingIds,
        {
          action: 'REMOVE',
        },
      );
      await expect(
        sql`UPDATE "booking_amendment_allocations" SET "status" = 'CONVERTED' WHERE "id" = ${allocationId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 19. Validation INSERT booking_amendment_segments
  // -------------------------------------------------------------------------
  it('rejette un segment sur un amendement non-SUPPLEMENT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'NEUTRAL' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlockId = await seedHOLDBlock(sql, ids);
      await expect(seedAmendmentSegment(sql, ids, allocationId, holdBlockId)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un segment avec période != période du HOLD block', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlockId = await seedHOLDBlock(sql, ids, 3);
      // Le segment utilise des dates différentes du block
      await expect(
        sql`
          INSERT INTO "booking_amendment_segments" (
            "allocation_id", "organization_id", "inventory_item_id",
            "hold_block_id", "delta_start_at", "delta_end_at"
          )
          VALUES (
            ${allocationId}, ${ids.orgId}, ${ids.itemId},
            ${holdBlockId}, '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un segment avec status initial != PROPOSED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const lineId = await seedAmendmentLine(sql, ids, amendmentId, bookingIds);
      const allocationId = await seedAmendmentAllocation(sql, ids, amendmentId, lineId, bookingIds);
      const holdBlockId = await seedHOLDBlock(sql, ids, 3);
      await expect(
        sql`
          INSERT INTO "booking_amendment_segments" (
            "allocation_id", "organization_id", "inventory_item_id",
            "hold_block_id", "delta_start_at", "delta_end_at", "status"
          )
          VALUES (
            ${allocationId}, ${ids.orgId}, ${ids.itemId},
            ${holdBlockId}, '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', 'CONVERTED'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 20. Validation INSERT amendment_payments
  // -------------------------------------------------------------------------
  it('rejette un paiement avec status initial != PENDING_PROVIDER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode",
            "status"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${ids.userId},
            2000, 'EUR', 'TEST',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT',
            'PROCESSING'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec customer_user_id != booking customer_user_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      // Créer un autre user
      const otherUser = await sql`
        INSERT INTO "users" ("email") VALUES (${'other-' + Math.random().toString(36).slice(2, 8) + '@example.com'})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "amendment_payments" (
            "organization_id", "booking_id", "amendment_id", "customer_user_id",
            "amount_minor", "currency", "environment",
            "connected_account_id", "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentId}, ${otherUser.id},
            2000, 'EUR', 'TEST',
            'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 21. Transitions amendment_payments (machine à états explicite)
  // -------------------------------------------------------------------------
  it('rejette la transition PENDING_PROVIDER → CANCELLED (interdit)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await expect(
        sql`UPDATE "amendment_payments" SET "status" = 'CANCELLED', "cancelled_at" = now(), "updated_at" = now() WHERE "id" = ${paymentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un timestamp terminal dans un état non-terminal (paiement)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await expect(
        sql`UPDATE "amendment_payments" SET "succeeded_at" = now(), "updated_at" = now() WHERE "id" = ${paymentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 22. Validation INSERT amendment_payment_attempts
  // -------------------------------------------------------------------------
  it('rejette un attempt avec status initial != PENDING_PROVIDER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      await expect(
        seedAmendmentPaymentAttempt(sql, ids, paymentId, { status: 'PROCESSING' }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un attempt avec attempt_number != max+1', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      // Premier attempt avec attempt_number=5 au lieu de 1
      await expect(
        seedAmendmentPaymentAttempt(sql, ids, paymentId, { attemptNumber: 5 }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte un second attempt avec attempt_number=2 après un premier terminal', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const paymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      // Premier attempt
      const attempt1Id = await seedAmendmentPaymentAttempt(sql, ids, paymentId, {
        attemptNumber: 1,
      });
      // Transition vers FAILED (terminal)
      await sql`UPDATE "amendment_payment_attempts" SET "status" = 'FAILED', "updated_at" = now() WHERE "id" = ${attempt1Id}`;
      // Second attempt avec attempt_number=2
      const attempt2Id = await seedAmendmentPaymentAttempt(sql, ids, paymentId, {
        attemptNumber: 2,
      });
      expect(attempt2Id).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 23. Refunds — validations supplémentaires
  // -------------------------------------------------------------------------
  it('rejette un refund avec montant > montant du paiement initial', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({ amount_minor: 1000 }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'PENDING',
            2000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un refund avec montant > montant du paiement de supplément', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingWithItem(sql, ids);
      const amendmentId = await seedAmendment(sql, ids, bookingIds, { type: 'SUPPLEMENT' });
      const amendmentPaymentId = await seedAmendmentPayment(sql, ids, bookingIds, amendmentId);
      // amendment_payments.amount_minor = 2000, on tente un refund de 3000
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${null}, ${amendmentPaymentId}, 'AMENDMENT_COMPENSATION', 'PENDING',
            3000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette les colonnes de résolution off-platform quand status != SETTLED_OFF_PLATFORM', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const staffId = await insertStaffUser(sql, ids);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee",
            "settled_off_platform_at", "settled_off_platform_by", "settlement_notes"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'PENDING',
            1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
            true, true,
            now(), ${staffId}, 'resolved manually'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette la transition vers SETTLED_OFF_PLATFORM depuis PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const staffId = await insertStaffUser(sql, ids);
      const refund = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'PENDING',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          UPDATE "refunds"
          SET "status" = 'SETTLED_OFF_PLATFORM',
              "settled_off_platform_at" = now(),
              "settled_off_platform_by" = ${staffId},
              "settlement_notes" = 'manual',
              "updated_at" = now()
          WHERE "id" = ${refund.id}
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('autorise la transition FAILED_REQUIRES_MANUAL_ACTION → SETTLED_OFF_PLATFORM', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const staffId = await insertStaffUser(sql, ids);
      const refund = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'FAILED_REQUIRES_MANUAL_ACTION',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        UPDATE "refunds"
        SET "status" = 'SETTLED_OFF_PLATFORM',
            "settled_off_platform_at" = now(),
            "settled_off_platform_by" = ${staffId},
            "settlement_notes" = 'resolved off platform',
            "updated_at" = now()
        WHERE "id" = ${refund.id}
      `;
      const row = await sql`SELECT "status" FROM "refunds" WHERE "id" = ${refund.id}`;
      expect(row[0]!.status).toBe('SETTLED_OFF_PLATFORM');
    } finally {
      await sql.end();
    }
  });

  it('rejette la modification d un refund SETTLED_OFF_PLATFORM (immuable)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const staffId = await insertStaffUser(sql, ids);
      const refund = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
          "amount_minor", "currency", "provider_idempotency_key", "requested_at",
          "reverse_transfer", "refund_application_fee",
          "settled_off_platform_at", "settled_off_platform_by", "settlement_notes"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, ${null}, 'BOOKING_MODIFICATION', 'SETTLED_OFF_PLATFORM',
          1000, 'EUR', ${'refund-' + Math.random().toString(36).slice(2, 12)}, now(),
          true, true,
          now(), ${staffId}, 'resolved off platform'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`UPDATE "refunds" SET "settlement_notes" = 'changed' WHERE "id" = ${refund.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

// ===========================================================================
// Test de montée de version réelle : 0001-0035 → 0036 via le runner Drizzle
// ===========================================================================
describe.skipIf(shouldSkipIntegrationTests())(
  'Schéma G7M-A — montée de version réelle 0035 → 0036',
  () => {
    const UPGRADE_DB_NAME = 'uttily_test_g7m_a_upgrade';
    let upgradeUrl: string | null = null;

    beforeAll(async () => {
      if (!url) return;
      const adminSql = postgres(url, { max: 1 });
      try {
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB_NAME};`);
        await adminSql.unsafe(`CREATE DATABASE ${UPGRADE_DB_NAME};`);
      } finally {
        await adminSql.end();
      }
      const upgradeUrlObj = new URL(url);
      upgradeUrlObj.pathname = `/${UPGRADE_DB_NAME}`;
      upgradeUrl = upgradeUrlObj.toString();
    }, 600000);

    afterAll(async () => {
      if (!url) return;
      const cleanupSql = postgres(url, { max: 1 });
      try {
        await cleanupSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${UPGRADE_DB_NAME}' AND pid <> pg_backend_pid();`,
        );
        await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB_NAME};`);
      } finally {
        await cleanupSql.end();
      }
    });

    // Helper : exécute le runner Drizzle officiel (migrate) sur un dossier donné.
    // Utilise le même mécanisme que runMigrations (drizzle-orm/postgres-js/migrator)
    // mais avec un migrationsFolder configurable pour permettre un upgrade en deux phases.
    async function runMigrationsFromFolder(dbUrl: string, folder: string): Promise<void> {
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      const migrationClient = postgres(dbUrl, { max: 1 });
      const db = drizzle(migrationClient);
      try {
        await migrate(db, { migrationsFolder: folder });
      } finally {
        await migrationClient.end();
      }
    }

    // Helper : crée un dossier temporaire contenant un sous-ensemble des migrations
    // + le journal Drizzle tronqué à l'idx spécifié (exclus).
    async function createTempMigrationsFolder(upToIdxExclusive: number): Promise<string> {
      const { mkdtempSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } =
        await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const { tmpdir } = await import('node:os');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const sourceMigrationsDir = join(__dirname, '..', 'drizzle');
      const tempDir = mkdtempSync(join(tmpdir(), 'g7m-a-upgrade-'));
      const tempMetaDir = join(tempDir, 'meta');
      mkdirSync(tempMetaDir, { recursive: true });

      // Copier les fichiers SQL 0001 jusqu'à upToIdxExclusive-1
      const sqlFiles = readdirSync(sourceMigrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of sqlFiles) {
        const num = parseInt(file.slice(0, 4), 10);
        if (isNaN(num) || num >= upToIdxExclusive + 1) continue;
        copyFileSync(join(sourceMigrationsDir, file), join(tempDir, file));
      }

      // Copier les fichiers meta/*.json (snapshots) pour les migrations incluses
      const metaFiles = readdirSync(join(sourceMigrationsDir, 'meta'))
        .filter((f) => f.endsWith('.json') && f !== '_journal.json')
        .sort();
      for (const file of metaFiles) {
        const num = parseInt(file.slice(0, 4), 10);
        if (isNaN(num) || num >= upToIdxExclusive + 1) continue;
        copyFileSync(join(sourceMigrationsDir, 'meta', file), join(tempMetaDir, file));
      }

      // Écrire le journal tronqué
      const journal = JSON.parse(
        await import('node:fs').then((fs) =>
          fs.readFileSync(join(sourceMigrationsDir, 'meta', '_journal.json'), 'utf-8'),
        ),
      );
      journal.entries = journal.entries.slice(0, upToIdxExclusive);
      writeFileSync(join(tempMetaDir, '_journal.json'), JSON.stringify(journal, null, 2));

      return tempDir;
    }

    // Helper : ajoute la migration suivante (idx = upToIdxExclusive) au dossier temporaire.
    async function addNextMigration(tempDir: string, idx: number): Promise<void> {
      const { copyFileSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const sourceMigrationsDir = join(__dirname, '..', 'drizzle');

      // Copier le fichier SQL correspondant à cet idx
      const journal = JSON.parse(
        readFileSync(join(sourceMigrationsDir, 'meta', '_journal.json'), 'utf-8'),
      );
      const entry = journal.entries[idx];
      if (!entry) throw new Error(`Journal entry ${idx} not found`);
      const sqlFile = `${entry.tag}.sql`;
      copyFileSync(join(sourceMigrationsDir, sqlFile), join(tempDir, sqlFile));

      // Copier le snapshot meta s'il existe
      const metaSnapshot = `${entry.tag}.json`;
      const metaFiles = readdirSync(join(sourceMigrationsDir, 'meta'));
      if (metaFiles.includes(metaSnapshot)) {
        copyFileSync(
          join(sourceMigrationsDir, 'meta', metaSnapshot),
          join(tempDir, 'meta', metaSnapshot),
        );
      }

      // Mettre à jour le journal pour inclure cette entrée
      const tempJournal = JSON.parse(readFileSync(join(tempDir, 'meta', '_journal.json'), 'utf-8'));
      tempJournal.entries = journal.entries.slice(0, idx + 1);
      writeFileSync(join(tempDir, 'meta', '_journal.json'), JSON.stringify(tempJournal, null, 2));
    }

    // Helper : compte les entrées dans drizzle.__drizzle_migrations
    async function countDrizzleMigrations(dbUrl: string): Promise<number> {
      const sql = postgres(dbUrl, { max: 1 });
      try {
        const rows = await sql`
          SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations
        `;
        return rows[0]?.cnt ?? 0;
      } finally {
        await sql.end();
      }
    }

    it('upgrade réel 0035→0036 via le runner Drizzle : journal, conservation, triggers', async () => {
      if (!url || !upgradeUrl) return;
      const { rmSync } = await import('node:fs');

      // ── Phase 1 : migrations 0001-0035 via le runner Drizzle officiel ──
      const tempDir35 = await createTempMigrationsFolder(35);
      try {
        await runMigrationsFromFolder(upgradeUrl, tempDir35);
      } finally {
        rmSync(tempDir35, { recursive: true, force: true });
      }

      // Vérifier 35 entrées dans __drizzle_migrations
      let migrationCount = await countDrizzleMigrations(upgradeUrl);
      expect(migrationCount).toBe(35);

      // Capturer les 35 hashes existants pour identifier 0036 par son hash réel
      // (et non par l'id auto-incrémenté qui n'est pas l'identité Drizzle).
      const hashCaptureSql = postgres(upgradeUrl, { max: 1 });
      let hashesBefore0036: string[];
      try {
        const rows = await hashCaptureSql`
          SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
        `;
        hashesBefore0036 = rows.map((r) => r.hash);
      } finally {
        await hashCaptureSql.end();
      }
      expect(hashesBefore0036).toHaveLength(35);

      // ── Phase 2 : insérer des données préexistantes représentatives ──
      const sql = postgres(upgradeUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, 'upgrade');

        // Booking complet avec item
        const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids, 2);
        const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
          (r) => r[0]!,
        );
        const booking = await insertBooking(
          sql,
          ids,
          draftId,
          payment.id,
          validBookingPayload(),
        ).then((r) => r[0]!);
        const line = await sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlockId}`;
        const bookingBlock = await sql`
          INSERT INTO "inventory_blocks" (
            "organization_id", "inventory_item_id", "type", "status",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at", "source_id"
          )
          VALUES (
            ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
            '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
            '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${booking.id}
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

        // Refund historique LATE_PAYMENT_NO_BOOKING
        const refundLatePayment = await sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 'SUCCEEDED',
            1000, 'EUR', ${'refund-up-late-' + Math.random().toString(36).slice(2, 8)}, now(),
            true, true
          )
          RETURNING "id", "amount_minor", "status", "reason", "payment_id"
        `.then((r) => r[0]!);

        // Refund historique EXTERNAL_REFUND
        const refundExternal = await sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "status",
            "amount_minor", "currency", "provider_idempotency_key", "requested_at",
            "reverse_transfer", "refund_application_fee"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, 'EXTERNAL_REFUND', 'PENDING',
            500, 'EUR', ${'refund-up-ext-' + Math.random().toString(36).slice(2, 8)}, now(),
            true, true
          )
          RETURNING "id", "amount_minor", "status", "reason", "payment_id"
        `.then((r) => r[0]!);

        // Condition report historique
        const staffId = await insertStaffUser(sql, ids);
        const conditionReport = await sql`
          INSERT INTO "condition_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "phase", "condition", "notes", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${booking.id}, ${bookingItem.id}, ${ids.itemId},
            'PICKUP', 'GOOD', ${null}, ${staffId}, ${'cr-up-' + Math.random().toString(36).slice(2, 8)}
          )
          RETURNING "id", "booking_item_id"
        `.then((r) => r[0]!);

        // Damage report historique
        const damageReport = await sql`
          INSERT INTO "damage_reports" (
            "organization_id", "booking_id", "booking_item_id", "inventory_item_id",
            "description", "reporter_user_id", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, ${booking.id}, ${bookingItem.id}, ${ids.itemId},
            'Rayure', ${staffId}, ${'dr-up-' + Math.random().toString(36).slice(2, 8)}
          )
          RETURNING "id", "booking_item_id"
        `.then((r) => r[0]!);

        // Snapshot des counts avant upgrade pour vérification post-rerun
        const bookingsBefore = await sql`SELECT count(*)::int AS cnt FROM bookings`;
        const refundsBefore = await sql`SELECT count(*)::int AS cnt FROM refunds`;
        const crBefore = await sql`SELECT count(*)::int AS cnt FROM condition_reports`;
        const drBefore = await sql`SELECT count(*)::int AS cnt FROM damage_reports`;

        // ── Phase 3 : ajouter 0036 au dossier temporaire et relancer le runner ──
        const tempDir36 = await createTempMigrationsFolder(35);
        try {
          await addNextMigration(tempDir36, 35);
          await runMigrationsFromFolder(upgradeUrl, tempDir36);
        } finally {
          rmSync(tempDir36, { recursive: true, force: true });
        }

        // ── Phase 4 : vérifications du journal ──
        migrationCount = await countDrizzleMigrations(upgradeUrl);
        expect(migrationCount).toBe(36);

        // 0036 identifiée par son hash réel (pas par l'id auto-incrémenté).
        // On récupère tous les hashes après upgrade et on isole celui qui
        // n'existait pas dans les 35 précédents : c'est le hash de 0036.
        const allHashesAfter = await sql`
          SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
        `;
        const hashesAfter0036 = allHashesAfter.map((r) => r.hash);
        expect(hashesAfter0036).toHaveLength(36);
        const hash0036 = hashesAfter0036.find((h) => !hashesBefore0036.includes(h));
        expect(hash0036).toBeDefined();

        // 0036 apparaît exactement une fois (par son hash, pas par id)
        const count0036ByHash = await sql`
          SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations WHERE hash = ${hash0036}
        `;
        expect(count0036ByHash[0]!.cnt).toBe(1);

        // ── Phase 5 : vérifier que les 6 nouvelles tables existent ──
        const g7mTables = await sql`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename IN (
            'booking_amendments', 'booking_amendment_lines',
            'booking_amendment_allocations', 'booking_amendment_segments',
            'amendment_payments', 'amendment_payment_attempts'
          )
          ORDER BY tablename
        `;
        expect(g7mTables.length).toBe(6);

        // ── Phase 6 : conservation des données préexistantes ──
        const latePaymentAfter = await sql`
          SELECT "id", "amount_minor", "status", "reason", "payment_id",
                 "amendment_payment_id", "settled_off_platform_at", "settled_off_platform_by", "settlement_notes"
          FROM "refunds" WHERE "id" = ${refundLatePayment.id}
        `;
        expect(latePaymentAfter).toHaveLength(1);
        expect(latePaymentAfter[0]!.id).toBe(refundLatePayment.id);
        expect(String(latePaymentAfter[0]!.amount_minor)).toBe(
          String(refundLatePayment.amount_minor),
        );
        expect(latePaymentAfter[0]!.status).toBe(refundLatePayment.status);
        expect(latePaymentAfter[0]!.reason).toBe(refundLatePayment.reason);
        expect(latePaymentAfter[0]!.payment_id).toBe(refundLatePayment.payment_id);
        expect(latePaymentAfter[0]!.amendment_payment_id).toBeNull();
        expect(latePaymentAfter[0]!.settled_off_platform_at).toBeNull();
        expect(latePaymentAfter[0]!.settled_off_platform_by).toBeNull();
        expect(latePaymentAfter[0]!.settlement_notes).toBeNull();

        const externalAfter = await sql`
          SELECT "id", "amount_minor", "status", "reason", "payment_id",
                 "amendment_payment_id"
          FROM "refunds" WHERE "id" = ${refundExternal.id}
        `;
        expect(externalAfter).toHaveLength(1);
        expect(externalAfter[0]!.id).toBe(refundExternal.id);
        expect(String(externalAfter[0]!.amount_minor)).toBe(String(refundExternal.amount_minor));
        expect(externalAfter[0]!.status).toBe(refundExternal.status);
        expect(externalAfter[0]!.reason).toBe(refundExternal.reason);
        expect(externalAfter[0]!.payment_id).toBe(refundExternal.payment_id);
        expect(externalAfter[0]!.amendment_payment_id).toBeNull();

        const crAfter = await sql`
          SELECT "id", "booking_item_id", "amendment_allocation_id"
          FROM "condition_reports" WHERE "id" = ${conditionReport.id}
        `;
        expect(crAfter).toHaveLength(1);
        expect(crAfter[0]!.id).toBe(conditionReport.id);
        expect(crAfter[0]!.booking_item_id).toBe(conditionReport.booking_item_id);
        expect(crAfter[0]!.amendment_allocation_id).toBeNull();

        const drAfter = await sql`
          SELECT "id", "booking_item_id", "amendment_allocation_id"
          FROM "damage_reports" WHERE "id" = ${damageReport.id}
        `;
        expect(drAfter).toHaveLength(1);
        expect(drAfter[0]!.id).toBe(damageReport.id);
        expect(drAfter[0]!.booking_item_id).toBe(damageReport.booking_item_id);
        expect(drAfter[0]!.amendment_allocation_id).toBeNull();

        // ── Phase 7 : vérifier que les triggers/contraintes G7M-A fonctionnent ──
        // Refund avec les deux origines NULL → doit échouer (XOR)
        await expect(
          sql`
            INSERT INTO "refunds" (
              "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
              "amount_minor", "currency", "provider_idempotency_key", "requested_at",
              "reverse_transfer", "refund_application_fee"
            )
            VALUES (
              ${ids.orgId}, ${null}, ${null}, 'EXTERNAL_REFUND', 'PENDING',
              100, 'EUR', ${'refund-up-fail1-' + Math.random().toString(36).slice(2, 8)}, now(),
              true, true
            )
          `,
        ).rejects.toThrow();

        // Refund avec les deux origines non-NULL → doit échouer (XOR)
        await expect(
          sql`
            INSERT INTO "refunds" (
              "organization_id", "payment_id", "amendment_payment_id", "reason", "status",
              "amount_minor", "currency", "provider_idempotency_key", "requested_at",
              "reverse_transfer", "refund_application_fee"
            )
            VALUES (
              ${ids.orgId}, ${payment.id}, ${payment.id}, 'BOOKING_MODIFICATION', 'PENDING',
              100, 'EUR', ${'refund-up-fail2-' + Math.random().toString(36).slice(2, 8)}, now(),
              true, true
            )
          `,
        ).rejects.toThrow();

        // ── Phase 8 : rerun du runner — idempotence, toujours 36, aucune perte ──
        const tempDir36b = await createTempMigrationsFolder(35);
        try {
          await addNextMigration(tempDir36b, 35);
          await runMigrationsFromFolder(upgradeUrl, tempDir36b);
        } finally {
          rmSync(tempDir36b, { recursive: true, force: true });
        }

        migrationCount = await countDrizzleMigrations(upgradeUrl);
        expect(migrationCount).toBe(36);

        // Après rerun, 0036 apparaît toujours exactement une fois (par son hash)
        const count0036ByHashRerun = await sql`
          SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations WHERE hash = ${hash0036}
        `;
        expect(count0036ByHashRerun[0]!.cnt).toBe(1);

        // Vérifier que les counts de données sont inchangés après rerun
        const bookingsAfter = await sql`SELECT count(*)::int AS cnt FROM bookings`;
        const refundsAfter = await sql`SELECT count(*)::int AS cnt FROM refunds`;
        const crAfter2 = await sql`SELECT count(*)::int AS cnt FROM condition_reports`;
        const drAfter2 = await sql`SELECT count(*)::int AS cnt FROM damage_reports`;
        expect(bookingsAfter[0]!.cnt).toBe(bookingsBefore[0]!.cnt);
        expect(refundsAfter[0]!.cnt).toBe(refundsBefore[0]!.cnt);
        expect(crAfter2[0]!.cnt).toBe(crBefore[0]!.cnt);
        expect(drAfter2[0]!.cnt).toBe(drBefore[0]!.cnt);
      } finally {
        await sql.end();
      }
    }, 600000);
  },
);
