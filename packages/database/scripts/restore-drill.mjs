import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rmdir, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

export const DEFAULT_LOCAL_DATABASE_URL = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';
export const REQUIRED_CONFIRMATION = '1';
export const RECOVERY_DRILL_ENVIRONMENT = 'UTTILY_RECOVERY_DRILL';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const DATABASE_NAME_PATTERN = /^uttily_recovery_(source|restored)_[a-z0-9_]+$/;

export const FIXTURE_IDS = Object.freeze({
  organization: '00000000-0000-0000-0000-000000002001',
  user: '00000000-0000-0000-0000-000000002002',
  membership: '00000000-0000-0000-0000-000000002003',
  location: '00000000-0000-0000-0000-000000002004',
  product: '00000000-0000-0000-0000-000000002005',
  variant: '00000000-0000-0000-0000-000000002006',
  inventoryItem: '00000000-0000-0000-0000-000000002007',
  draft: '00000000-0000-0000-0000-000000002008',
  draftLine: '00000000-0000-0000-0000-000000002009',
  holdBlock: '00000000-0000-0000-0000-00000000200a',
  allocation: '00000000-0000-0000-0000-00000000200b',
  payment: '00000000-0000-0000-0000-00000000200c',
  paymentAttempt: '00000000-0000-0000-0000-00000000200d',
  webhook: '00000000-0000-0000-0000-00000000200e',
  booking: '00000000-0000-0000-0000-00000000200f',
  bookingLine: '00000000-0000-0000-0000-000000002010',
  bookingBlock: '00000000-0000-0000-0000-000000002011',
  bookingItem: '00000000-0000-0000-0000-000000002012',
  outbox: '00000000-0000-0000-0000-000000002013',
  effectConfirmation: '00000000-0000-0000-0000-000000002014',
  effectContract: '00000000-0000-0000-0000-000000002015',
  effectReceipt: '00000000-0000-0000-0000-000000002016',
  effectEmail: '00000000-0000-0000-0000-000000002017',
});

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function parseDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() !== databaseUrl) {
    throw new Error('DATABASE_URL doit être une URL PostgreSQL locale.');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL doit être une URL PostgreSQL locale.');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Le restore drill accepte uniquement une URL PostgreSQL locale.');
  }

  if (!LOCAL_HOSTS.has(normalizeHost(parsed.hostname))) {
    throw new Error('Restore drill refusé : l’URL doit cibler localhost, 127.0.0.1 ou ::1.');
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('DATABASE_URL doit contenir un nom de base PostgreSQL.');
  }

  return parsed;
}

export function resolveRecoveryDrillDatabaseUrl(environment = process.env) {
  const databaseUrl = environment.RECOVERY_DRILL_DATABASE_URL ?? environment.DATABASE_URL;
  return databaseUrl === undefined || databaseUrl === '' ? DEFAULT_LOCAL_DATABASE_URL : databaseUrl;
}

export function assertRecoveryDrillEnvironment(environment = process.env) {
  if (environment[RECOVERY_DRILL_ENVIRONMENT] !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `Le restore drill exige ${RECOVERY_DRILL_ENVIRONMENT}=1 ; aucune base ne sera touchée sans cette confirmation.`,
    );
  }

  if (environment.NODE_ENV === 'production') {
    throw new Error('Restore drill refusé quand NODE_ENV=production.');
  }
}

export function databaseUrlForName(databaseUrl, databaseName) {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('Nom de base de drill invalide.');
  }

  const parsed = parseDatabaseUrl(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function buildDatabaseNames(now = Date.now(), processId = process.pid) {
  const suffix = `${Number(now).toString(36)}_${Number(processId).toString(36)}`;
  return {
    source: `uttily_recovery_source_${suffix}`,
    restored: `uttily_recovery_restored_${suffix}`,
  };
}

function commandEnvironment(sourceUrl, restoredUrl) {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TZ: 'UTC',
    NODE_ENV: 'test',
    DATABASE_URL: sourceUrl,
    DATABASE_DIRECT_URL: sourceUrl,
    STRIPE_ENVIRONMENT: 'TEST',
    PAYMENTS_LIVE_ENABLED: 'false',
    RECOVERY_DRILL_RESTORED_DATABASE_URL: restoredUrl,
  };
}

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
    throw new Error(`${command} a échoué pendant le restore drill (code ${String(code)}).`);
  }
}

async function assertRequiredTools() {
  for (const command of ['pg_dump', 'pg_restore', 'psql']) {
    await runCommand(command, ['--version'], { env: process.env });
  }
}

function migrationEnvironment(sourceUrl, restoredUrl) {
  return commandEnvironment(sourceUrl, restoredUrl);
}

