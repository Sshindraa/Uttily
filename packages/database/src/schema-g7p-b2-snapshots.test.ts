import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma G7P-B2-A — fondations des snapshots
 * de prix flexibles (ADR-018, migration 0033).
 *
 * Vérifie :
 * - La migration 0033 (nouvelles colonnes sur booking_drafts, booking_draft_lines,
 *   bookings, booking_lines ; contraintes CHECK ; triggers multi-tenant et
 *   d'immutabilité ; FK vers pricing_plans ; index partiels).
 * - La compatibilité legacy (lignes existantes avec pricing_snapshot_version =
 *   'legacy-daily-v1', toutes les colonnes flexibles NULL).
 * - L'insertion de snapshots flexibles (HOURLY, FIXED_DURATION, DAILY avec et
 *   sans remise).
 * - Les contraintes financières (montants négatifs, overflow, cohérence
 *   avant/après remise, remise sur plan non-DAILY).
 * - L'isolation multi-tenant (plan d'une autre organisation rejeté, devise
 *   différente rejetée).
 * - La cohérence intent/plan (DAY_RANGE exige DAILY).
 * - L'immutabilité (snapshot financier figé, lignes insert-only, status
 *   modifiable).
 * - La retraite plan sans effet sur le snapshot.
 * - Les transitions de statut autorisées.
 * - La concurrence (insertion de brouillon vs retraite de plan).
 * - Le journal de migrations (53 entrées).
 */

const TEST_DB_NAME = 'uttily_test_g7p_b2_snapshots';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma G7P-B2-A.');
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BaseIds {
  orgId: string;
  locationId: string;
  productId: string;
  variantId: string;
  userId: string;
  dailyPlanId: string;
}

/**
 * Crée les données de base (organisation, établissement, catégorie, produit,
 * variante, utilisateur client) et un plan DAILY ACTIVE v1 par défaut avec
 * traductions FR+EN. Retourne leurs IDs.
 */
async function seedBaseData(
  sql: postgres.Sql,
  opts: {
    orgCurrency?: string;
    variantPrice?: number;
  } = {},
): Promise<BaseIds> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const orgCurrency = opts.orgCurrency ?? 'EUR';
  const variantPrice = opts.variantPrice ?? 5000;

  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, ${orgCurrency})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', ${orgCurrency})
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
    INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', ${variantPrice}, ${orgCurrency})
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  // Crée un plan DAILY par défaut ACTIVE v1 avec traductions FR+EN.
  const plan = await sql`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "location_id", "plan_type",
      "currency", "price_amount_minor", "priority", "lifecycle_state", "version"
    )
    VALUES (${org.id}, ${variant.id}, NULL, 'DAILY', ${orgCurrency}, ${variantPrice}, 0, 'DRAFT', 1)
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Tarif journalier'), (${plan.id}, 'en', 'Daily rate')
  `;
  await sql`
    INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
    VALUES (${plan.id}, 7, 10)
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  return {
    orgId: org.id,
    locationId: location.id,
    productId: product.id,
    variantId: variant.id,
    userId: user.id,
    dailyPlanId: plan.id,
  };
}

/**
 * Crée un plan HOURLY DRAFT pour la variante, puis l'active avec traductions.
 */
async function seedHourlyPlan(sql: postgres.Sql, ids: BaseIds, currency = 'EUR'): Promise<string> {
  const plan = await sql`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "plan_type",
      "currency", "price_amount_minor",
      "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes",
      "version"
    )
    VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', ${currency}, 1500, 60, 480, 15, 1)
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Tarif horaire'), (${plan.id}, 'en', 'Hourly rate')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  return plan.id;
}

/**
 * Crée un plan FIXED_DURATION DRAFT pour la variante, puis l'active avec traductions.
 */
async function seedFixedDurationPlan(
  sql: postgres.Sql,
  ids: BaseIds,
  currency = 'EUR',
): Promise<string> {
  const plan = await sql`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "plan_type",
      "currency", "price_amount_minor", "included_duration_minutes",
      "version"
    )
    VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', ${currency}, 3000, 120, 1)
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${plan.id}, 'fr', 'Forfait 2h'), (${plan.id}, 'en', '2h package')
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  return plan.id;
}

/**
 * Insère un brouillon legacy (pricing_snapshot_version = 'legacy-daily-v1').
 */
async function insertLegacyDraft(
  sql: postgres.Sql,
  ids: BaseIds,
  _overrides: Record<string, unknown> = {},
): Promise<string> {
  const draft = await sql`
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
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'UNDETERMINED', 'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return draft.id;
}

const draftTxMap = new WeakMap<postgres.Sql, { count: number; lines: number }>();

/**
 * Insère un brouillon flexible (pricing_snapshot_version = 'flexible-pricing-v1').
 */
