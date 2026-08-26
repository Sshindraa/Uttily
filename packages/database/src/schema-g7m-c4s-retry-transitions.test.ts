import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { assertLocalhost, runMigrations } from '../src/index';

/**
 * Tests PostgreSQL ciblés pour G7M-C4-S (ADR-023, migration 0037).
 *
 * Ce fichier couvre uniquement les transitions de schéma nécessaires au futur
 * cycle de vie C4-A. Il ne teste ni worker, ni cron, ni webhook, ni service
 * métier de retry.
 */

const TEST_DB_NAME = 'uttily_test_g7m_c4s';
const UPGRADE_DB_NAME = 'uttily_test_g7m_c4s_upgrade';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  return !url || process.env.SKIP_INTEGRATION_TESTS === '1';
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
let upgradeUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour les tests G7M-C4-S.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  if (!(await checkConnectivity(url))) {
    throw new Error('DATABASE_URL est définie mais PostgreSQL est injoignable.');
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${UPGRADE_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  const upgradeUrlObj = new URL(url);
  upgradeUrlObj.pathname = `/${UPGRADE_DB_NAME}`;
  upgradeUrl = upgradeUrlObj.toString();
  await runMigrations(testUrl);
}, 600000);

afterAll(async () => {
  if (!url) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    for (const dbName of [TEST_DB_NAME, UPGRADE_DB_NAME]) {
      await cleanupSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      );
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${dbName};`);
    }
  } finally {
    await cleanupSql.end();
  }
});

interface FixtureIds {
  organizationId: string;
  userId: string;
  bookingId: string;
  amendmentId: string;
  paymentId: string;
  attemptId: string;
}

async function seedPaymentFixture(
  sql: postgres.Sql,
  suffix: string,
  amendmentStatus = 'HOLD_PENDING',
  amendmentType: 'SUPPLEMENT' | 'NEUTRAL' = 'SUPPLEMENT',
): Promise<FixtureIds> {
  const organization = await sql`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${`C4-S ${suffix}`}, ${`c4s-${suffix}`})
    RETURNING id
  `.then((rows) => rows[0]!);
  const user = await sql`
    INSERT INTO users (email)
    VALUES (${`c4s-${suffix}@example.com`})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await sql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${organization.id}, 'Annecy', ${`c4s-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const draft = await sql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, billable_unit, billable_unit_count,
      currency, cancellation_policy_snapshot
    )
    VALUES (
      ${organization.id}, ${location.id}, ${user.id},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, 'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1' })}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const bookingPayment = await sql`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status,
      amount_minor, currency, tax_status, tax_amount_minor,
      commission_amount_minor, financial_terms_version, legal_terms_version,
      terms_acceptance_snapshot, connected_account_id, settlement_merchant_mode,
      environment
    )
    VALUES (
      ${organization.id}, ${draft.id}, ${user.id}, 'PENDING_PROVIDER',
      10000, 'EUR', 'NOT_APPLICABLE', 0,
      500, '1', '1', ${sql.json({ version: '1' })},
      'acct_booking', 'CONNECTED_ACCOUNT', 'TEST'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await sql`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id,
      status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, tax_status,
      tax_amount_minor, commission_amount_minor, total_amount_minor,
      cancellation_policy_snapshot, terms_acceptance_snapshot, confirmed_at
    )
    VALUES (
      ${organization.id}, ${location.id}, ${user.id}, ${draft.id}, ${bookingPayment.id},
      'CONFIRMED', '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      30, 30, 'EUR', 10000, 0, 'NOT_APPLICABLE', 0, 500, 10000,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1' })},
      ${sql.json({ version: '1', user_id: user.id })}, '2026-01-01 12:00:00+00'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const amendment = await sql`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at,
      new_blocked_start_at, new_blocked_end_at, hold_deadline, created_by,
      created_at
    )
    VALUES (
      ${organization.id}, ${booking.id}, 1, ${amendmentType}, ${amendmentStatus},
      ${sql.json({ totalAmountMinor: 10000 })},
      ${sql.json({ totalAmountMinor: 12000, supplementAmountMinor: 2000 })},
      '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
      '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
      ${amendmentType === 'SUPPLEMENT' ? '2026-01-01 12:10:00+00' : null}, ${user.id}, '2026-01-01 12:00:00+00'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  if (amendmentType === 'NEUTRAL') {
    return {
      organizationId: organization.id,
      userId: user.id,
      bookingId: booking.id,
      amendmentId: amendment.id,
      paymentId: '',
      attemptId: '',
    };
  }

  const payment = await sql`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id,
      amount_minor, currency, environment, connected_account_id,
      charge_model, settlement_merchant_mode
    )
    VALUES (
      ${organization.id}, ${booking.id}, ${amendment.id}, ${user.id},
      2000, 'EUR', 'TEST', 'acct_test', 'DESTINATION', 'CONNECTED_ACCOUNT'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const attempt = await sql`
    INSERT INTO amendment_payment_attempts (
      organization_id, amendment_payment_id, attempt_number, status,
      provider_idempotency_key
    )
    VALUES (${organization.id}, ${payment.id}, 1, 'PENDING_PROVIDER', ${`c4s-attempt-${suffix}`})
    RETURNING id
  `.then((rows) => rows[0]!);

  return {
    organizationId: organization.id,
    userId: user.id,
    bookingId: booking.id,
    amendmentId: amendment.id,
    paymentId: payment.id,
    attemptId: attempt.id,
  };
}

async function markPaymentFailed(sql: postgres.Sql, ids: FixtureIds): Promise<void> {
  await sql`
    UPDATE amendment_payment_attempts
    SET status = 'FAILED', provider_payment_intent_id = ${`pi-failed-${ids.paymentId}`},
        provider_status = 'requires_payment_method', last_provider_error_code = 'card_declined'
    WHERE id = ${ids.attemptId}
  `;
  await sql`
    UPDATE amendment_payments
    SET status = 'FAILED', failed_at = now(), updated_at = now()
    WHERE id = ${ids.paymentId}
  `;
}

async function seedReadyAmendment(sql: postgres.Sql, suffix: string): Promise<string> {
  const ids = await seedPaymentFixture(sql, suffix, 'READY_TO_APPLY', 'NEUTRAL');
  return ids.amendmentId;
}

async function runMigrationsFromFolder(dbUrl: string, folder: string): Promise<void> {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const migrationClient = postgres(dbUrl, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: folder });
  } finally {
    await migrationClient.end();
  }
}

async function createMigrationFolder(migrationCount: number): Promise<string> {
  const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } =
    await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { tmpdir } = await import('node:os');
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const tempDir = mkdtempSync(join(tmpdir(), 'g7m-c4s-upgrade-'));
  const tempMetaDir = join(tempDir, 'meta');
  mkdirSync(tempMetaDir, { recursive: true });

  for (const file of readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const number = Number.parseInt(file.slice(0, 4), 10);
    if (number >= 1 && number <= migrationCount) {
      copyFileSync(join(sourceDir, file), join(tempDir, file));
    }
  }
  for (const file of readdirSync(join(sourceDir, 'meta'))
    .filter((entry) => entry.endsWith('.json') && entry !== '_journal.json')
    .sort()) {
    const number = Number.parseInt(file.slice(0, 4), 10);
    if (number >= 1 && number <= migrationCount) {
      copyFileSync(join(sourceDir, 'meta', file), join(tempMetaDir, file));
    }
  }
  const journal = JSON.parse(readFileSync(join(sourceDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  journal.entries = journal.entries.slice(0, migrationCount);
  writeFileSync(join(tempMetaDir, '_journal.json'), JSON.stringify(journal, null, 2));
  return tempDir;
}

async function appendMigration(folder: string, index: number): Promise<void> {
  const { copyFileSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const journal = JSON.parse(readFileSync(join(sourceDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries[index];
  if (!entry) throw new Error(`Migration index ${index} not found`);
  copyFileSync(join(sourceDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  const snapshot = `${entry.tag}.json`;
  if (readdirSync(join(sourceDir, 'meta')).includes(snapshot)) {
    copyFileSync(join(sourceDir, 'meta', snapshot), join(folder, 'meta', snapshot));
  }
  const tempJournal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  tempJournal.entries = journal.entries.slice(0, index + 1);
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(tempJournal, null, 2));
}

async function migrationCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  return rows[0]!.count;
}

describe.skipIf(shouldSkipIntegrationTests())('G7M-C4-S — transitions PostgreSQL', () => {
  it('applique 0037 après les 36 migrations historiques', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      expect(await migrationCount(sql)).toBe(39);
      const rows = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
      expect(rows).toHaveLength(39);
      const { readFileSync } = await import('node:fs');
      const { dirname, join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const journalPath = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'drizzle',
        'meta',
        '_journal.json',
      );
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ tag: string }>;
      };
      expect(journal.entries[36]!.tag).toBe('0037_g7m_c4_supplement_retry_transitions');
    } finally {
      await sql.end();
    }
  });

  it('autorise READY_TO_APPLY → EXPIRED et rejette les transitions interdites', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const amendmentId = await seedReadyAmendment(sql, 'expire');
      await sql`
        UPDATE booking_amendments
        SET status = 'EXPIRED', expired_at = now(), updated_at = now()
        WHERE id = ${amendmentId}
      `;
      await expect(
        sql`UPDATE booking_amendments SET status = 'READY_TO_APPLY', updated_at = now() WHERE id = ${amendmentId}`,
      ).rejects.toThrow();

      const forbiddenId = await seedReadyAmendment(sql, 'forbidden');
      await expect(
        sql`UPDATE booking_amendments SET status = 'HOLD_PENDING', updated_at = now() WHERE id = ${forbiddenId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('conserve les états terminaux des amendements', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const amendmentId = await seedReadyAmendment(sql, 'terminal');
      await sql`
        UPDATE booking_amendments
        SET status = 'APPLIED', applied_at = now(), updated_at = now()
        WHERE id = ${amendmentId}
      `;
      await expect(
        sql`UPDATE booking_amendments SET status = 'FAILED', failed_at = now(), updated_at = now() WHERE id = ${amendmentId}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('réarme FAILED uniquement avec un nouvel attempt N+1 PENDING_PROVIDER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedPaymentFixture(sql, 'retry');
      await markPaymentFailed(sql, ids);
      await expect(
        sql`UPDATE amendment_payments SET status = 'PENDING_PROVIDER', updated_at = now() WHERE id = ${ids.paymentId}`,
      ).rejects.toThrow();

      await sql`
        INSERT INTO amendment_payment_attempts (
          organization_id, amendment_payment_id, attempt_number, status,
          provider_idempotency_key
        )
        VALUES (${ids.organizationId}, ${ids.paymentId}, 2, 'PENDING_PROVIDER', 'c4s-retry-valid')
      `;
      await sql`
        UPDATE amendment_payments
        SET status = 'PENDING_PROVIDER', failed_at = NULL, updated_at = now()
        WHERE id = ${ids.paymentId}
      `;
      const payment =
        await sql`SELECT status, failed_at FROM amendment_payments WHERE id = ${ids.paymentId}`;
      const attempts = await sql`
        SELECT attempt_number, status, provider_payment_intent_id, provider_status
        FROM amendment_payment_attempts
        WHERE amendment_payment_id = ${ids.paymentId}
        ORDER BY attempt_number
      `;
      expect(payment[0]).toMatchObject({ status: 'PENDING_PROVIDER', failed_at: null });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        attempt_number: 1,
        status: 'FAILED',
        provider_status: 'requires_payment_method',
      });
      expect(attempts[1]).toMatchObject({
        attempt_number: 2,
        status: 'PENDING_PROVIDER',
        provider_payment_intent_id: null,
        provider_status: null,
      });
    } finally {
      await sql.end();
    }
  });

  it('rejette un retry avec provider, sans attempt, non-increasing ou plusieurs nonterminaux', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedPaymentFixture(sql, 'invalid-retry');
      await markPaymentFailed(sql, ids);
      await expect(
        sql`
          INSERT INTO amendment_payment_attempts (
            organization_id, amendment_payment_id, attempt_number, status,
            provider_payment_intent_id, provider_status, provider_idempotency_key
          )
          VALUES (${ids.organizationId}, ${ids.paymentId}, 2, 'PENDING_PROVIDER', 'pi-already-set', 'requires_action', 'c4s-provider')
          RETURNING id
        `,
      ).resolves.toHaveLength(1);
      await expect(
        sql`UPDATE amendment_payments SET status = 'PENDING_PROVIDER', updated_at = now() WHERE id = ${ids.paymentId}`,
      ).rejects.toThrow();
      await sql`DELETE FROM amendment_payment_attempts WHERE amendment_payment_id = ${ids.paymentId} AND attempt_number = 2`;

      await expect(
        sql`
          INSERT INTO amendment_payment_attempts (
            organization_id, amendment_payment_id, attempt_number, status,
            provider_idempotency_key
          )
          VALUES (${ids.organizationId}, ${ids.paymentId}, 0, 'PENDING_PROVIDER', 'c4s-zero')
        `,
      ).rejects.toThrow();
      await expect(
        sql`
          INSERT INTO amendment_payment_attempts (
            organization_id, amendment_payment_id, attempt_number, status,
            provider_idempotency_key
          )
          VALUES (${ids.organizationId}, ${ids.paymentId}, 1, 'PENDING_PROVIDER', 'c4s-duplicate')
        `,
      ).rejects.toThrow();

      await sql`
        INSERT INTO amendment_payment_attempts (
          organization_id, amendment_payment_id, attempt_number, status,
          provider_idempotency_key
        )
        VALUES (${ids.organizationId}, ${ids.paymentId}, 2, 'PENDING_PROVIDER', 'c4s-nonterminal')
      `;
      await expect(
        sql`
          INSERT INTO amendment_payment_attempts (
            organization_id, amendment_payment_id, attempt_number, status,
            provider_idempotency_key
          )
          VALUES (${ids.organizationId}, ${ids.paymentId}, 3, 'PROCESSING', 'c4s-second-nonterminal')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette FAILED → PROCESSING et les retries depuis SUCCEEDED/CANCELLED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const failedIds = await seedPaymentFixture(sql, 'failed-processing');
      await markPaymentFailed(sql, failedIds);
      await expect(
        sql`UPDATE amendment_payments SET status = 'PROCESSING', updated_at = now() WHERE id = ${failedIds.paymentId}`,
      ).rejects.toThrow();

      for (const status of ['SUCCEEDED', 'CANCELLED'] as const) {
        const ids = await seedPaymentFixture(sql, `terminal-${status.toLowerCase()}`);
        if (status === 'SUCCEEDED') {
          await sql`UPDATE amendment_payments SET status = 'SUCCEEDED', succeeded_at = now(), updated_at = now() WHERE id = ${ids.paymentId}`;
        } else {
          await sql`UPDATE amendment_payments SET status = 'PROCESSING', processing_started_at = now(), updated_at = now() WHERE id = ${ids.paymentId}`;
          await sql`UPDATE amendment_payments SET status = 'CANCELLED', cancelled_at = now(), updated_at = now() WHERE id = ${ids.paymentId}`;
        }
        await expect(
          sql`UPDATE amendment_payments SET status = 'PENDING_PROVIDER', updated_at = now() WHERE id = ${ids.paymentId}`,
        ).rejects.toThrow();
      }
    } finally {
      await sql.end();
    }
  });

  it('préserve les snapshots du paiement et les identifiants provider des attempts', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedPaymentFixture(sql, 'immutable');
      await expect(
        sql`UPDATE amendment_payments SET amount_minor = 3000 WHERE id = ${ids.paymentId}`,
      ).rejects.toThrow();
      await markPaymentFailed(sql, ids);
      await expect(
        sql`UPDATE amendment_payment_attempts SET provider_payment_intent_id = 'pi-other' WHERE id = ${ids.attemptId}`,
      ).rejects.toThrow();
      const rows = await sql`
        SELECT amount_minor FROM amendment_payments WHERE id = ${ids.paymentId}
      `;
      expect(String(rows[0]!.amount_minor)).toBe('2000');
    } finally {
      await sql.end();
    }
  });

  it('sérialise deux retries concurrents sans deadlock et annule le perdant', async () => {
    if (!testUrl) return;
    const setup = postgres(testUrl, { max: 1 });
    const first = postgres(testUrl, { max: 1 });
    const second = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedPaymentFixture(setup, 'concurrent');
      await markPaymentFailed(setup, ids);
      const retry = async (client: postgres.Sql, key: string): Promise<'won' | 'lost'> => {
        try {
          await client.begin(async (tx) => {
            const payment = await tx`
              SELECT status FROM amendment_payments WHERE id = ${ids.paymentId} FOR UPDATE
            `;
            if (payment[0]!.status !== 'FAILED') throw new Error('retry already won');
            await tx`
              INSERT INTO amendment_payment_attempts (
                organization_id, amendment_payment_id, attempt_number, status,
                provider_idempotency_key
              )
              VALUES (${ids.organizationId}, ${ids.paymentId}, 2, 'PENDING_PROVIDER', ${key})
            `;
            await tx`
              UPDATE amendment_payments
              SET status = 'PENDING_PROVIDER', failed_at = NULL, updated_at = now()
              WHERE id = ${ids.paymentId}
            `;
          });
          return 'won';
        } catch {
          return 'lost';
        }
      };
      const outcome = await Promise.race([
        Promise.all([retry(first, 'c4s-concurrent-a'), retry(second, 'c4s-concurrent-b')]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('concurrent retry did not complete')), 5000),
        ),
      ]);
      expect(outcome.sort()).toEqual(['lost', 'won']);
      const attempts = await setup`
        SELECT attempt_number, status, provider_payment_intent_id, provider_status
        FROM amendment_payment_attempts
        WHERE amendment_payment_id = ${ids.paymentId}
        ORDER BY attempt_number
      `;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        attempt_number: 1,
        status: 'FAILED',
        provider_payment_intent_id: `pi-failed-${ids.paymentId}`,
      });
      expect(attempts[1]).toMatchObject({
        attempt_number: 2,
        status: 'PENDING_PROVIDER',
        provider_payment_intent_id: null,
        provider_status: null,
      });
    } finally {
      await Promise.all([first.end(), second.end(), setup.end()]);
    }
  });

  it('upgrade réel 0036 → 0037 conserve les données et le hash une seule fois', async () => {
    if (!upgradeUrl) return;
    const { rmSync } = await import('node:fs');
    const before = await createMigrationFolder(36);
    try {
      await runMigrationsFromFolder(upgradeUrl, before);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }

    const sql = postgres(upgradeUrl, { max: 1 });
    try {
      expect(await migrationCount(sql)).toBe(36);
      const historical = await sql`
        INSERT INTO organizations (legal_name, slug)
        VALUES ('Historical C4-S', 'historical-c4s')
        RETURNING id, legal_name, slug
      `;
      const beforeHashes = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
      const migrationFolder = await createMigrationFolder(36);
      try {
        await appendMigration(migrationFolder, 36);
        await runMigrationsFromFolder(upgradeUrl, migrationFolder);
      } finally {
        rmSync(migrationFolder, { recursive: true, force: true });
      }

      expect(await migrationCount(sql)).toBe(37);
      const afterHashes = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
      expect(afterHashes).toHaveLength(37);
      const newHashes = afterHashes.filter(
        (row) => !beforeHashes.some((beforeRow) => beforeRow.hash === row.hash),
      );
      expect(newHashes).toHaveLength(1);
      expect(
        (
          await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${newHashes[0]!.hash}`
        )[0]!.count,
      ).toBe(1);
      expect(
        await sql`SELECT id, legal_name, slug FROM organizations WHERE id = ${historical[0]!.id}`,
      ).toEqual(historical);

      const rerunFolder = await createMigrationFolder(36);
      try {
        await appendMigration(rerunFolder, 36);
        await runMigrationsFromFolder(upgradeUrl, rerunFolder);
      } finally {
        rmSync(rerunFolder, { recursive: true, force: true });
      }
      expect(await migrationCount(sql)).toBe(37);
      expect(
        (
          await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${newHashes[0]!.hash}`
        )[0]!.count,
      ).toBe(1);
      expect(
        await sql`SELECT id, legal_name, slug FROM organizations WHERE id = ${historical[0]!.id}`,
      ).toEqual(historical);
    } finally {
      await sql.end();
    }
  }, 600000);
});
