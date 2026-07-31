import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 5 (ADR-010).
 *
 * Vérifie les contraintes CHECK, UNIQUE, les triggers multi-tenant,
 * les valeurs par défaut et la migration idempotente des tables
 * organization_payment_accounts, payments, payment_attempts,
 * payment_webhook_events, bookings, booking_lines, booking_items,
 * outbox_events et refunds.
 *
 * Reprend la stratégie de setup de schema-lot4.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot5';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 5.');
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
      ${p.succeeded_at ?? null}
    )
    RETURNING "id"
  `;
}

interface AttemptPayload {
  attempt_number: number;
  status: string;
  provider_idempotency_key: string;
  provider_status: string | null;
  provider_payment_intent_id?: string | null;
}

function validAttemptPayload(overrides: Partial<AttemptPayload> = {}): AttemptPayload {
  return {
    attempt_number: 1,
    status: 'PENDING_PROVIDER',
    provider_idempotency_key: 'idem-' + Math.random().toString(36).slice(2, 12),
    provider_status: 'requires_payment_method',
    provider_payment_intent_id: null,
    ...overrides,
  };
}

async function insertAttempt(
  sql: postgres.Sql,
  ids: BaseIds,
  paymentId: string,
  p: AttemptPayload,
) {
  return sql`
    INSERT INTO "payment_attempts" (
      "organization_id", "payment_id", "attempt_number", "status",
      "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
    )
    VALUES (
      ${ids.orgId}, ${paymentId}, ${p.attempt_number}, ${p.status},
      ${p.provider_payment_intent_id ?? null}, ${p.provider_idempotency_key}, ${p.provider_status}
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
  const holdBlock = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
    )
    VALUES (
      ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
    VALUES (${line.id}, ${holdBlock.id})
  `;
  return { draftId: draft.id, lineId: line.id, holdBlockId: holdBlock.id };
}

describe.skipIf(shouldSkipIntegrationTests())('Schéma Lot 5 — contraintes PostgreSQL', () => {
  // -------------------------------------------------------------------------
  // 1. Migration from scratch — toutes les tables Lot 5 existent
  // -------------------------------------------------------------------------
  it('crée les 9 tables Lot 5 et __drizzle_migrations a 20 entrées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const lot5Tables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'organization_payment_accounts', 'payments', 'payment_attempts',
          'payment_webhook_events', 'bookings', 'booking_lines', 'booking_items',
          'outbox_events', 'refunds'
        )
        ORDER BY tablename
      `;
      expect(lot5Tables.length).toBe(9);

      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(20);
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
      expect(rows.length).toBe(20);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 3. CHECK constraints — payments
  // -------------------------------------------------------------------------
  it('rejette un paiement avec amount_minor négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(sql, ids, draftId, validPaymentPayload({ amount_minor: -1 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec amount_minor > MAX_SAFE_INTEGER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(sql, ids, draftId, validPaymentPayload({ amount_minor: 9007199254740992 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un paiement avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(sql, ids, draftId, validPaymentPayload({ currency: 'USD' })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement avec commission > amount', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(sql, ids, draftId, validPaymentPayload({ commission_amount_minor: 20000 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un paiement avec tax_status = 'UNDETERMINED'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(
          sql,
          ids,
          draftId,
          validPaymentPayload({ tax_status: 'UNDETERMINED', tax_amount_minor: null }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un paiement avec charge_model != 'DESTINATION'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        sql`
          INSERT INTO "payments" (
            "organization_id", "draft_id", "customer_user_id",
            "status", "amount_minor", "currency",
            "tax_status", "tax_amount_minor",
            "commission_amount_minor",
            "financial_terms_version", "legal_terms_version",
            "terms_acceptance_snapshot",
            "connected_account_id",
            "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${draftId}, ${ids.userId},
            'PENDING_PROVIDER', 10000, 'EUR',
            'NOT_APPLICABLE', 0,
            500,
            '1', '1',
            ${sql.json({ version: '1' })},
            'acct_test',
            'DIRECT', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un paiement SUCCEEDED sans succeeded_at', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(
          sql,
          ids,
          draftId,
          validPaymentPayload({ status: 'SUCCEEDED', succeeded_at: null }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 4. CHECK constraints — payment_attempts
  // -------------------------------------------------------------------------
  it('rejette une tentative avec attempt_number = 0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertAttempt(sql, ids, payment.id, validAttemptPayload({ attempt_number: 0 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une tentative avec provider_idempotency_key vide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertAttempt(
          sql,
          ids,
          payment.id,
          validAttemptPayload({ provider_idempotency_key: '   ' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 5. CHECK constraints — payment_webhook_events
  // -------------------------------------------------------------------------
  it('rejette un webhook avec payload_sha256 invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "payment_webhook_events" (
            "organization_id", "provider", "environment",
            "provider_event_id", "provider_event_created_at",
            "event_type", "provider_object_id", "api_version",
            "payload_sha256", "normalized_payload"
          )
          VALUES (
            ${ids.orgId}, 'STRIPE', 'TEST',
            'evt_001', 1700000000,
            'payment_intent.succeeded', 'pi_test', '2024-01-01',
            'not-a-hash', ${sql.json({ type: 'payment_intent.succeeded' })}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un webhook avec provider != 'STRIPE'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "payment_webhook_events" (
            "organization_id", "provider", "environment",
            "provider_event_id", "provider_event_created_at",
            "event_type", "provider_object_id", "api_version",
            "payload_sha256", "normalized_payload"
          )
          VALUES (
            ${ids.orgId}, 'PAYPAL', 'TEST',
            'evt_002', 1700000000,
            'payment_intent.succeeded', 'pi_test', '2024-01-01',
            ${'a'.repeat(64)}, ${sql.json({ type: 'payment_intent.succeeded' })}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 6. CHECK constraints — bookings
  // -------------------------------------------------------------------------
  it('rejette une réservation avec total_amount_minor négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertBooking(
          sql,
          ids,
          draftId,
          payment.id,
          validBookingPayload({
            total_amount_minor: -1,
            subtotal_amount_minor: -1,
            mandatory_fees_amount_minor: 0,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une réservation avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertBooking(sql, ids, draftId, payment.id, validBookingPayload({ currency: 'USD' })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une réservation avec tax_status = 'UNDETERMINED'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertBooking(
          sql,
          ids,
          draftId,
          payment.id,
          validBookingPayload({ tax_status: 'UNDETERMINED', tax_amount_minor: null }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation où total != subtotal + mandatory_fees', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertBooking(
          sql,
          ids,
          draftId,
          payment.id,
          validBookingPayload({
            subtotal_amount_minor: 10000,
            mandatory_fees_amount_minor: 500,
            total_amount_minor: 10000,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation avec commission > total', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertBooking(
          sql,
          ids,
          draftId,
          payment.id,
          validBookingPayload({ commission_amount_minor: 20000 }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 7. CHECK constraints — booking_lines
  // -------------------------------------------------------------------------
  it('rejette une ligne de réservation avec quantity = 0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${booking.id}, ${ids.variantId}, 0, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne de réservation avec prix négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${booking.id}, ${ids.variantId}, 1, -1, 2, 10000, ${sql.json({ name: 'Standard' })})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une ligne de réservation avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "currency", "variant_snapshot"
          )
          VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, 'USD', ${sql.json({ name: 'Standard' })})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 8. CHECK constraints — refunds
  // -------------------------------------------------------------------------
  it('rejette un remboursement avec amount_minor négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', -1, 'EUR',
            ${'refund-' + Math.random().toString(36).slice(2, 12)}, now()
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un remboursement avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'USD',
            ${'refund-' + Math.random().toString(36).slice(2, 12)}, now()
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 9. CHECK constraints — outbox_events
  // -------------------------------------------------------------------------
  it('rejette un outbox_event avec attempt_count négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "outbox_events" (
            "organization_id", "aggregate_type", "aggregate_id",
            "event_type", "event_version", "payload",
            "attempt_count", "available_at", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, 'booking', ${sql`gen_random_uuid()`},
            'BOOKING_CONFIRMED', '1', ${sql.json({ booking_id: 'test' })},
            -1, now(), ${'outbox-' + Math.random().toString(36).slice(2, 12)}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un outbox_event avec idempotency_key vide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "outbox_events" (
            "organization_id", "aggregate_type", "aggregate_id",
            "event_type", "event_version", "payload",
            "available_at", "idempotency_key"
          )
          VALUES (
            ${ids.orgId}, 'booking', ${sql`gen_random_uuid()`},
            'BOOKING_CONFIRMED', '1', ${sql.json({ booking_id: 'test' })},
            now(), '   '
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 10. UNIQUE constraints — payments
  // -------------------------------------------------------------------------
  it('rejette deux paiements pour le même draft_id (unique)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await insertPayment(sql, ids, draftId, validPaymentPayload());
      await expect(insertPayment(sql, ids, draftId, validPaymentPayload())).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 11. UNIQUE constraints — payment_attempts
  // -------------------------------------------------------------------------
  it('rejette deux tentatives avec le même (payment_id, attempt_number)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertAttempt(sql, ids, payment.id, validAttemptPayload({ attempt_number: 1 }));
      await expect(
        insertAttempt(sql, ids, payment.id, validAttemptPayload({ attempt_number: 1 })),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux tentatives avec le même provider_payment_intent_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ provider_payment_intent_id: 'pi_test_dup' }),
      );
      await expect(
        insertAttempt(
          sql,
          ids,
          payment.id,
          validAttemptPayload({
            attempt_number: 2,
            provider_payment_intent_id: 'pi_test_dup',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux tentatives avec le même provider_idempotency_key', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const key = 'idem-dup-' + Math.random().toString(36).slice(2, 12);
      await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ provider_idempotency_key: key }),
      );
      await expect(
        insertAttempt(
          sql,
          ids,
          payment.id,
          validAttemptPayload({ attempt_number: 2, provider_idempotency_key: key }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 12. UNIQUE constraints — payment_webhook_events
  // -------------------------------------------------------------------------
  it('rejette deux webhooks avec le même (provider, environment, provider_event_id)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const insertWebhook = () => sql`
        INSERT INTO "payment_webhook_events" (
          "organization_id", "provider", "environment",
          "provider_event_id", "provider_event_created_at",
          "event_type", "provider_object_id", "api_version",
          "payload_sha256", "normalized_payload"
        )
        VALUES (
          ${ids.orgId}, 'STRIPE', 'TEST',
          'evt_dup', 1700000000,
          'payment_intent.succeeded', 'pi_test', '2024-01-01',
          ${'a'.repeat(64)}, ${sql.json({ type: 'payment_intent.succeeded' })}
        )
      `;
      await insertWebhook();
      await expect(insertWebhook()).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 13. UNIQUE constraints — bookings
  // -------------------------------------------------------------------------
  it('rejette deux réservations pour le même draft_id (unique)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertBooking(sql, ids, draftId, payment.id, validBookingPayload());
      await expect(
        insertBooking(sql, ids, draftId, payment.id, validBookingPayload()),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux réservations pour le même payment_id (unique)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée deux brouillons distincts pour avoir deux draft_id différents
      const { draftId: draftId1 } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId1, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertBooking(sql, ids, draftId1, payment.id, validBookingPayload());
      // Crée un second brouillon pour le second booking
      const draft2 = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft2.id}`;
      await expect(
        insertBooking(sql, ids, draft2.id, payment.id, validBookingPayload()),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 14. UNIQUE constraints — booking_lines
  // -------------------------------------------------------------------------
  it('rejette deux lignes avec le même (booking_id, variant_id)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
      `;
      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 15. UNIQUE constraints — booking_items
  // -------------------------------------------------------------------------
  it('rejette deux booking_items avec le même (booking_id, inventory_item_id)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids);
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
      // Convertit le hold block en CONVERTED pour éviter le conflit d'exclusion.
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
      await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlockId}, ${bookingBlock.id})
      `;
      // Second booking_item avec le même (booking_id, inventory_item_id) mais un autre bloc
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-2-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      const bookingBlock2 = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${item2.id}, 'BOOKING', 'ACTIVE',
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "booking_items" (
            "booking_id", "booking_line_id", "inventory_item_id",
            "booking_block_id"
          )
          VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${bookingBlock2.id})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux booking_items avec le même source_hold_block_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids);
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
      // Convertit le hold block en CONVERTED pour éviter le conflit d'exclusion.
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
      await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${holdBlockId}, ${bookingBlock.id})
      `;
      // Crée un second item pour un autre exemplaire
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-2-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      const bookingBlock2 = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${item2.id}, 'BOOKING', 'ACTIVE',
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "booking_items" (
            "booking_id", "booking_line_id", "inventory_item_id",
            "source_hold_block_id", "booking_block_id"
          )
          VALUES (${booking.id}, ${line.id}, ${item2.id}, ${holdBlockId}, ${bookingBlock2.id})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux booking_items avec le même booking_block_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      // Le hold block de seedHeldDraftWithLine utilise les dates 2026-02-10 à 2026-02-12.
      // On crée le booking block sur des dates différentes (avril) pour éviter le
      // conflit avec l'exclusion constraint no_overlapping_blocks.
      const bookingBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
          '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${bookingBlock.id})
      `;
      // Crée un second item pour un autre exemplaire
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-3-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "booking_items" (
            "booking_id", "booking_line_id", "inventory_item_id",
            "booking_block_id"
          )
          VALUES (${booking.id}, ${line.id}, ${item2.id}, ${bookingBlock.id})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte un booking_item avec source_hold_block_id NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      const bookingBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
          '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const inserted = await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${ids.itemId}, null, ${bookingBlock.id})
        RETURNING "id"
      `;
      expect(inserted).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it('accepte deux booking_items avec source_hold_block_id NULL (partial unique index)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      // Premier booking_item avec source_hold_block_id NULL
      const bookingBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
          '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const first = await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${ids.itemId}, null, ${bookingBlock.id})
        RETURNING "id"
      `;
      expect(first).toHaveLength(1);
      // Second booking_item avec source_hold_block_id NULL pour un autre exemplaire
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'KAY-4-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      const bookingBlock2 = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${item2.id}, 'BOOKING', 'ACTIVE',
          '2026-05-10 09:00:00+00', '2026-05-12 17:00:00+00',
          '2026-05-10 08:30:00+00', '2026-05-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const second = await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${line.id}, ${item2.id}, null, ${bookingBlock2.id})
        RETURNING "id"
      `;
      expect(second).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 16. UNIQUE constraints — outbox_events
  // -------------------------------------------------------------------------
  it('rejette deux outbox_events avec le même idempotency_key', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const key = 'outbox-dup-' + Math.random().toString(36).slice(2, 12);
      const insertOutbox = () => sql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id",
          "event_type", "event_version", "payload",
          "available_at", "idempotency_key"
        )
        VALUES (
          ${ids.orgId}, 'booking', ${sql`gen_random_uuid()`},
          'BOOKING_CONFIRMED', '1', ${sql.json({ booking_id: 'test' })},
          now(), ${key}
        )
      `;
      await insertOutbox();
      await expect(insertOutbox()).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 17. UNIQUE constraints — refunds
  // -------------------------------------------------------------------------
  it('rejette deux remboursements avec le même (payment_id, reason)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      const insertRefund = (key: string) => sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "amount_minor", "currency",
          "provider_idempotency_key", "requested_at"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
          ${key}, now()
        )
      `;
      await insertRefund('refund-1-' + Math.random().toString(36).slice(2, 12));
      await expect(
        insertRefund('refund-2-' + Math.random().toString(36).slice(2, 12)),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux remboursements avec le même provider_refund_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId: draftId1 } = await seedHeldDraftWithLine(sql, ids);
      const payment1 = await insertPayment(
        sql,
        ids,
        draftId1,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "amount_minor", "currency",
          "provider_refund_id", "provider_idempotency_key", "requested_at"
        )
        VALUES (
          ${ids.orgId}, ${payment1.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
          're_dup', ${'refund-1-' + Math.random().toString(36).slice(2, 12)}, now()
        )
      `;
      // Crée un second paiement pour un autre draft
      const draft2 = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft2.id}`;
      const payment2 = await insertPayment(
        sql,
        ids,
        draft2.id,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_refund_id", "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${ids.orgId}, ${payment2.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
            're_dup', ${'refund-2-' + Math.random().toString(36).slice(2, 12)}, now()
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux remboursements avec le même provider_idempotency_key', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId: draftId1 } = await seedHeldDraftWithLine(sql, ids);
      const payment1 = await insertPayment(
        sql,
        ids,
        draftId1,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      const key = 'idem-refund-' + Math.random().toString(36).slice(2, 12);
      await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "amount_minor", "currency",
          "provider_idempotency_key", "requested_at"
        )
        VALUES (
          ${ids.orgId}, ${payment1.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
          ${key}, now()
        )
      `;
      // Crée un second paiement pour un autre draft
      const draft2 = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft2.id}`;
      const payment2 = await insertPayment(
        sql,
        ids,
        draft2.id,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${ids.orgId}, ${payment2.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
            ${key}, now()
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 18. UNIQUE constraints — organization_payment_accounts
  // -------------------------------------------------------------------------
  it('rejette deux comptes avec le même (organization_id, provider, environment)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const insertAccount = () => sql`
        INSERT INTO "organization_payment_accounts" (
          "organization_id", "provider", "environment",
          "provider_account_id", "account_api_generation", "onboarding_status",
          "transfers_capability_status", "settlement_merchant_mode",
          "controller_configuration_snapshot", "requirements_snapshot"
        )
        VALUES (
          ${ids.orgId}, 'STRIPE', 'TEST',
          ${'acct_' + Math.random().toString(36).slice(2, 12)}, 'ACCOUNTS_V2', 'PENDING',
          'PENDING', 'CONNECTED_ACCOUNT',
          ${sql.json({ fees_collector: 'PLATFORM' })}, ${sql.json({ currently_due: [] })}
        )
      `;
      await insertAccount();
      await expect(insertAccount()).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux comptes avec le même (provider, environment, provider_account_id)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const acctId = 'acct_shared_' + Math.random().toString(36).slice(2, 12);
      const insertAccount = (orgId: string) => sql`
        INSERT INTO "organization_payment_accounts" (
          "organization_id", "provider", "environment",
          "provider_account_id", "account_api_generation", "onboarding_status",
          "transfers_capability_status", "settlement_merchant_mode",
          "controller_configuration_snapshot", "requirements_snapshot"
        )
        VALUES (
          ${orgId}, 'STRIPE', 'TEST',
          ${acctId}, 'ACCOUNTS_V2', 'PENDING',
          'PENDING', 'CONNECTED_ACCOUNT',
          ${sql.json({ fees_collector: 'PLATFORM' })}, ${sql.json({ currently_due: [] })}
        )
      `;
      await insertAccount(ids.orgId);
      await expect(insertAccount(orgB.id)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 19. Multi-tenant isolation — triggers
  // -------------------------------------------------------------------------
  it('rejette un paiement dont organization_id != draft.organization_id (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      // Crée une seconde organisation
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-pay-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "payments" (
            "organization_id", "draft_id", "customer_user_id",
            "status", "amount_minor", "currency",
            "tax_status", "tax_amount_minor",
            "commission_amount_minor",
            "financial_terms_version", "legal_terms_version",
            "terms_acceptance_snapshot",
            "connected_account_id",
            "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${orgB.id}, ${draftId}, ${ids.userId},
            'PENDING_PROVIDER', 10000, 'EUR',
            'NOT_APPLICABLE', 0,
            500,
            '1', '1',
            ${sql.json({ version: '1' })},
            'acct_test',
            'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une tentative dont organization_id != payment.organization_id (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-attempt-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "payment_attempts" (
            "organization_id", "payment_id", "attempt_number", "status",
            "provider_idempotency_key", "provider_status"
          )
          VALUES (
            ${orgB.id}, ${payment.id}, 1, 'PENDING_PROVIDER',
            ${'idem-' + Math.random().toString(36).slice(2, 12)}, 'requires_payment_method'
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation dont organization_id != draft.organization_id (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-booking-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const p = validBookingPayload();
      await expect(
        sql`
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
            ${orgB.id}, ${ids.locationId}, ${ids.userId},
            ${draftId}, ${payment.id}, ${p.status},
            ${p.customer_start_at}, ${p.customer_end_at},
            ${p.blocked_start_at}, ${p.blocked_end_at},
            ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
            ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
            ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
            ${p.commission_amount_minor}, ${p.total_amount_minor},
            ${sql.json(p.cancellation_policy_snapshot)}, ${sql.json(p.terms_acceptance_snapshot)},
            ${p.confirmed_at}
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation dont organization_id != payment.organization_id (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-booking2-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un location dans orgB pour pouvoir créer un draft valide dans orgB.
      const locB = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgB.id}, 'Loc B', ${'loc-b-' + suffix}, 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un brouillon valide dans orgB.
      const draftBValid = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot"
        )
        VALUES (
          ${orgB.id}, ${locB.id}, ${ids.userId},
          '2026-03-10 09:00:00+00', '2026-03-12 17:00:00+00',
          '2026-03-10 08:30:00+00', '2026-03-12 17:30:00+00',
          'Europe/Paris', 30, 30,
          10000, 0, 10000,
          'UNDETERMINED', 'DAY', 2,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      // Tente de créer un booking dans orgB avec le draft de orgB mais le payment de orgA.
      // Le trigger before_check_booking_org_consistency doit rejeter car
      // payment.organization_id (orgA) <> booking.organization_id (orgB).
      const p = validBookingPayload();
      await expect(
        sql`
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
            ${orgB.id}, ${locB.id}, ${ids.userId},
            ${draftBValid.id}, ${payment.id}, ${p.status},
            ${p.customer_start_at}, ${p.customer_end_at},
            ${p.blocked_start_at}, ${p.blocked_end_at},
            ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
            ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
            ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
            ${p.commission_amount_minor}, ${p.total_amount_minor},
            ${sql.json(p.cancellation_policy_snapshot)}, ${sql.json(p.terms_acceptance_snapshot)},
            ${p.confirmed_at}
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette un remboursement dont organization_id != payment.organization_id (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-refund-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${orgB.id}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
            ${'refund-' + Math.random().toString(36).slice(2, 12)}, now()
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 20. Cross-relation invalid — booking_line variant from different org
  // -------------------------------------------------------------------------
  it('rejette une ligne de réservation dont la variante appartient à une autre organisation (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      // Crée une variante dans une autre organisation
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-line-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const productB = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgB.id}, ${category.id}, 'Kayak B', ${'kayak-b-line-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const variantB = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${productB.id}, 'Standard B')
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${booking.id}, ${variantB.id}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard B' })})
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette un booking_item dont le booking_block appartient à une autre organisation (trigger)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
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
      // Crée une organisation B avec un exemplaire et un bloc BOOKING
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-item-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const locationB = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgB.id}, 'Annecy B', ${'annecy-b-item-' + suffix}, 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const productB = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgB.id}, ${category.id}, 'Kayak B', ${'kayak-b-item-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const variantB = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${productB.id}, 'Standard B')
        RETURNING "id"
      `.then((r) => r[0]!);
      const itemB = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${orgB.id}, ${variantB.id}, ${'KAY-B-' + suffix}, ${locationB.id})
        RETURNING "id"
      `.then((r) => r[0]!);
      const bookingBlockB = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${orgB.id}, ${itemB.id}, 'BOOKING', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "booking_items" (
            "booking_id", "booking_line_id", "inventory_item_id",
            "booking_block_id"
          )
          VALUES (${booking.id}, ${line.id}, ${ids.itemId}, ${bookingBlockB.id})
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 21. Amounts out of bounds — MAX_SAFE_INTEGER boundary
  // -------------------------------------------------------------------------
  it('rejette un paiement avec commission_amount_minor > MAX_SAFE_INTEGER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        insertPayment(
          sql,
          ids,
          draftId,
          validPaymentPayload({ commission_amount_minor: 9007199254740992 }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un remboursement avec amount_minor > MAX_SAFE_INTEGER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "refunds" (
            "organization_id", "payment_id", "reason", "amount_minor", "currency",
            "provider_idempotency_key", "requested_at"
          )
          VALUES (
            ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 9007199254740992, 'EUR',
            ${'refund-' + Math.random().toString(36).slice(2, 12)}, now()
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 22. Snapshots incomplete — NOT NULL jsonb
  // -------------------------------------------------------------------------
  it('rejette un paiement avec terms_acceptance_snapshot NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      await expect(
        sql`
          INSERT INTO "payments" (
            "organization_id", "draft_id", "customer_user_id",
            "status", "amount_minor", "currency",
            "tax_status", "tax_amount_minor",
            "commission_amount_minor",
            "financial_terms_version", "legal_terms_version",
            "terms_acceptance_snapshot",
            "connected_account_id",
            "charge_model", "settlement_merchant_mode"
          )
          VALUES (
            ${ids.orgId}, ${draftId}, ${ids.userId},
            'PENDING_PROVIDER', 10000, 'EUR',
            'NOT_APPLICABLE', 0,
            500,
            '1', '1',
            NULL,
            'acct_test',
            'DESTINATION', 'CONNECTED_ACCOUNT'
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation avec cancellation_policy_snapshot NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const p = validBookingPayload();
      await expect(
        sql`
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
            ${draftId}, ${payment.id}, ${p.status},
            ${p.customer_start_at}, ${p.customer_end_at},
            ${p.blocked_start_at}, ${p.blocked_end_at},
            ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
            ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
            ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
            ${p.commission_amount_minor}, ${p.total_amount_minor},
            NULL, ${sql.json(p.terms_acceptance_snapshot)},
            ${p.confirmed_at}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette une réservation avec terms_acceptance_snapshot NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const p = validBookingPayload();
      await expect(
        sql`
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
            ${draftId}, ${payment.id}, ${p.status},
            ${p.customer_start_at}, ${p.customer_end_at},
            ${p.blocked_start_at}, ${p.blocked_end_at},
            ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
            ${p.currency}, ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor},
            ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps},
            ${p.commission_amount_minor}, ${p.total_amount_minor},
            ${sql.json(p.cancellation_policy_snapshot)}, NULL,
            ${p.confirmed_at}
          )
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 23. Valid insert — end-to-end happy path
  // -------------------------------------------------------------------------
  it('accepte un paiement, une tentative, une réservation, une ligne et un outbox valides', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId, holdBlockId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      expect(payment).toBeDefined();

      const attempt = await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ provider_payment_intent_id: 'pi_valid_001' }),
      ).then((r) => r[0]!);
      expect(attempt).toBeDefined();

      // Marque le paiement comme SUCCEEDED pour la confirmation
      await sql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${payment.id}`;
      await sql`UPDATE "payment_attempts" SET "status" = 'SUCCEEDED' WHERE "id" = ${attempt.id}`;
      await sql`UPDATE "booking_drafts" SET "status" = 'CONVERTED' WHERE "id" = ${draftId}`;
      await sql`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${holdBlockId}`;
      await sql`UPDATE "allocations" SET "status" = 'CONVERTED' WHERE "inventory_block_id" = ${holdBlockId}`;

      const booking = await insertBooking(
        sql,
        ids,
        draftId,
        payment.id,
        validBookingPayload(),
      ).then((r) => r[0]!);
      expect(booking).toBeDefined();

      const line = await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(line).toBeDefined();

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
      expect(bookingItem).toBeDefined();

      const outbox = await sql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id",
          "event_type", "event_version", "payload",
          "available_at", "idempotency_key"
        )
        VALUES (
          ${ids.orgId}, 'booking', ${booking.id},
          'BOOKING_CONFIRMED', '1', ${sql.json({ booking_id: booking.id })},
          now(), ${'outbox-valid-' + Math.random().toString(36).slice(2, 12)}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(outbox).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 24. Valid webhook insert
  // -------------------------------------------------------------------------
  it('accepte un webhook valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const webhook = await sql`
        INSERT INTO "payment_webhook_events" (
          "organization_id", "provider", "environment",
          "provider_event_id", "provider_event_created_at",
          "event_type", "provider_object_id", "api_version",
          "payload_sha256", "normalized_payload"
        )
        VALUES (
          ${ids.orgId}, 'STRIPE', 'TEST',
          'evt_valid_001', 1700000000,
          'payment_intent.succeeded', 'pi_test', '2024-01-01',
          ${'b'.repeat(64)}, ${sql.json({ type: 'payment_intent.succeeded' })}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(webhook).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 25. Valid organization_payment_account insert
  // -------------------------------------------------------------------------
  it('accepte un compte de paiement organisation valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const account = await sql`
        INSERT INTO "organization_payment_accounts" (
          "organization_id", "provider", "environment",
          "provider_account_id", "account_api_generation", "onboarding_status",
          "transfers_capability_status", "settlement_merchant_mode",
          "controller_configuration_snapshot", "requirements_snapshot"
        )
        VALUES (
          ${ids.orgId}, 'STRIPE', 'TEST',
          ${'acct_valid_' + Math.random().toString(36).slice(2, 12)}, 'ACCOUNTS_V2', 'PENDING',
          'PENDING', 'CONNECTED_ACCOUNT',
          ${sql.json({ fees_collector: 'PLATFORM' })}, ${sql.json({ currently_due: [] })}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(account).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 26. Valid refund insert
  // -------------------------------------------------------------------------
  it('accepte un remboursement valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(
        sql,
        ids,
        draftId,
        validPaymentPayload({
          status: 'SUCCEEDED',
          amount_minor: 10000,
          succeeded_at: '2026-01-01 12:00:00+00',
        }),
      ).then((r) => r[0]!);
      const refund = await sql`
        INSERT INTO "refunds" (
          "organization_id", "payment_id", "reason", "amount_minor", "currency",
          "provider_idempotency_key", "requested_at"
        )
        VALUES (
          ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING', 10000, 'EUR',
          ${'refund-valid-' + Math.random().toString(36).slice(2, 12)}, now()
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(refund).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 27. provider_status nullable avant l'appel fournisseur (migration 0020)
  // -------------------------------------------------------------------------
  it('accepte une tentative avec provider_status = NULL et provider_payment_intent_id = NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      const attempt = await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ provider_status: null, provider_payment_intent_id: null }),
      ).then((r) => r[0]!);
      expect(attempt).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 28. provider_status requis quand provider_payment_intent_id est renseigné
  // -------------------------------------------------------------------------
  it('rejette une tentative avec provider_payment_intent_id renseigné mais provider_status = NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await expect(
        insertAttempt(
          sql,
          ids,
          payment.id,
          validAttemptPayload({
            provider_payment_intent_id: 'pi_test_null_status',
            provider_status: null,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 29. Une seule tentative non terminale par paiement (index unique partiel)
  // -------------------------------------------------------------------------
  it('rejette deux tentatives non terminales pour le même payment_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ attempt_number: 1, status: 'PENDING_PROVIDER' }),
      );
      await expect(
        insertAttempt(
          sql,
          ids,
          payment.id,
          validAttemptPayload({ attempt_number: 2, status: 'REQUIRES_ACTION' }),
        ),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 30. Tentative terminale autorisée à côté d'une tentative non terminale
  // -------------------------------------------------------------------------
  it("accepte une tentative SUCCEEDED à côté d'une tentative PENDING_PROVIDER pour le même payment_id", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { draftId } = await seedHeldDraftWithLine(sql, ids);
      const payment = await insertPayment(sql, ids, draftId, validPaymentPayload()).then(
        (r) => r[0]!,
      );
      await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ attempt_number: 1, status: 'SUCCEEDED' }),
      );
      const second = await insertAttempt(
        sql,
        ids,
        payment.id,
        validAttemptPayload({ attempt_number: 2, status: 'PENDING_PROVIDER' }),
      ).then((r) => r[0]!);
      expect(second).toBeDefined();
    } finally {
      await sql.end();
    }
  });
});