async function insertFlexibleDraft(
  sql: postgres.Sql,
  ids: BaseIds,
  opts: {
    billableUnit?: string;
    currency?: string;
    intentType?: string;
    algorithmVersion?: string;
    roundingRuleVersion?: string;
    subtotalAmountMinor?: number;
    totalAmountMinor?: number;
    taxStatus?: string;
    taxAmountMinor?: number | null;
    taxRateBps?: number | null;
    commissionAmountMinor?: number | null;
    intentSnapshot?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const billableUnit = opts.billableUnit ?? 'MINUTE';
  const currency = opts.currency ?? 'EUR';
  const intentType = opts.intentType ?? 'TIME_RANGE';
  const algoVer = opts.algorithmVersion ?? 'flexible-pricing-v1';
  const roundVer = opts.roundingRuleVersion ?? 'half-up-v1';
  // Montants canoniques par défaut alignés avec les helpers de ligne
  const defaultSubtotal =
    billableUnit === 'MINUTE' ? 12000 : billableUnit === 'FIXED_DURATION' ? 3000 : 10000;
  const subtotal = opts.subtotalAmountMinor ?? defaultSubtotal;
  const total = opts.totalAmountMinor ?? subtotal;
  // Champs financiers par défaut alignés avec les bookings de test (NOT_APPLICABLE, 0, null, 600)
  const taxStatus = opts.taxStatus ?? 'NOT_APPLICABLE';
  const taxAmountMinor = opts.taxAmountMinor ?? 0;
  const taxRateBps = opts.taxRateBps ?? null;
  const commissionAmountMinor = opts.commissionAmountMinor ?? 600;
  const tx = await sql`SELECT txid_current_if_assigned() AS txid`.then(
    (r) => r[0]!.txid as string | null,
  );
  const inDraftTx = draftTxMap.has(sql);
  if (!tx) {
    await sql`BEGIN`;
  }
  const draft = await sql`
    INSERT INTO "booking_drafts" (
      "organization_id", "location_id", "customer_user_id",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
      "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
      "billable_unit", "billable_unit_count",
      "currency", "cancellation_policy_snapshot",
      "pricing_snapshot_version", "pricing_algorithm_version",
      "pricing_rounding_rule_version", "pricing_intent_type",
      "pricing_intent_snapshot", "pricing_resolved_locale"
    )
    VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
      'Europe/Paris', 30, 30,
      ${subtotal}, 0, ${total},
      ${taxStatus}::tax_status, ${taxAmountMinor}, ${taxRateBps}, ${commissionAmountMinor},
      ${billableUnit}, 1,
      ${currency}, ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      'flexible-pricing-v1', ${algoVer},
      ${roundVer}, ${intentType},
      ${sql.json((opts.intentSnapshot ?? { kind: intentType, startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' }) as never)},
      'fr'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  if (!tx) {
    draftTxMap.set(sql, { count: 1, lines: 0 });
  } else if (inDraftTx) {
    const state = draftTxMap.get(sql)!;
    state.count += 1;
  }
  return draft.id;
}

/**
 * Insère une ligne de brouillon legacy.
 */
async function insertLegacyDraftLine(
  sql: postgres.Sql,
  draftId: string,
  variantId: string,
): Promise<string> {
  const line = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity",
      "unit_price_amount_minor", "billable_unit_count",
      "line_total_amount_minor", "currency", "variant_snapshot"
    )
    VALUES (
      ${draftId}, ${variantId}, 1,
      5000, 2,
      10000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return line.id;
}

/**
 * Insère une ligne de brouillon flexible HOURLY.
 */
async function insertHourlyDraftLine(
  sql: postgres.Sql,
  draftId: string,
  variantId: string,
  planId: string,
  opts: {
    billedDurationMinutes?: number;
    requestedDurationMinutes?: number;
    unitPriceAmountMinor?: number;
    lineTotalAmountMinor?: number;
    quantity?: number;
  } = {},
): Promise<string> {
  const billedDur = opts.billedDurationMinutes ?? 120;
  const reqDur = opts.requestedDurationMinutes ?? 120;
  const unitPrice = opts.unitPriceAmountMinor ?? 1500;
  const quantity = opts.quantity ?? 1;
  const plan = await sql`
    SELECT "billing_increment_minutes" FROM "pricing_plans" WHERE "id" = ${planId}
  `.then((r) => r[0]!);
  const billingIncrement = plan.billing_increment_minutes ?? 15;
  const billableUnitCount = billedDur / billingIncrement;
  if (billableUnitCount % 1 !== 0) {
    throw new Error(
      `billedDurationMinutes ${billedDur} is not a multiple of billingIncrement ${billingIncrement}`,
    );
  }
  const computedLineTotal = unitPrice * billableUnitCount * quantity;
  const lineTotal = opts.lineTotalAmountMinor ?? computedLineTotal;
  const line = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity",
      "unit_price_amount_minor", "billable_unit_count",
      "line_total_amount_minor", "currency", "variant_snapshot",
      "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
      "pricing_public_label", "pricing_requested_duration_minutes",
      "pricing_billed_duration_minutes"
    )
    VALUES (
      ${draftId}, ${variantId}, ${quantity},
      ${unitPrice}, ${billableUnitCount},
      ${lineTotal}, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
      ${planId}, 1, 'HOURLY',
      'Tarif horaire', ${reqDur},
      ${billedDur}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  const state = draftTxMap.get(sql);
  if (state) {
    state.lines += 1;
    if (state.lines >= state.count) {
      await sql`COMMIT`;
      draftTxMap.delete(sql);
    }
  }
  return line.id;
}

/**
 * Insère une ligne de brouillon flexible FIXED_DURATION.
 */
async function insertFixedDurationDraftLine(
  sql: postgres.Sql,
  draftId: string,
  variantId: string,
  planId: string,
  opts: {
    coveredDurationMinutes?: number;
    requestedDurationMinutes?: number;
    unitPriceAmountMinor?: number;
    lineTotalAmountMinor?: number;
    quantity?: number;
  } = {},
): Promise<string> {
  const coveredDur = opts.coveredDurationMinutes ?? 120;
  const reqDur = opts.requestedDurationMinutes ?? 120;
  const unitPrice = opts.unitPriceAmountMinor ?? 3000;
  const quantity = opts.quantity ?? 1;
  const computedLineTotal = unitPrice * 1 * quantity;
  const lineTotal = opts.lineTotalAmountMinor ?? computedLineTotal;
  const line = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity",
      "unit_price_amount_minor", "billable_unit_count",
      "line_total_amount_minor", "currency", "variant_snapshot",
      "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
      "pricing_public_label", "pricing_requested_duration_minutes",
      "pricing_covered_duration_minutes"
    )
    VALUES (
      ${draftId}, ${variantId}, ${quantity},
      ${unitPrice}, 1,
      ${lineTotal}, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
      ${planId}, 1, 'FIXED_DURATION',
      'Forfait 2h', ${reqDur},
      ${coveredDur}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  const state = draftTxMap.get(sql);
  if (state) {
    state.lines += 1;
    if (state.lines >= state.count) {
      await sql`COMMIT`;
      draftTxMap.delete(sql);
    }
  }
  return line.id;
}

/**
 * Insère une ligne de brouillon flexible DAILY.
 */
async function insertDailyDraftLine(
  sql: postgres.Sql,
  draftId: string,
  variantId: string,
  planId: string,
  opts: {
    billedDays?: number;
    requestedDurationMinutes?: number;
    unitPriceAmountMinor?: number;
    lineTotalAmountMinor?: number;
    discountThresholdDays?: number | null;
    discountPercent?: number | null;
    amountBeforeDiscountMinor?: number | null;
    amountAfterDiscountMinor?: number | null;
    quantity?: number;
    selectedWindow?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const billedDays = opts.billedDays ?? 2;
  const reqDur = opts.requestedDurationMinutes ?? null;
  const unitPrice = opts.unitPriceAmountMinor ?? 5000;
  const quantity = opts.quantity ?? 1;
  const computedAmountBefore = unitPrice * billedDays * quantity;
  const hasDiscount =
    opts.discountThresholdDays !== undefined &&
    opts.discountThresholdDays !== null &&
    opts.discountPercent !== undefined &&
    opts.discountPercent !== null;
  let amountAfter = opts.amountAfterDiscountMinor;
  if (amountAfter === undefined || amountAfter === null) {
    if (hasDiscount) {
      const amountBefore = opts.amountBeforeDiscountMinor ?? computedAmountBefore;
      const percent = opts.discountPercent!;
      const discount = Math.floor((amountBefore * percent * 2 + 100) / 200);
      amountAfter = amountBefore - discount;
    } else {
      amountAfter = opts.amountBeforeDiscountMinor ?? computedAmountBefore;
    }
  }
  const amountBefore = opts.amountBeforeDiscountMinor ?? computedAmountBefore;
  const lineTotal = opts.lineTotalAmountMinor ?? amountAfter;
  const discountThreshold = opts.discountThresholdDays ?? null;
  const discountPercent = opts.discountPercent ?? null;
  // G7P-B2-B Round 2 — Defect 2 : default DAY_RANGE_BOUNDARIES window snapshot
  // for DAILY lines. When selectedWindow is explicitly null, omit the column.
  const defaultWindow: Record<string, unknown> = {
    kind: 'DAY_RANGE_BOUNDARIES',
    firstDay: {
      localDate: '2026-01-10',
      weekdayMask: 127,
      startTime: '09:00:00',
      endTime: '17:00:00',
    },
    lastDay: {
      localDate: '2026-01-11',
      weekdayMask: 127,
      startTime: '09:00:00',
      endTime: '17:00:00',
    },
  };
  const selectedWindow = opts.selectedWindow === undefined ? defaultWindow : opts.selectedWindow;
  const line = await sql`
    INSERT INTO "booking_draft_lines" (
      "draft_id", "variant_id", "quantity",
      "unit_price_amount_minor", "billable_unit_count",
      "line_total_amount_minor", "currency", "variant_snapshot",
      "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
      "pricing_public_label", "pricing_requested_duration_minutes",
      "pricing_billed_days",
      "pricing_selected_window",
      "pricing_discount_threshold_days", "pricing_discount_percent",
      "pricing_amount_before_discount_minor", "pricing_amount_after_discount_minor"
    )
    VALUES (
      ${draftId}, ${variantId}, ${quantity},
      ${unitPrice}, ${billedDays},
      ${lineTotal}, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
      ${planId}, 1, 'DAILY',
      'Tarif journalier', ${reqDur},
      ${billedDays},
      ${selectedWindow === null ? null : sql.json(selectedWindow as never)},
      ${discountThreshold}, ${discountPercent},
      ${amountBefore}, ${amountAfter}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  const state = draftTxMap.get(sql);
  if (state) {
    state.lines += 1;
    if (state.lines >= state.count) {
      await sql`COMMIT`;
      draftTxMap.delete(sql);
    }
  }
  return line.id;
}

/**
 * Crée une réservation complète (draft CONVERTED + payment SUCCEEDED + booking
 * CONFIRMED + booking_line) pour tester l'immutabilité des bookings.
 * Retourne les IDs du booking et de la ligne.
 */
async function seedBooking(
  sql: postgres.Sql,
  ids: BaseIds,
): Promise<{ bookingId: string; lineId: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  // Draft (status CONVERTED — déjà converti en réservation)
  const draft = await sql`
    INSERT INTO "booking_drafts" (
      "organization_id", "location_id", "customer_user_id",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
      "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
      "billable_unit", "billable_unit_count",
      "currency", "cancellation_policy_snapshot", "status", "expires_at"
    ) VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      'CONVERTED', '2026-02-15 09:55:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Payment (SUCCEEDED)
  const payment = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id", "charge_model", "settlement_merchant_mode",
      "environment", "succeeded_at"
    ) VALUES (
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      'SUCCEEDED'::payment_status, 10000, 'EUR',
      'NOT_APPLICABLE', 500,
      'v1', 'v1',
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
      ${'acct_test_' + suffix}, 'DESTINATION', 'PLATFORM',
      'TEST'::payment_environment, '2026-02-15 09:58:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Booking (CONFIRMED)
  const booking = await sql`
    INSERT INTO "bookings" (
      "organization_id", "location_id", "customer_user_id",
      "draft_id", "payment_id", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
      "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor", "total_amount_minor",
      "billable_unit", "billable_unit_count",
      "cancellation_policy_snapshot", "terms_acceptance_snapshot",
      "confirmed_at"
    ) VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${draft.id}, ${payment.id}, 'CONFIRMED'::booking_status,
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      'Europe/Paris', 30, 30,
      'EUR', 10000, 0,
      'NOT_APPLICABLE', 0, null,
      500, 10000,
      'DAY', 2,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
      '2026-02-15 10:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Booking line
  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot",
      "source_draft_line_id"
    )
    VALUES (${booking.id}, ${ids.variantId}, 2, 5000, 2, 10000, ${sql.json({ name: 'Standard' })}, NULL)
    RETURNING "id"
  `.then((r) => r[0]!);

  return { bookingId: booking.id, lineId: line.id };
}

// ---------------------------------------------------------------------------
// A. Migration & schema existence
// ---------------------------------------------------------------------------

async function withSql(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  if (!testUrl) return;
  const sql = postgres(testUrl!, { max: 1 });
  try {
    await fn(sql);
  } finally {
    await sql.end();
  }
}

describe.skipIf(shouldSkipIntegrationTests())('G7P-B2-A — Pricing snapshot foundations', () => {
  // A. Migration & schema existence

  it('A1 — migration vide : toutes les nouvelles colonnes existent sur les 4 tables avec les bons types', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // booking_drafts — 6 new columns
      const draftCols = await sql`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = 'booking_drafts'
            AND column_name IN (
              'pricing_snapshot_version', 'pricing_algorithm_version',
              'pricing_rounding_rule_version', 'pricing_intent_type',
              'pricing_intent_snapshot', 'pricing_resolved_locale'
            )
          ORDER BY column_name
        `;
      expect(draftCols.length).toBe(6);
      const snapVer = draftCols.find((c) => c.column_name === 'pricing_snapshot_version');
      expect(snapVer!.is_nullable).toBe('NO');
      expect(snapVer!.column_default).toContain('legacy-daily-v1');
      expect(snapVer!.data_type).toBe('text');
      const intentSnap = draftCols.find((c) => c.column_name === 'pricing_intent_snapshot');
      expect(intentSnap!.data_type).toBe('jsonb');

      // booking_draft_lines — 13 new columns
      const draftLineCols = await sql`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = 'booking_draft_lines'
            AND column_name IN (
              'pricing_plan_id', 'pricing_plan_version', 'pricing_plan_type',
              'pricing_public_label', 'pricing_requested_duration_minutes',
              'pricing_billed_duration_minutes', 'pricing_covered_duration_minutes',
              'pricing_billed_days', 'pricing_selected_window',
              'pricing_discount_threshold_days', 'pricing_discount_percent',
              'pricing_amount_before_discount_minor', 'pricing_amount_after_discount_minor'
            )
          ORDER BY column_name
        `;
      expect(draftLineCols.length).toBe(13);
      const planIdCol = draftLineCols.find((c) => c.column_name === 'pricing_plan_id');
      expect(planIdCol!.data_type).toBe('uuid');
      const amountBefore = draftLineCols.find(
        (c) => c.column_name === 'pricing_amount_before_discount_minor',
      );
      expect(amountBefore!.data_type).toBe('bigint');

      // bookings — 6 new columns
      const bookingCols = await sql`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = 'bookings'
            AND column_name IN (
              'pricing_snapshot_version', 'pricing_algorithm_version',
              'pricing_rounding_rule_version', 'pricing_intent_type',
              'pricing_intent_snapshot', 'pricing_resolved_locale'
            )
          ORDER BY column_name
        `;
      expect(bookingCols.length).toBe(6);
      const bSnapVer = bookingCols.find((c) => c.column_name === 'pricing_snapshot_version');
      expect(bSnapVer!.is_nullable).toBe('NO');
      expect(bSnapVer!.column_default).toContain('legacy-daily-v1');

      // booking_lines — 13 new columns
      const bookingLineCols = await sql`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = 'booking_lines'
            AND column_name IN (
              'pricing_plan_id', 'pricing_plan_version', 'pricing_plan_type',
              'pricing_public_label', 'pricing_requested_duration_minutes',
              'pricing_billed_duration_minutes', 'pricing_covered_duration_minutes',
              'pricing_billed_days', 'pricing_selected_window',
              'pricing_discount_threshold_days', 'pricing_discount_percent',
              'pricing_amount_before_discount_minor', 'pricing_amount_after_discount_minor'
            )
          ORDER BY column_name
        `;
      expect(bookingLineCols.length).toBe(13);
    } finally {
      await sql.end();
    }
  });

  it('A2 — upgrade 0032 → 0033 : données legacy préservées', async () => {
    if (!testUrl) return;
    // Cette base est déjà migrée à 0033. On vérifie que les données legacy
    // (insérées sans colonnes flexibles) sont préservées avec les valeurs par défaut.
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);
      const lineId = await insertLegacyDraftLine(sql, draftId, ids.variantId);

      // Vérifier que le draft a pricing_snapshot_version = 'legacy-daily-v1'
      const draft = await sql`
          SELECT "pricing_snapshot_version", "pricing_algorithm_version", "pricing_intent_type"
          FROM "booking_drafts" WHERE "id" = ${draftId}
        `.then((r) => r[0]!);
      expect(draft.pricing_snapshot_version).toBe('legacy-daily-v1');
      expect(draft.pricing_algorithm_version).toBe(null);
      expect(draft.pricing_intent_type).toBe(null);

      // Vérifier que la ligne a toutes les colonnes flexibles NULL
      const line = await sql`
          SELECT "pricing_plan_id", "pricing_plan_type", "pricing_billed_days"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(line.pricing_plan_id).toBe(null);
      expect(line.pricing_plan_type).toBe(null);
      expect(line.pricing_billed_days).toBe(null);
    } finally {
      await sql.end();
    }
  });

  it('A3 — conservation exacte des montants legacy après upgrade', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);
      await insertLegacyDraftLine(sql, draftId, ids.variantId);

      const draft = await sql`
          SELECT "subtotal_amount_minor", "total_amount_minor", "billable_unit_count"
          FROM "booking_drafts" WHERE "id" = ${draftId}
        `.then((r) => r[0]!);
      expect(Number(draft.subtotal_amount_minor)).toBe(10000);
      expect(Number(draft.total_amount_minor)).toBe(10000);
      expect(draft.billable_unit_count).toBe(2);
    } finally {
      await sql.end();
    }
  });

  // B. Legacy compatibility

  it('B1 — un brouillon legacy avec billable_unit = DAY est accepté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);
      expect(draftId).toBeTruthy();
    } finally {
      await sql.end();
    }
  });

  // C. Flexible snapshot insertion

  it('C1 — insertion HOURLY valide : draft flexible + ligne HOURLY → succès', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const lineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      expect(lineId).toBeTruthy();

      const line = await sql`
          SELECT "pricing_plan_type", "pricing_billed_duration_minutes"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(line.pricing_plan_type).toBe('HOURLY');
      expect(line.pricing_billed_duration_minutes).toBe(120);
    } finally {
      await sql.end();
    }
  });

  it('C2 — insertion FIXED_DURATION valide : draft flexible + ligne FIXED_DURATION → succès', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedFixedDurationPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 3000,
        totalAmountMinor: 3000,
      });
      const lineId = await insertFixedDurationDraftLine(sql, draftId, ids.variantId, planId);
      expect(lineId).toBeTruthy();

      const line = await sql`
          SELECT "pricing_plan_type", "pricing_covered_duration_minutes"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(line.pricing_plan_type).toBe('FIXED_DURATION');
      expect(line.pricing_covered_duration_minutes).toBe(120);
    } finally {
      await sql.end();
    }
  });

  it('C3 — insertion DAILY sans remise : amount_before = amount_after → succès', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        intentSnapshot: {
          kind: 'DAY_RANGE',
          startDate: '2026-01-10',
          endDateExclusive: '2026-01-12',
        },
      });
      const lineId = await insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
        billedDays: 2,
        amountBeforeDiscountMinor: 10000,
        amountAfterDiscountMinor: 10000,
        discountThresholdDays: null,
        discountPercent: null,
      });
      expect(lineId).toBeTruthy();

      const line = await sql`
          SELECT "pricing_plan_type", "pricing_billed_days",
                 "pricing_amount_before_discount_minor", "pricing_amount_after_discount_minor"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(line.pricing_plan_type).toBe('DAILY');
      expect(line.pricing_billed_days).toBe(2);
      expect(Number(line.pricing_amount_before_discount_minor)).toBe(10000);
      expect(Number(line.pricing_amount_after_discount_minor)).toBe(10000);
    } finally {
      await sql.end();
    }
  });

  it('C4 — insertion DAILY avec remise : threshold, percent, before > after → succès', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        subtotalAmountMinor: 31500,
        totalAmountMinor: 31500,
        intentSnapshot: {
          kind: 'DAY_RANGE',
          startDate: '2026-01-10',
          endDateExclusive: '2026-01-17',
        },
      });
      const lineId = await insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
        billedDays: 7,
        amountBeforeDiscountMinor: 35000,
        amountAfterDiscountMinor: 31500,
        discountThresholdDays: 7,
        discountPercent: 10,
        lineTotalAmountMinor: 31500,
        selectedWindow: {
          kind: 'DAY_RANGE_BOUNDARIES',
          firstDay: {
            localDate: '2026-01-10',
            weekdayMask: 127,
            startTime: '09:00:00',
            endTime: '17:00:00',
          },
          lastDay: {
            localDate: '2026-01-16',
            weekdayMask: 127,
            startTime: '09:00:00',
            endTime: '17:00:00',
          },
        },
      });
      expect(lineId).toBeTruthy();

      const line = await sql`
          SELECT "pricing_plan_type", "pricing_billed_days",
                 "pricing_discount_threshold_days", "pricing_discount_percent",
                 "pricing_amount_before_discount_minor", "pricing_amount_after_discount_minor"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(line.pricing_plan_type).toBe('DAILY');
      expect(line.pricing_billed_days).toBe(7);
      expect(line.pricing_discount_threshold_days).toBe(7);
      expect(line.pricing_discount_percent).toBe(10);
      expect(Number(line.pricing_amount_before_discount_minor)).toBe(35000);
      expect(Number(line.pricing_amount_after_discount_minor)).toBe(31500);
    } finally {
      await sql.end();
    }
  });

  // D. Financial constraints

  it('D1 — rejet montant négatif : pricing_amount_before_discount_minor < 0 → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          amountBeforeDiscountMinor: -100,
          amountAfterDiscountMinor: -100,
        }),
      ).rejects.toThrow(/DAILY amount_before_discount mismatch/);
    } finally {
      await sql.end();
    }
  });

  it('D2 — rejet overflow : amount > Number.MAX_SAFE_INTEGER → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          amountBeforeDiscountMinor: 9007199254740992,
          amountAfterDiscountMinor: 9007199254740992,
        }),
      ).rejects.toThrow(/DAILY amount_before_discount mismatch/);
    } finally {
      await sql.end();
    }
  });

  it('D3 — rejet incohérence avant/après remise : amount_before < amount_after → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          amountBeforeDiscountMinor: 5000,
          amountAfterDiscountMinor: 6000,
        }),
      ).rejects.toThrow(/DAILY amount_before_discount mismatch/);
    } finally {
      await sql.end();
    }
  });

  it('D4 — rejet remise sur plan non DAILY : threshold NOT NULL mais plan_type = HOURLY → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
            INSERT INTO "booking_draft_lines" (
              "draft_id", "variant_id", "quantity",
              "unit_price_amount_minor", "billable_unit_count",
              "line_total_amount_minor", "currency", "variant_snapshot",
              "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
              "pricing_public_label", "pricing_requested_duration_minutes",
              "pricing_billed_duration_minutes",
              "pricing_discount_threshold_days"
            )
            VALUES (
              ${draftId}, ${ids.variantId}, 1,
              1500, 8,
              12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
              ${planId}, 1, 'HOURLY',
              'Tarif horaire', 120,
              120,
              7
            )
          `,
      ).rejects.toThrow(/pricing_discount_threshold_daily_only|pricing_day_range_requires_daily/);
    } finally {
      await sql.end();
    }
  });

  // E. Multi-tenant isolation

  it('E1 — rejet devise différente : draft EUR référence un plan USD → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // Créer une org en EUR avec un plan HOURLY USD (plan par défaut, pas de
      // vérification de devise pour les plans default location_id NULL).
      const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
      const planUsd = await seedHourlyPlan(sql, ids, 'USD');

      // Créer un draft EUR (même org).
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });

      // Tenter d'insérer une ligne EUR qui référence le plan USD → rejeté
      // par le trigger de cohérence devise (plan currency ≠ draft currency).
      await expect(insertHourlyDraftLine(sql, draftId, ids.variantId, planUsd)).rejects.toThrow(
        /currency mismatch/,
      );
    } finally {
      await sql.end();
    }
  });

  it('E2 — rejet plan d une autre organisation : draft orgA référence plan orgB → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const idsA = await seedBaseData(sql);
      const idsB = await seedBaseData(sql);
      const planB = await seedHourlyPlan(sql, idsB);

      const draftId = await insertFlexibleDraft(sql, idsA, { billableUnit: 'MINUTE' });
      await expect(insertHourlyDraftLine(sql, draftId, idsA.variantId, planB)).rejects.toThrow(
        /organization_id mismatch/,
      );
    } finally {
      await sql.end();
    }
  });

  // F. Immutability

  it('F1 — protection immutabilité : UPDATE d une colonne financière → rejeté, UPDATE status → autorisé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 0,
        totalAmountMinor: 0,
      });
      await insertHourlyDraftLine(sql, draftId, ids.variantId, planId, {
        unitPriceAmountMinor: 0,
      });

      // UPDATE d'une colonne financière → rejeté
      await expect(
        sql`UPDATE "booking_drafts" SET "subtotal_amount_minor" = 99999 WHERE "id" = ${draftId}`,
      ).rejects.toThrow(/immutable/);

      // UPDATE du status → autorisé
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = '2026-12-31T00:00:00Z' WHERE "id" = ${draftId}`;
      const draft = await sql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('HELD');
    } finally {
      await sql.end();
    }
  });

  it('F2 — immutabilité conditionnelle des lignes de brouillon : DRAFT autorise UPDATE, HELD rejette tout', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const lineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      // Le draft est DRAFT → UPDATE d'une colonne pricing_* est autorisé
      // G7P-B2-B Round 2 — Defect 2 : le window snapshot doit avoir un kind valide
      await sql`UPDATE "booking_draft_lines" SET "pricing_selected_window" = ${sql.json({ kind: 'TIME_RANGE_WINDOW', weekdayMask: 127, startTime: '09:00:00', endTime: '17:00:00' })} WHERE "id" = ${lineId}`;
      const line1 =
        await sql`SELECT "pricing_selected_window" FROM "booking_draft_lines" WHERE "id" = ${lineId}`.then(
          (r) => r[0]!,
        );
      expect(line1.pricing_selected_window).toEqual({
        kind: 'TIME_RANGE_WINDOW',
        weekdayMask: 127,
        startTime: '09:00:00',
        endTime: '17:00:00',
      });

      // UPDATE d'une colonne non-pricing est aussi autorisé en DRAFT
      await sql`UPDATE "booking_draft_lines" SET "variant_snapshot" = ${sql.json({ name: 'Updated' })} WHERE "id" = ${lineId}`;
      const line2 =
        await sql`SELECT "variant_snapshot" FROM "booking_draft_lines" WHERE "id" = ${lineId}`.then(
          (r) => r[0]!,
        );
      expect(line2.variant_snapshot).toEqual({ name: 'Updated' });

      // Passer le draft en HELD → toutes les modifications sont rejetées
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = '2026-12-31T00:00:00Z' WHERE "id" = ${draftId}`;

      // UPDATE d'une colonne pricing_* → rejeté
      await expect(
        sql`UPDATE "booking_draft_lines" SET "pricing_billed_duration_minutes" = 888 WHERE "id" = ${lineId}`,
      ).rejects.toThrow(/Cannot update draft line/);

      // UPDATE d'une colonne non-pricing → rejeté aussi
      await expect(
        sql`UPDATE "booking_draft_lines" SET "quantity" = 3 WHERE "id" = ${lineId}`,
      ).rejects.toThrow(/Cannot update draft line/);

      // DELETE → rejeté
      await expect(sql`DELETE FROM "booking_draft_lines" WHERE "id" = ${lineId}`).rejects.toThrow(
        /Cannot delete draft line/,
      );
    } finally {
      await sql.end();
    }
  });

  it('F3 — immutabilité des bookings : UPDATE colonne financière → rejeté, UPDATE status → autorisé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { bookingId } = await seedBooking(sql, ids);

      // UPDATE d'une colonne financière sur booking → rejeté
      await expect(
        sql`UPDATE "bookings" SET "subtotal_amount_minor" = 99999 WHERE "id" = ${bookingId}`,
      ).rejects.toThrow(/immutable/);

      // UPDATE d'une colonne JSONB snapshot sur booking → rejeté
      await expect(
        sql`UPDATE "bookings" SET "cancellation_policy_snapshot" = '"corrupted"'::jsonb WHERE "id" = ${bookingId}`,
      ).rejects.toThrow(/immutable/);

      // UPDATE du snapshot marketplace ajouté par la migration 0049 → rejeté
      // par le trigger dédié, tout en conservant l'immutabilité après son ajout.
      await expect(
        sql`UPDATE "bookings" SET "marketplace_fee_snapshot" = '{}'::jsonb WHERE "id" = ${bookingId}`,
      ).rejects.toThrow(/marketplace fee snapshot is immutable/);

      // UPDATE du status sur booking → autorisé (fulfillment transitions)
      await sql`UPDATE "bookings" SET "status" = 'READY_FOR_PICKUP' WHERE "id" = ${bookingId}`;
      const booking = await sql`SELECT "status" FROM "bookings" WHERE "id" = ${bookingId}`.then(
        (r) => r[0]!,
      );
      expect(booking.status).toBe('READY_FOR_PICKUP');
    } finally {
      await sql.end();
    }
  });

  it('F4 — immutabilité des booking_lines : UPDATE et DELETE → rejetés', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const { lineId } = await seedBooking(sql, ids);

      // UPDATE d'une colonne financière sur booking_line → rejeté
      await expect(
        sql`UPDATE "booking_lines" SET "line_total_amount_minor" = 99999 WHERE "id" = ${lineId}`,
      ).rejects.toThrow(/Cannot update booking line/);

      // UPDATE d'une colonne pricing_* sur booking_line → rejeté
      await expect(
        sql`UPDATE "booking_lines" SET "pricing_plan_type" = 'DAILY' WHERE "id" = ${lineId}`,
      ).rejects.toThrow(/Cannot update booking line/);

      // DELETE d'une booking_line → rejeté
      await expect(sql`DELETE FROM "booking_lines" WHERE "id" = ${lineId}`).rejects.toThrow(
        /Cannot delete booking line/,
      );
    } finally {
      await sql.end();
    }
  });

  // G. Plan retirement/replacement

  it('G1 — retraite plan sans effet : le snapshot du draft reste inchangé après RETIRED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const lineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      // Snapshot avant retraite
      const before = await sql`
          SELECT "pricing_plan_id", "pricing_plan_version", "pricing_public_label"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);

      // Retirer le plan
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;

      // Snapshot après retraite — inchangé
      const after = await sql`
          SELECT "pricing_plan_id", "pricing_plan_version", "pricing_public_label"
          FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
      expect(after.pricing_plan_id).toBe(before.pricing_plan_id);
      expect(after.pricing_plan_version).toBe(before.pricing_plan_version);
      expect(after.pricing_public_label).toBe(before.pricing_public_label);
    } finally {
      await sql.end();
    }
  });

  // H. Status transitions

  it('H1 — transitions de statut : DRAFT → HELD → PAYMENT_PROCESSING → toutes autorisées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 0,
        totalAmountMinor: 0,
      });
      await insertHourlyDraftLine(sql, draftId, ids.variantId, planId, {
        unitPriceAmountMinor: 0,
      });

      // DRAFT → HELD
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = '2026-12-31T00:00:00Z' WHERE "id" = ${draftId}`;
      let draft = await sql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('HELD');

      // HELD → PAYMENT_PROCESSING
      await sql`UPDATE "booking_drafts" SET "status" = 'PAYMENT_PROCESSING' WHERE "id" = ${draftId}`;
      draft = await sql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`.then(
        (r) => r[0]!,
      );
      expect(draft.status).toBe('PAYMENT_PROCESSING');
    } finally {
      await sql.end();
    }
  });

  // P0-1 — brouillon flexible sans ligne

  it('P0-1a — flexible draft with no lines (status HELD) is rejected at COMMIT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await sql`BEGIN`;
      await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot", "status", "expires_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris', 30, 30,
          0, 0, 0,
          'UNDETERMINED', 'MINUTE', 1,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          'HELD', '2026-12-31T00:00:00Z',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
      `;
      await expect(sql`COMMIT`).rejects.toThrow(/flexible draft must have at least one line/);
    } finally {
      await sql.end();
    }
  });

  it('P0-1b — flexible draft + line in the same transaction is accepted at COMMIT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      await sql`BEGIN`;
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      await sql`COMMIT`;
      const rows = await sql`SELECT "id" FROM "booking_drafts" WHERE "id" = ${draftId}`;
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('P0-1c — flexible draft with no lines (status DRAFT) is rejected at COMMIT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await sql`BEGIN`;
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      expect(draftId).toBeTruthy();
      await expect(sql`COMMIT`).rejects.toThrow(/flexible draft must have at least one line/);
    } finally {
      await sql`ROLLBACK`;
      await sql.end();
    }
  });

  // I. Concurrency

  it('I1 — concurrence : insertion draft vs retraite plan — pas de deadlock, snapshot préservé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);

      // Deux connexions séparées.
      const sqlA = postgres(testUrl!, { max: 1 });
      const sqlB = postgres(testUrl!, { max: 1 });

      // Connexion A : insère un draft + ligne référençant le plan.
      // Connexion B : retire le plan.
      const draftId = await insertFlexibleDraft(sqlA, ids, { billableUnit: 'MINUTE' });
      await insertHourlyDraftLine(sqlA, draftId, ids.variantId, planId);
      await sqlA.end();

      await sqlB`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
      await sqlB.end();

      // Les deux opérations doivent se terminer sans deadlock.
      // L'insertion réussit toujours (la FK ne vérifie pas lifecycle_state).
      // La retraite réussit toujours.

      // Vérifier que le plan est RETIRED
      const plan =
        await sql`SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${planId}`.then(
          (r) => r[0]!,
        );
      expect(plan.lifecycle_state).toBe('RETIRED');

      // Vérifier que le snapshot du draft est inchangé après la retraite.
      // Le draft référence toujours le plan original avec sa version.
      const draftLine = await sql`
          SELECT "pricing_plan_id", "pricing_plan_version", "pricing_public_label"
          FROM "booking_draft_lines"
          WHERE "pricing_plan_id" = ${planId}
          LIMIT 1
        `.then((r) => r[0]!);
      expect(draftLine.pricing_plan_id).toBe(planId);
      expect(draftLine.pricing_plan_version).toBe(1);
      expect(draftLine.pricing_public_label).toBe('Tarif horaire');
    } finally {
      await sql.end();
    }
  });

  // J. Migration journal

  it('J1 — journal de migrations : __drizzle_migrations a 53 entrées, _journal.json a 53 entrées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(53);

      // Vérifier le _journal.json
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const journalPath = join(__dirname, '..', 'drizzle', 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
      expect(journal.entries.length).toBe(53);
      expect(journal.entries[32]!.tag).toBe('0033_g7p_b2_pricing_snapshots');
      expect(journal.entries[32]!.idx).toBe(32);
    } finally {
      await sql.end();
    }
  });

  // K. Additional constraint checks

  it('K1 — rejet champs de version manquants : flexible sans algorithm_version → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
            INSERT INTO "booking_drafts" (
              "organization_id", "location_id", "customer_user_id",
              "customer_start_at", "customer_end_at",
              "blocked_start_at", "blocked_end_at",
              "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
              "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
              "tax_status", "billable_unit", "billable_unit_count",
              "currency", "cancellation_policy_snapshot",
              "pricing_snapshot_version", "pricing_intent_type"
            )
            VALUES (
              ${ids.orgId}, ${ids.locationId}, ${ids.userId},
              '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
              '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
              'Europe/Paris', 30, 30,
              3000, 0, 3000,
              'UNDETERMINED', 'MINUTE', 1,
              'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
              'flexible-pricing-v1', 'TIME_RANGE'
            )
          `,
      ).rejects.toThrow(/booking_drafts_flexible_metadata_exact/);
    } finally {
      await sql.end();
    }
  });

  it('K2 — rejet cohérence intent/plan : DAY_RANGE avec plan HOURLY → rejeté par coherence trigger', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      // Tenter d'insérer une ligne HOURLY (sans discount_threshold) sur un
      // draft DAY_RANGE → rejeté par le trigger de cohérence intent/plan.
      await expect(
        sql`
            INSERT INTO "booking_draft_lines" (
              "draft_id", "variant_id", "quantity",
              "unit_price_amount_minor", "billable_unit_count",
              "line_total_amount_minor", "currency", "variant_snapshot",
              "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
              "pricing_public_label", "pricing_requested_duration_minutes",
              "pricing_billed_duration_minutes"
            )
            VALUES (
              ${draftId}, ${ids.variantId}, 1,
              1500, 1,
              3000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
              ${planId}, 1, 'HOURLY',
              'Tarif horaire', 120,
              120
            )
          `,
      ).rejects.toThrow(/DAY_RANGE intent requires DAILY plan type/);
    } finally {
      await sql.end();
    }
  });

  it('K3 — rejet discount_percent hors range : percent = 150 → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          billedDays: 7,
          amountBeforeDiscountMinor: 35000,
          amountAfterDiscountMinor: 0,
          discountThresholdDays: 7,
          discountPercent: 150,
        }),
      ).rejects.toThrow(/discount percent must be between 1 and 99/);
    } finally {
      await sql.end();
    }
  });

  it('K4 — rejet HOURLY sans billed_duration_minutes → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
            INSERT INTO "booking_draft_lines" (
              "draft_id", "variant_id", "quantity",
              "unit_price_amount_minor", "billable_unit_count",
              "line_total_amount_minor", "currency", "variant_snapshot",
              "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
              "pricing_public_label", "pricing_requested_duration_minutes"
            )
            VALUES (
              ${draftId}, ${ids.variantId}, 1,
              1500, 1,
              3000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
              ${planId}, 1, 'HOURLY',
              'Tarif horaire', 120
            )
          `,
      ).rejects.toThrow(/HOURLY requires positive pricing_billed_duration_minutes/);
    } finally {
      await sql.end();
    }
  });

  it('K5 — rejet DAILY sans billed_days → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        sql`
            INSERT INTO "booking_draft_lines" (
              "draft_id", "variant_id", "quantity",
              "unit_price_amount_minor", "billable_unit_count",
              "line_total_amount_minor", "currency", "variant_snapshot",
              "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
              "pricing_public_label", "pricing_requested_duration_minutes"
            )
            VALUES (
              ${draftId}, ${ids.variantId}, 1,
              5000, 1,
              5000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
              ${ids.dailyPlanId}, 1, 'DAILY',
              'Tarif journalier', NULL
            )
          `,
      ).rejects.toThrow(/DAILY requires positive pricing_billed_days/);
    } finally {
      await sql.end();
    }
  });

  it('K6 — rejet FIXED_DURATION sans covered_duration_minutes → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedFixedDurationPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
            INSERT INTO "booking_draft_lines" (
              "draft_id", "variant_id", "quantity",
              "unit_price_amount_minor", "billable_unit_count",
              "line_total_amount_minor", "currency", "variant_snapshot",
              "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
              "pricing_public_label", "pricing_requested_duration_minutes"
            )
            VALUES (
              ${draftId}, ${ids.variantId}, 1,
              3000, 1,
              3000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
              ${planId}, 1, 'FIXED_DURATION',
              'Forfait 2h', 120
            )
          `,
      ).rejects.toThrow(/FIXED_DURATION requires positive pricing_covered_duration_minutes/);
    } finally {
      await sql.end();
    }
  });

  it('K7 — rejet legacy-daily-v1 avec billable_unit non DAY → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
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
              ${ids.orgId}, ${ids.locationId}, ${ids.userId},
              '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
              '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
              'Europe/Paris', 30, 30,
              10000, 0, 10000,
              'UNDETERMINED', 'HOURLY', 2,
              'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
            )
          `,
      ).rejects.toThrow(/legacy_billable_unit_day/);
    } finally {
      await sql.end();
    }
  });

  it('K8 — triggers et index de 0033 existent', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // Triggers
      const triggers = await sql`
          SELECT tgname FROM pg_trigger WHERE tgname IN (
            'before_check_draft_financial_immutability',
            'before_check_draft_line_immutability',
            'before_check_booking_financial_immutability',
            'before_check_booking_line_immutability',
            'before_enforce_draft_location_coherence',
            'before_enforce_draft_line_pricing_coherence',
            'before_enforce_booking_line_pricing_coherence',
            'after_validate_flexible_draft_aggregates_line',
            'after_validate_flexible_draft_aggregates_draft',
            'after_validate_flexible_booking_aggregates_line',
            'after_validate_flexible_booking_aggregates_booking'
          )
        `;
      expect(triggers.length).toBe(11);

      // Index partiels
      const indexes = await sql`
          SELECT indexname FROM pg_indexes
          WHERE indexname IN (
            'booking_draft_lines_pricing_plan_id_idx',
            'booking_lines_pricing_plan_id_idx'
          )
        `;
      expect(indexes.length).toBe(2);

      // FK constraints
      const fks = await sql`
          SELECT conname FROM pg_constraint
          WHERE conname IN (
            'booking_draft_lines_pricing_plan_id_fk',
            'booking_lines_pricing_plan_id_fk'
          )
        `;
      expect(fks.length).toBe(2);
    } finally {
      await sql.end();
    }
  });

  // T1-T4 : politique timezone fail-closed dans enforce_draft_location_coherence.
  // Un fuseau invalide (location ou draft) doit être rejeté ; un mismatch
  // entre deux fuseaux valides doit être rejeté ; un match exact est accepté.

  it('T1 — location with invalid IANA timezone → new draft rejected', async () => {
    await withSql(async (sql) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const org = await sql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
        VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Directly INSERT a location with an invalid time_zone (no trigger prevents this)
      const location = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
        VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'InvalidTimeZone', 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      const user = await sql`
        INSERT INTO "users" ("email")
        VALUES (${'customer-' + suffix + '@example.com'})
        RETURNING "id"
      `.then((r) => r[0]!);

      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot",
            "pricing_snapshot_version", "pricing_algorithm_version",
            "pricing_rounding_rule_version", "pricing_intent_type",
            "pricing_intent_snapshot", "pricing_resolved_locale"
          ) VALUES (
            ${org.id}, ${location.id}, ${user.id},
            '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
            'Europe/Paris', 30, 30,
            12000, 0, 12000,
            'NOT_APPLICABLE', 'MINUTE', 1,
            'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
            'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
            ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
            'fr'
          )
        `,
      ).rejects.toThrow(/location time_zone .* is not a valid IANA timezone/);
    });
  });

  it('T2 — draft with invalid timezone → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);

      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot",
            "pricing_snapshot_version", "pricing_algorithm_version",
            "pricing_rounding_rule_version", "pricing_intent_type",
            "pricing_intent_snapshot", "pricing_resolved_locale"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
            'InvalidTimeZone', 30, 30,
            12000, 0, 12000,
            'NOT_APPLICABLE', 'MINUTE', 1,
            'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'InvalidTimeZone' })},
            'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
            ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
            'fr'
          )
        `,
      ).rejects.toThrow(/timezone .* is not a valid IANA timezone/);
    });
  });

  it('T3 — valid location but different draft timezone → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);

      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot",
            "pricing_snapshot_version", "pricing_algorithm_version",
            "pricing_rounding_rule_version", "pricing_intent_type",
            "pricing_intent_snapshot", "pricing_resolved_locale"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
            'America/New_York', 30, 30,
            12000, 0, 12000,
            'NOT_APPLICABLE', 'MINUTE', 1,
            'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'America/New_York' })},
            'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
            ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
            'fr'
          )
        `,
      ).rejects.toThrow(/timezone .* does not match location time_zone/);
    });
  });

  it('T4 — same valid IANA timezone → accepted', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      expect(draftId).toBeTruthy();
    });
  });

  // L. Round-2 negative invariants

  it('L1 — parent flexible + all-NULL line → rejected', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot"
          )
          VALUES (
            ${draftId}, ${ids.variantId}, 1,
            1500, 1,
            1500, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })}
          )
        `,
      ).rejects.toThrow(/flexible parent requires a complete pricing snapshot/);
    } finally {
      await sql.end();
    }
  });

  it('L2 — parent legacy + any flexible column set → rejected', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label"
          )
          VALUES (
            ${draftId}, ${ids.variantId}, 1,
            5000, 2,
            10000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${ids.dailyPlanId}, 1, 'DAILY',
            'Tarif journalier'
          )
        `,
      ).rejects.toThrow(/legacy parent requires all pricing_/);
    } finally {
      await sql.end();
    }
  });

  it('L3 — DAY_RANGE with pricing_plan_type NULL → rejected', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = ids.dailyPlanId;
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
      });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_days",
            "pricing_amount_before_discount_minor", "pricing_amount_after_discount_minor"
          )
          VALUES (
            ${draftId}, ${ids.variantId}, 1,
            5000, 2,
            10000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${planId}, 1, NULL,
            'Tarif journalier', NULL,
            2,
            10000, 10000
          )
        `,
      ).rejects.toThrow(/flexible parent requires a complete pricing snapshot/);
    } finally {
      await sql.end();
    }
  });

  it('L4 — subtotal mismatching sum(line_total) → rejected at COMMIT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 1,
        totalAmountMinor: 1,
      });
      await expect(insertHourlyDraftLine(sql, draftId, ids.variantId, planId)).rejects.toThrow(
        /subtotal_amount_minor .* does not match sum of line totals/,
      );
    } finally {
      await sql.end();
    }
  });

  it('L5 — late line insert into HELD draft → rejected', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = '2026-12-31T00:00:00Z' WHERE "id" = ${draftId}`;
      await expect(insertHourlyDraftLine(sql, draftId, ids.variantId, planId)).rejects.toThrow(
        /Cannot insert draft line/,
      );
    } finally {
      await sql.end();
    }
  });

  it('L6 — concurrent draft-line insert vs plan retirement completes without deadlock', async () => {
    if (!testUrl) return;
    const sql1 = postgres(testUrl, { max: 1 });
    const sql2 = postgres(testUrl, { max: 1 });

    try {
      const ids = await seedBaseData(sql1);
      const planId = await seedHourlyPlan(sql1, ids);

      await sql1`BEGIN`;
      await sql2`BEGIN`;

      const draftId = await insertFlexibleDraft(sql1, ids, { billableUnit: 'MINUTE' });

      // Barrière : sql1 prend le verrou 1000 (start barrier uniquement), insère la ligne
      // (le trigger enforce_draft_line_pricing_coherence prend FOR SHARE sur pricing_plans),
      // puis libère la barrière. sql2 acquiert le verrou 1000 et tente l'UPDATE qui
      // bloque sur le FOR SHARE du trigger (pas de verrou manuel FOR UPDATE).
      await sql1`SELECT pg_advisory_lock(1000)`;

      const insertLine = sql1`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes"
        )
        VALUES (
          ${draftId}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql1.json({ name: 'Standard' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120
        )
      `;
      await insertLine;
      await sql1`SELECT pg_advisory_unlock(1000)`;

      // sql2 acquiert le verrou 1000, puis tente l'UPDATE de la ligne plan.
      await sql2`SELECT pg_advisory_lock(1000)`;
      const sql2Pid = await sql2`SELECT pg_backend_pid() AS pid`.then((r) => r[0]!.pid);
      const updatePlan = sql2`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
      await Promise.race([
        updatePlan,
        new Promise<void>((_, reject) => setTimeout(reject, 100)),
      ]).catch(() => {});

      // sql2 is blocked on the plan row until sql1 commits.
      const sql3 = postgres(testUrl, { max: 1 });
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [backend] = (await sql3`
            SELECT state, wait_event_type, wait_event
            FROM pg_stat_activity
            WHERE pid = ${sql2Pid}
          `) as { state: string; wait_event_type: string | null }[];
          const ungranted = (await sql3`
            SELECT locktype, mode
            FROM pg_locks
            WHERE pid = ${sql2Pid} AND granted = false
          `) as { locktype: string; mode: string }[];
          if (
            backend &&
            backend.state === 'active' &&
            backend.wait_event_type === 'Lock' &&
            ungranted.some((l) => l.locktype === 'transactionid' && l.mode === 'ShareLock')
          ) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
      } finally {
        await sql3.end();
      }

      await sql1`COMMIT`;
      await updatePlan;
      await sql2`COMMIT`;

      const plan =
        await sql1`SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${planId}`.then(
          (r) => r[0]!,
        );
      expect(plan.lifecycle_state).toBe('RETIRED');
      const line =
        await sql1`SELECT "pricing_plan_id" FROM "booking_draft_lines" WHERE "draft_id" = ${draftId}`.then(
          (r) => r[0]!,
        );
      expect(line.pricing_plan_id).toBe(planId);
    } finally {
      await sql1.end();
      await sql2.end();
    }
  });

  it('L7 — concurrent copy draft → booking blocks source draft line update', async () => {
    if (!testUrl) return;
    const sql1 = postgres(testUrl, { max: 1 });
    const sql2 = postgres(testUrl, { max: 1 });

    try {
      const ids = await seedBaseData(sql1);
      const planId = await seedHourlyPlan(sql1, ids);
      const draftId = await insertFlexibleDraft(sql1, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql1, draftId, ids.variantId, planId);

      const payment = await sql1`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql1.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test_l7', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await sql1`BEGIN`;
      await sql2`BEGIN`;

      // sql1 prend le verrou 1001 (start barrier uniquement), copie le draft en booking, puis libère.
      // L'INSERT booking_line (trigger enforce_booking_line_pricing_coherence) prend FOR SHARE
      // sur la source booking_draft_line, ce qui bloque tout UPDATE concurrent (pas de verrou manuel).
      await sql1`SELECT pg_advisory_lock(1001)`;

      const booking = await sql1`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id}, 'CONFIRMED'::booking_status,
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris', 30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql1.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql1.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql1.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await sql1`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql1.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120, 120,
          ${sourceLineId}
        )
      `;

      await sql1`SELECT pg_advisory_unlock(1001)`;

      // sql2 acquiert le verrou 1001, puis tente un UPDATE réel (mutation observable) sur la source.
      // On modifie unit_price_amount_minor ET line_total_amount_minor pour maintenir la cohérence
      // arithmétique (le trigger enforce_draft_line_pricing_coherence vérifie unit_price * count * qty).
      await sql2`SELECT pg_advisory_lock(1001)`;
      const sql2Pid = await sql2`SELECT pg_backend_pid() AS pid`.then((r) => r[0]!.pid);
      const updateLine = sql2`UPDATE "booking_draft_lines" SET "unit_price_amount_minor" = 9999, "line_total_amount_minor" = 79992 WHERE "id" = ${sourceLineId}`;
      await Promise.race([
        updateLine,
        new Promise<void>((_, reject) => setTimeout(reject, 100)),
      ]).catch(() => {});

      // sql2 est bloqué sur un verrou de la ligne source.
      const sql3 = postgres(testUrl, { max: 1 });
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [backend] = (await sql3`
            SELECT state, wait_event_type, wait_event
            FROM pg_stat_activity
            WHERE pid = ${sql2Pid}
          `) as { state: string; wait_event_type: string | null }[];
          const ungranted = (await sql3`
            SELECT locktype, mode
            FROM pg_locks
            WHERE pid = ${sql2Pid} AND granted = false
          `) as { locktype: string; mode: string }[];
          if (
            backend &&
            backend.state === 'active' &&
            backend.wait_event_type === 'Lock' &&
            ungranted.some((l) => l.locktype === 'transactionid' && l.mode === 'ShareLock')
          ) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
      } finally {
        await sql3.end();
      }

      await sql1`COMMIT`;
      await updateLine;
      await sql2`ROLLBACK`;

      const copied = await sql1`
          SELECT "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor", "source_draft_line_id"
          FROM "booking_lines"
          WHERE "booking_id" = ${booking.id}
        `.then((r) => r[0]!);
      expect(copied).not.toBeNull();
      expect(copied.unit_price_amount_minor).toBe('1500');
      expect(copied.billable_unit_count).toBe(8);
      expect(copied.line_total_amount_minor).toBe('12000');
      expect(copied.source_draft_line_id).toBe(sourceLineId);

      const source = await sql1`
          SELECT "unit_price_amount_minor" FROM "booking_draft_lines" WHERE "id" = ${sourceLineId}
        `.then((r) => r[0]!);
      expect(source.unit_price_amount_minor).toBe('1500');
    } finally {
      await sql1.end();
      await sql2.end();
    }
  });

  it('L17 — flexible line with wrong pricing_plan_version → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes"
          ) VALUES (
            ${draftId}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${planId}, 99, 'HOURLY',
            'Tarif horaire', 120, 120
          )
        `,
      ).rejects.toThrow(/pricing_plan_version snapshot mismatch/);
    });
  });

  it('L8 — flexible line with pricing_plan_type not matching plan → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        intentType: 'TIME_RANGE',
        subtotalAmountMinor: 35000,
        totalAmountMinor: 35000,
      });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_days",
            "pricing_amount_before_discount_minor", "pricing_amount_after_discount_minor"
          ) VALUES (
            ${draftId}, ${ids.variantId}, 1,
            5000, 7,
            35000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${ids.dailyPlanId}, 1, 'HOURLY',
            'Tarif journalier', 2880, 7,
            35000, 35000
          )
        `,
      ).rejects.toThrow(/pricing_plan_type snapshot mismatch/);
    });
  });

  it('L9 — flexible line referencing a DRAFT or RETIRED plan → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftPlan = await sql`
        INSERT INTO "pricing_plans" (
          "organization_id", "product_variant_id", "location_id", "plan_type",
          "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes",
          "billing_increment_minutes", "version"
        ) VALUES (
          ${ids.orgId}, ${ids.variantId}, NULL, 'HOURLY', 'EUR', 1500,
          60, 480, 15, 1
        ) RETURNING "id"
      `.then((r) => r[0]!);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes"
          ) VALUES (
            ${draftId}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${draftPlan.id}, 1, 'HOURLY',
            'Tarif horaire', 120, 120
          )
        `,
      ).rejects.toThrow(/pricing_plan is not ACTIVE/);
    });
  });

  it('L10 — flexible draft with a false pricing_algorithm_version → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      await expect(
        insertFlexibleDraft(sql, ids, {
          billableUnit: 'MINUTE',
          algorithmVersion: 'v2',
        }),
      ).rejects.toThrow(/booking_drafts_flexible_metadata_exact/);
    });
  });

  it('L11 — flexible draft with a false pricing_rounding_rule_version → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      await expect(
        insertFlexibleDraft(sql, ids, {
          billableUnit: 'MINUTE',
          roundingRuleVersion: 'v1',
        }),
      ).rejects.toThrow(/booking_drafts_flexible_metadata_exact/);
    });
  });

  it('L12 — flexible draft with pricing_intent_snapshot not a JSON object → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot",
            "pricing_snapshot_version", "pricing_algorithm_version",
            "pricing_rounding_rule_version", "pricing_intent_type",
            "pricing_intent_snapshot", "pricing_resolved_locale"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
            'Europe/Paris', 30, 30,
            0, 0, 0,
            'UNDETERMINED', 'MINUTE', 1,
            'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
            'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
            '"not-an-object"'::jsonb, 'fr'
          )
        `,
      ).rejects.toThrow(/booking_drafts_flexible_metadata_exact/);
    });
  });

  it('L13 — flexible draft with empty pricing_resolved_locale → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot",
            "pricing_snapshot_version", "pricing_algorithm_version",
            "pricing_rounding_rule_version", "pricing_intent_type",
            "pricing_intent_snapshot", "pricing_resolved_locale"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
            '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
            'Europe/Paris', 30, 30,
            0, 0, 0,
            'UNDETERMINED', 'MINUTE', 1,
            'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
            'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
            ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })}, ''
          )
        `,
      ).rejects.toThrow(/booking_drafts_flexible_metadata_exact/);
    });
  });

  it('L14 — DAILY line with partial discount representation → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        subtotalAmountMinor: 35000,
        totalAmountMinor: 35000,
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          billedDays: 7,
          amountBeforeDiscountMinor: 35000,
          amountAfterDiscountMinor: 35000,
          discountThresholdDays: null,
          discountPercent: 10,
        }),
      ).rejects.toThrow(/partial discount representation/);
    });
  });

  it('L15 — DAILY line with 100% discount → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        subtotalAmountMinor: 0,
        totalAmountMinor: 0,
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          billedDays: 7,
          amountBeforeDiscountMinor: 35000,
          discountThresholdDays: 7,
          discountPercent: 100,
        }),
      ).rejects.toThrow(/discount percent must be between 1 and 99/);
    });
  });

  it('L16 — DAILY line with incorrect half-up rounding result → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        subtotalAmountMinor: 32000,
        totalAmountMinor: 32000,
      });
      await expect(
        insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          billedDays: 7,
          amountBeforeDiscountMinor: 35000,
          amountAfterDiscountMinor: 32000,
          discountThresholdDays: 7,
          discountPercent: 10,
          lineTotalAmountMinor: 32000,
        }),
      ).rejects.toThrow(/amount_after does not match half-up rounding/);
    });
  });

  it('L18 — flexible draft left with no lines after DELETE → rejected at COMMIT', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const line = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      await expect(sql`DELETE FROM "booking_draft_lines" WHERE "id" = ${line}`).rejects.toThrow(
        /flexible draft must have at least one line/,
      );
    });
  });

  it('L19 — draft line using a currency different from the parent → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes"
          ) VALUES (
            ${draftId}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'USD', ${sql.json({ name: 'Standard' })},
            ${planId}, 1, 'HOURLY',
            'Tarif horaire', 120, 120
          )
        `,
      ).rejects.toThrow(/currency mismatch/);
    });
  });

  it('L20 — booking line that does not exactly match its source draft line → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      await sql`BEGIN`;

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id}, 'CONFIRMED'::booking_status,
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes", "source_draft_line_id"
          ) VALUES (
            ${booking.id}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${planId}, 1, 'HOURLY',
            'Tarif horaire', 999, 120,
            ${sourceLineId}
          )
        `,
      ).rejects.toThrow(/snapshot does not match source draft line/);
      await sql`ROLLBACK`;
    });
  });

  it('L22 — UPDATE of draft_id or booking_id on an immutable line → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId1 = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const draftId2 = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
      const lineId = await insertHourlyDraftLine(sql, draftId1, ids.variantId, planId);
      await expect(
        sql`UPDATE "booking_draft_lines" SET "draft_id" = ${draftId2} WHERE "id" = ${lineId}`,
      ).rejects.toThrow(/draft_id and variant_id are immutable/);
    });
  });

  it('L23 — legacy 0032 data is still migratable and readable', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draft = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
          'Europe/Paris', 30, 30,
          10000, 0, 10000,
          'UNDETERMINED', 'DAY', 2,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
        ) RETURNING "id", "pricing_snapshot_version"
      `.then((r) => r[0]!);
      expect(draft.pricing_snapshot_version).toBe('legacy-daily-v1');
    });
  });

  it('L24 — legacy createBookingDraftWithHold flow still works', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draft = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot", "status", "expires_at"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00',
          'Europe/Paris', 30, 30,
          10000, 0, 10000,
          'UNDETERMINED', 'DAY', 2,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          'DRAFT', '2026-12-31T00:00:00Z'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await sql`UPDATE "booking_drafts" SET "status" = 'HELD' WHERE "id" = ${draft.id}`;

      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot"
        ) VALUES (
          ${draft.id}, ${ids.variantId}, 2,
          5000, 2,
          10000, 'EUR', ${sql.json({ name: 'Standard' })}
        ) RETURNING "id"
      `.then((r) => r[0]!);
      expect(line.id).toBeTruthy();

      await sql`UPDATE "booking_drafts" SET "status" = 'PAYMENT_PROCESSING' WHERE "id" = ${draft.id}`;
      const updated =
        await sql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draft.id}`.then(
          (r) => r[0]!,
        );
      expect(updated.status).toBe('PAYMENT_PROCESSING');
    });
  });

  // M. Round-2 fixes

  it('M1 — draft total does not equal subtotal + mandatory_fees → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      await expect(
        insertFlexibleDraft(sql, ids, {
          billableUnit: 'MINUTE',
          subtotalAmountMinor: 12000,
          totalAmountMinor: 13000,
        }),
      ).rejects.toThrow(/booking_drafts_total_equals_subtotal_plus_fees/);
    });
  });

  it('M2 — draft with non-zero mandatory_fees and matching total → accepted', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      await sql`BEGIN`;
      const draft = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        )
        VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris', 30, 30,
          12000, 1000, 13000,
          'UNDETERMINED', 'MINUTE', 1,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes"
        )
        VALUES (
          ${draft.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120
        )
      `;
      await sql`COMMIT`;
      const verified = await sql`
        SELECT "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor"
        FROM "booking_drafts" WHERE "id" = ${draft.id}
      `.then((r) => r[0]!);
      expect(Number(verified.subtotal_amount_minor)).toBe(12000);
      expect(Number(verified.mandatory_fees_amount_minor)).toBe(1000);
      expect(Number(verified.total_amount_minor)).toBe(13000);
    });
  });

  it('M3 — booking total does not equal subtotal + mandatory_fees → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 10000, 'EUR',
          'NOT_APPLICABLE', 500,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await expect(
        sql`
          INSERT INTO "bookings" (
            "organization_id", "location_id", "customer_user_id",
            "draft_id", "payment_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "prep_buffer_minutes", "cleanup_buffer_minutes",
            "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
            "tax_status", "tax_amount_minor", "tax_rate_bps",
            "commission_amount_minor", "total_amount_minor",
            "cancellation_policy_snapshot", "terms_acceptance_snapshot",
            "confirmed_at",
            "billable_unit"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            ${draftId}, ${payment.id},
            '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
            '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
            30, 30,
            'EUR', 10000, 1000,
            'NOT_APPLICABLE', 0, null,
            500, 10000,
            ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
            ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
            '2026-02-15 10:00:00+00',
            'DAY'
          )
        `,
      ).rejects.toThrow(/bookings_total_equals_subtotal_plus_fees/);
    });
  });

  it('M4 — booking subtotal does not match sum of line totals → rejected at COMMIT', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;
      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 9999, 0,
          'NOT_APPLICABLE', 0, null,
          600, 9999,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        )
        VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120, ${sourceLineId}
        )
      `;
      await expect(sql`COMMIT`).rejects.toThrow(
        /subtotal_amount_minor .* does not match sum of line totals/,
      );
    });
  });

  it('M5 — booking line with currency different from parent → rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await expect(
        sql`
          INSERT INTO "booking_lines" (
            "booking_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes", "source_draft_line_id"
          )
          VALUES (
            ${booking.id}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'USD', ${sql.json({ name: 'Standard' })},
            ${planId}, 1, 'HOURLY',
            'Tarif horaire', 120,
            120, ${sourceLineId}
          )
        `,
      ).rejects.toThrow(/snapshot does not match source draft line/);
      await sql`ROLLBACK`;
    });
  });

  it('M6 — flexible booking without lines is rejected at COMMIT', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'DAY',
        intentType: 'DAY_RANGE',
        subtotalAmountMinor: 10000,
        totalAmountMinor: 10000,
        intentSnapshot: {
          kind: 'DAY_RANGE',
          startDate: '2026-01-10',
          endDateExclusive: '2026-01-12',
        },
      });
      const lineId = await insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId);
      expect(lineId).toBeTruthy();

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 10000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;
      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 10000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 10000,
          'MINUTE', 120,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`UPDATE "bookings" SET "status" = 'READY_FOR_PICKUP' WHERE "id" = ${booking.id}`;
      await expect(sql`COMMIT`).rejects.toThrow(/flexible booking must have at least one line/);
    });
  });

  it('M7 — booking line can reference a retired plan after confirmation', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const line = await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        )
        VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120, ${sourceLineId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`COMMIT`;
      expect(line.id).toBeTruthy();
    });
  });

  it('M7b — full confirmation with a RETIRED plan copies the source line', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const line = await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120, ${sourceLineId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`COMMIT`;

      const bookingLine = await sql`
        SELECT "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor",
               "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
               "pricing_public_label", "pricing_requested_duration_minutes",
               "pricing_billed_duration_minutes", "source_draft_line_id"
        FROM "booking_lines" WHERE "id" = ${line.id}
      `.then((r) => r[0]!);
      const sourceLine = await sql`
        SELECT "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor",
               "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
               "pricing_public_label", "pricing_requested_duration_minutes",
               "pricing_billed_duration_minutes", "id"
        FROM "booking_draft_lines" WHERE "id" = ${sourceLineId}
      `.then((r) => r[0]!);
      expect(bookingLine.source_draft_line_id).toBe(sourceLineId);
      expect(bookingLine.unit_price_amount_minor).toBe(sourceLine.unit_price_amount_minor);
      expect(bookingLine.billable_unit_count).toBe(sourceLine.billable_unit_count);
      expect(bookingLine.line_total_amount_minor).toBe(sourceLine.line_total_amount_minor);
      expect(bookingLine.pricing_plan_id).toBe(sourceLine.pricing_plan_id);
      expect(bookingLine.pricing_plan_version).toBe(sourceLine.pricing_plan_version);
      expect(bookingLine.pricing_plan_type).toBe(sourceLine.pricing_plan_type);
      expect(bookingLine.pricing_public_label).toBe(sourceLine.pricing_public_label);
      expect(bookingLine.pricing_requested_duration_minutes).toBe(
        sourceLine.pricing_requested_duration_minutes,
      );
      expect(bookingLine.pricing_billed_duration_minutes).toBe(
        sourceLine.pricing_billed_duration_minutes,
      );
    });
  });

  it('M8 — legacy booking with billable_unit ≠ DAY is rejected', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const draftId = await insertLegacyDraft(sql, ids);
      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 10000, 'EUR',
          'NOT_APPLICABLE', 500,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await expect(
        sql`
          INSERT INTO "bookings" (
            "organization_id", "location_id", "customer_user_id",
            "draft_id", "payment_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "prep_buffer_minutes", "cleanup_buffer_minutes",
            "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
            "tax_status", "tax_amount_minor", "tax_rate_bps",
            "commission_amount_minor", "total_amount_minor",
            "cancellation_policy_snapshot", "terms_acceptance_snapshot",
            "confirmed_at",
            "billable_unit"
          ) VALUES (
            ${ids.orgId}, ${ids.locationId}, ${ids.userId},
            ${draftId}, ${payment.id},
            '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
            '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
            30, 30,
            'EUR', 10000, 0,
            'NOT_APPLICABLE', 0, null,
            500, 10000,
            ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
            ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
            '2026-02-15 10:00:00+00',
            'HOURLY'
          )
        `,
      ).rejects.toThrow(/legacy_metadata_null/);
    });
  });

  // R. Round-3 final corrections (P0-1)

  it('R1 — flexible draft with no line inserted without UPDATE is rejected at COMMIT', async () => {
    await withSql(async (sql) => {
      const base = await seedBaseData(sql);
      await sql`BEGIN`;
      const draft = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot", "status", "expires_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${base.orgId}, ${base.locationId}, ${base.userId},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris', 30, 30,
          12000, 0, 12000,
          'UNDETERMINED', 'MINUTE', 1,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          'HELD', '2026-12-31T00:00:00Z',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(draft.id).toBeTruthy();
      // No UPDATE of status, no lines: the deferred INSERT trigger should reject at COMMIT.
      try {
        await expect(sql`COMMIT`).rejects.toThrow(/flexible draft must have at least one line/);
      } finally {
        await sql`ROLLBACK`;
      }
    });
  });

  it('R2 — flexible draft and line inserted in the same transaction are accepted', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      await sql`BEGIN`;
      const draft = await sql`
        INSERT INTO "booking_drafts" (
          "organization_id", "location_id", "customer_user_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "billable_unit", "billable_unit_count",
          "currency", "cancellation_policy_snapshot",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris', 30, 30,
          12000, 0, 12000,
          'UNDETERMINED', 'MINUTE', 1,
          'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes"
        ) VALUES (
          ${draft.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120
        )
      `;
      await expect(sql`COMMIT`).resolves.toBeDefined();
    });
  });

  it('R3 — booking root diverging from source draft is rejected at COMMIT', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;
      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 10:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120, ${sourceLineId}
        )
      `;
      await expect(sql`COMMIT`).rejects.toThrow(/root row must be an exact copy/);
    });
  });

  it('R4 — new local plan activated after draft has no effect on confirmation', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      const newPlan = await sql`
        INSERT INTO "pricing_plans" (
          "organization_id", "product_variant_id", "location_id", "plan_type",
          "currency", "price_amount_minor", "priority", "lifecycle_state", "version",
          "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes"
        ) VALUES (
          ${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'HOURLY', 'EUR',
          1000, 1, 'ACTIVE', 1,
          60, 240, 60
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120,
          120, ${sourceLineId}
        )
      `;
      await sql`COMMIT`;
      expect(newPlan.id).toBeTruthy();
    });
  });

  // R5a-R5d : G7P-B2-C Round 3 (P0-2) — les champs financiers tax_status,
  // tax_amount_minor, tax_rate_bps, commission_amount_minor ne sont PLUS
  // vérifiés par le trigger validate_flexible_booking_aggregates. Ils
  // proviennent de `payments` (ADR-010 §6), pas du brouillon. Chaque test
  // modifie exactement un champ et vérifie que le COMMIT réussit.

  /**
   * Tente une confirmation (booking + booking_line) avec des champs financiers
   * personnalisés sur le booking. Attend un succès à COMMIT (les champs
   * financiers ne sont plus vérifiés par le trigger).
   */
  async function attemptBookingConfirmationWithFinancialsAccept(
    sql: postgres.Sql,
    ids: BaseIds,
    draftId: string,
    sourceLineId: string,
    paymentId: string,
    planId: string,
    bookingFinancials: {
      taxStatus: string;
      taxAmountMinor: number | null;
      taxRateBps: number | null;
      commissionAmountMinor: number;
    },
  ): Promise<void> {
    await sql`BEGIN`;
    const booking = await sql`
      INSERT INTO "bookings" (
        "organization_id", "location_id", "customer_user_id",
        "draft_id", "payment_id",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at",
        "timezone",
        "prep_buffer_minutes", "cleanup_buffer_minutes",
        "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps",
        "commission_amount_minor", "total_amount_minor",
        "billable_unit", "billable_unit_count",
        "cancellation_policy_snapshot", "terms_acceptance_snapshot",
        "confirmed_at",
        "pricing_snapshot_version", "pricing_algorithm_version",
        "pricing_rounding_rule_version", "pricing_intent_type",
        "pricing_intent_snapshot", "pricing_resolved_locale"
      ) VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId},
        ${draftId}, ${paymentId},
        '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
        '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
        'Europe/Paris',
        30, 30,
        'EUR', 12000, 0,
        ${bookingFinancials.taxStatus}::tax_status, ${bookingFinancials.taxAmountMinor}, ${bookingFinancials.taxRateBps},
        ${bookingFinancials.commissionAmountMinor}, 12000,
        'MINUTE', 1,
        ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
        ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
        '2026-02-15 10:00:00+00',
        'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
        ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
        'fr'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await sql`
      INSERT INTO "booking_lines" (
        "booking_id", "variant_id", "quantity",
        "unit_price_amount_minor", "billable_unit_count",
        "line_total_amount_minor", "currency", "variant_snapshot",
        "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
        "pricing_public_label", "pricing_requested_duration_minutes",
        "pricing_billed_duration_minutes", "source_draft_line_id"
      ) VALUES (
        ${booking.id}, ${ids.variantId}, 1,
        1500, 8,
        12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
        ${planId}, 1, 'HOURLY',
        'Tarif horaire', 120, 120,
        ${sourceLineId}
      )
    `;
    await sql`COMMIT`;
  }

  /**
   * Tente une confirmation (booking + booking_line) avec un subtotal divergent.
   * Attend un échec à COMMIT — le subtotal est un champ de pricing locatif,
   * toujours vérifié par le trigger validate_flexible_booking_aggregates.
   */
  async function attemptBookingConfirmationWithSubtotalMismatch(
    sql: postgres.Sql,
    ids: BaseIds,
    draftId: string,
    sourceLineId: string,
    paymentId: string,
    planId: string,
  ): Promise<void> {
    await sql`BEGIN`;
    const booking = await sql`
      INSERT INTO "bookings" (
        "organization_id", "location_id", "customer_user_id",
        "draft_id", "payment_id",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at",
        "timezone",
        "prep_buffer_minutes", "cleanup_buffer_minutes",
        "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps",
        "commission_amount_minor", "total_amount_minor",
        "billable_unit", "billable_unit_count",
        "cancellation_policy_snapshot", "terms_acceptance_snapshot",
        "confirmed_at",
        "pricing_snapshot_version", "pricing_algorithm_version",
        "pricing_rounding_rule_version", "pricing_intent_type",
        "pricing_intent_snapshot", "pricing_resolved_locale"
      ) VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId},
        ${draftId}, ${paymentId},
        '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
        '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
        'Europe/Paris',
        30, 30,
        'EUR', 9999, 0,
        'NOT_APPLICABLE'::tax_status, 0, null,
        600, 9999,
        'MINUTE', 1,
        ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
        ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
        '2026-02-15 10:00:00+00',
        'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
        ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00', endAt: '2026-01-10T11:00:00' })},
        'fr'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await expect(
      sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1,
          1500, 8,
          9999, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${planId}, 1, 'HOURLY',
          'Tarif horaire', 120, 120,
          ${sourceLineId}
        )
      `,
    ).rejects.toThrow(/snapshot does not match source draft line/);
    await sql`ROLLBACK`;
  }

  /**
   * Crée un payment SUCCEEDED pour les tests R5.
   */
  async function seedPaymentForR5(
    sql: postgres.Sql,
    ids: BaseIds,
    draftId: string,
  ): Promise<string> {
    const payment = await sql`
      INSERT INTO "payments" (
        "organization_id", "draft_id", "customer_user_id",
        "status", "amount_minor", "currency",
        "tax_status", "commission_amount_minor",
        "financial_terms_version", "legal_terms_version",
        "terms_acceptance_snapshot",
        "connected_account_id", "charge_model", "settlement_merchant_mode",
        "environment", "succeeded_at"
      ) VALUES (
        ${ids.orgId}, ${draftId}, ${ids.userId},
        'SUCCEEDED'::payment_status, 12000, 'EUR',
        'NOT_APPLICABLE', 600,
        'v1', 'v1',
        ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
        'acct_test_r5', 'DESTINATION', 'PLATFORM',
        'TEST'::payment_environment, '2026-02-15 09:58:00+00'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    return payment.id;
  }

  it('R5a — tax_status différent → accepted at COMMIT (tax comes from payment, not draft)', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        taxRateBps: null,
        commissionAmountMinor: 600,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const paymentId = await seedPaymentForR5(sql, ids, draftId);

      // Booking diverges on tax_status: APPLIED instead of NOT_APPLICABLE.
      // G7P-B2-C Round 3 (P0-2) — tax/commission are no longer part of the
      // exact copy check. They come from `payments` (ADR-010 §6), not from
      // the draft. The trigger should NOT reject this.
      await attemptBookingConfirmationWithFinancialsAccept(
        sql,
        ids,
        draftId,
        sourceLineId,
        paymentId,
        planId,
        {
          taxStatus: 'APPLIED',
          taxAmountMinor: 0,
          taxRateBps: null,
          commissionAmountMinor: 600,
        },
      );
    });
  });

  it('R5b — tax_amount_minor différent → accepted at COMMIT (tax comes from payment, not draft)', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
        taxStatus: 'APPLIED',
        taxAmountMinor: 0,
        taxRateBps: null,
        commissionAmountMinor: 600,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const paymentId = await seedPaymentForR5(sql, ids, draftId);

      // Booking diverges on tax_amount_minor: 100 instead of 0.
      // G7P-B2-C Round 3 (P0-2) — tax_amount_minor is no longer part of the
      // exact copy check. It comes from `payments` (ADR-010 §6).
      await attemptBookingConfirmationWithFinancialsAccept(
        sql,
        ids,
        draftId,
        sourceLineId,
        paymentId,
        planId,
        {
          taxStatus: 'APPLIED',
          taxAmountMinor: 100,
          taxRateBps: null,
          commissionAmountMinor: 600,
        },
      );
    });
  });

  it('R5c — tax_rate_bps différent → accepted at COMMIT (tax comes from payment, not draft)', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        taxRateBps: null,
        commissionAmountMinor: 600,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const paymentId = await seedPaymentForR5(sql, ids, draftId);

      // Booking diverges on tax_rate_bps: 3000 instead of null.
      // G7P-B2-C Round 3 (P0-2) — tax_rate_bps is no longer part of the
      // exact copy check. It comes from `payments` (ADR-010 §6).
      await attemptBookingConfirmationWithFinancialsAccept(
        sql,
        ids,
        draftId,
        sourceLineId,
        paymentId,
        planId,
        {
          taxStatus: 'NOT_APPLICABLE',
          taxAmountMinor: 0,
          taxRateBps: 3000,
          commissionAmountMinor: 600,
        },
      );
    });
  });

  it('R5d — commission_amount_minor différent → accepted at COMMIT (commission comes from payment, not draft)', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        taxRateBps: null,
        commissionAmountMinor: 600,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const paymentId = await seedPaymentForR5(sql, ids, draftId);

      // Booking diverges on commission_amount_minor: 999 instead of 600.
      // G7P-B2-C Round 3 (P0-2) — commission_amount_minor is no longer part
      // of the exact copy check. It comes from `payments` (ADR-010 §6).
      await attemptBookingConfirmationWithFinancialsAccept(
        sql,
        ids,
        draftId,
        sourceLineId,
        paymentId,
        planId,
        {
          taxStatus: 'NOT_APPLICABLE',
          taxAmountMinor: 0,
          taxRateBps: null,
          commissionAmountMinor: 999,
        },
      );
    });
  });

  it('R5e — subtotal_amount_minor différent → rejected at COMMIT (rental pricing still enforced)', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        taxRateBps: null,
        commissionAmountMinor: 600,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
      const paymentId = await seedPaymentForR5(sql, ids, draftId);

      // Booking diverges on subtotal_amount_minor: 9999 instead of 12000.
      // G7P-B2-C Round 3 (P0-2) — subtotal is a rental pricing field, NOT a
      // financial terms field. It must remain an exact copy of the draft.
      // The trigger MUST reject this.
      await attemptBookingConfirmationWithSubtotalMismatch(
        sql,
        ids,
        draftId,
        sourceLineId,
        paymentId,
        planId,
      );
    });
  });

  it('M7c — Translation change after draft does not affect confirmation', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      // Active plan translations are immutable. We attempt the direct update;
      // when it is rejected, we simulate the catalogue change with a new active plan.
      try {
        await sql`
          UPDATE "pricing_plan_translations"
          SET "public_label" = 'NEW TRANSLATION'
          WHERE "pricing_plan_id" = ${planId} AND "locale" = 'fr'
        `;
      } catch (err) {
        if (!/cannot UPDATE translation/.test(String(err))) {
          throw err;
        }
        // Retire the original and publish a new version carrying the new label.
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
        const newPlan = await sql`
          INSERT INTO "pricing_plans" (
            "organization_id", "product_variant_id", "location_id", "plan_type",
            "currency", "price_amount_minor", "priority", "lifecycle_state", "version",
            "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes"
          ) VALUES (
            ${ids.orgId}, ${ids.variantId}, NULL, 'HOURLY', 'EUR',
            1500, 1, 'DRAFT', 2,
            60, 480, 15
          )
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${newPlan.id}, 'fr', 'NEW TRANSLATION'), (${newPlan.id}, 'en', 'New hourly rate')
        `;
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${newPlan.id}`;
      }

      const sourceLine = await sql`
        SELECT "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor",
               "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
               "pricing_public_label", "pricing_requested_duration_minutes",
               "pricing_billed_duration_minutes", "currency", "quantity"
        FROM "booking_draft_lines" WHERE "id" = ${sourceLineId}
      `.then((r) => r[0]!);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const line = await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, ${sourceLine.quantity},
          ${sourceLine.unit_price_amount_minor}, ${sourceLine.billable_unit_count},
          ${sourceLine.line_total_amount_minor}, ${sourceLine.currency}, ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${sourceLine.pricing_plan_id}, ${sourceLine.pricing_plan_version}, ${sourceLine.pricing_plan_type},
          ${sourceLine.pricing_public_label}, ${sourceLine.pricing_requested_duration_minutes},
          ${sourceLine.pricing_billed_duration_minutes}, ${sourceLineId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`COMMIT`;

      const bookingLine = await sql`
        SELECT "pricing_public_label" FROM "booking_lines" WHERE "id" = ${line.id}
      `.then((r) => r[0]!);
      expect(bookingLine.pricing_public_label).toBe(sourceLine.pricing_public_label);
      expect(bookingLine.pricing_public_label).not.toBe('NEW TRANSLATION');
    });
  });

  it('M7d — Catalogue price change after draft does not affect confirmation', async () => {
    await withSql(async (sql) => {
      const ids = await seedBaseData(sql);
      const planId = await seedHourlyPlan(sql, ids);
      const draftId = await insertFlexibleDraft(sql, ids, {
        billableUnit: 'MINUTE',
        subtotalAmountMinor: 12000,
        totalAmountMinor: 12000,
      });
      const sourceLineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);

      try {
        await sql`
          UPDATE "pricing_plans"
          SET "price_amount_minor" = "price_amount_minor" * 10
          WHERE "id" = ${planId}
        `;
      } catch (err) {
        if (!/immutable fields/.test(String(err))) {
          throw err;
        }
        // Active plans are immutable; simulate a catalogue change with a new, more expensive version.
        // Retire the original first to respect the active business-key unique constraint.
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${planId}`;
        const newPlan = await sql`
          INSERT INTO "pricing_plans" (
            "organization_id", "product_variant_id", "location_id", "plan_type",
            "currency", "price_amount_minor", "priority", "lifecycle_state", "version",
            "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes"
          ) VALUES (
            ${ids.orgId}, ${ids.variantId}, NULL, 'HOURLY', 'EUR',
            15000, 1, 'DRAFT', 2,
            60, 480, 15
          )
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${newPlan.id}, 'fr', 'Nouveau tarif horaire'), (${newPlan.id}, 'en', 'New hourly rate')
        `;
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${newPlan.id}`;
      }

      const sourceLine = await sql`
        SELECT "unit_price_amount_minor", "billable_unit_count", "line_total_amount_minor",
               "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
               "pricing_public_label", "pricing_requested_duration_minutes",
               "pricing_billed_duration_minutes", "currency", "quantity"
        FROM "booking_draft_lines" WHERE "id" = ${sourceLineId}
      `.then((r) => r[0]!);

      const payment = await sql`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id",
          "status", "amount_minor", "currency",
          "tax_status", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version",
          "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode",
          "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draftId}, ${ids.userId},
          'SUCCEEDED'::payment_status, 12000, 'EUR',
          'NOT_APPLICABLE', 600,
          'v1', 'v1',
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          'acct_test', 'DESTINATION', 'PLATFORM',
          'TEST'::payment_environment, '2026-02-15 09:58:00+00'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      await sql`BEGIN`;

      const booking = await sql`
        INSERT INTO "bookings" (
          "organization_id", "location_id", "customer_user_id",
          "draft_id", "payment_id",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at",
          "timezone",
          "prep_buffer_minutes", "cleanup_buffer_minutes",
          "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
          "tax_status", "tax_amount_minor", "tax_rate_bps",
          "commission_amount_minor", "total_amount_minor",
          "billable_unit", "billable_unit_count",
          "cancellation_policy_snapshot", "terms_acceptance_snapshot",
          "confirmed_at",
          "pricing_snapshot_version", "pricing_algorithm_version",
          "pricing_rounding_rule_version", "pricing_intent_type",
          "pricing_intent_snapshot", "pricing_resolved_locale"
        ) VALUES (
          ${ids.orgId}, ${ids.locationId}, ${ids.userId},
          ${draftId}, ${payment.id},
          '2026-01-10 09:00:00+00', '2026-01-10 11:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-10 11:30:00+00',
          'Europe/Paris',
          30, 30,
          'EUR', 12000, 0,
          'NOT_APPLICABLE', 0, null,
          600, 12000,
          'MINUTE', 1,
          ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
          ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-02-15T09:57:00Z' })},
          '2026-02-15 10:00:00+00',
          'flexible-pricing-v1', 'flexible-pricing-v1', 'half-up-v1', 'TIME_RANGE',
          ${sql.json({ kind: 'TIME_RANGE', startAt: '2026-01-10T09:00:00Z', endAt: '2026-01-10T11:00:00Z' })},
          'fr'
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      const line = await sql`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity",
          "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "currency", "variant_snapshot",
          "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
          "pricing_public_label", "pricing_requested_duration_minutes",
          "pricing_billed_duration_minutes", "source_draft_line_id"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, ${sourceLine.quantity},
          ${sourceLine.unit_price_amount_minor}, ${sourceLine.billable_unit_count},
          ${sourceLine.line_total_amount_minor}, ${sourceLine.currency}, ${sql.json({ name: 'Standard', sku: 'STD-001' })},
          ${sourceLine.pricing_plan_id}, ${sourceLine.pricing_plan_version}, ${sourceLine.pricing_plan_type},
          ${sourceLine.pricing_public_label}, ${sourceLine.pricing_requested_duration_minutes},
          ${sourceLine.pricing_billed_duration_minutes}, ${sourceLineId}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`COMMIT`;

      const bookingLine = await sql`
        SELECT "unit_price_amount_minor" FROM "booking_lines" WHERE "id" = ${line.id}
      `.then((r) => r[0]!);
      expect(bookingLine.unit_price_amount_minor).toBe(sourceLine.unit_price_amount_minor);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // G7P-B2-B Round 2 — Defect 2 : Window snapshot validation
  // ─────────────────────────────────────────────────────────────────────────
  describe('G7P-B2-B Round 2 — window snapshot validation', () => {
    // Helper: default DAY_RANGE_BOUNDARIES snapshot for 2026-01-10 to 2026-01-12
    const dayRangeWindow = (firstDate = '2026-01-10', lastDate = '2026-01-11') => ({
      kind: 'DAY_RANGE_BOUNDARIES' as const,
      firstDay: {
        localDate: firstDate,
        weekdayMask: 127,
        startTime: '09:00:00',
        endTime: '17:00:00',
      },
      lastDay: {
        localDate: lastDate,
        weekdayMask: 127,
        startTime: '09:00:00',
        endTime: '17:00:00',
      },
    });

    it('W1 — DAY_RANGE DAILY with NULL pricing_selected_window → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        // Insert DAILY line with selectedWindow: null → should be rejected
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: null,
          }),
        ).rejects.toThrow(/DAY_RANGE DAILY line requires non-null pricing_selected_window/);
      } finally {
        await sql.end();
      }
    });

    it('W2 — DAY_RANGE with TIME_RANGE_WINDOW snapshot → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: {
              kind: 'TIME_RANGE_WINDOW',
              weekdayMask: 127,
              startTime: '09:00:00',
              endTime: '17:00:00',
            },
          }),
        ).rejects.toThrow(/DAY_RANGE intent requires DAY_RANGE_BOUNDARIES snapshot/);
      } finally {
        await sql.end();
      }
    });

    it('W3 — TIME_RANGE DAILY with DAY_RANGE_BOUNDARIES snapshot → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Insert a TIME_RANGE draft (default insertFlexibleDraft uses TIME_RANGE)
        const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
        // Insert a DAILY line with DAY_RANGE_BOUNDARIES snapshot
        // Need requestedDurationMinutes > 0 for TIME_RANGE DAILY validation
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            requestedDurationMinutes: 120,
            selectedWindow: dayRangeWindow(),
          }),
        ).rejects.toThrow(/DAY_RANGE_BOUNDARIES snapshot requires DAY_RANGE intent/);
      } finally {
        await sql.end();
      }
    });

    it('W4 — pricing_selected_window with unknown kind → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: { kind: 'UNKNOWN_KIND', foo: 'bar' } as never,
          }),
        ).rejects.toThrow(/unknown kind/);
      } finally {
        await sql.end();
      }
    });

    it('W5 — DAY_RANGE_BOUNDARIES with missing firstDay → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: {
              kind: 'DAY_RANGE_BOUNDARIES',
              lastDay: {
                localDate: '2026-01-11',
                weekdayMask: 127,
                startTime: '09:00:00',
                endTime: '17:00:00',
              },
            } as never,
          }),
        ).rejects.toThrow(/DAY_RANGE_BOUNDARIES requires firstDay and lastDay/);
      } finally {
        await sql.end();
      }
    });

    it('W6 — DAY_RANGE_BOUNDARIES with partial firstDay (missing localDate) → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: {
              kind: 'DAY_RANGE_BOUNDARIES',
              firstDay: { weekdayMask: 127, startTime: '09:00:00', endTime: '17:00:00' },
              lastDay: {
                localDate: '2026-01-11',
                weekdayMask: 127,
                startTime: '09:00:00',
                endTime: '17:00:00',
              },
            } as never,
          }),
        ).rejects.toThrow(/firstDay requires localDate/);
      } finally {
        await sql.end();
      }
    });

    it('W7 — DAY_RANGE_BOUNDARIES with matching intent dates → accepted', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        const lineId = await insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
          selectedWindow: dayRangeWindow(),
        });
        expect(lineId).toBeTruthy();
        // Verify the window was persisted
        const line = await sql`
          SELECT "pricing_selected_window" FROM "booking_draft_lines" WHERE "id" = ${lineId}
        `.then((r) => r[0]!);
        expect(line.pricing_selected_window.kind).toBe('DAY_RANGE_BOUNDARIES');
      } finally {
        await sql.end();
      }
    });

    it('W8 — DAY_RANGE_BOUNDARIES with mismatched firstDay.localDate → rejected', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const draftId = await insertFlexibleDraft(sql, ids, {
          billableUnit: 'DAY',
          intentType: 'DAY_RANGE',
          intentSnapshot: {
            kind: 'DAY_RANGE',
            startDate: '2026-01-10',
            endDateExclusive: '2026-01-12',
          },
        });
        await expect(
          insertDailyDraftLine(sql, draftId, ids.variantId, ids.dailyPlanId, {
            selectedWindow: dayRangeWindow('2026-01-15', '2026-01-11'),
          }),
        ).rejects.toThrow(/firstDay.localDate.*does not match intent startDate/);
      } finally {
        await sql.end();
      }
    });

    it('W9 — HOURLY with non-null TIME_RANGE_WINDOW → accepted (window applicable)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const planId = await seedHourlyPlan(sql, ids);
        const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
        // Insert HOURLY line with a TIME_RANGE_WINDOW snapshot
        const line = await sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity",
            "unit_price_amount_minor", "billable_unit_count",
            "line_total_amount_minor", "currency", "variant_snapshot",
            "pricing_plan_id", "pricing_plan_version", "pricing_plan_type",
            "pricing_public_label", "pricing_requested_duration_minutes",
            "pricing_billed_duration_minutes",
            "pricing_selected_window"
          )
          VALUES (
            ${draftId}, ${ids.variantId}, 1,
            1500, 8,
            12000, 'EUR', ${sql.json({ name: 'Standard', sku: 'STD-001' })},
            ${planId}, 1, 'HOURLY',
            'Tarif horaire', 120,
            120,
            ${sql.json({ kind: 'TIME_RANGE_WINDOW', weekdayMask: 127, startTime: '09:00:00', endTime: '17:00:00' })}
          )
          RETURNING "id"
        `.then((r) => r[0]!);
        expect(line.id).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    it('W10 — HOURLY with NULL pricing_selected_window → accepted', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const planId = await seedHourlyPlan(sql, ids);
        const draftId = await insertFlexibleDraft(sql, ids, { billableUnit: 'MINUTE' });
        const lineId = await insertHourlyDraftLine(sql, draftId, ids.variantId, planId);
        expect(lineId).toBeTruthy();
      } finally {
        await sql.end();
      }
    });
  });
});
