import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertLocalhost } from '../src/index';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(packageRoot, 'drizzle');
const migration0049Path = join(migrationsDir, '0049_split_marketplace_fees.sql');
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';
const shouldSkip = !ci && (!url || process.env.SKIP_INTEGRATION_TESTS === '1');

function migrationNumber(fileName: string): number {
  return Number.parseInt(fileName.slice(0, 4), 10);
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

async function applyMigrationsThrough(sql: postgres.Sql, lastMigration: number): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((fileName) => /^\d{4}_.*\.sql$/.test(fileName))
    .filter((fileName) => migrationNumber(fileName) <= lastMigration)
    .sort();

  for (const fileName of files) {
    await sql.unsafe(readFileSync(join(migrationsDir, fileName), 'utf8'));
  }
}

interface SeededRows {
  draftId: string;
  organizationId: string;
  userId: string;
}

async function seedRows(sql: postgres.Sql, split: boolean): Promise<SeededRows> {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organization = await sql`
    INSERT INTO organizations (legal_name, slug, default_currency)
    VALUES (${`Split test ${suffix}`}, ${`split-test-${suffix}`}, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const user = await sql`
    INSERT INTO users (email)
    VALUES (${`split-test-${suffix}@example.com`})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await sql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${organization.id}, 'Test location', ${`split-location-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);

  const snapshot = {
    ruleVersion: 'split-13-7-v1',
    roundingRule: 'HALF_UP_PER_COMPONENT',
    marketplaceFeeBaseAmountMinor: 10000,
    merchantRateBps: 1300,
    merchantFeeAmountMinor: 1300,
    customerRateBps: 700,
    customerServiceFeeAmountMinor: 700,
    customerTotalAmountMinor: 10700,
    merchantNetAmountMinor: 8700,
    platformApplicationFeeAmountMinor: 2000,
  };
  const draft = await sql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, commission_amount_minor, billable_unit,
      billable_unit_count, cancellation_policy_snapshot, expires_at,
      customer_total_amount_minor, marketplace_fee_snapshot
    )
    VALUES (
      ${organization.id}, ${location.id}, ${user.id}, 'HELD',
      '2030-01-01T09:00:00Z', '2030-01-01T17:00:00Z',
      '2030-01-01T08:30:00Z', '2030-01-01T17:30:00Z',
      'Europe/Paris', 30, 30, 'EUR', 10000, 0, 10000,
      'NOT_APPLICABLE', 0, 0, 'DAY', 1,
      ${sql.json({ policy: 'FLEXIBLE', version: '1' })},
      '2030-01-01T08:00:00Z',
      ${split ? 10700 : null}, ${split ? sql.json(snapshot) : null}
    )
    RETURNING id
  `.then((rows) => rows[0]!);

  return { draftId: draft.id, organizationId: organization.id, userId: user.id };
}

describe.skipIf(shouldSkip)('migration 0049 — preuve PostgreSQL ciblée', () => {
  const databaseName = `uttily_test_split_marketplace_fees_${process.pid}_${Date.now()}`;
  let testUrl: string | null = null;
  let sql: postgres.Sql | null = null;

  beforeAll(async () => {
    if (!url) throw new Error('CI: DATABASE_URL est requise pour le test split-fee.');
    assertLocalhost(url);
    if (!(await checkConnectivity(url))) {
      throw new Error('DATABASE_URL est définie mais PostgreSQL est injoignable.');
    }

    const adminSql = postgres(url, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${databaseName}`);
    await adminSql.end();

    const testUrlObject = new URL(url);
    testUrlObject.pathname = `/${databaseName}`;
    testUrl = testUrlObject.toString();
    sql = postgres(testUrl, { max: 1 });
    await applyMigrationsThrough(sql, 48);

    const before0049 = await sql`
      SELECT p.proname, pg_get_functiondef(p.oid) AS function_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'validate_marketplace_fee_snapshot_immutability',
          'validate_split_marketplace_fee_snapshot_immutability'
        )
    `;
    expect(before0049).toHaveLength(0);

    const historicalGuard = await sql`
      SELECT pg_get_functiondef(p.oid) AS function_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'enforce_booking_financial_immutability'
    `;
    expect(historicalGuard).toHaveLength(1);
    expect(historicalGuard[0]!.function_def).toContain('bookings: financial snapshot is immutable');

    const historicalTrigger = await sql`
      SELECT pg_get_triggerdef(t.oid) AS trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'bookings'
        AND t.tgname = 'before_check_booking_financial_immutability'
    `;
    expect(historicalTrigger).toHaveLength(1);
    expect(historicalTrigger[0]!.trigger_def).toContain(
      'EXECUTE FUNCTION enforce_booking_financial_immutability()',
    );

    await sql.unsafe(readFileSync(migration0049Path, 'utf8'));
  });

  afterAll(async () => {
    await sql?.end();
    if (!url || !testUrl) return;
    const adminSql = postgres(url, { max: 1 });
    try {
      await adminSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
      );
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    } finally {
      await adminSql.end();
    }
  });

  it('installe les trois triggers split sur la fonction spécifique et préserve le guard historique', async () => {
    if (!sql) throw new Error('PostgreSQL test setup unavailable');
    const functions = await sql`
      SELECT proname, pg_get_functiondef(oid) AS function_def
      FROM pg_proc
      WHERE proname IN ('validate_marketplace_fee_snapshot_immutability', 'validate_split_marketplace_fee_snapshot_immutability')
      ORDER BY proname
    `;
    expect(functions.map((row) => row.proname)).toEqual([
      'validate_split_marketplace_fee_snapshot_immutability',
    ]);
    expect(functions[0]!.function_def).toContain('to_jsonb(NEW)');

    const triggers = await sql`
      SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND n.nspname = 'public'
        AND t.tgname IN (
          'booking_drafts_marketplace_fee_snapshot_immutable',
          'payments_marketplace_fee_snapshot_immutable',
          'bookings_marketplace_fee_snapshot_immutable'
        )
      ORDER BY c.relname
    `;
    expect(triggers).toHaveLength(3);
    for (const row of triggers) {
      expect(row.trigger_def).toContain(
        'EXECUTE FUNCTION validate_split_marketplace_fee_snapshot_immutability()',
      );
    }
  });

  it('ne remplace pas une fonction historique homonyme lors d’un rejeu', async () => {
    if (!sql) throw new Error('PostgreSQL test setup unavailable');
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION validate_marketplace_fee_snapshot_immutability()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'historical guard sentinel';
      END;
      $$
    `);

    await sql.unsafe(readFileSync(migration0049Path, 'utf8'));
    const historical = await sql`
      SELECT pg_get_functiondef(p.oid) AS function_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'validate_marketplace_fee_snapshot_immutability'
    `;
    expect(historical).toHaveLength(1);
    expect(historical[0]!.function_def).toContain('historical guard sentinel');
  });

  it('rejette une mutation legacy et une mutation d’un nouveau champ split', async () => {
    if (!sql) throw new Error('PostgreSQL test setup unavailable');
    const legacy = await seedRows(sql, false);
    await expect(
      sql`UPDATE booking_drafts SET subtotal_amount_minor = 10001 WHERE id = ${legacy.draftId}`,
    ).rejects.toThrow(/financial snapshot is immutable/);

    const split = await seedRows(sql, true);
    await expect(
      sql`UPDATE booking_drafts SET marketplace_fee_snapshot = ${sql.json({ changed: true })} WHERE id = ${split.draftId}`,
    ).rejects.toThrow(/marketplace fee snapshot is immutable/);
    await expect(
      sql`UPDATE booking_drafts SET customer_total_amount_minor = 10701 WHERE id = ${split.draftId}`,
    ).rejects.toThrow(/marketplace fee snapshot is immutable/);
  });

  it('autorise la mise à jour de status sur payments sans colonnes customer-total', async () => {
    if (!sql) throw new Error('PostgreSQL test setup unavailable');
    const seeded = await seedRows(sql, false);
    const payment = await sql`
      INSERT INTO payments (
        organization_id, draft_id, customer_user_id, status, amount_minor,
        currency, tax_status, tax_amount_minor, commission_amount_minor,
        financial_terms_version, legal_terms_version, terms_acceptance_snapshot,
        connected_account_id, charge_model, settlement_merchant_mode, environment
      )
      VALUES (
        ${seeded.organizationId}, ${seeded.draftId}, ${seeded.userId},
        'PENDING_PROVIDER', 10000, 'EUR', 'NOT_APPLICABLE', 0, 0,
        'v1', 'v1', ${sql.json({ version: 'v1' })},
        'acct_split_test', 'DESTINATION', 'PLATFORM', 'TEST'
      )
      RETURNING id
    `.then((rows) => rows[0]!);

    await sql`UPDATE payments SET status = 'FAILED' WHERE id = ${payment.id}`;
    const result = await sql`SELECT status FROM payments WHERE id = ${payment.id}`;
    expect(result[0]!.status).toBe('FAILED');
  });
});
