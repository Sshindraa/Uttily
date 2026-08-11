import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  runMigrations,
  assertLocalhost,
  type DatabaseClient,
  createDatabase,
} from '@uttily/database';
import { getEffectiveBooking } from './get-effective-booking';
import { EffectiveBookingError } from './errors';

/**
 * Tests d'intégration PostgreSQL pour getEffectiveBooking (G7M-B1, ADR-023 §4.1, §11.1).
 *
 * Stratégie : base de test dédiée (comme schema-g7m-a-amendments.test.ts),
 * skip si pas DATABASE_URL en local, échec explicite en CI.
 *
 * Couverture :
 *  1. booking sans amendement → projection originale
 *  2. un amendement APPLIED → projection du snapshot après
 *  3. plusieurs APPLIED → dernier amendment_number utilisé
 *  4. HOLD_PENDING ignoré
 *  5. READY_TO_APPLY ignoré
 *  6. EXPIRED ignoré
 *  7. CANCELLED ignoré
 *  8. lignes REMOVE exclues
 *  9. ADD/MODIFY/UNCHANGED projetées
 * 10. allocations CONVERTED incluses
 * 11. allocations PROPOSED/RELEASED exclues
 * 12. historique APPLIED ordonné
 * 13. tenant isolation avec une deuxième organisation
 * 14. booking inexistante et booking autre tenant → même NOT_FOUND
 * 15. devise et montants préservés
 * 16. timezone du lieu préservé
 * 17. données JSONB persistées invalides → erreur Core typée
 * 18. aucune écriture effectuée par la projection
 * 19. paiement initial SUCCEEDED inclus dans grossCollected
 * 20. paiement initial non-SUCCEEDED exclu
 * 21. amendment_payment SUCCEEDED inclus
 * 22. amendment_payment non-SUCCEEDED exclu
 * 23. refund SUCCEEDED sur payment initial inclus
 * 24. refund SUCCEEDED sur amendment_payment inclus
 * 25. PENDING/SUBMITTED/FAILED_REQUIRES_MANUAL_ACTION comptés comme encore dus
 * 26. SETTLED_OFF_PLATFORM compté séparément et pas comme encore dû
 * 27. refunds des deux origines agrégés sans double comptage
 * 28. plusieurs amendment_payments et refunds sans multiplication cartésienne
 * 29. tenant B exclu des financials
 * 30. invariant financier avec valeurs représentatives
 * 31. appel réel depuis une transaction
 * 32. logicalLineId original
 * 33. logicalLineId amendé
 * 34. invariant financier violé → rejet FINANCIAL_INVARIANT_VIOLATION
 */

const TEST_DB_NAME = 'uttily_test_g7m_b1';
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
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests G7M-B1.');
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
        'Démarrez la base (docker-compose up -d postgres) ou unset DATABASE_URL pour skipper.',
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
  db = createDatabase(testUrl);
  rawSql = postgres(testUrl, { max: 5 });
}, 600000);

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers (reprend le pattern de schema-g7m-a-amendments.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  variantId: string;
  itemId: string;
}

async function seedBaseData(sql: postgres.Sql, suffix?: string): Promise<BaseIds> {
  // Toujours ajouter un suffixe aléatoire pour garantir l'unicité du slug
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
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + fullSuffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name")
    VALUES (${product.id}, 'Standard')
    RETURNING "id"
  `.then((r) => r[0]!);
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + fullSuffix}, ${location.id})
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    variantId: variant.id,
    itemId: item.id,
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
    RETURNING "id"
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
    status: 'SUCCEEDED',
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
    succeeded_at: '2026-01-01 12:00:00+00',
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
  timezone: string;
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
    customer_start_at: '2026-02-10 09:00:00+00',
    customer_end_at: '2026-02-12 17:00:00+00',
    blocked_start_at: '2026-02-10 08:30:00+00',
    blocked_end_at: '2026-02-12 17:30:00+00',
    timezone: 'Europe/Paris',
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
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
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
      ${p.timezone}, ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
      ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
      ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
      ${p.commission_amount_minor}, ${p.total_amount_minor},
      ${sql.json(p.cancellation_policy_snapshot)}, ${sql.json(p.terms_acceptance_snapshot)},
      ${p.confirmed_at}
    )
    RETURNING "id"
  `;
}

interface BookingWithItemIds {
  bookingId: string;
  bookingItemId: string;
  lineId: string;
  blockId: string;
}