async function applyMigrations(repoRoot, sourceUrl, restoredUrl) {
  await runCommand('pnpm', ['--filter', '@uttily/database', 'db:migrate'], {
    cwd: repoRoot,
    env: migrationEnvironment(sourceUrl, restoredUrl),
  });
}

async function createDatabase(adminUrl, databaseName) {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('Refus de créer une base dont le nom n’est pas généré par le drill.');
  }

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(adminUrl, databaseName) {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('Refus de supprimer une base dont le nom n’est pas généré par le drill.');
  }

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function insertFixture(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  const ids = FIXTURE_IDS;
  try {
    await sql.begin(async (tx) => {
      const categoryRows = await tx`
        SELECT "id" FROM "categories" ORDER BY "slug" ASC LIMIT 1
      `;
      if (categoryRows.length !== 1) {
        throw new Error('La fixture de recovery nécessite une catégorie seedée.');
      }
      const categoryId = categoryRows[0].id;

      await tx`
        INSERT INTO "users" ("id", "email", "display_name", "locale")
        VALUES (${ids.user}, 'recovery-drill@example.test', 'Recovery Drill', 'fr')
      `;
      await tx`
        INSERT INTO "organizations" (
          "id", "legal_name", "public_display_name", "slug", "status",
          "is_professional", "default_currency", "default_cancellation_policy_code"
        ) VALUES (
          ${ids.organization}, 'Recovery Drill Organisation', 'Recovery Drill',
          'recovery-drill', 'ACTIVE', true, 'EUR', 'FLEXIBLE'
        )
      `;
      await tx`
        INSERT INTO "organization_memberships" (
          "id", "organization_id", "user_id", "role", "status", "accepted_at"
        ) VALUES (${ids.membership}, ${ids.organization}, ${ids.user}, 'OWNER', 'ACTIVE', now())
      `;
      await tx`
        INSERT INTO "locations" (
          "id", "organization_id", "name", "slug", "time_zone", "address_line1",
          "city", "postal_code", "country_code", "pickup_enabled", "is_publicly_listed",
          "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency"
        ) VALUES (
          ${ids.location}, ${ids.organization}, 'Recovery Drill Location', 'recovery-drill',
          'Europe/Paris', '1 Test Street', 'Lyon', '69001', 'FR', true, false, 30, 30, 'EUR'
        )
      `;
      await tx`
        INSERT INTO "products" (
          "id", "organization_id", "category_id", "name", "slug", "description", "publication_status"
        ) VALUES (
          ${ids.product}, ${ids.organization}, ${categoryId}, 'Recovery Drill Equipment',
          'recovery-drill-equipment', 'Fixture TEST pour restore drill', 'DRAFT'
        )
      `;
      await tx`
        INSERT INTO "product_variants" (
          "id", "product_id", "name", "sku_suffix", "daily_price_amount_minor", "currency"
        ) VALUES (${ids.variant}, ${ids.product}, 'Standard', 'recovery', 1500, 'EUR')
      `;
      await tx`
        INSERT INTO "inventory_items" (
          "id", "organization_id", "product_variant_id", "internal_sku", "condition",
          "status", "current_location_id"
        ) VALUES (
          ${ids.inventoryItem}, ${ids.organization}, ${ids.variant}, 'RECOVERY-001',
          'GOOD', 'ACTIVE', ${ids.location}
        )
      `;
      await tx`
        INSERT INTO "booking_drafts" (
          "id", "organization_id", "location_id", "customer_user_id", "status",
          "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
          "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "currency",
          "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
          "tax_status", "tax_amount_minor", "commission_amount_minor", "billable_unit",
          "billable_unit_count", "cancellation_policy_snapshot", "expires_at"
        ) VALUES (
          ${ids.draft}, ${ids.organization}, ${ids.location}, ${ids.user}, 'HELD',
          '2026-09-10T09:00:00Z', '2026-09-12T09:00:00Z',
          '2026-09-10T08:30:00Z', '2026-09-12T09:30:00Z', 'Europe/Paris', 30, 30, 'EUR',
          3000, 0, 3000, 'NOT_APPLICABLE', 0, 300, 'DAY', 2,
          ${sql.json({ code: 'FLEXIBLE' })}, '2099-01-01T00:00:00Z'
        )
      `;
      await tx`
        INSERT INTO "booking_draft_lines" (
          "id", "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "currency", "variant_snapshot"
        ) VALUES (
          ${ids.draftLine}, ${ids.draft}, ${ids.variant}, 1, 1500, 2, 3000, 'EUR',
          ${sql.json({ name: 'Recovery Drill Equipment', variantName: 'Standard' })}
        )
      `;
      await tx`
        INSERT INTO "inventory_blocks" (
          "id", "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
          "expires_at", "source_id", "created_by"
        ) VALUES (
          ${ids.holdBlock}, ${ids.organization}, ${ids.inventoryItem}, 'HOLD', 'ACTIVE',
          '2026-09-10T09:00:00Z', '2026-09-12T09:00:00Z',
          '2026-09-10T08:30:00Z', '2026-09-12T09:30:00Z', '2099-01-01T00:00:00Z',
          ${ids.draft}, ${ids.user}
        )
      `;
      await tx`
        INSERT INTO "allocations" ("id", "draft_line_id", "inventory_block_id", "status")
        VALUES (${ids.allocation}, ${ids.draftLine}, ${ids.holdBlock}, 'ALLOCATED')
      `;
      await tx`
        INSERT INTO "organization_payment_accounts" (
          "id", "organization_id", "provider", "environment", "provider_account_id",
          "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
          "transfers_capability_status", "settlement_merchant_mode",
          "controller_configuration_snapshot", "requirements_snapshot"
        ) VALUES (
          '00000000-0000-0000-0000-000000002018', ${ids.organization}, 'STRIPE', 'TEST',
          'acct_recovery_drill_test', 'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true,
          'ACTIVE', 'PLATFORM', ${sql.json({ source: 'recovery-drill' })}, ${sql.json({})}
        )
      `;
      await tx`
        INSERT INTO "payments" (
          "id", "organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "environment",
          "currency", "tax_status", "tax_amount_minor", "commission_amount_minor",
          "financial_terms_version", "legal_terms_version", "terms_acceptance_snapshot",
          "connected_account_id", "charge_model", "settlement_merchant_mode", "succeeded_at"
        ) VALUES (
          ${ids.payment}, ${ids.organization}, ${ids.draft}, ${ids.user}, 'SUCCEEDED', 3000, 'TEST',
          'EUR', 'NOT_APPLICABLE', 0, 300, 'v1', 'v1',
          ${sql.json({ termsVersion: 'v1', source: 'recovery-drill' })},
          'acct_recovery_drill_test', 'DESTINATION', 'PLATFORM', '2026-09-01T10:00:00Z'
        )
      `;
      await tx`
        INSERT INTO "payment_attempts" (
          "id", "organization_id", "payment_id", "attempt_number", "status",
          "provider_payment_intent_id", "provider_idempotency_key", "provider_status"
        ) VALUES (
          ${ids.paymentAttempt}, ${ids.organization}, ${ids.payment}, 1, 'SUCCEEDED',
          'pi_recovery_drill_test', 'recovery-drill-payment-attempt-1', 'succeeded'
        )
      `;
      await tx`
        INSERT INTO "payment_webhook_events" (
          "id", "organization_id", "environment", "provider_event_id", "provider_event_created_at",
          "event_type", "provider_object_id", "api_version", "payload_sha256", "normalized_payload",
          "status", "processed_at"
        ) VALUES (
          ${ids.webhook}, ${ids.organization}, 'TEST', 'evt_recovery_drill_test', 1788256800,
          'payment_intent.succeeded', 'pi_recovery_drill_test', '2026-01-28',
          repeat('a', 64), ${sql.json({ type: 'payment_intent.succeeded', source: 'recovery-drill' })},
          'PROCESSED', '2026-09-01T10:00:01Z'
        )
      `;
      await tx`UPDATE "allocations" SET "status" = 'CONVERTED' WHERE "id" = ${ids.allocation}`;
      await tx`UPDATE "inventory_blocks" SET "status" = 'CONVERTED' WHERE "id" = ${ids.holdBlock}`;
      await tx`UPDATE "booking_drafts" SET "status" = 'CONVERTED' WHERE "id" = ${ids.draft}`;
      await tx`
        INSERT INTO "bookings" (
          "id", "organization_id", "location_id", "customer_user_id", "draft_id", "payment_id",
          "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
          "prep_buffer_minutes", "cleanup_buffer_minutes", "currency", "subtotal_amount_minor",
          "mandatory_fees_amount_minor", "tax_status", "tax_amount_minor", "commission_amount_minor",
          "commission_rule_snapshot", "total_amount_minor", "cancellation_policy_snapshot",
          "terms_acceptance_snapshot", "confirmed_at"
        ) VALUES (
          ${ids.booking}, ${ids.organization}, ${ids.location}, ${ids.user}, ${ids.draft}, ${ids.payment},
          'CONFIRMED', '2026-09-10T09:00:00Z', '2026-09-12T09:00:00Z',
          '2026-09-10T08:30:00Z', '2026-09-12T09:30:00Z', 30, 30, 'EUR', 3000, 0,
          'NOT_APPLICABLE', 0, 300, ${sql.json({ version: 'v1', source: 'recovery-drill' })}, 3000,
          ${sql.json({ code: 'FLEXIBLE' })}, ${sql.json({ termsVersion: 'v1', source: 'recovery-drill' })},
          '2026-09-01T10:00:02Z'
        )
      `;
      await tx`
        INSERT INTO "booking_lines" (
          "id", "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "currency", "variant_snapshot"
        ) VALUES (
          ${ids.bookingLine}, ${ids.booking}, ${ids.variant}, 1, 1500, 2, 3000, 'EUR',
          ${sql.json({ name: 'Recovery Drill Equipment', variantName: 'Standard' })}
        )
      `;
      await tx`
        INSERT INTO "inventory_blocks" (
          "id", "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
          "source_id", "created_by"
        ) VALUES (
          ${ids.bookingBlock}, ${ids.organization}, ${ids.inventoryItem}, 'BOOKING', 'ACTIVE',
          '2026-09-10T09:00:00Z', '2026-09-12T09:00:00Z',
          '2026-09-10T08:30:00Z', '2026-09-12T09:30:00Z', ${ids.booking}, ${ids.user}
        )
      `;
      await tx`
        INSERT INTO "booking_items" (
          "id", "booking_id", "booking_line_id", "inventory_item_id",
          "source_hold_block_id", "booking_block_id"
        ) VALUES (
          ${ids.bookingItem}, ${ids.booking}, ${ids.bookingLine}, ${ids.inventoryItem},
          ${ids.holdBlock}, ${ids.bookingBlock}
        )
      `;
      await tx`
        INSERT INTO "outbox_events" (
          "id", "organization_id", "aggregate_type", "aggregate_id", "event_type",
          "event_version", "payload", "status", "attempt_count", "available_at", "idempotency_key"
        ) VALUES (
          ${ids.outbox}, ${ids.organization}, 'BOOKING', ${ids.booking}, 'BOOKING_CONFIRMED',
          'v1', ${sql.json({ bookingId: ids.booking, source: 'recovery-drill' })}, 'PENDING', 0,
          '2026-09-01T10:00:03Z', 'recovery-drill-outbox-1'
        )
      `;
      await tx`
        INSERT INTO "outbox_effects" (
          "id", "organization_id", "outbox_event_id", "effect_type", "status", "idempotency_key"
        ) VALUES
          (${ids.effectConfirmation}, ${ids.organization}, ${ids.outbox}, 'GENERATE_CONFIRMATION', 'PENDING', 'recovery-drill-effect-confirmation'),
          (${ids.effectContract}, ${ids.organization}, ${ids.outbox}, 'GENERATE_CONTRACT', 'PENDING', 'recovery-drill-effect-contract'),
          (${ids.effectReceipt}, ${ids.organization}, ${ids.outbox}, 'GENERATE_RECEIPT', 'PENDING', 'recovery-drill-effect-receipt'),
          (${ids.effectEmail}, ${ids.organization}, ${ids.outbox}, 'SEND_EMAIL', 'PENDING', 'recovery-drill-effect-email')
      `;
    });
  } finally {
    await sql.end();
  }
}

