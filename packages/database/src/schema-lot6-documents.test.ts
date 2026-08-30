import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 6 G5B (ADR-013).
 *
 * Vérifie les contraintes CHECK, UNIQUE, les triggers multi-tenant,
 * les triggers append-only, les transitions contrôlées et la migration
 * des tables document_render_snapshots, documents, outbox_effects et
 * notification_deliveries.
 *
 * Reprend la stratégie de setup de schema-lot6.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot6_documents';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 6 G5B.');
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

async function seedBaseData(
  sql: postgres.Sql,
  suffix = Math.random().toString(36).slice(2, 10),
  opts: { withOperatingCurrency?: boolean } = {},
): Promise<BaseIds> {
  const withOperatingCurrency = opts.withOperatingCurrency ?? true;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = withOperatingCurrency
    ? await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
        VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!)
    : await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris')
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

// --- Helpers de draft/payment/booking (copies de schema-lot6.test.ts) ---

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

// --- Helpers spécifiques G5B ---

interface BookingAndOutboxIds {
  orgId: string;
  bookingId: string;
  outboxEventId: string;
  draftId: string;
  paymentId: string;
}

/**
 * Crée un draft, payment, booking, puis un outbox_event BOOKING_CONFIRMED.v1.
 * Retourne les IDs nécessaires pour les tests documentaires.
 */
async function seedBookingAndOutboxEvent(
  sql: postgres.Sql,
  ids: BaseIds,
): Promise<BookingAndOutboxIds> {
  const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids);
  const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then((r) => r[0]!);
  const booking = await insertBooking(sql, ids, draftId, payment.id, validBookingPayload()).then(
    (r) => r[0]!,
  );
  // Convertir le hold en booking block + booking_item
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
      '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
      '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${booking.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "booking_items" (
      "booking_id", "booking_line_id", "inventory_item_id",
      "source_hold_block_id", "booking_block_id"
    )
    VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlockId}, ${bookingBlock.id})
  `;

  const outboxEvent = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id",
      "event_type", "event_version", "payload",
      "status", "attempt_count", "available_at", "idempotency_key"
    )
    VALUES (
      ${ids.orgId}, 'BOOKING', ${booking.id},
      'BOOKING_CONFIRMED', 'v1', ${sql.json({
        bookingId: booking.id,
        paymentId: payment.id,
        draftId: draftId,
        organizationId: ids.orgId,
      })},
      'PENDING', 0, now(), ${'booking_confirmed_' + booking.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    orgId: ids.orgId,
    bookingId: booking.id,
    outboxEventId: outboxEvent.id,
    draftId: draftId,
    paymentId: payment.id,
  };
}

const VALID_CHECKSUM = 'a'.repeat(64);

/**
 * Insère un document_render_snapshot valide.
 */
async function insertRenderSnapshot(sql: postgres.Sql, ids: BookingAndOutboxIds): Promise<string> {
  const row = await sql`
    INSERT INTO "document_render_snapshots" (
      "organization_id", "outbox_event_id", "booking_id",
      "snapshot", "template_version"
    )
    VALUES (
      ${ids.orgId}, ${ids.outboxEventId}, ${ids.bookingId},
      ${sql.json({ version: '1', data: {} })}, '1'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return row.id;
}

interface DocumentPayload {
  type: string;
  version: number;
  storage_key: string;
  content_type: string;
  checksum_sha256: string;
  size_bytes: number;
  template_version: string;
  generated_at: string;
  idempotency_key: string;
}

function validDocumentPayload(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  return {
    type: 'CONFIRMATION',
    version: 1,
    storage_key: 'docs/' + Math.random().toString(36).slice(2, 16),
    content_type: 'application/pdf',
    checksum_sha256: VALID_CHECKSUM,
    size_bytes: 1024,
    template_version: '1',
    generated_at: '2026-01-01 12:00:00+00',
    idempotency_key: 'doc-' + Math.random().toString(36).slice(2, 16),
    ...overrides,
  };
}

async function insertDocument(
  sql: postgres.Sql,
  ids: BookingAndOutboxIds,
  snapshotId: string,
  p: DocumentPayload,
) {
  return sql`
    INSERT INTO "documents" (
      "organization_id", "booking_id", "type", "version",
      "storage_key", "content_type", "checksum_sha256", "size_bytes",
      "template_version", "generated_at",
      "source_outbox_event_id", "render_snapshot_id", "idempotency_key"
    )
    VALUES (
      ${ids.orgId}, ${ids.bookingId}, ${p.type}, ${p.version},
      ${p.storage_key}, ${p.content_type}, ${p.checksum_sha256}, ${p.size_bytes},
      ${p.template_version}, ${p.generated_at},
      ${ids.outboxEventId}, ${snapshotId}, ${p.idempotency_key}
    )
    RETURNING "id"
  `;
}

interface OutboxEffectPayload {
  effect_type: string;
  status: string;
  document_id: string | null;
  storage_key: string | null;
  idempotency_key: string;
  attempt_count: number;
  failure_code: string | null;
  completed_at: string | null;
}

function validOutboxEffectPayload(
  overrides: Partial<OutboxEffectPayload> = {},
): OutboxEffectPayload {
  return {
    effect_type: 'GENERATE_CONFIRMATION',
    status: 'PENDING',
    document_id: null,
    storage_key: null,
    idempotency_key: 'eff-' + Math.random().toString(36).slice(2, 16),
    attempt_count: 0,
    failure_code: null,
    completed_at: null,
    ...overrides,
  };
}

async function insertOutboxEffect(
  sql: postgres.Sql,
  ids: BookingAndOutboxIds,
  p: OutboxEffectPayload,
) {
  return sql`
    INSERT INTO "outbox_effects" (
      "organization_id", "outbox_event_id", "effect_type", "status",
      "document_id", "storage_key", "idempotency_key",
      "attempt_count", "failure_code", "completed_at"
    )
    VALUES (
      ${ids.orgId}, ${ids.outboxEventId}, ${p.effect_type}, ${p.status},
      ${p.document_id}, ${p.storage_key}, ${p.idempotency_key},
      ${p.attempt_count}, ${p.failure_code}, ${p.completed_at}
    )
    RETURNING "id"
  `;
}

interface NotificationDeliveryPayload {
  outbox_effect_id: string;
  recipient_email: string;
  template_key: string;
  provider_idempotency_key: string;
  status: string;
  provider_message_id: string | null;
  failure_code: string | null;
  sent_at: string | null;
  provider_first_attempt_started_at: string | null;
  idempotency_key: string;
}

function validNotificationDeliveryPayload(
  overrides: Partial<NotificationDeliveryPayload> = {},
): NotificationDeliveryPayload {
  return {
    outbox_effect_id: '',
    recipient_email: 'customer@example.com',
    template_key: 'booking_confirmed_customer',
    provider_idempotency_key: 'prov-' + Math.random().toString(36).slice(2, 16),
    status: 'PENDING',
    provider_message_id: null,
    failure_code: null,
    sent_at: null,
    provider_first_attempt_started_at: null,
    idempotency_key: 'nd-' + Math.random().toString(36).slice(2, 16),
    ...overrides,
  };
}

async function insertNotificationDelivery(
  sql: postgres.Sql,
  ids: BookingAndOutboxIds,
  p: NotificationDeliveryPayload,
) {
  return sql`
    INSERT INTO "notification_deliveries" (
      "organization_id", "outbox_event_id", "outbox_effect_id",
      "recipient_email", "template_key", "provider_idempotency_key",
      "status", "provider_message_id", "failure_code", "sent_at",
      "provider_first_attempt_started_at",
      "idempotency_key"
    )
    VALUES (
      ${ids.orgId}, ${ids.outboxEventId}, ${p.outbox_effect_id},
      ${p.recipient_email}, ${p.template_key}, ${p.provider_idempotency_key},
      ${p.status}, ${p.provider_message_id}, ${p.failure_code}, ${p.sent_at},
      ${p.provider_first_attempt_started_at},
      ${p.idempotency_key}
    )
    RETURNING "id"
  `;
}