async function seedBookingWithItem(
  sql: postgres.Sql,
  ids: BaseIds,
  monthOffset = 2,
): Promise<BookingWithItemIds> {
  const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
  const draftLine = await sql`
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
    VALUES (${draftLine.id}, ${holdBlock.id})
  `;
  const payment = await insertPayment(sql, ids, draft.id, validPaymentPayload()).then((r) => r[0]!);
  const booking = await insertBooking(sql, ids, draft.id, payment.id, validBookingPayload()).then(
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
  await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlock.id}`;
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
    VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlock.id}, ${bookingBlock.id})
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    bookingId: booking.id,
    bookingItemId: bookingItem.id,
    lineId: line.id,
    blockId: bookingBlock.id,
  };
}

interface AmendmentOpts {
  type?: 'NEUTRAL' | 'SUPPLEMENT' | 'REFUND';
  amendmentNumber?: number;
  status?: string;
  snapshotAfter?: unknown;
  newCustomerStartAt?: string;
  newCustomerEndAt?: string;
  newBlockedStartAt?: string;
  newBlockedEndAt?: string;
}

async function seedAmendment(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingIds: BookingWithItemIds,
  opts: AmendmentOpts = {},
): Promise<string> {
  const type = opts.type ?? 'NEUTRAL';
  const amendmentNumber = opts.amendmentNumber ?? 1;
  const isSupplement = type === 'SUPPLEMENT';
  // Status d'INSERT selon le trigger : SUPPLEMENT→HOLD_PENDING, NEUTRAL/REFUND→READY_TO_APPLY
  const insertStatus = isSupplement ? 'HOLD_PENDING' : 'READY_TO_APPLY';
  const targetStatus = opts.status ?? insertStatus;
  const createdAt = '2026-01-01 12:00:00+00';
  const holdDeadline = isSupplement ? '2026-01-01 12:10:00+00' : null;
  const snapshotAfter = opts.snapshotAfter ?? { totalAmountMinor: 12000, currency: 'EUR' };

  // INSERT avec le statut initial imposé par le trigger
  const amendment = await sql`
    INSERT INTO "booking_amendments" (
      "organization_id", "booking_id", "amendment_number", "type", "status",
      "financial_snapshot_before", "financial_snapshot_after",
      "new_customer_start_at", "new_customer_end_at",
      "new_blocked_start_at", "new_blocked_end_at",
      "hold_deadline", "created_by", "created_at"
    )
    VALUES (
      ${ids.orgId}, ${bookingIds.bookingId}, ${amendmentNumber}, ${type}, ${insertStatus},
      ${sql.json({ totalAmountMinor: 10000, currency: 'EUR' })}, ${sql.json(snapshotAfter as never)},
      ${opts.newCustomerStartAt ?? '2026-02-10 09:00:00+00'},
      ${opts.newCustomerEndAt ?? '2026-02-12 17:00:00+00'},
      ${opts.newBlockedStartAt ?? '2026-02-10 08:30:00+00'},
      ${opts.newBlockedEndAt ?? '2026-02-12 17:30:00+00'},
      ${holdDeadline}, ${ids.userId}, ${createdAt}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Si le statut cible diffère du statut d'INSERT, effectuer la transition
  if (targetStatus !== insertStatus) {
    if (targetStatus === 'APPLIED') {
      if (isSupplement) {
        // SUPPLEMENT: HOLD_PENDING → READY_TO_APPLY → APPLIED
        await sql`UPDATE "booking_amendments" SET "status" = 'READY_TO_APPLY' WHERE "id" = ${amendment.id}`;
      }
      // READY_TO_APPLY → APPLIED (requiert applied_at)
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'APPLIED', "applied_at" = '2026-01-01 12:05:00+00'
        WHERE "id" = ${amendment.id}
      `;
    } else if (targetStatus === 'EXPIRED') {
      // HOLD_PENDING → EXPIRED (requiert expired_at)
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'EXPIRED', "expired_at" = '2026-01-01 12:15:00+00'
        WHERE "id" = ${amendment.id}
      `;
    } else if (targetStatus === 'CANCELLED') {
      // HOLD_PENDING → CANCELLED (requiert cancelled_at)
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'CANCELLED', "cancelled_at" = '2026-01-01 12:15:00+00'
        WHERE "id" = ${amendment.id}
      `;
    } else if (targetStatus === 'READY_TO_APPLY' && isSupplement) {
      // SUPPLEMENT: HOLD_PENDING → READY_TO_APPLY
      await sql`
        UPDATE "booking_amendments"
        SET "status" = 'READY_TO_APPLY'
        WHERE "id" = ${amendment.id}
      `;
    }
  }

  return amendment.id;
}

interface AmendmentLineOpts {
  originType?: 'ORIGINAL' | 'AMENDMENT';
  action?: 'ADD' | 'MODIFY' | 'REMOVE' | 'UNCHANGED';
  logicalLineId?: string;
  sourceBookingLineId?: string | null;
  variantId?: string;
  afterQuantity?: number;
  afterUnitPrice?: number;
}

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
  const variantId = opts.variantId ?? ids.variantId;
  const logicalLineId =
    opts.logicalLineId ??
    (originType === 'ORIGINAL' ? bookingIds.lineId : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  let beforeQty: number, afterQty: number, beforePrice: number, afterPrice: number;
  switch (action) {
    case 'ADD':
      beforeQty = 0;
      afterQty = opts.afterQuantity ?? 1;
      beforePrice = 0;
      afterPrice = opts.afterUnitPrice ?? 5000;
      break;
    case 'MODIFY':
      beforeQty = 1;
      afterQty = opts.afterQuantity ?? 2;
      beforePrice = 5000;
      afterPrice = opts.afterUnitPrice ?? 5000;
      break;
    case 'REMOVE':
      beforeQty = 1;
      afterQty = 0;
      beforePrice = 5000;
      afterPrice = 0;
      break;
    default:
      beforeQty = 1;
      afterQty = opts.afterQuantity ?? 1;
      beforePrice = 5000;
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
      ${originType}, ${sourceBookingLineId}, ${variantId}, ${action},
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
  // Le trigger impose INSERT en PROPOSED, puis UPDATE vers CONVERTED/RELEASED
  const targetStatus = opts.status ?? 'PROPOSED';

  const allocation = await sql`
    INSERT INTO "booking_amendment_allocations" (
      "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
      "action", "source_booking_block_id", "applied_booking_block_id", "status",
      "effective_customer_start_at", "effective_customer_end_at",
      "effective_blocked_start_at", "effective_blocked_end_at"
    )
    VALUES (
      ${amendmentId}, ${amendmentLineId}, ${ids.orgId}, ${ids.itemId},
      ${action}, ${sourceBookingBlockId}, ${null}, 'PROPOSED',
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Transition vers le statut cible si différent de PROPOSED
  if (targetStatus === 'CONVERTED') {
    // PROPOSED → CONVERTED requiert applied_booking_block_id
    // Libérer l'ancien block BOOKING pour éviter le chevauchement (exclusion constraint)
    await sql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${bookingIds.blockId}`;
    // Créer un nouveau block BOOKING/ACTIVE pour cet amendement
    const newBlock = await sql`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at", "source_id"
      )
      VALUES (
        ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${bookingIds.bookingId}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await sql`
      UPDATE "booking_amendment_allocations"
      SET "status" = 'CONVERTED', "applied_booking_block_id" = ${newBlock.id}
      WHERE "id" = ${allocation.id}
    `;
  } else if (targetStatus === 'RELEASED') {
    // PROPOSED → RELEASED
    await sql`
      UPDATE "booking_amendment_allocations"
      SET "status" = 'RELEASED'
      WHERE "id" = ${allocation.id}
    `;
  }

  return allocation.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers — amendment_payments et refunds (G7M-B1 corrections)
// ─────────────────────────────────────────────────────────────────────────────

interface AmendmentPaymentOpts {
  status?: string;
  amountMinor?: number;
  succeededAt?: string | null;
}

async function seedAmendmentPayment(
  sql: postgres.Sql,
  ids: BaseIds,
  bookingId: string,
  amendmentId: string,
  opts: AmendmentPaymentOpts = {},
): Promise<string> {
  const targetStatus = opts.status ?? 'SUCCEEDED';
  const amountMinor = opts.amountMinor ?? 3000;
  // Le trigger impose INSERT en PENDING_PROVIDER, puis UPDATE vers le statut cible
  const ap = await sql`
    INSERT INTO "amendment_payments" (
      "organization_id", "booking_id", "amendment_id", "customer_user_id",
      "amount_minor", "currency", "environment",
      "connected_account_id", "charge_model", "settlement_merchant_mode",
      "status"
    )
    VALUES (
      ${ids.orgId}, ${bookingId}, ${amendmentId}, ${ids.userId},
      ${amountMinor}, 'EUR', 'TEST',
      'acct_test123', 'DESTINATION', 'CONNECTED_ACCOUNT',
      'PENDING_PROVIDER'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Transition vers le statut cible
  if (targetStatus === 'SUCCEEDED') {
    await sql`UPDATE "amendment_payments" SET "status" = 'SUCCEEDED', "succeeded_at" = '2026-01-01 12:10:00+00' WHERE "id" = ${ap.id}`;
  } else if (targetStatus === 'FAILED') {
    await sql`UPDATE "amendment_payments" SET "status" = 'FAILED', "failed_at" = '2026-01-01 12:10:00+00' WHERE "id" = ${ap.id}`;
  } else if (targetStatus === 'CANCELLED') {
    await sql`UPDATE "amendment_payments" SET "status" = 'CANCELLED', "cancelled_at" = '2026-01-01 12:10:00+00' WHERE "id" = ${ap.id}`;
  }
  // PENDING_PROVIDER : pas de transition nécessaire

  return ap.id;
}

interface RefundOpts {
  status?: string;
  amountMinor?: number;
  reason?: string;
  paymentId?: string | null;
  amendmentPaymentId?: string | null;
  settledOffPlatformAt?: string | null;
  settledOffPlatformBy?: string | null;
  settlementNotes?: string | null;
}

async function seedRefund(sql: postgres.Sql, ids: BaseIds, opts: RefundOpts = {}): Promise<string> {
  const status = opts.status ?? 'SUCCEEDED';
  const amountMinor = opts.amountMinor ?? 2000;
  const reason =
    opts.reason ?? (opts.amendmentPaymentId ? 'AMENDMENT_COMPENSATION' : 'BOOKING_MODIFICATION');
  const paymentId = opts.paymentId ?? null;
  const amendmentPaymentId = opts.amendmentPaymentId ?? null;
  const settledOffPlatformAt = opts.settledOffPlatformAt ?? null;
  const settledOffPlatformBy = opts.settledOffPlatformBy ?? null;
  const settlementNotes = opts.settlementNotes ?? null;
  const refund = await sql`
    INSERT INTO "refunds" (
      "organization_id", "payment_id", "amendment_payment_id",
      "reason", "status", "amount_minor", "currency",
      "provider_idempotency_key", "reverse_transfer", "refund_application_fee",
      "requested_at", "succeeded_at",
      "settled_off_platform_at", "settled_off_platform_by", "settlement_notes"
    )
    VALUES (
      ${ids.orgId}, ${paymentId}, ${amendmentPaymentId},
      ${reason}, ${status}, ${amountMinor}, 'EUR',
      ${'rf_key_' + Math.random().toString(36).slice(2)}, true, true,
      '2026-01-01 12:20:00+00',
      ${status === 'SUCCEEDED' ? '2026-01-01 12:25:00+00' : null},
      ${settledOffPlatformAt}, ${settledOffPlatformBy}, ${settlementNotes}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return refund.id;
}

const skip = shouldSkipIntegrationTests();

describe.skipIf(skip)('getEffectiveBooking — intégration PostgreSQL', () => {
  it('1. booking sans amendement → projection originale', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    const { booking } = result;

    expect(booking.lastAppliedAmendmentNumber).toBe(0);
    expect(booking.amendments).toHaveLength(0);
    expect(booking.effectiveTotalAmountMinor).toBe(10000);
    expect(booking.effectiveCurrency).toBe('EUR');
    expect(booking.effectiveCustomerStartAt).toEqual(new Date('2026-02-10 09:00:00+00'));
    expect(booking.effectiveCustomerEndAt).toEqual(new Date('2026-02-12 17:00:00+00'));
    expect(booking.effectiveBlockedStartAt).toEqual(new Date('2026-02-10 08:30:00+00'));
    expect(booking.effectiveBlockedEndAt).toEqual(new Date('2026-02-12 17:30:00+00'));
    expect(booking.lines).toHaveLength(1);
    expect(booking.lines[0]!.quantity).toBe(1);
    expect(booking.lines[0]!.action).toBe('UNCHANGED');
    expect(booking.allocations).toHaveLength(1);
    expect(booking.allocations[0]!.action).toBe('RETAIN');
  });

  it('2. un amendement APPLIED → projection du snapshot après', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    const lineId = await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'MODIFY',
      afterQuantity: 1,
    });
    await seedAmendmentAllocation(rawSql, ids, amendmentId, lineId, bookingIds, {
      status: 'CONVERTED',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    const { booking } = result;

    expect(booking.lastAppliedAmendmentNumber).toBe(1);
    expect(booking.effectiveTotalAmountMinor).toBe(10000);
    expect(booking.effectiveCurrency).toBe('EUR');
    expect(booking.effectiveCustomerStartAt).toEqual(new Date('2026-02-10 09:00:00+00'));
    expect(booking.amendments).toHaveLength(1);
    expect(booking.amendments[0]!.amendmentNumber).toBe(1);
    expect(booking.amendments[0]!.type).toBe('NEUTRAL');
  });

  it('3. plusieurs APPLIED → dernier amendment_number utilisé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const a1 = await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 1,
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 9000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, a1, bookingIds, { action: 'UNCHANGED' });
    const a2 = await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 2,
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, a2, bookingIds, { action: 'UNCHANGED' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    const { booking } = result;

    expect(booking.lastAppliedAmendmentNumber).toBe(2);
    expect(booking.effectiveTotalAmountMinor).toBe(10000);
    expect(booking.amendments).toHaveLength(2);
    expect(booking.amendments[0]!.amendmentNumber).toBe(1);
    expect(booking.amendments[1]!.amendmentNumber).toBe(2);
  });

  it('4. HOLD_PENDING ignoré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'HOLD_PENDING',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lastAppliedAmendmentNumber).toBe(0);
    expect(result.booking.effectiveTotalAmountMinor).toBe(10000);
  });

  it('5. READY_TO_APPLY ignoré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    await seedAmendment(rawSql, ids, bookingIds, { status: 'READY_TO_APPLY' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lastAppliedAmendmentNumber).toBe(0);
  });

  it('6. EXPIRED ignoré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // EXPIRED n'est atteignable que depuis HOLD_PENDING (SUPPLEMENT)
    await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'EXPIRED',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lastAppliedAmendmentNumber).toBe(0);
  });

  it('7. CANCELLED ignoré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // CANCELLED n'est atteignable que depuis HOLD_PENDING (SUPPLEMENT)
    await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'CANCELLED',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lastAppliedAmendmentNumber).toBe(0);
  });

  it('8. lignes REMOVE exclues', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'REMOVE' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lines).toHaveLength(0);
  });

  it('9. ADD/MODIFY/UNCHANGED projetées', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // Créer une deuxième variante pour la ligne ADD (contrainte unique amendment+variant)
    const variant2 = await rawSql`
      INSERT INTO "product_variants" ("product_id", "name")
      VALUES (
        (SELECT "product_id" FROM "product_variants" WHERE "id" = ${ids.variantId}),
        'Premium'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    // UNCHANGED sur la ligne existante
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    // ADD d'une nouvelle ligne avec une variante différente
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'ADD',
      originType: 'AMENDMENT',
      logicalLineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sourceBookingLineId: null,
      variantId: variant2.id,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.lines).toHaveLength(2);
    const actions = result.booking.lines.map((l) => l.action).sort();
    expect(actions).toEqual(['ADD', 'UNCHANGED']);
  });

  it('10. allocations CONVERTED incluses', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    const lineId = await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'UNCHANGED',
    });
    await seedAmendmentAllocation(rawSql, ids, amendmentId, lineId, bookingIds, {
      status: 'CONVERTED',
      action: 'RETAIN',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.allocations).toHaveLength(1);
    expect(result.booking.allocations[0]!.action).toBe('RETAIN');
  });

  it('11. allocations PROPOSED/RELEASED exclues', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    const lineId = await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'UNCHANGED',
    });
    // Une allocation PROPOSED (non CONVERTED) — exclue de la projection
    await seedAmendmentAllocation(rawSql, ids, amendmentId, lineId, bookingIds, {
      status: 'PROPOSED',
      action: 'RETAIN',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.allocations).toHaveLength(0);
  });

  it('12. historique APPLIED ordonné', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // Insérer dans l'ordre inverse pour vérifier le tri
    await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 3,
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 1,
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 9000, currency: 'EUR' },
    });
    await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 2,
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 7000, currency: 'EUR' },
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.amendments.map((a) => a.amendmentNumber)).toEqual([1, 2, 3]);
    expect(result.booking.lastAppliedAmendmentNumber).toBe(3);
    expect(result.booking.effectiveTotalAmountMinor).toBe(10000);
  });

  it('13. tenant isolation avec une deuxième organisation', async () => {
    if (!db || !rawSql) return;
    const idsA = await seedBaseData(rawSql, 'aaa');
    const idsB = await seedBaseData(rawSql, 'bbb');
    const bookingIdsA = await seedBookingWithItem(rawSql, idsA);

    // Tentative de lecture depuis l'org B
    const result = await getEffectiveBooking(db, idsB.orgId, bookingIdsA.bookingId);

    expect(result.kind).toBe('NOT_FOUND');
  });

  it('14. booking inexistante et booking autre tenant → même NOT_FOUND', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const nonexistentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const result1 = await getEffectiveBooking(db, ids.orgId, nonexistentId);
    const result2 = await getEffectiveBooking(
      db,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      nonexistentId,
    );

    expect(result1.kind).toBe('NOT_FOUND');
    expect(result2.kind).toBe('NOT_FOUND');
    // Même forme — aucune fuite d'information
    expect(result1).toEqual(result2);
  });

  it('15. devise et montants préservés', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.effectiveTotalAmountMinor).toBe(10000);
    expect(result.booking.effectiveCurrency).toBe('EUR');
  });

  it('16. timezone du lieu préservé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.booking.timezone).toBe('Europe/Paris');
  });

  it('17. données JSONB persistées invalides → erreur Core typée', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // Snapshot invalide : totalAmountMinor négatif
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: -500, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    await expect(getEffectiveBooking(db, ids.orgId, bookingIds.bookingId)).rejects.toThrow(
      EffectiveBookingError,
    );
    await expect(getEffectiveBooking(db, ids.orgId, bookingIds.bookingId)).rejects.toThrow(
      /négatif|SNAPSHOT_INVALID/,
    );
  });

  it('18. aucune écriture effectuée par la projection', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    // Capturer les timestamps de dernière modification
    const beforeRows = await rawSql`
      SELECT "updated_at" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}
    `;
    const beforeTs = beforeRows[0]!.updated_at;

    // Attendre 100ms pour qu'une éventuelle écriture soit détectable
    await new Promise((r) => setTimeout(r, 100));

    await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    const afterRows = await rawSql`
      SELECT "updated_at" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}
    `;
    const afterTs = afterRows[0]!.updated_at;

    expect(afterTs).toEqual(beforeTs);
  });
  // ─────────────────────────────────────────────────────────────────────────────
  // Tests financiers (G7M-B1 corrections — ADR-023 §4.1, §11.1)
  // ─────────────────────────────────────────────────────────────────────────────

  it('19. paiement initial SUCCEEDED inclus dans grossCollected', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // seedBookingWithItem crée un paiement SUCCEEDED de 10000
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(10000);
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(0);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(10000);
    expect(result.booking.financials.contractualTotalAmountMinor).toBe(10000);
  });

  it('20. paiement initial non-SUCCEEDED exclu du grossCollected', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    // Créer un booking avec un paiement FAILED
    const draft = await insertDraft(rawSql, ids, validDraftPayload()).then((r) => r[0]!);
    await rawSql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
    const draftLine = await rawSql`
      INSERT INTO "booking_draft_lines" ("draft_id", "variant_id", "quantity", "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor", "variant_snapshot")
      VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${rawSql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);
    const holdBlock = await rawSql`
      INSERT INTO "inventory_blocks" ("organization_id", "inventory_item_id", "type", "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "expires_at", "source_id")
      VALUES (${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE', '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00', '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', '2026-03-09 12:00:00+00', ${draft.id})
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`INSERT INTO "allocations" ("draft_line_id", "inventory_block_id") VALUES (${draftLine.id}, ${holdBlock.id})`;
    const failedPayment = await insertPayment(
      rawSql,
      ids,
      draft.id,
      validPaymentPayload({ status: 'FAILED', succeeded_at: null }),
    ).then((r) => r[0]!);
    const booking = await insertBooking(
      rawSql,
      ids,
      draft.id,
      failedPayment.id,
      validBookingPayload(),
    ).then((r) => r[0]!);
    const line = await rawSql`
      INSERT INTO "booking_lines" ("booking_id", "variant_id", "quantity", "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor", "variant_snapshot")
      VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${rawSql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlock.id}`;
    const bookingBlock = await rawSql`
      INSERT INTO "inventory_blocks" ("organization_id", "inventory_item_id", "type", "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "source_id")
      VALUES (${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE', '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00', '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${booking.id})
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`
      INSERT INTO "booking_items" ("booking_id", "booking_line_id", "inventory_item_id", "source_hold_block_id", "booking_block_id")
      VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlock.id}, ${bookingBlock.id})
    `;
    // Amendement APPLIED avec snapshot=0 pour satisfaire l'invariant financier
    // (grossCollected=0, successfulRefunded=0, settledOffPlatform=0, refundStillOwed=0 → contractualTotal=0)
    const bookingIdsForAmendment: BookingWithItemIds = {
      bookingId: booking.id,
      bookingItemId: '',
      lineId: line.id,
      blockId: bookingBlock.id,
    };
    const amendmentId = await seedAmendment(rawSql, ids, bookingIdsForAmendment, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 0, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIdsForAmendment, {
      action: 'UNCHANGED',
    });

    const result = await getEffectiveBooking(db, ids.orgId, booking.id);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(0);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(0);
  });

  it('21. amendment_payment SUCCEEDED inclus dans grossCollected', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 13000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, amendmentId, {
      status: 'SUCCEEDED',
      amountMinor: 3000,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // 10000 (initial) + 3000 (supplement) = 13000
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(13000);
  });

  it('22. amendment_payment non-SUCCEEDED exclu du grossCollected', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, amendmentId, {
      status: 'PENDING_PROVIDER',
      amountMinor: 3000,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // Seul le paiement initial SUCCEEDED compte
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(10000);
  });

  it('23. refund SUCCEEDED sur payment initial inclus', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    // Récupérer le paymentId de la booking
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 2000,
    });
    // Amendement APPLIED avec snapshot=8000 pour satisfaire l'invariant financier
    // (grossCollected=10000, successfulRefunded=2000, settledOffPlatform=0, refundStillOwed=0 → contractualTotal=8000)
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 8000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(2000);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(8000);
    expect(result.booking.financials.refundStillOwedAmountMinor).toBe(0);
  });

  it('24. refund SUCCEEDED sur amendment_payment inclus', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 12000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    const apId = await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, amendmentId, {
      status: 'SUCCEEDED',
      amountMinor: 3000,
    });
    await seedRefund(rawSql, ids, {
      amendmentPaymentId: apId,
      status: 'SUCCEEDED',
      amountMinor: 1000,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(1000);
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(13000);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(12000);
  });

  it('25. PENDING/SUBMITTED/FAILED_REQUIRES_MANUAL_ACTION comptés comme encore dus', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'PENDING',
      amountMinor: 500,
    });
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUBMITTED',
      amountMinor: 700,
    });
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'FAILED_REQUIRES_MANUAL_ACTION',
      amountMinor: 300,
    });
    // Amendement APPLIED avec snapshot=8500 pour satisfaire l'invariant financier
    // (grossCollected=10000, successfulRefunded=0, settledOffPlatform=0, refundStillOwed=1500 → contractualTotal=8500)
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 8500, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.financials.refundStillOwedAmountMinor).toBe(1500);
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(0);
  });

  it('26. SETTLED_OFF_PLATFORM compté séparément et pas comme encore dû', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SETTLED_OFF_PLATFORM',
      amountMinor: 800,
      settledOffPlatformAt: '2026-01-02 10:00:00+00',
      settledOffPlatformBy: ids.userId,
      settlementNotes: 'Résolution manuelle hors plateforme',
    });
    // Amendement APPLIED avec snapshot=9200 pour satisfaire l'invariant financier
    // (grossCollected=10000, successfulRefunded=0, settledOffPlatform=800, refundStillOwed=0 → contractualTotal=9200)
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 9200, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.financials.settledOffPlatformAmountMinor).toBe(800);
    expect(result.booking.financials.refundStillOwedAmountMinor).toBe(0);
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(0);
  });

  it('27. refunds des deux origines agrégés sans double comptage', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    // Refund sur payment initial
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 1000,
    });
    // Refund sur amendment_payment
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 11500, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    const apId = await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, amendmentId, {
      status: 'SUCCEEDED',
      amountMinor: 3000,
    });
    await seedRefund(rawSql, ids, {
      amendmentPaymentId: apId,
      status: 'SUCCEEDED',
      amountMinor: 500,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // 1000 (initial) + 500 (amendment) = 1500, pas 2000 (pas de double comptage)
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(1500);
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(13000);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(11500);
  });

  it('28. plusieurs amendment_payments et refunds sans multiplication cartésienne', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    // Deux amendment_payments SUCCEEDED
    const a1 = await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 1,
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 13000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, a1, bookingIds, { action: 'UNCHANGED' });
    const ap1 = await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, a1, {
      status: 'SUCCEEDED',
      amountMinor: 3000,
    });
    const a2 = await seedAmendment(rawSql, ids, bookingIds, {
      amendmentNumber: 2,
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 14000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, a2, bookingIds, { action: 'UNCHANGED' });
    const ap2 = await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, a2, {
      status: 'SUCCEEDED',
      amountMinor: 3000,
    });
    // Refund sur chaque origine
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 1000,
    });
    await seedRefund(rawSql, ids, {
      amendmentPaymentId: ap1,
      status: 'SUCCEEDED',
      amountMinor: 500,
    });
    await seedRefund(rawSql, ids, {
      amendmentPaymentId: ap2,
      status: 'SUCCEEDED',
      amountMinor: 500,
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // grossCollected = 10000 + 3000 + 3000 = 16000 (pas 22000 ou autre)
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(16000);
    // successfulRefunded = 1000 + 500 + 500 = 2000 (pas 6000 ou autre)
    expect(result.booking.financials.successfulRefundedAmountMinor).toBe(2000);
    expect(result.booking.financials.netCollectedAmountMinor).toBe(14000);
  });

  it('29. tenant B exclu des financials', async () => {
    if (!db || !rawSql) return;
    const idsA = await seedBaseData(rawSql, 'aaa');
    const idsB = await seedBaseData(rawSql, 'bbb');
    const bookingIdsA = await seedBookingWithItem(rawSql, idsA);
    const paymentRowA =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIdsA.bookingId}`.then(
        (r) => r[0]!,
      );
    // Refund de l'org A
    await seedRefund(rawSql, idsA, {
      paymentId: paymentRowA.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 2000,
    });
    // Amendement APPLIED pour le booking A avec snapshot=8000 pour satisfaire l'invariant financier
    // (grossCollected=10000, successfulRefunded=2000, settledOffPlatform=0, refundStillOwed=0 → contractualTotal=8000)
    const amendmentIdA = await seedAmendment(rawSql, idsA, bookingIdsA, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 8000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, idsA, amendmentIdA, bookingIdsA, { action: 'UNCHANGED' });
    // Créer un booking dans l'org B avec un paiement et un refund
    const bookingIdsB = await seedBookingWithItem(rawSql, idsB);
    const paymentRowB =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIdsB.bookingId}`.then(
        (r) => r[0]!,
      );
    await seedRefund(rawSql, idsB, {
      paymentId: paymentRowB.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 5000,
    });

    // Lire le booking A depuis l'org A
    const resultA = await getEffectiveBooking(db, idsA.orgId, bookingIdsA.bookingId);
    expect(resultA.kind).toBe('FOUND');
    if (resultA.kind !== 'FOUND') return;
    // Le refund de l'org B (5000) ne doit pas apparaître
    expect(resultA.booking.financials.successfulRefundedAmountMinor).toBe(2000);
    expect(resultA.booking.financials.grossCollectedAmountMinor).toBe(10000);
  });

  it('30. invariant financier avec valeurs représentatives', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    // Amendment avec supplement — snapshotAfter cohérent avec le solde comptable :
    // grossCollected(15000) - successfulRefunded(3000) - settledOffPlatform(300) - refundStillOwed(500) = 11200
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      type: 'SUPPLEMENT',
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 11200, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    const apId = await seedAmendmentPayment(rawSql, ids, bookingIds.bookingId, amendmentId, {
      status: 'SUCCEEDED',
      amountMinor: 5000,
    });
    // Refunds variés
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 2000,
    });
    await seedRefund(rawSql, ids, {
      amendmentPaymentId: apId,
      status: 'SUCCEEDED',
      amountMinor: 1000,
    });
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'PENDING',
      amountMinor: 500,
    });
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SETTLED_OFF_PLATFORM',
      amountMinor: 300,
      settledOffPlatformAt: '2026-01-02 10:00:00+00',
      settledOffPlatformBy: ids.userId,
      settlementNotes: 'Résolution manuelle',
    });

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);
    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    const f = result.booking.financials;
    // grossCollected = 10000 + 5000 = 15000
    expect(f.grossCollectedAmountMinor).toBe(15000);
    // successfulRefunded = 2000 + 1000 = 3000
    expect(f.successfulRefundedAmountMinor).toBe(3000);
    // refundStillOwed = 500
    expect(f.refundStillOwedAmountMinor).toBe(500);
    // settledOffPlatform = 300
    expect(f.settledOffPlatformAmountMinor).toBe(300);
    // netCollected = 15000 - 3000 = 12000
    expect(f.netCollectedAmountMinor).toBe(12000);
    // contractualTotal = 11200 (dernier APPLIED, cohérent avec le solde comptable)
    expect(f.contractualTotalAmountMinor).toBe(11200);
    // Invariant ADR-023 §11.2 (obligatoire) :
    // grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = contractualTotal
    const accountingBalance =
      f.grossCollectedAmountMinor -
      f.successfulRefundedAmountMinor -
      f.settledOffPlatformAmountMinor -
      f.refundStillOwedAmountMinor;
    expect(accountingBalance).toBe(f.contractualTotalAmountMinor);
    expect(accountingBalance).toBe(11200);
  });

  it('31. appel réel depuis une transaction', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);

    // Appeler getEffectiveBooking depuis l'intérieur d'une transaction
    const result = await db.transaction(async (tx) => {
      return getEffectiveBooking(tx, ids.orgId, bookingIds.bookingId);
    });

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.booking.id).toBe(bookingIds.bookingId);
    expect(result.booking.financials.grossCollectedAmountMinor).toBe(10000);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tests logicalLineId sur allocations (G7M-B1 corrections)
  // ─────────────────────────────────────────────────────────────────────────────

  it('32. logicalLineId original — allocation liée à la bonne ligne originale', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.booking.allocations).toHaveLength(1);
    // Pour une projection originale, logicalLineId = booking_line_id
    expect(result.booking.allocations[0]!.logicalLineId).toBe(bookingIds.lineId);
    // Vérifier que la ligne et l'allocation partagent le même logicalLineId
    expect(result.booking.lines[0]!.logicalLineId).toBe(bookingIds.lineId);
    expect(result.booking.allocations[0]!.logicalLineId).toBe(
      result.booking.lines[0]!.logicalLineId,
    );
  });

  it('33. logicalLineId amendé — allocation liée à la bonne ligne logique', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const logicalLineIdA = bookingIds.lineId; // ligne originale
    const logicalLineIdB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // nouvelle ligne logique
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    // Ligne UNCHANGED sur la ligne originale
    const lineAId = await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'UNCHANGED',
      logicalLineId: logicalLineIdA,
    });
    // Ligne ADD avec un nouveau logicalLineId
    const variant2 = await rawSql`
      INSERT INTO "product_variants" ("product_id", "name")
      VALUES ((SELECT "product_id" FROM "product_variants" WHERE "id" = ${ids.variantId}), 'Premium')
      RETURNING "id"
    `.then((r) => r[0]!);
    const lineBId = await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, {
      action: 'ADD',
      originType: 'AMENDMENT',
      logicalLineId: logicalLineIdB,
      sourceBookingLineId: null,
      variantId: variant2.id,
    });
    // Allocation CONVERTED sur la ligne A
    await seedAmendmentAllocation(rawSql, ids, amendmentId, lineAId, bookingIds, {
      status: 'CONVERTED',
      action: 'RETAIN',
    });
    // Allocation CONVERTED sur la ligne B (ADD) — nécessite un nouveau block
    // Libérer l'ancien block déjà libéré par la première allocation CONVERTED
    // Créer un deuxième item pour éviter le chevauchement
    const item2 = await rawSql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${ids.orgId}, ${variant2.id}, ${'KAY2-' + Math.random().toString(36).slice(2)}, ${ids.locationId})
      RETURNING "id"
    `.then((r) => r[0]!);
    const block2 = await rawSql`
      INSERT INTO "inventory_blocks" ("organization_id", "inventory_item_id", "type", "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "source_id")
      VALUES (${ids.orgId}, ${item2.id}, 'BOOKING', 'ACTIVE', '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00', '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${bookingIds.bookingId})
      RETURNING "id"
    `.then((r) => r[0]!);
    // INSERT allocation en PROPOSED puis UPDATE vers CONVERTED avec le block2
    const allocB = await rawSql`
      INSERT INTO "booking_amendment_allocations" (
        "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id",
        "action", "source_booking_block_id", "applied_booking_block_id", "status",
        "effective_customer_start_at", "effective_customer_end_at",
        "effective_blocked_start_at", "effective_blocked_end_at"
      )
      VALUES (
        ${amendmentId}, ${lineBId}, ${ids.orgId}, ${item2.id},
        'ADD', ${null}, ${null}, 'PROPOSED',
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`UPDATE "booking_amendment_allocations" SET "status" = 'CONVERTED', "applied_booking_block_id" = ${block2.id} WHERE "id" = ${allocB.id}`;

    const result = await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);

    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    // Deux lignes, deux allocations
    expect(result.booking.lines).toHaveLength(2);
    expect(result.booking.allocations).toHaveLength(2);
    // Les allocations sont ordonnées par logicalLineId
    const allocs = result.booking.allocations;
    // Vérifier que chaque allocation est liée à la bonne ligne logique
    const allocA = allocs.find((a) => a.logicalLineId === logicalLineIdA);
    const allocB2 = allocs.find((a) => a.logicalLineId === logicalLineIdB);
    expect(allocA).toBeDefined();
    expect(allocB2).toBeDefined();
    expect(allocA!.action).toBe('RETAIN');
    expect(allocB2!.action).toBe('ADD');
    // Vérifier que les lignes et allocations ne sont pas mélangées
    const lineA = result.booking.lines.find((l) => l.logicalLineId === logicalLineIdA);
    const lineB = result.booking.lines.find((l) => l.logicalLineId === logicalLineIdB);
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    expect(lineA!.action).toBe('UNCHANGED');
    expect(lineB!.action).toBe('ADD');
    // Les logicalLineId correspondent
    expect(allocA!.logicalLineId).toBe(lineA!.logicalLineId);
    expect(allocB2!.logicalLineId).toBe(lineB!.logicalLineId);
  });

  it('34. invariant financier violé → rejet FINANCIAL_INVARIANT_VIOLATION', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(rawSql);
    const bookingIds = await seedBookingWithItem(rawSql, ids);
    const paymentRow =
      await rawSql`SELECT "payment_id" FROM "bookings" WHERE "id" = ${bookingIds.bookingId}`.then(
        (r) => r[0]!,
      );
    // Booking avec paiement initial 10000, amendment APPLIED avec snapshotAfter totalAmountMinor=10000.
    // Mais un refund SUCCEEDED de 2000 sur le payment initial crée une incohérence :
    // solde = 10000 - 2000 - 0 - 0 = 8000 ≠ 10000 = contractualTotal.
    const amendmentId = await seedAmendment(rawSql, ids, bookingIds, {
      status: 'APPLIED',
      snapshotAfter: { totalAmountMinor: 10000, currency: 'EUR' },
    });
    await seedAmendmentLine(rawSql, ids, amendmentId, bookingIds, { action: 'UNCHANGED' });
    await seedRefund(rawSql, ids, {
      paymentId: paymentRow.payment_id,
      status: 'SUCCEEDED',
      amountMinor: 2000,
    });

    await expect(getEffectiveBooking(db, ids.orgId, bookingIds.bookingId)).rejects.toThrow(
      EffectiveBookingError,
    );
    await expect(getEffectiveBooking(db, ids.orgId, bookingIds.bookingId)).rejects.toThrow(
      /FINANCIAL_INVARIANT_VIOLATION|Invariant financier violé/,
    );
    // Vérifier le code exact
    try {
      await getEffectiveBooking(db, ids.orgId, bookingIds.bookingId);
      throw new Error('devrait avoir levé');
    } catch (e) {
      expect(e).toBeInstanceOf(EffectiveBookingError);
      expect((e as EffectiveBookingError).code).toBe('FINANCIAL_INVARIANT_VIOLATION');
    }
  });
});