async function mutateFixture(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  const ids = FIXTURE_IDS;
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM "outbox_effects" WHERE "outbox_event_id" = ${ids.outbox}`;
      await tx`DELETE FROM "outbox_events" WHERE "id" = ${ids.outbox}`;
      await tx`DELETE FROM "booking_items" WHERE "id" = ${ids.bookingItem}`;
      await tx`DELETE FROM "inventory_blocks" WHERE "id" = ${ids.bookingBlock}`;
      await tx`UPDATE "payments" SET "status" = 'FAILED', "succeeded_at" = NULL WHERE "id" = ${ids.payment}`;
      await tx`UPDATE "payment_attempts" SET "status" = 'FAILED', "provider_status" = 'failed' WHERE "id" = ${ids.paymentAttempt}`;
      await tx`UPDATE "payment_webhook_events" SET "status" = 'FAILED', "processed_at" = NULL WHERE "id" = ${ids.webhook}`;
    });
  } finally {
    await sql.end();
  }
}

async function verifyFixture(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  const ids = FIXTURE_IDS;
  try {
    const rows = await sql`
      SELECT
        b."status" AS booking_status,
        p."status" AS payment_status,
        pa."status" AS payment_attempt_status,
        pwe."status" AS webhook_status,
        bb."status" AS booking_block_status,
        oe."status" AS outbox_status,
        count(DISTINCT bi."id")::int AS booking_item_count,
        count(DISTINCT oeffect."id")::int AS outbox_effect_count,
        count(DISTINCT pv."id")::int AS relation_variant_count
      FROM "bookings" b
      JOIN "payments" p ON p."id" = b."payment_id"
      JOIN "payment_attempts" pa ON pa."payment_id" = p."id"
      JOIN "payment_webhook_events" pwe ON pwe."provider_object_id" = pa."provider_payment_intent_id"
      JOIN "booking_items" bi ON bi."booking_id" = b."id"
      JOIN "inventory_blocks" bb ON bb."id" = bi."booking_block_id"
      JOIN "inventory_items" ii ON ii."id" = bi."inventory_item_id"
      JOIN "product_variants" pv ON pv."id" = ii."product_variant_id"
      JOIN "outbox_events" oe ON oe."aggregate_id" = b."id"
      JOIN "outbox_effects" oeffect ON oeffect."outbox_event_id" = oe."id"
      WHERE b."id" = ${ids.booking}
        AND p."id" = ${ids.payment}
        AND oe."id" = ${ids.outbox}
      GROUP BY b."status", p."status", pa."status", pwe."status", bb."status", oe."status"
    `;

    const row = rows[0];
    const checks = {
      booking: row?.booking_status === 'CONFIRMED',
      payment: row?.payment_status === 'SUCCEEDED',
      paymentAttempt: row?.payment_attempt_status === 'SUCCEEDED',
      webhook: row?.webhook_status === 'PROCESSED',
      bookingBlock: row?.booking_block_status === 'ACTIVE',
      outbox: row?.outbox_status === 'PENDING',
      bookingItemRelation: row?.booking_item_count === 1,
      outboxEffects: row?.outbox_effect_count === 4,
      variantRelation: row?.relation_variant_count === 1,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      throw new Error(`Vérification du restore drill échouée: ${failedChecks.join(', ')}.`);
    }
    return checks;
  } finally {
    await sql.end();
  }
}

async function cleanupDirectory(directory) {
  try {
    await unlink(join(directory, 'recovery.dump'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rmdir(directory);
}

export async function runRestoreDrill(options = {}) {
  const environment = options.environment ?? process.env;
  assertRecoveryDrillEnvironment(environment);
  await assertRequiredTools();

  const baseUrl = resolveRecoveryDrillDatabaseUrl(environment);
  parseDatabaseUrl(baseUrl);

  const names = buildDatabaseNames(options.now ?? Date.now(), options.processId ?? process.pid);
  const sourceUrl = databaseUrlForName(baseUrl, names.source);
  const restoredUrl = databaseUrlForName(baseUrl, names.restored);
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dumpDirectory = await mkdtemp(join(tmpdir(), 'uttily-recovery-drill-'));
  const dumpPath = join(dumpDirectory, 'recovery.dump');
  const startedAt = Date.now();
  let sourceCreated = false;
  let restoredCreated = false;

  try {
    await createDatabase(baseUrl, names.source);
    sourceCreated = true;
    await applyMigrations(repoRoot, sourceUrl, restoredUrl);
    await insertFixture(sourceUrl);
    await runCommand(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file',
        dumpPath,
        '--dbname',
        sourceUrl,
      ],
      { env: commandEnvironment(sourceUrl, restoredUrl) },
    );
    await mutateFixture(sourceUrl);
    await createDatabase(baseUrl, names.restored);
    restoredCreated = true;
    await runCommand(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', restoredUrl, dumpPath],
      { env: commandEnvironment(sourceUrl, restoredUrl) },
    );
    const checks = await verifyFixture(restoredUrl);
    const dumpSize = (await stat(dumpPath)).size;
    return {
      status: 'PASS',
      mechanism: 'pg_dump custom + pg_restore',
      checks,
      dumpBytes: dumpSize,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    const cleanupErrors = [];
    if (restoredCreated) {
      try {
        await dropDatabase(baseUrl, names.restored);
      } catch {
        cleanupErrors.push(names.restored);
      }
    }
    if (sourceCreated) {
      try {
        await dropDatabase(baseUrl, names.source);
      } catch {
        cleanupErrors.push(names.source);
      }
    }
    try {
      await cleanupDirectory(dumpDirectory);
    } catch {
      cleanupErrors.push(basename(dumpDirectory));
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`Nettoyage du restore drill incomplet: ${cleanupErrors.join(', ')}.`);
    }
  }
}

async function main() {
  try {
    const result = await runRestoreDrill();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Restore drill échoué.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