describe.skipIf(shouldSkipIntegrationTests())('Lot 6 G5B — Documents transactionnels', () => {
  // -------------------------------------------------------------------------
  // 1. Migration from scratch — toutes les tables G5B existent
  // -------------------------------------------------------------------------
  it('crée les 4 tables G5B et __drizzle_migrations a 50 entrées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const tables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'document_render_snapshots', 'documents', 'outbox_effects', 'notification_deliveries'
        )
        ORDER BY tablename
      `;
      expect(tables.length).toBe(4);

      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(50);
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
      expect(rows.length).toBe(50);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Enums — toutes les valeurs attendues existent
  // -------------------------------------------------------------------------
  it('les 5 enums G5B contiennent toutes les valeurs attendues', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // pg_enum est la source de vérité PostgreSQL pour les valeurs d'enum.
      // enum_range(NULL::type) est sérialisé différemment selon le driver
      // (postgres.js retourne un tableau, pas la chaîne '{...}'), donc on
      // interroge pg_enum directement pour une assertion stable.
      const docType = await sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'document_type')
        ORDER BY enumsortorder
      `;
      expect(docType.map((r) => r.enumlabel)).toEqual(['CONFIRMATION', 'CONTRACT', 'RECEIPT']);

      const effectType = await sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'outbox_effect_type')
        ORDER BY enumsortorder
      `;
      expect(effectType.map((r) => r.enumlabel)).toEqual([
        'GENERATE_CONFIRMATION',
        'GENERATE_CONTRACT',
        'GENERATE_RECEIPT',
        'SEND_EMAIL',
      ]);

      const effectStatus = await sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'outbox_effect_status')
        ORDER BY enumsortorder
      `;
      expect(effectStatus.map((r) => r.enumlabel)).toEqual(['PENDING', 'COMPLETED', 'FAILED']);

      const notifStatus = await sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_delivery_status')
        ORDER BY enumsortorder
      `;
      expect(notifStatus.map((r) => r.enumlabel)).toEqual([
        'PENDING',
        'SENT',
        'FAILED',
        'REQUIRES_MANUAL_REVIEW',
      ]);

      const failCode = await sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'document_processing_failure_code')
        ORDER BY enumsortorder
      `;
      expect(failCode.map((r) => r.enumlabel)).toEqual([
        'PAYLOAD_MALFORMED',
        'STORAGE_PUT_FAILED',
        'STORAGE_CHECKSUM_MISMATCH',
        'STORAGE_NOT_FOUND',
        'RENDER_FAILED',
        'EMAIL_SEND_FAILED',
        'LEASE_LOST',
        'UNKNOWN_ERROR',
        'PROVIDER_RESULT_UNCERTAIN',
        'EMAIL_RETRY_WINDOW_EXPIRED',
      ]);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 4. document_render_snapshots — insertion valide
  // -------------------------------------------------------------------------
  it('accepte un snapshot de rendu valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      expect(snapshotId).toBeTruthy();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 5. document_render_snapshots — CHECK template_version non vide
  // -------------------------------------------------------------------------
  it('rejette un snapshot avec template_version vide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      await expect(
        sql`
          INSERT INTO "document_render_snapshots" (
            "organization_id", "outbox_event_id", "booking_id",
            "snapshot", "template_version"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.outboxEventId}, ${bookingIds.bookingId},
            ${sql.json({ version: '1' })}, '   '
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 6. document_render_snapshots — CHECK snapshot est un objet JSON
  // -------------------------------------------------------------------------
  it('rejette un snapshot qui n est pas un objet JSON', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      await expect(
        sql`
          INSERT INTO "document_render_snapshots" (
            "organization_id", "outbox_event_id", "booking_id",
            "snapshot", "template_version"
          )
          VALUES (
            ${ids.orgId}, ${bookingIds.outboxEventId}, ${bookingIds.bookingId},
            ${sql.json([1, 2, 3])}, '1'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 7. document_render_snapshots — UNIQUE(outbox_event_id)
  // -------------------------------------------------------------------------
  it('rejette un deuxième snapshot pour le même outbox_event_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      await insertRenderSnapshot(sql, bookingIds);
      await expect(insertRenderSnapshot(sql, bookingIds)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 8. document_render_snapshots — trigger multi-tenant (outbox_event)
  // -------------------------------------------------------------------------
  it('rejette un snapshot dont l outbox_event appartient à une autre organisation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "document_render_snapshots" (
            "organization_id", "outbox_event_id", "booking_id",
            "snapshot", "template_version"
          )
          VALUES (
            ${ids2.orgId}, ${bookingIds.outboxEventId}, ${bookingIds.bookingId},
            ${sql.json({ version: '1' })}, '1'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 9. document_render_snapshots — append-only (UPDATE et DELETE interdits)
  // -------------------------------------------------------------------------
  it('refuse UPDATE sur document_render_snapshots', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      await expect(
        sql`UPDATE "document_render_snapshots" SET "template_version" = '2' WHERE "id" = ${snapshotId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('refuse DELETE sur document_render_snapshots', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      await expect(
        sql`DELETE FROM "document_render_snapshots" WHERE "id" = ${snapshotId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 10. documents — insertion valide
  // -------------------------------------------------------------------------
  it('accepte un document valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const result = await insertDocument(sql, bookingIds, snapshotId, validDocumentPayload());
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 11. documents — CHECK checksum SHA-256 hex 64
  // -------------------------------------------------------------------------
  it('rejette un checksum SHA-256 invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      await expect(
        insertDocument(
          sql,
          bookingIds,
          snapshotId,
          validDocumentPayload({ checksum_sha256: 'abc' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12. documents — CHECK version > 0
  // -------------------------------------------------------------------------
  it('rejette un document avec version <= 0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      await expect(
        insertDocument(sql, bookingIds, snapshotId, validDocumentPayload({ version: 0 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12b. documents — CHECK size_bytes accepte Number.MAX_SAFE_INTEGER
  // -------------------------------------------------------------------------
  it('documents.size_bytes accepte Number.MAX_SAFE_INTEGER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBookingAndOutboxEvent(sql, await seedBaseData(sql));
      const snapshotId = (
        await sql`
          INSERT INTO "document_render_snapshots" (
            "organization_id", "outbox_event_id", "booking_id", "snapshot", "template_version"
          ) VALUES (
            ${ids.orgId}, ${ids.outboxEventId}, ${ids.bookingId},
            ${sql.json({ version: '1' })}, '1'
          )
          RETURNING "id"
        `
      )[0]!.id;

      // Utiliser un littéral SQL pour éviter toute perte de précision côté JS
      await sql`
        INSERT INTO "documents" (
          "id", "organization_id", "booking_id", "type", "version",
          "storage_key", "content_type", "checksum_sha256", "size_bytes",
          "template_version", "generated_at", "source_outbox_event_id", "render_snapshot_id",
          "idempotency_key"
        ) VALUES (
          ${cryptoRandomUUID()}, ${ids.orgId}, ${ids.bookingId}, 'CONFIRMATION', 1,
          ${cryptoRandomUUID()}, 'application/pdf',
          '0000000000000000000000000000000000000000000000000000000000000000',
          9007199254740991,
          '1', now(), ${ids.outboxEventId}, ${snapshotId},
          ${'doc_maxsafe_' + ids.outboxEventId}
        )
      `;
      // Si on arrive ici, la contrainte a accepté MAX_SAFE_INTEGER
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12c. documents — CHECK size_bytes rejette dépassement MAX_SAFE_INTEGER
  // -------------------------------------------------------------------------
  it('documents.size_bytes rejette 9007199254740992 (dépassement MAX_SAFE_INTEGER)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBookingAndOutboxEvent(sql, await seedBaseData(sql));
      const snapshotId = (
        await sql`
          INSERT INTO "document_render_snapshots" (
            "organization_id", "outbox_event_id", "booking_id", "snapshot", "template_version"
          ) VALUES (
            ${ids.orgId}, ${ids.outboxEventId}, ${ids.bookingId},
            ${sql.json({ version: '1' })}, '1'
          )
          RETURNING "id"
        `
      )[0]!.id;

      // Utiliser un littéral SQL pour envoyer la valeur exacte sans perte côté JS
      await expect(sql`
        INSERT INTO "documents" (
          "id", "organization_id", "booking_id", "type", "version",
          "storage_key", "content_type", "checksum_sha256", "size_bytes",
          "template_version", "generated_at", "source_outbox_event_id", "render_snapshot_id",
          "idempotency_key"
        ) VALUES (
          ${cryptoRandomUUID()}, ${ids.orgId}, ${ids.bookingId}, 'CONFIRMATION', 1,
          ${cryptoRandomUUID()}, 'application/pdf',
          '0000000000000000000000000000000000000000000000000000000000000000',
          9007199254740992,
          '1', now(), ${ids.outboxEventId}, ${snapshotId},
          ${'doc_overmax_' + ids.outboxEventId}
        )
      `).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 13. documents — UNIQUE(booking_id, type, version)
  // -------------------------------------------------------------------------
  it('rejette un document dupliqué (booking_id, type, version)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const payload = validDocumentPayload();
      await insertDocument(sql, bookingIds, snapshotId, payload);
      await expect(
        insertDocument(sql, bookingIds, snapshotId, {
          ...payload,
          idempotency_key: 'doc-dup-' + Math.random().toString(36).slice(2, 12),
          storage_key: 'docs/dup-' + Math.random().toString(36).slice(2, 12),
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 14. documents — trigger multi-tenant (booking + outbox + snapshot)
  // -------------------------------------------------------------------------
  it('rejette un document dont le booking appartient à une autre organisation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const ids2 = await seedBaseData(sql);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      await expect(
        sql`
          INSERT INTO "documents" (
            "organization_id", "booking_id", "type", "version",
            "storage_key", "content_type", "checksum_sha256", "size_bytes",
            "template_version", "generated_at",
            "source_outbox_event_id", "render_snapshot_id", "idempotency_key"
          )
          VALUES (
            ${ids2.orgId}, ${bookingIds.bookingId}, 'CONFIRMATION', 1,
            ${'docs/org-' + Math.random().toString(36).slice(2, 12)}, 'application/pdf',
            ${VALID_CHECKSUM}, 1024, '1', '2026-01-01 12:00:00+00',
            ${bookingIds.outboxEventId}, ${snapshotId}, ${'doc-org-' + Math.random().toString(36).slice(2, 12)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 15. documents — append-only (UPDATE et DELETE interdits)
  // -------------------------------------------------------------------------
  it('refuse UPDATE sur documents', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const doc = await insertDocument(sql, bookingIds, snapshotId, validDocumentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        sql`UPDATE "documents" SET "size_bytes" = 2048 WHERE "id" = ${doc.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('refuse DELETE sur documents', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const doc = await insertDocument(sql, bookingIds, snapshotId, validDocumentPayload()).then(
        (r) => r[0]!,
      );
      await expect(sql`DELETE FROM "documents" WHERE "id" = ${doc.id}`).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 16. outbox_effects — insertion valide PENDING
  // -------------------------------------------------------------------------
  it('accepte un effet GENERATE_CONFIRMATION PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const result = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'GENERATE_CONFIRMATION' }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte un effet SEND_EMAIL PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const result = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 17. outbox_effects — CHECK PENDING invariants
  // -------------------------------------------------------------------------
  it('rejette un effet PENDING avec document_id non-null', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      await expect(
        insertOutboxEffect(
          sql,
          bookingIds,
          validOutboxEffectPayload({
            status: 'PENDING',
            document_id: '00000000-0000-0000-0000-000000000000',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 18. outbox_effects — CHECK SEND_EMAIL invariants
  // -------------------------------------------------------------------------
  it('rejette un effet SEND_EMAIL avec storage_key non-null', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      await expect(
        insertOutboxEffect(
          sql,
          bookingIds,
          validOutboxEffectPayload({
            effect_type: 'SEND_EMAIL',
            storage_key: 'docs/test',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 19. outbox_effects — UNIQUE(outbox_event_id, effect_type)
  // -------------------------------------------------------------------------
  it('rejette un effet dupliqué (outbox_event_id, effect_type)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const payload = validOutboxEffectPayload({ effect_type: 'GENERATE_CONTRACT' });
      await insertOutboxEffect(sql, bookingIds, payload);
      await expect(
        insertOutboxEffect(sql, bookingIds, {
          ...payload,
          idempotency_key: 'eff-dup-' + Math.random().toString(36).slice(2, 12),
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 20. outbox_effects — transition PENDING → COMPLETED
  // -------------------------------------------------------------------------
  it('autorise la transition PENDING → COMPLETED avec document_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const doc = await insertDocument(
        sql,
        bookingIds,
        snapshotId,
        validDocumentPayload({ type: 'CONFIRMATION' }),
      ).then((r) => r[0]!);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({
          effect_type: 'GENERATE_CONFIRMATION',
          storage_key: 'docs/reserved-' + Math.random().toString(36).slice(2, 12),
        }),
      ).then((r) => r[0]!);
      await sql`
        UPDATE "outbox_effects"
        SET "status" = 'COMPLETED', "document_id" = ${doc.id},
            "completed_at" = now()
        WHERE "id" = ${effect.id}
      `;
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 21. outbox_effects — transition PENDING → FAILED
  // -------------------------------------------------------------------------
  it('autorise la transition PENDING → FAILED avec failure_code', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'GENERATE_RECEIPT' }),
      ).then((r) => r[0]!);
      await sql`
        UPDATE "outbox_effects"
        SET "status" = 'FAILED', "failure_code" = 'RENDER_FAILED',
            "completed_at" = now()
        WHERE "id" = ${effect.id}
      `;
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 22. outbox_effects — transition interdite COMPLETED → PENDING
  // -------------------------------------------------------------------------
  it('refuse la transition COMPLETED → PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const snapshotId = await insertRenderSnapshot(sql, bookingIds);
      const doc = await insertDocument(
        sql,
        bookingIds,
        snapshotId,
        validDocumentPayload({ type: 'CONFIRMATION' }),
      ).then((r) => r[0]!);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({
          effect_type: 'GENERATE_CONFIRMATION',
          storage_key: 'docs/reserved-' + Math.random().toString(36).slice(2, 12),
        }),
      ).then((r) => r[0]!);
      await sql`
        UPDATE "outbox_effects"
        SET "status" = 'COMPLETED', "document_id" = ${doc.id},
            "completed_at" = now()
        WHERE "id" = ${effect.id}
      `;
      await expect(
        sql`UPDATE "outbox_effects" SET "status" = 'PENDING' WHERE "id" = ${effect.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 23. outbox_effects — colonnes immuables
  // -------------------------------------------------------------------------
  it('refuse la modification d une colonne immuable (effect_type)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'GENERATE_CONFIRMATION' }),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "outbox_effects" SET "effect_type" = 'GENERATE_CONTRACT' WHERE "id" = ${effect.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 24. outbox_effects — attempt_count ne peut pas diminuer
  // -------------------------------------------------------------------------
  it('refuse la diminution de attempt_count', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'GENERATE_CONFIRMATION', attempt_count: 3 }),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "outbox_effects" SET "attempt_count" = 1 WHERE "id" = ${effect.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 25. outbox_effects — storage_key immuable une fois renseignée
  // -------------------------------------------------------------------------
  it('refuse le changement de storage_key une fois renseignée', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({
          effect_type: 'GENERATE_CONFIRMATION',
          storage_key: 'docs/initial-' + Math.random().toString(36).slice(2, 12),
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`UPDATE "outbox_effects" SET "storage_key" = ${'docs/changed-' + Math.random().toString(36).slice(2, 12)} WHERE "id" = ${effect.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 26. outbox_effects — trigger multi-tenant
  // -------------------------------------------------------------------------
  it('rejette un effet dont l outbox_event appartient à une autre organisation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const ids2 = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "outbox_effects" (
            "organization_id", "outbox_event_id", "effect_type", "status",
            "idempotency_key", "attempt_count"
          )
          VALUES (
            ${ids2.orgId}, ${bookingIds.outboxEventId}, 'GENERATE_CONFIRMATION', 'PENDING',
            ${'eff-org-' + Math.random().toString(36).slice(2, 12)}, 0
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 27. notification_deliveries — insertion valide PENDING
  // -------------------------------------------------------------------------
  it('accepte une notification_delivery PENDING liée à un effet SEND_EMAIL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
      ).then((r) => r[0]!);
      const result = await insertNotificationDelivery(
        sql,
        bookingIds,
        validNotificationDeliveryPayload({ outbox_effect_id: effect.id }),
      );
      expect(result).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 28. notification_deliveries — trigger multi-tenant + effect_type SEND_EMAIL
  // -------------------------------------------------------------------------
  it('rejette une notification liée à un effet non-SEND_EMAIL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'GENERATE_CONFIRMATION' }),
      ).then((r) => r[0]!);
      await expect(
        insertNotificationDelivery(
          sql,
          bookingIds,
          validNotificationDeliveryPayload({ outbox_effect_id: effect.id }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 29. notification_deliveries — transition PENDING → SENT
  // -------------------------------------------------------------------------
  it('autorise la transition PENDING → SENT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
      ).then((r) => r[0]!);
      const delivery = await insertNotificationDelivery(
        sql,
        bookingIds,
        validNotificationDeliveryPayload({ outbox_effect_id: effect.id }),
      ).then((r) => r[0]!);
      await sql`
        UPDATE "notification_deliveries"
        SET "status" = 'SENT', "provider_message_id" = 'msg-123',
            "sent_at" = now()
        WHERE "id" = ${delivery.id}
      `;
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 30. notification_deliveries — transition interdite SENT → PENDING
  // -------------------------------------------------------------------------
  it('refuse la transition SENT → PENDING', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
      ).then((r) => r[0]!);
      const delivery = await insertNotificationDelivery(
        sql,
        bookingIds,
        validNotificationDeliveryPayload({ outbox_effect_id: effect.id }),
      ).then((r) => r[0]!);
      await sql`
        UPDATE "notification_deliveries"
        SET "status" = 'SENT', "provider_message_id" = 'msg-456',
            "sent_at" = now()
        WHERE "id" = ${delivery.id}
      `;
      await expect(
        sql`UPDATE "notification_deliveries" SET "status" = 'PENDING' WHERE "id" = ${delivery.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 31. Enums — absence de BOUNCED / EMAIL_BOUNCED
  // -------------------------------------------------------------------------
  describe('Enums', () => {
    it('notification_delivery_status ne contient pas BOUNCED', async () => {
      if (!testUrl) return; // skip si pas de DB
      const sql = postgres(testUrl, { max: 1 });
      try {
        const result = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_delivery_status')
          ORDER BY enumsortorder
        `;
        const labels = result.map((r) => r.enumlabel);
        expect(labels).toEqual(['PENDING', 'SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW']);
        expect(labels).not.toContain('BOUNCED');
      } finally {
        await sql.end();
      }
    });

    it('document_processing_failure_code ne contient pas EMAIL_BOUNCED', async () => {
      if (!testUrl) return; // skip si pas de DB
      const sql = postgres(testUrl, { max: 1 });
      try {
        const result = await sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'document_processing_failure_code')
          ORDER BY enumsortorder
        `;
        const labels = result.map((r) => r.enumlabel);
        expect(labels).not.toContain('EMAIL_BOUNCED');
        expect(labels).toContain('PAYLOAD_MALFORMED');
        expect(labels).toContain('LEASE_LOST');
      } finally {
        await sql.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 32. Unicités — concurrence sur UNIQUE(outbox_event_id, effect_type)
  // -------------------------------------------------------------------------
  describe('Unicités', () => {
    it('concurrence sur UNIQUE(outbox_event_id, effect_type) : une seule insertion réussit', async () => {
      if (!testUrl) return; // skip si pas de DB
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBookingAndOutboxEvent(sql, await seedBaseData(sql));
        const effectId = cryptoRandomUUID();
        const idempotencyKey = `effect_concurrent_${ids.outboxEventId}`;
        // Première insertion réussit
        await sql`
          INSERT INTO "outbox_effects" (
            "id", "organization_id", "outbox_event_id", "effect_type",
            "status", "idempotency_key", "attempt_count"
          ) VALUES (
            ${effectId}, ${ids.orgId}, ${ids.outboxEventId}, 'GENERATE_CONFIRMATION',
            'PENDING', ${idempotencyKey}, 0
          )
        `;
        // Deuxième insertion avec même (outbox_event_id, effect_type) échoue
        await expect(sql`
          INSERT INTO "outbox_effects" (
            "id", "organization_id", "outbox_event_id", "effect_type",
            "status", "idempotency_key", "attempt_count"
          ) VALUES (
            ${cryptoRandomUUID()}, ${ids.orgId}, ${ids.outboxEventId}, 'GENERATE_CONFIRMATION',
            'PENDING', ${'other_' + idempotencyKey}, 0
          )
        `).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 33. Transitions outbox_effects — PENDING → PENDING pour réservation storage_key
  // -------------------------------------------------------------------------
  describe('Transitions outbox_effects', () => {
    it('PENDING → PENDING autorisé pour réservation de storage_key', async () => {
      if (!testUrl) return; // skip si pas de DB
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBookingAndOutboxEvent(sql, await seedBaseData(sql));
        const effectId = (
          await sql`
            INSERT INTO "outbox_effects" (
              "id", "organization_id", "outbox_event_id", "effect_type",
              "status", "idempotency_key", "attempt_count"
            ) VALUES (
              ${cryptoRandomUUID()}, ${ids.orgId}, ${ids.outboxEventId}, 'GENERATE_CONFIRMATION',
              'PENDING', ${'reserve_sk_' + ids.outboxEventId}, 0
            )
            RETURNING "id"
          `
        )[0]!.id;

        // Réservation de storage_key : PENDING → PENDING avec storage_key renseignée
        const storageKey = cryptoRandomUUID();
        await sql`
          UPDATE "outbox_effects"
          SET "storage_key" = ${storageKey}
          WHERE "id" = ${effectId} AND "status" = 'PENDING'
        `;
        // Vérifier que storage_key est bien réservée
        const result =
          await sql`SELECT "storage_key", "status" FROM "outbox_effects" WHERE "id" = ${effectId}`;
        expect(result[0]!.storage_key).toBe(storageKey);
        expect(result[0]!.status).toBe('PENDING');
      } finally {
        await sql.end();
      }
    });
  });

  // =========================================================================
  // G5H-C2A — Fondation PostgreSQL de la politique email fail-closed
  // =========================================================================
  describe('G5H-C2A — Email delivery safety', () => {
    // Helper local : crée une notification_deliveries PENDING complète
    async function createPendingDelivery(sql: postgres.Sql): Promise<{ id: string }> {
      const ids = await seedBaseData(sql);
      const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
      const effect = await insertOutboxEffect(
        sql,
        bookingIds,
        validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
      ).then((r) => r[0]!);
      const delivery = await insertNotificationDelivery(
        sql,
        bookingIds,
        validNotificationDeliveryPayload({ outbox_effect_id: effect.id }),
      ).then((r) => r[0]!);
      return { id: delivery.id };
    }

    // --- 4. Colonne provider_first_attempt_started_at initialement NULL ---
    it('provider_first_attempt_started_at est NULL après INSERT', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        const row = await sql`
          SELECT "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.provider_first_attempt_started_at).toBeNull();
      } finally {
        await sql.end();
      }
    });

    // --- 5. timestamp NULL → valeur autorisé ---
    it('provider_first_attempt_started_at : NULL → valeur autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        const ts = '2026-03-15T10:00:00Z';
        await sql`
          UPDATE "notification_deliveries"
          SET "provider_first_attempt_started_at" = ${ts}
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.provider_first_attempt_started_at).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    // --- 6. valeur → même valeur autorisé (UPDATE sans changement) ---
    it('provider_first_attempt_started_at : valeur → même valeur autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        const ts = '2026-03-15T10:00:00Z';
        await sql`
          UPDATE "notification_deliveries"
          SET "provider_first_attempt_started_at" = ${ts}
          WHERE "id" = ${id}
        `;
        // UPDATE sans changement du timestamp (changement autre colonne)
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'PENDING'
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.provider_first_attempt_started_at).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    // --- 7. valeur → autre valeur refusé ---
    it('provider_first_attempt_started_at : valeur → autre valeur refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        const ts1 = '2026-03-15T10:00:00Z';
        const ts2 = '2026-03-16T10:00:00Z';
        await sql`
          UPDATE "notification_deliveries"
          SET "provider_first_attempt_started_at" = ${ts1}
          WHERE "id" = ${id}
        `;
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "provider_first_attempt_started_at" = ${ts2}
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 8. valeur → NULL refusé ---
    it('provider_first_attempt_started_at : valeur → NULL refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        const ts = '2026-03-15T10:00:00Z';
        await sql`
          UPDATE "notification_deliveries"
          SET "provider_first_attempt_started_at" = ${ts}
          WHERE "id" = ${id}
        `;
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "provider_first_attempt_started_at" = NULL
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 9. PENDING → REQUIRES_MANUAL_REVIEW avec PROVIDER_RESULT_UNCERTAIN ---
    it('PENDING → REQUIRES_MANUAL_REVIEW avec PROVIDER_RESULT_UNCERTAIN autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "status", "failure_code" FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.status).toBe('REQUIRES_MANUAL_REVIEW');
        expect(row[0]!.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');
      } finally {
        await sql.end();
      }
    });

    // --- 10. PENDING → REQUIRES_MANUAL_REVIEW avec EMAIL_RETRY_WINDOW_EXPIRED ---
    it('PENDING → REQUIRES_MANUAL_REVIEW avec EMAIL_RETRY_WINDOW_EXPIRED autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'EMAIL_RETRY_WINDOW_EXPIRED'
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "status", "failure_code" FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.status).toBe('REQUIRES_MANUAL_REVIEW');
        expect(row[0]!.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');
      } finally {
        await sql.end();
      }
    });

    // --- 11. REQUIRES_MANUAL_REVIEW sans failure code refusé (CHECK) ---
    it('REQUIRES_MANUAL_REVIEW sans failure_code refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW'
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 12. REQUIRES_MANUAL_REVIEW avec ancien failure code refusé (CHECK) ---
    it('REQUIRES_MANUAL_REVIEW avec EMAIL_SEND_FAILED refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'EMAIL_SEND_FAILED'
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 13. REQUIRES_MANUAL_REVIEW avec provider_message_id non NULL refusé ---
    it('REQUIRES_MANUAL_REVIEW avec provider_message_id non NULL refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'PROVIDER_RESULT_UNCERTAIN',
                "provider_message_id" = 'msg-123'
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 14. REQUIRES_MANUAL_REVIEW avec sent_at non NULL refusé ---
    it('REQUIRES_MANUAL_REVIEW avec sent_at non NULL refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'PROVIDER_RESULT_UNCERTAIN',
                "sent_at" = now()
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 15. REQUIRES_MANUAL_REVIEW → PENDING refusé (trigger) ---
    it('REQUIRES_MANUAL_REVIEW → PENDING refusé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'
          WHERE "id" = ${id}
        `;
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'PENDING', "failure_code" = NULL
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 16. REQUIRES_MANUAL_REVIEW → SENT valide ---
    it('REQUIRES_MANUAL_REVIEW → SENT valide avec invariants SENT', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'
          WHERE "id" = ${id}
        `;
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT',
              "provider_message_id" = 'msg-resolved',
              "sent_at" = now(),
              "failure_code" = NULL
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "status", "provider_message_id", "failure_code", "sent_at"
          FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.status).toBe('SENT');
        expect(row[0]!.provider_message_id).toBe('msg-resolved');
        expect(row[0]!.failure_code).toBeNull();
        expect(row[0]!.sent_at).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    // --- 17. REQUIRES_MANUAL_REVIEW → FAILED valide ---
    it('REQUIRES_MANUAL_REVIEW → FAILED valide avec invariants FAILED', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'EMAIL_RETRY_WINDOW_EXPIRED'
          WHERE "id" = ${id}
        `;
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'FAILED',
              "failure_code" = 'EMAIL_SEND_FAILED'
          WHERE "id" = ${id}
        `;
        const row = await sql`
          SELECT "status", "failure_code", "sent_at"
          FROM "notification_deliveries" WHERE "id" = ${id}
        `;
        expect(row[0]!.status).toBe('FAILED');
        expect(row[0]!.failure_code).toBe('EMAIL_SEND_FAILED');
        expect(row[0]!.sent_at).toBeNull();
      } finally {
        await sql.end();
      }
    });

    // --- 18. États SENT et FAILED immuables ---
    it('FAILED → PENDING refusé (état terminal immuable)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'FAILED', "failure_code" = 'LEASE_LOST'
          WHERE "id" = ${id}
        `;
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'PENDING', "failure_code" = NULL
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('SENT → REQUIRES_MANUAL_REVIEW refusé (état terminal immuable)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const { id } = await createPendingDelivery(sql);
        await sql`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT', "provider_message_id" = 'msg-789',
              "sent_at" = now()
          WHERE "id" = ${id}
        `;
        await expect(
          sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'
            WHERE "id" = ${id}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // --- 19. Contraintes et triggers recréés après remplacement des enums ---
    it('CHECK constraints recréées sur notification_deliveries', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const constraints = await sql`
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'notification_deliveries'::regclass
            AND conname IN (
              'notification_deliveries_pending_invariants',
              'notification_deliveries_sent_invariants',
              'notification_deliveries_failed_invariants',
              'notification_deliveries_requires_manual_review_invariants'
            )
          ORDER BY conname
        `;
        const names = constraints.map((r) => r.conname as string);
        expect(names).toContain('notification_deliveries_pending_invariants');
        expect(names).toContain('notification_deliveries_sent_invariants');
        expect(names).toContain('notification_deliveries_failed_invariants');
        expect(names).toContain('notification_deliveries_requires_manual_review_invariants');
      } finally {
        await sql.end();
      }
    });

    it('triggers recréés sur notification_deliveries', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const triggers = await sql`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'notification_deliveries'::regclass AND NOT tgisinternal
          ORDER BY tgname
        `;
        const names = triggers.map((r) => r.tgname as string);
        expect(names).toContain('before_check_notification_delivery');
        expect(names).toContain('before_check_notification_delivery_transition');
        expect(names).toContain('before_check_notification_delivery_provider_timestamp');
      } finally {
        await sql.end();
      }
    });

    it('trigger de transition recréé sur outbox_effects', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const triggers = await sql`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'outbox_effects'::regclass AND NOT tgisinternal
          ORDER BY tgname
        `;
        const names = triggers.map((r) => r.tgname as string);
        expect(names).toContain('before_check_outbox_effect');
        expect(names).toContain('before_check_outbox_effect_transition');
      } finally {
        await sql.end();
      }
    });

    // --- 20. Les deux colonnes failure_code utilisent le nouvel enum ---
    it('outbox_effects.failure_code et notification_deliveries.failure_code utilisent le nouvel enum', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const outboxType = await sql`
          SELECT t.typname
          FROM information_schema.columns c
          JOIN pg_type t ON t.oid = c.udt_name::regtype
          WHERE c.table_name = 'outbox_effects' AND c.column_name = 'failure_code'
        `;
        expect(outboxType[0]!.typname).toBe('document_processing_failure_code');

        const notifType = await sql`
          SELECT t.typname
          FROM information_schema.columns c
          JOIN pg_type t ON t.oid = c.udt_name::regtype
          WHERE c.table_name = 'notification_deliveries' AND c.column_name = 'failure_code'
        `;
        expect(notifType[0]!.typname).toBe('document_processing_failure_code');
      } finally {
        await sql.end();
      }
    });

    // --- 23. Compte final de migrations égal à 31 ---
    it('__drizzle_migrations contient 50 entrées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(50);
      } finally {
        await sql.end();
      }
    });

    // --- Test : la migration 0029 n'utilise pas ALTER TYPE ... ADD VALUE ---
    it("la migration 0029 n'utilise pas ALTER TYPE ... ADD VALUE", () => {
      const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
      const content = readFileSync(
        join(migrationsDir, '0029_lot6_email_delivery_safety.sql'),
        'utf-8',
      );
      expect(content).not.toMatch(/ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i);
    });

    // --- 21. Migration depuis 0028 (base dédiée) ---
    describe('Migration depuis 0028', () => {
      const MIGRATION_TEST_DB = 'uttily_test_lot6_migration_0029';
      let migrationTestUrl: string | null = null;
      let migrationAdminSql: ReturnType<typeof postgres> | null = null;

      beforeAll(async () => {
        // L'absence de DATABASE_URL est gérée par le describe.skipIf parent :
        // si on arrive ici, url est obligatoirement présent. On garde toutefois
        // une garde-fou qui lève explicitement plutôt que de retourner silencieusement.
        if (!url) {
          throw new Error(
            "Migration depuis 0028 : DATABASE_URL est requise (le skip global aurait dû empêcher l'exécution).",
          );
        }
        migrationAdminSql = postgres(url, { max: 1 });
        // La création de la base dédiée doit échouer bruyamment : JAMAIS de return silencieux.
        await migrationAdminSql.unsafe(`DROP DATABASE IF EXISTS ${MIGRATION_TEST_DB};`);
        await migrationAdminSql.unsafe(`CREATE DATABASE ${MIGRATION_TEST_DB};`);
        const testUrlObj = new URL(url);
        testUrlObj.pathname = `/${MIGRATION_TEST_DB}`;
        migrationTestUrl = testUrlObj.toString();

        // Appliquer les migrations 0001 à 0028 manuellement
        const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
        const allFiles = readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        const sql = postgres(migrationTestUrl, { max: 1 });
        try {
          for (const file of allFiles) {
            const num = parseInt(file.slice(0, 4), 10);
            if (isNaN(num) || num >= 29) continue;
            const sqlContent = readFileSync(join(migrationsDir, file), 'utf-8');
            await sql.unsafe(sqlContent);
          }
        } finally {
          await sql.end();
        }
      });

      afterAll(async () => {
        if (migrationAdminSql) {
          try {
            await migrationAdminSql.unsafe(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MIGRATION_TEST_DB}' AND pid <> pg_backend_pid();`,
            );
            await migrationAdminSql.unsafe(`DROP DATABASE IF EXISTS ${MIGRATION_TEST_DB};`);
          } finally {
            await migrationAdminSql.end();
          }
        }
      });

      it('conserve les données existantes et applique le nouvel enum + colonne', async () => {
        // Garde-fou explicite : si la base dédiée n'a pas pu être préparée, on échoue
        // bruyamment plutôt que de retourner silencieusement (anti faux-positif P0).
        expect(url).toBeTruthy();
        expect(migrationTestUrl).toBeTruthy();
        const sql = postgres(migrationTestUrl!, { max: 1 });
        // Booléien de preuve d'exécution de 0029 : initialisé à false, passé à true
        // uniquement après succès de l'application de la migration.
        let migration0029Applied = false;
        try {
          // -----------------------------------------------------------------
          // Préparation des données sur la base arrêtée à 0028
          // -----------------------------------------------------------------
          const ids = await seedBaseData(sql, undefined, { withOperatingCurrency: false });
          const bookingIds = await seedBookingAndOutboxEvent(sql, ids);

          // Effet 1 — SEND_EMAIL PENDING (pour la delivery PENDING)
          const effectPending = await insertOutboxEffect(
            sql,
            bookingIds,
            validOutboxEffectPayload({
              effect_type: 'SEND_EMAIL',
              status: 'PENDING',
              failure_code: null,
              completed_at: null,
            }),
          ).then((r) => r[0]!);

          // Un second outbox_event est nécessaire car la contrainte UNIQUE
          // (outbox_event_id, effect_type) interdit deux SEND_EMAIL sur le même event.
          const outboxEvent2 = await sql`
            INSERT INTO "outbox_events" (
              "organization_id", "aggregate_type", "aggregate_id",
              "event_type", "event_version", "payload",
              "status", "attempt_count", "available_at", "idempotency_key"
            )
            VALUES (
              ${bookingIds.orgId}, 'BOOKING', ${bookingIds.bookingId},
              'BOOKING_CONFIRMED', 'v1', ${sql.json({
                bookingId: bookingIds.bookingId,
                paymentId: bookingIds.paymentId,
                draftId: bookingIds.draftId,
                organizationId: bookingIds.orgId,
              })},
              'PENDING', 0, now(), ${'booking_confirmed_2_' + bookingIds.bookingId}
            )
            RETURNING "id"
          `.then((r) => r[0]!);
          const bookingIds2: BookingAndOutboxIds = {
            ...bookingIds,
            outboxEventId: outboxEvent2.id,
          };

          // Effet 2 — SEND_EMAIL PENDING (pour la delivery SENT, insérée manuellement
          // hors pipeline : l'effet reste PENDING car la Phase C n'a pas tourné)
          const effectSent = await insertOutboxEffect(
            sql,
            bookingIds2,
            validOutboxEffectPayload({
              effect_type: 'SEND_EMAIL',
              status: 'PENDING',
              failure_code: null,
              completed_at: null,
            }),
          ).then((r) => r[0]!);

          // Un troisième outbox_event pour le SEND_EMAIL FAILED (même contrainte UNIQUE)
          const outboxEvent3 = await sql`
            INSERT INTO "outbox_events" (
              "organization_id", "aggregate_type", "aggregate_id",
              "event_type", "event_version", "payload",
              "status", "attempt_count", "available_at", "idempotency_key"
            )
            VALUES (
              ${bookingIds.orgId}, 'BOOKING', ${bookingIds.bookingId},
              'BOOKING_CONFIRMED', 'v1', ${sql.json({
                bookingId: bookingIds.bookingId,
                paymentId: bookingIds.paymentId,
                draftId: bookingIds.draftId,
                organizationId: bookingIds.orgId,
              })},
              'PENDING', 0, now(), ${'booking_confirmed_3_' + bookingIds.bookingId}
            )
            RETURNING "id"
          `.then((r) => r[0]!);
          const bookingIds3: BookingAndOutboxIds = {
            ...bookingIds,
            outboxEventId: outboxEvent3.id,
          };

          // Effet 3 — SEND_EMAIL FAILED (pour la delivery FAILED)
          const effectFailed = await insertOutboxEffect(
            sql,
            bookingIds3,
            validOutboxEffectPayload({
              effect_type: 'SEND_EMAIL',
              status: 'FAILED',
              failure_code: 'EMAIL_SEND_FAILED',
              completed_at: '2026-03-15T09:30:00Z',
            }),
          ).then((r) => r[0]!);

          // Effet 4 — GENERATE_CONFIRMATION FAILED (effet documentaire, pas de delivery)
          const effectDocFailed = await insertOutboxEffect(
            sql,
            bookingIds,
            validOutboxEffectPayload({
              effect_type: 'GENERATE_CONFIRMATION',
              status: 'FAILED',
              failure_code: 'RENDER_FAILED',
              completed_at: '2026-03-15T08:00:00Z',
            }),
          ).then((r) => r[0]!);

          // Delivery 1 — PENDING (provider_message_id NULL, sent_at NULL, failure_code NULL)
          const deliveryPending = await sql`
            INSERT INTO "notification_deliveries" (
              "organization_id", "outbox_event_id", "outbox_effect_id",
              "recipient_email", "template_key", "provider_idempotency_key",
              "status", "provider_message_id", "failure_code", "sent_at",
              "idempotency_key"
            )
            VALUES (
              ${bookingIds.orgId}, ${bookingIds.outboxEventId}, ${effectPending.id},
              'customer@example.com', 'booking_confirmed_customer',
              ${'prov-mig-pending-' + Math.random().toString(36).slice(2, 16)},
              'PENDING', NULL, NULL, NULL,
              ${'nd-mig-pending-' + Math.random().toString(36).slice(2, 16)}
            )
            RETURNING "id"
          `.then((r) => r[0]!);

          // Delivery 2 — SENT (provider_message_id non vide, sent_at non NULL, failure_code NULL)
          const deliverySent = await sql`
            INSERT INTO "notification_deliveries" (
              "organization_id", "outbox_event_id", "outbox_effect_id",
              "recipient_email", "template_key", "provider_idempotency_key",
              "status", "provider_message_id", "failure_code", "sent_at",
              "idempotency_key"
            )
            VALUES (
              ${bookingIds2.orgId}, ${bookingIds2.outboxEventId}, ${effectSent.id},
              'customer@example.com', 'booking_confirmed_customer',
              ${'prov-mig-sent-' + Math.random().toString(36).slice(2, 16)},
              'SENT', 'msg-sent-mig-001', NULL, '2026-03-15T10:00:00Z',
              ${'nd-mig-sent-' + Math.random().toString(36).slice(2, 16)}
            )
            RETURNING "id"
          `.then((r) => r[0]!);

          // Delivery 3 — FAILED (failure_code='EMAIL_SEND_FAILED', sent_at NULL, provider_message_id NULL)
          const deliveryFailed = await sql`
            INSERT INTO "notification_deliveries" (
              "organization_id", "outbox_event_id", "outbox_effect_id",
              "recipient_email", "template_key", "provider_idempotency_key",
              "status", "provider_message_id", "failure_code", "sent_at",
              "idempotency_key"
            )
            VALUES (
              ${bookingIds3.orgId}, ${bookingIds3.outboxEventId}, ${effectFailed.id},
              'customer@example.com', 'booking_confirmed_customer',
              ${'prov-mig-failed-' + Math.random().toString(36).slice(2, 16)},
              'FAILED', NULL, 'EMAIL_SEND_FAILED', NULL,
              ${'nd-mig-failed-' + Math.random().toString(36).slice(2, 16)}
            )
            RETURNING "id"
          `.then((r) => r[0]!);

          // Vérifier que les données sont bien là avant la migration
          const beforeDeliveries =
            await sql`SELECT count(*)::int as n FROM "notification_deliveries"`;
          expect(beforeDeliveries[0]!.n).toBe(3);
          const beforeEffects = await sql`SELECT count(*)::int as n FROM "outbox_effects"`;
          expect(beforeEffects[0]!.n).toBe(4);

          // -----------------------------------------------------------------
          // Application de la migration 0029
          // -----------------------------------------------------------------
          const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
          const migration0029 = readFileSync(
            join(migrationsDir, '0029_lot6_email_delivery_safety.sql'),
            'utf-8',
          );
          await sql.unsafe(migration0029);
          migration0029Applied = true;

          // -----------------------------------------------------------------
          // Vérifications après 0029
          // -----------------------------------------------------------------

          // Preuve que 0029 a réellement été exécutée : la colonne existe
          const colCheck = await sql`
            SELECT column_name, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'notification_deliveries'
              AND column_name = 'provider_first_attempt_started_at'
          `;
          expect(colCheck.length).toBe(1);
          expect(colCheck[0]!.is_nullable).toBe('YES');

          // Conservation du compte des lignes
          const afterDeliveries =
            await sql`SELECT count(*)::int as n FROM "notification_deliveries"`;
          expect(afterDeliveries[0]!.n).toBe(3);
          const afterEffects = await sql`SELECT count(*)::int as n FROM "outbox_effects"`;
          expect(afterEffects[0]!.n).toBe(4);

          // Conservation des IDs et statuts des 3 deliveries
          const pendingRow = await sql`
            SELECT "status", "provider_message_id", "sent_at", "failure_code",
                   "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${deliveryPending.id}
          `;
          expect(pendingRow[0]!.status).toBe('PENDING');
          expect(pendingRow[0]!.provider_message_id).toBeNull();
          expect(pendingRow[0]!.sent_at).toBeNull();
          expect(pendingRow[0]!.failure_code).toBeNull();
          expect(pendingRow[0]!.provider_first_attempt_started_at).toBeNull();

          const sentRow = await sql`
            SELECT "status", "provider_message_id", "sent_at", "failure_code",
                   "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${deliverySent.id}
          `;
          expect(sentRow[0]!.status).toBe('SENT');
          expect(sentRow[0]!.provider_message_id).toBe('msg-sent-mig-001');
          expect(new Date(sentRow[0]!.sent_at).toISOString()).toBe('2026-03-15T10:00:00.000Z');
          expect(sentRow[0]!.failure_code).toBeNull();
          expect(sentRow[0]!.provider_first_attempt_started_at).toBeNull();

          const failedRow = await sql`
            SELECT "status", "provider_message_id", "sent_at", "failure_code",
                   "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${deliveryFailed.id}
          `;
          expect(failedRow[0]!.status).toBe('FAILED');
          expect(failedRow[0]!.provider_message_id).toBeNull();
          expect(failedRow[0]!.sent_at).toBeNull();
          expect(failedRow[0]!.failure_code).toBe('EMAIL_SEND_FAILED');
          expect(failedRow[0]!.provider_first_attempt_started_at).toBeNull();

          // Conservation de l'effet outbox FAILED documentaire (RENDER_FAILED)
          const docFailedRow = await sql`
            SELECT "status", "failure_code", "effect_type"
            FROM "outbox_effects" WHERE "id" = ${effectDocFailed.id}
          `;
          expect(docFailedRow[0]!.status).toBe('FAILED');
          expect(docFailedRow[0]!.failure_code).toBe('RENDER_FAILED');
          expect(docFailedRow[0]!.effect_type).toBe('GENERATE_CONFIRMATION');

          // provider_first_attempt_started_at IS NULL pour TOUTES les anciennes lignes
          const nullTsCount = await sql`
            SELECT count(*)::int as n FROM "notification_deliveries"
            WHERE "provider_first_attempt_started_at" IS NOT NULL
          `;
          expect(nullTsCount[0]!.n).toBe(0);

          // Les anciens types _old n'existent plus
          const oldType = await sql`
            SELECT count(*)::int as n FROM pg_type WHERE typname = 'notification_delivery_status_old'
          `;
          expect(oldType[0]!.n).toBe(0);

          const oldFailType = await sql`
            SELECT count(*)::int as n FROM pg_type WHERE typname = 'document_processing_failure_code_old'
          `;
          expect(oldFailType[0]!.n).toBe(0);

          // Le nouvel enum notification_delivery_status a 4 valeurs dont REQUIRES_MANUAL_REVIEW
          const enumVals = await sql`
            SELECT enumlabel FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_delivery_status')
            ORDER BY enumsortorder
          `;
          expect(enumVals.map((r) => r.enumlabel)).toEqual([
            'PENDING',
            'SENT',
            'FAILED',
            'REQUIRES_MANUAL_REVIEW',
          ]);

          // Le nouvel enum document_processing_failure_code a 10 valeurs
          const failEnumVals = await sql`
            SELECT enumlabel FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'document_processing_failure_code')
            ORDER BY enumsortorder
          `;
          expect(failEnumVals.length).toBe(10);
          expect(failEnumVals.map((r) => r.enumlabel)).toContain('PROVIDER_RESULT_UNCERTAIN');
          expect(failEnumVals.map((r) => r.enumlabel)).toContain('EMAIL_RETRY_WINDOW_EXPIRED');

          // Preuve finale : 0029 a réellement été appliquée
          expect(migration0029Applied).toBe(true);
        } finally {
          await sql.end();
        }
      });
    });

    // =========================================================================
    // G5H-C2A — Interaction triggers transition + immutabilité timestamp (P0)
    // =========================================================================
    describe('G5H-C2A — Interaction triggers transition + immutabilité timestamp', () => {
      // Test 1 : transition PENDING → SENT avec changement simultané du timestamp (NULL → valeur) autorisé
      it('PENDING → SENT avec provider_first_attempt_started_at NULL → valeur autorisé', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const { id } = await createPendingDelivery(sql);
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'SENT',
                "provider_message_id" = 'msg-xyz',
                "sent_at" = now(),
                "provider_first_attempt_started_at" = now()
            WHERE "id" = ${id}
          `;
          const row = await sql`
            SELECT "status", "provider_message_id", "sent_at", "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${id}
          `;
          expect(row[0]!.status).toBe('SENT');
          expect(row[0]!.provider_message_id).toBe('msg-xyz');
          expect(row[0]!.sent_at).toBeTruthy();
          expect(row[0]!.provider_first_attempt_started_at).toBeTruthy();
        } finally {
          await sql.end();
        }
      });

      // Test 2 : transition PENDING → REQUIRES_MANUAL_REVIEW avec timestamp NULL → valeur autorisé
      it('PENDING → REQUIRES_MANUAL_REVIEW avec provider_first_attempt_started_at NULL → valeur autorisé', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const { id } = await createPendingDelivery(sql);
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'PROVIDER_RESULT_UNCERTAIN',
                "provider_first_attempt_started_at" = now()
            WHERE "id" = ${id}
          `;
          const row = await sql`
            SELECT "status", "failure_code", "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${id}
          `;
          expect(row[0]!.status).toBe('REQUIRES_MANUAL_REVIEW');
          expect(row[0]!.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');
          expect(row[0]!.provider_first_attempt_started_at).toBeTruthy();
        } finally {
          await sql.end();
        }
      });

      // Test 3 : transition PENDING → SENT avec modification d'un timestamp déjà renseigné refusé
      it('PENDING → SENT avec provider_first_attempt_started_at valeur → autre valeur refusé', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const ids = await seedBaseData(sql);
          const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
          const effect = await insertOutboxEffect(
            sql,
            bookingIds,
            validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
          ).then((r) => r[0]!);
          const initialTs = '2026-03-15T10:00:00Z';
          const delivery = await insertNotificationDelivery(
            sql,
            bookingIds,
            validNotificationDeliveryPayload({
              outbox_effect_id: effect.id,
              provider_first_attempt_started_at: initialTs,
            }),
          ).then((r) => r[0]!);
          await expect(
            sql`
              UPDATE "notification_deliveries"
              SET "status" = 'SENT',
                  "provider_message_id" = 'msg-abc',
                  "sent_at" = now(),
                  "provider_first_attempt_started_at" = now()
              WHERE "id" = ${delivery.id}
            `,
          ).rejects.toThrow();
        } finally {
          await sql.end();
        }
      });

      // Test 4 : transition REQUIRES_MANUAL_REVIEW → SENT avec timestamp conservé autorisé
      it('REQUIRES_MANUAL_REVIEW → SENT avec provider_first_attempt_started_at conservé autorisé', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const ids = await seedBaseData(sql);
          const bookingIds = await seedBookingAndOutboxEvent(sql, ids);
          const effect = await insertOutboxEffect(
            sql,
            bookingIds,
            validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
          ).then((r) => r[0]!);
          const initialTs = '2026-03-15T10:00:00Z';
          const delivery = await insertNotificationDelivery(
            sql,
            bookingIds,
            validNotificationDeliveryPayload({
              outbox_effect_id: effect.id,
              provider_first_attempt_started_at: initialTs,
            }),
          ).then((r) => r[0]!);
          // Passer en REQUIRES_MANUAL_REVIEW (timestamp déjà renseigné, conservé)
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'REQUIRES_MANUAL_REVIEW',
                "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'
            WHERE "id" = ${delivery.id}
          `;
          // Passer en SENT sans toucher provider_first_attempt_started_at
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'SENT',
                "provider_message_id" = 'msg-final',
                "sent_at" = now(),
                "failure_code" = NULL
            WHERE "id" = ${delivery.id}
          `;
          const row = await sql`
            SELECT "status", "provider_message_id", "provider_first_attempt_started_at"
            FROM "notification_deliveries" WHERE "id" = ${delivery.id}
          `;
          expect(row[0]!.status).toBe('SENT');
          expect(row[0]!.provider_message_id).toBe('msg-final');
          expect(row[0]!.provider_first_attempt_started_at).toBeTruthy();
        } finally {
          await sql.end();
        }
      });
    });

    // =========================================================================
    // G5H-C2A — Immuabilité états terminaux croisés (P1)
    // =========================================================================
    describe('G5H-C2A — Immuabilité états terminaux croisés', () => {
      // Test 5 : SENT → FAILED refusé
      it('SENT → FAILED refusé (état terminal immuable)', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const { id } = await createPendingDelivery(sql);
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'SENT', "provider_message_id" = 'msg-sent',
                "sent_at" = now()
            WHERE "id" = ${id}
          `;
          await expect(
            sql`
              UPDATE "notification_deliveries"
              SET "status" = 'FAILED', "failure_code" = 'EMAIL_SEND_FAILED',
                  "sent_at" = NULL
              WHERE "id" = ${id}
            `,
          ).rejects.toThrow();
        } finally {
          await sql.end();
        }
      });

      // Test 6 : FAILED → SENT refusé
      it('FAILED → SENT refusé (état terminal immuable)', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const { id } = await createPendingDelivery(sql);
          await sql`
            UPDATE "notification_deliveries"
            SET "status" = 'FAILED', "failure_code" = 'EMAIL_SEND_FAILED'
            WHERE "id" = ${id}
          `;
          await expect(
            sql`
              UPDATE "notification_deliveries"
              SET "status" = 'SENT', "provider_message_id" = 'msg-late',
                  "sent_at" = now(), "failure_code" = NULL
              WHERE "id" = ${id}
            `,
          ).rejects.toThrow();
        } finally {
          await sql.end();
        }
      });
    });

    // =========================================================================
    // G5H-C2A — Trigger multi-tenant préservé après migration 0029 (P1)
    // =========================================================================
    describe('G5H-C2A — Trigger multi-tenant préservé après migration 0029', () => {
      // Test 7 : le trigger before_check_notification_delivery existe toujours après 0029
      it('le trigger before_check_notification_delivery existe après migration 0029', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          const rows = await sql`
            SELECT tgname FROM pg_trigger
            WHERE tgrelid = 'notification_deliveries'::regclass
              AND NOT tgisinternal
              AND tgname = 'before_check_notification_delivery'
          `;
          expect(rows.length).toBe(1);
        } finally {
          await sql.end();
        }
      });

      // Test 7b : le trigger multi-tenant fonctionne (insertion cross-org refusée)
      it('le trigger before_check_notification_delivery refuse une delivery cross-organisation', async () => {
        if (!testUrl) return;
        const sql = postgres(testUrl, { max: 1 });
        try {
          // Créer deux organisations distinctes avec leurs propres bookings/effects
          const idsA = await seedBaseData(sql);
          const bookingIdsA = await seedBookingAndOutboxEvent(sql, idsA);
          const effectA = await insertOutboxEffect(
            sql,
            bookingIdsA,
            validOutboxEffectPayload({ effect_type: 'SEND_EMAIL' }),
          ).then((r) => r[0]!);

          const idsB = await seedBaseData(sql);
          const bookingIdsB = await seedBookingAndOutboxEvent(sql, idsB);
          // Tenter d'insérer une notification_deliveries avec organization_id de B
          // mais outbox_effect_id de A → doit échouer (trigger multi-tenant)
          await expect(
            insertNotificationDelivery(
              sql,
              bookingIdsB,
              validNotificationDeliveryPayload({
                outbox_effect_id: effectA.id,
              }),
            ),
          ).rejects.toThrow();
        } finally {
          await sql.end();
        }
      });
    });
  });
});
