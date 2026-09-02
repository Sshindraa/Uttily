import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  runMigrations,
  organizationMemberships,
  assertLocalhost,
} from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import {
  createOrganizationForUser,
  createLocation,
  provisionUserFromOidc,
  type AuthenticatedUser,
} from '@uttily/core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : Clerk et getDb.
//
// Les Server Actions dépendent de Clerk (`getAuthenticatedUser` via
// `currentUser()`) et du singleton `getDb()`. On mocke les deux pour
// contrôler l'identité et brancher une base de test PostgreSQL réelle.
// ---------------------------------------------------------------------------

vi.mock('@clerk/nextjs/server', () => ({
  currentUser: vi.fn<() => Promise<unknown>>(),
}));

// Mock `next/cache` : `revalidatePath` n'est pas disponible hors Next.js runtime.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// `getDb` est mocké pour retourner le client de test. On l'injecte via
// une variable mutable afin de pouvoir la réinitialiser entre les tests.
let testDb: DatabaseClient | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

// Mock `@/lib/auth` : `getAuthenticatedUser` utilise `currentUser` (mocké Clerk)
// et `getDb` (mocké ci-dessus) pour provisionner l'utilisateur dans la base de test.
// On délègue au vrai module en important dynamiquement, mais comme les mocks
// `@clerk/nextjs/server` et `@/lib/db` sont déjà en place, on peut réimporter
// le module réel via `vi.importActual`.
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { getAuthenticatedUser: actual.getAuthenticatedUser };
});

// Mock `@uttily/core` : on passe tout au travers (vi.importActual) sauf
// `prepareBooking` qui est enveloppé dans un `vi.fn` pour permettre de
// simuler une erreur interne brute (test UNKNOWN / sanitisation G4A).
// Par défaut, le `vi.fn` appelle l'implémentation réelle.
vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<typeof import('@uttily/core')>('@uttily/core');
  return { ...actual, prepareBooking: vi.fn(actual.prepareBooking) };
});

// Importe les actions APRÈS les mocks pour qu'elles utilisent les versions mockées.
const { currentUser } = await import('@clerk/nextjs/server');
const {
  prepareBookingAction,
  pickupBookingAction,
  returnBookingAction,
  closeBookingAction,
  createConditionReportAction,
  createDamageReportAction,
} = await import('./fulfillment');
const { revalidatePath } = await import('next/cache');
// Référence au mock `prepareBooking` pour pouvoir le surcharger ponctuellement.
const coreModule = await import('@uttily/core');

// ---------------------------------------------------------------------------
// Setup base de test (réplique minimale de setupIntegrationTestDb).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttily_test_fulfillment_actions';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
function shouldSkipIntegrationTests(): boolean {
  if (isCi) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

let adminUrl: string | null = null;
let testUrl: string | null = null;
let adminSql: ReturnType<typeof postgres> | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isCi) throw new Error("CI: DATABASE_URL est requise pour les tests d'action.");
    return;
  }

  // Vérifie la connectivité.
  adminSql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await adminSql`SELECT 1`;
  } catch {
    await adminSql.end();
    adminSql = null;
    if (isCi) throw new Error('CI: base PostgreSQL non joignable.');
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  adminUrl = url;

  // Crée la base de test.
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
    adminSql = null;
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);

  testDb = createDatabase(testUrl);
  // Client raw SQL pour les seeds complexes (booking avec draft, payment, lines, items).
  rawSql = postgres(testUrl, { max: 5 });
});

afterAll(async () => {
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (testDb) {
    await testDb.$client.end();
    testDb = null;
  }
  if (adminUrl) {
    const cleanupSql = postgres(adminUrl, { max: 1 });
    try {
      await cleanupSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
      );
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    } finally {
      await cleanupSql.end();
    }
  }
});

beforeEach(async () => {
  if (!testDb) return;
  vi.mocked(currentUser).mockReset();
  vi.mocked(revalidatePath).mockClear();
  // Réinitialise le mock `prepareBooking` : efface l'historique des appels et
  // restaure l'implémentation par défaut (l'implémentation réelle).
  vi.mocked(coreModule.prepareBooking).mockClear();
  vi.mocked(coreModule.prepareBooking).mockImplementation(
    (await vi.importActual<typeof import('@uttily/core')>('@uttily/core')).prepareBooking,
  );
  // TRUNCATE réinitialise toutes les tables métier (RESTART IDENTITY).
  // Les catégories seedées par migration ne sont pas tronquées.
  await testDb.execute(
    sql`TRUNCATE TABLE
      condition_reports, damage_reports,
      booking_fulfillment_events, outbox_events, audit_log,
      booking_items, booking_lines, inventory_blocks,
      payments, bookings, booking_draft_lines, booking_drafts,
      allocations, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships,
      organizations, users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

// ---------------------------------------------------------------------------
// Helpers de test.
// ---------------------------------------------------------------------------

function mockClerkUser(user: AuthenticatedUser | null): void {
  if (!user) {
    vi.mocked(currentUser).mockResolvedValue(null as never);
    return;
  }
  vi.mocked(currentUser).mockResolvedValue({
    id: user.oidcSubject,
    primaryEmailAddress: {
      emailAddress: user.email,
      verification: { status: user.emailVerified ? 'verified' : 'unverified' },
    },
  } as never);
}

async function makeUser(email: string): Promise<AuthenticatedUser> {
  if (!testDb) throw new Error('db not initialized');
  return provisionUserFromOidc(testDb, {
    oidcSubject: `clerk-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function makeOrg(
  user: AuthenticatedUser,
  legalName: string,
): Promise<{ organizationId: string; locationId: string }> {
  if (!testDb) throw new Error('db not initialized');
  const { organization } = await createOrganizationForUser(testDb, user, {
    legalName,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(testDb, {
    organizationId: organization.id,
    name: 'Shop Principal',
    timeZone: 'Europe/Paris',
  });
  return { organizationId: organization.id, locationId: location.id };
}

/** Ajoute une membership avec un rôle et un statut donnés. */
async function addMember(
  organizationId: string,
  user: AuthenticatedUser,
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF',
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED' = 'ACTIVE',
): Promise<void> {
  if (!testDb) throw new Error('db not initialized');
  await testDb
    .insert(organizationMemberships)
    .values({
      organizationId,
      userId: user.id,
      role,
      status,
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();
}

function makeFormData(data: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(data)) {
    fd.set(key, value);
  }
  return fd;
}

// Valeur initiale useActionState (_prev non utilisé par les actions).
const EMPTY_PREV = { ok: false as const, code: 'UNKNOWN' as const, message: '' };

// ---------------------------------------------------------------------------
// Seed helpers (adaptés de packages/core/src/fulfillment/reports.integration.test.ts).
// ---------------------------------------------------------------------------

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  itemId: string;
}

interface BookingIds {
  bookingId: string;
  bookingItemId: string;
  lineId: string;
  blockId: string;
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

async function seedBaseData(suffix = SUFFIX()): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
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
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + _pi},
        'image/jpeg', 102400, 800, 600, ${('000' + _pi).repeat(16).slice(0, 64)},
        ${_pi}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${location.id}, 'GOOD', 'ACTIVE')
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemId: item.id,
  };
}

async function seedConfirmedBooking(ids: BaseIds, monthOffset = 2): Promise<BookingIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const month = String(monthOffset).padStart(2, '0');

  const draft = await sql`
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
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`},
      'Europe/Paris', 30, 30,
      10000, 0, 10000,
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;

  const draftLine = await sql`
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
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`}, ${`2026-${month}-09 12:00:00+00`}, ${draft.id}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  await sql`
    INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
    VALUES (${draftLine.id}, ${holdBlock.id})
  `;

  const payment = await sql`
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
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, null,
      500,
      '1', '1',
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_test123',
      'DESTINATION', 'CONNECTED_ACCOUNT',
      'TEST',
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const booking = await sql`
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
      ${draft.id}, ${payment.id}, 'CONFIRMED',
      ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-12 17:00:00+00`},
      ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-12 17:30:00+00`},
      30, 30,
      'EUR', 10000, 0,
      'NOT_APPLICABLE', 0, null,
      500, 10000,
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: '1', user_id: 'test', accepted_at: '2026-01-01T00:00:00Z' })},
      '2026-01-01 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

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

async function setBookingStatus(bookingId: string, status: string): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  await rawSql`UPDATE bookings SET status = ${status} WHERE id = ${bookingId}`;
}

// ---------------------------------------------------------------------------
// Helpers de vérification (compteurs via rawSql).
// ---------------------------------------------------------------------------

async function countBookingsInOrg(orgId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM bookings WHERE organization_id = ${orgId}`;
  return rows[0]!.cnt;
}

async function countOutboxEventsInOrg(orgId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM outbox_events WHERE organization_id = ${orgId}`;
  return rows[0]!.cnt;
}

async function countConditionReportsInOrg(orgId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM condition_reports WHERE organization_id = ${orgId}`;
  return rows[0]!.cnt;
}

async function countDamageReportsInOrg(orgId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM damage_reports WHERE organization_id = ${orgId}`;
  return rows[0]!.cnt;
}

async function countFulfillmentEventsInOrg(orgId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM booking_fulfillment_events WHERE organization_id = ${orgId}`;
  return rows[0]!.cnt;
}

async function countConditionReports(bookingId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows =
    await rawSql`SELECT count(*)::int AS cnt FROM condition_reports WHERE booking_id = ${bookingId}`;
  return rows[0]!.cnt;
}

// countDamageReports retiré : non utilisé dans cette suite (les counts de dommages
// sont vérifiés via les assertions ActionResult et les requêtes directes inline).

// ---------------------------------------------------------------------------
// Helper : seed complet pour un test de réussite.
// Crée org, operator (OWNER), booking confirmée.
// ---------------------------------------------------------------------------

async function seedConfirmedBookingWithOperator(
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF' = 'OWNER',
): Promise<{ ids: BaseIds; booking: BookingIds; operator: AuthenticatedUser; orgId: string }> {
  if (!testDb || !rawSql) throw new Error('db not initialized');
  const ids = await seedBaseData();
  const operator = await makeUser(`operator-${SUFFIX()}@example.com`);
  await addMember(ids.orgId, operator, role);
  mockClerkUser(operator);
  const booking = await seedConfirmedBooking(ids);
  return { ids, booking, operator, orgId: ids.orgId };
}

// ===========================================================================
// Tests.
// ===========================================================================

describe.skipIf(shouldSkipIntegrationTests())('Server Actions — fulfillment', () => {
  // -------------------------------------------------------------------------
  // 1. Authentification (8 tests).
  // -------------------------------------------------------------------------
  describe('Authentification', () => {
    it('utilisateur non authentifié → UNAUTHENTICATED', async () => {
      if (!testDb || !rawSql) return;
      mockClerkUser(null);
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await prepareBookingAction(
        '00000000-0000-0000-0000-000000000002',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNAUTHENTICATED');
      }
    });

    it('membership absente → FORBIDDEN', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      // Utilisateur sans membership dans l'org.
      const outsider = await makeUser(`outsider-${SUFFIX()}@example.com`);
      mockClerkUser(outsider);
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await prepareBookingAction(ids.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FORBIDDEN');
      }
    });

    it('membership SUSPENDED → FORBIDDEN', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const operator = await makeUser(`suspended-${SUFFIX()}@example.com`);
      await addMember(ids.orgId, operator, 'STAFF', 'SUSPENDED');
      mockClerkUser(operator);
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await prepareBookingAction(ids.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FORBIDDEN');
      }
    });

    it('OWNER autorisé → prepareBookingAction succès', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-owner-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
    });

    it('ADMIN autorisé → prepareBookingAction succès', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('ADMIN');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-admin-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
    });

    it('MANAGER autorisé → prepareBookingAction succès', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('MANAGER');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-manager-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
    });

    it('STAFF autorisé → prepareBookingAction succès', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('STAFF');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-staff-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
    });

    it('organisation différente → FORBIDDEN (le helper web refuse avant Core)', async () => {
      if (!testDb || !rawSql) return;
      // L'utilisateur est OWNER de org1 mais pas de org2.
      const owner = await makeUser(`owner-cross-${SUFFIX()}@example.com`);
      await makeOrg(owner, 'Org Cross A');
      const ids2 = await seedBaseData();
      mockClerkUser(owner);
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'key-cross-' + SUFFIX(),
      });
      // Appelle l'action avec org2 (l'utilisateur n'est pas membre de org2).
      const result = await prepareBookingAction(ids2.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FORBIDDEN');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Parseurs (8 tests).
  // -------------------------------------------------------------------------
  describe('Parseurs', () => {
    it('UUID invalide (bookingId) → VALIDATION + fieldErrors.bookingId', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: 'not-a-uuid',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await prepareBookingAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.bookingId).toBeDefined();
      }
    });

    it('clé vide → VALIDATION + fieldErrors.idempotencyKey', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: '',
      });
      const result = await prepareBookingAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.idempotencyKey).toBeDefined();
      }
    });

    it('clé trop longue (>200) → VALIDATION + fieldErrors.idempotencyKey', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'x'.repeat(201),
      });
      const result = await prepareBookingAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.idempotencyKey).toBeDefined();
      }
    });

    it('phase invalide → VALIDATION + fieldErrors.phase (createConditionReportAction)', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        bookingItemId: '00000000-0000-0000-0000-000000000002',
        phase: 'INVALID_PHASE',
        condition: 'GOOD',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await createConditionReportAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.phase).toBeDefined();
      }
    });

    it('condition invalide → VALIDATION + fieldErrors.condition', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        bookingItemId: '00000000-0000-0000-0000-000000000002',
        phase: 'PICKUP',
        condition: 'INVALID_CONDITION',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await createConditionReportAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.condition).toBeDefined();
      }
    });

    it('notes trop longues (>5000) → VALIDATION + fieldErrors.notes', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        bookingItemId: '00000000-0000-0000-0000-000000000002',
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'x'.repeat(5001),
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await createConditionReportAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.notes).toBeDefined();
      }
    });

    it('description trop longue (>5000) → VALIDATION + fieldErrors.description (createDamageReportAction)', async () => {
      if (!testDb || !rawSql) return;
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        bookingItemId: '00000000-0000-0000-0000-000000000002',
        description: 'x'.repeat(5001),
        idempotencyKey: 'key-' + SUFFIX(),
      });
      const result = await createDamageReportAction(
        '00000000-0000-0000-0000-000000000001',
        EMPTY_PREV,
        fd,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION');
        expect(result.fieldErrors?.description).toBeDefined();
      }
    });

    it('organizationId et actorUserId injectés côté serveur (FormData frauduleux ignoré)', async () => {
      if (!testDb || !rawSql) return;
      // Seed booking + prepare pour que le condition report soit valide (READY_FOR_PICKUP).
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      const prepareResult = await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      expect(prepareResult.ok).toBe(true);

      // FormData avec organizationId et actorUserId frauduleux — l'action doit les ignorer.
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: '',
        idempotencyKey: 'key-cr-' + SUFFIX(),
        organizationId: 'fraud-org-id',
        actorUserId: 'fraud-user-id',
      });
      const result = await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Six actions — succès nominal (6 tests).
  // -------------------------------------------------------------------------
  describe('Succès nominal', () => {
    it('succès prepareBooking → ActionResult ok avec kind APPLIED', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
        expect(result.data.bookingId).toBe(booking.bookingId);
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('succès pickupBooking (après prepare)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Prepare d'abord.
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      // Pickup.
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-pickup-' + SUFFIX(),
      });
      const result = await pickupBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('succès returnBooking (après pickup)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      const fdPickup = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-pickup-' + SUFFIX(),
      });
      await pickupBookingAction(orgId, EMPTY_PREV, fdPickup);
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-return-' + SUFFIX(),
      });
      const result = await returnBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('succès closeBooking (après return)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      const fdPickup = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-pickup-' + SUFFIX(),
      });
      await pickupBookingAction(orgId, EMPTY_PREV, fdPickup);
      const fdReturn = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-return-' + SUFFIX(),
      });
      await returnBookingAction(orgId, EMPTY_PREV, fdReturn);
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-close-' + SUFFIX(),
      });
      const result = await closeBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('succès createConditionReport (phase PICKUP, après prepare)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'RAS',
        idempotencyKey: 'key-cr-' + SUFFIX(),
      });
      const result = await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('succès createDamageReport (après pickup)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);
      const fdPickup = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-pickup-' + SUFFIX(),
      });
      await pickupBookingAction(orgId, EMPTY_PREV, fdPickup);
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        description: 'Rayure sur la coque',
        idempotencyKey: 'key-dr-' + SUFFIX(),
      });
      const result = await createDamageReportAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('APPLIED');
      }
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Mapping d'erreurs (5 tests).
  // -------------------------------------------------------------------------
  describe("Mapping d'erreurs", () => {
    it('transition invalide → FULFILLMENT_INVALID_TRANSITION', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Force le statut à ACTIVE (après pickup) — prepareBooking depuis ACTIVE est invalide.
      await setBookingStatus(booking.bookingId, 'ACTIVE');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-invalid-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FULFILLMENT_INVALID_TRANSITION');
      }
    });

    it('report refusé par statut → FULFILLMENT_REPORT_NOT_ALLOWED', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Booking est CONFIRMED — le rapport PICKUP nécessite READY_FOR_PICKUP.
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        idempotencyKey: 'key-cr-' + SUFFIX(),
      });
      const result = await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FULFILLMENT_REPORT_NOT_ALLOWED');
      }
    });

    it('idempotency conflict (même clé, payload différent) → CONFLICT_IDEMPOTENCY', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Prepare d'abord pour que le booking soit READY_FOR_PICKUP.
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);

      // Premier rapport avec condition GOOD.
      const key = 'key-conflict-' + SUFFIX();
      const fd1 = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        idempotencyKey: key,
      });
      const result1 = await createConditionReportAction(orgId, EMPTY_PREV, fd1);
      expect(result1.ok).toBe(true);

      // Deuxième rapport avec même clé mais condition FAIR (payload différent).
      const fd2 = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'FAIR',
        idempotencyKey: key,
      });
      const result2 = await createConditionReportAction(orgId, EMPTY_PREV, fd2);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });

    it('replay réussi sans doublon (même clé, même payload → même résultat, 1 seule mutation)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Prepare d'abord.
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);

      // Premier rapport.
      const key = 'key-replay-' + SUFFIX();
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'RAS',
        idempotencyKey: key,
      });
      const result1 = await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(result1.ok).toBe(true);

      // Replay : même payload, même clé.
      vi.mocked(revalidatePath).mockClear();
      const result2 = await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(result2.ok).toBe(true);
      if (result2.ok && result1.ok) {
        expect(result2.data).toEqual(result1.data);
      }
      // Un seul rapport en base (pas de doublon).
      expect(await countConditionReports(booking.bookingId)).toBe(1);
      // revalidatePath appelée à chaque appel d'action (y compris replay).
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('erreur inconnue sanitisée → UNKNOWN, message générique (pas de fuite)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Mocke `prepareBooking` pour lancer une erreur brute (non FulfillmentError)
      // contenant un détail interne sensible. L'action-mapper doit la sanitiser
      // en { code: 'UNKNOWN', message: 'Une erreur inattendue est survenue.' }.
      const SECRET = 'SECRET_INTERNAL_DB_DETAIL_12345';
      vi.mocked(coreModule.prepareBooking).mockImplementationOnce(() => {
        throw new Error(SECRET);
      });
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-unknown-' + SUFFIX(),
      });
      const result = await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNKNOWN');
        expect(result.message).toBe('Une erreur inattendue est survenue.');
        // La chaîne sensible ne doit JAMAIS apparaître dans le résultat sérialisé.
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. revalidatePath (7 tests).
  // -------------------------------------------------------------------------
  describe('revalidatePath', () => {
    it('validation locale échouée → revalidatePath NON appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const fd = makeFormData({
        bookingId: 'not-a-uuid',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await prepareBookingAction('00000000-0000-0000-0000-000000000001', EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it('FORBIDDEN (membership absente) → revalidatePath NON appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const ids = await seedBaseData();
      const outsider = await makeUser(`rvp-forbidden-${SUFFIX()}@example.com`);
      mockClerkUser(outsider);
      const fd = makeFormData({
        bookingId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await prepareBookingAction(ids.orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it('transition invalide (FULFILLMENT_INVALID_TRANSITION) → revalidatePath NON appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Force le statut à ACTIVE — prepareBooking depuis ACTIVE est invalide.
      await setBookingStatus(booking.bookingId, 'ACTIVE');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it('report refusé (FULFILLMENT_REPORT_NOT_ALLOWED) → revalidatePath NON appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Booking est CONFIRMED — le rapport PICKUP nécessite READY_FOR_PICKUP.
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it('UNKNOWN (erreur inconnue) → revalidatePath NON appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      vi.mocked(coreModule.prepareBooking).mockImplementationOnce(() => {
        throw new Error('SECRET_INTERNAL_DB_DETAIL_12345');
      });
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it('succès APPLIED → revalidatePath appelée', async () => {
      if (!testDb || !rawSql) return;
      vi.mocked(revalidatePath).mockClear();
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    });

    it('replay réussi (même clé, même payload) → revalidatePath appelée 4x (une par chemin)', async () => {
      if (!testDb || !rawSql) return;
      const { booking, orgId } = await seedConfirmedBookingWithOperator('OWNER');
      // Prepare d'abord pour que le booking soit READY_FOR_PICKUP.
      const fdPrepare = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(orgId, EMPTY_PREV, fdPrepare);

      // Premier rapport.
      const key = 'key-replay-rvp-' + SUFFIX();
      const fd = makeFormData({
        bookingId: booking.bookingId,
        bookingItemId: booking.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        notes: 'RAS',
        idempotencyKey: key,
      });
      vi.mocked(revalidatePath).mockClear();
      await createConditionReportAction(orgId, EMPTY_PREV, fd);
      // Chaque appel d'action invalide les listes et détails historiques et du cockpit.
      expect(vi.mocked(revalidatePath)).toHaveBeenCalledTimes(4);

      // Replay : même payload, même clé.
      vi.mocked(revalidatePath).mockClear();
      await createConditionReportAction(orgId, EMPTY_PREV, fd);
      expect(vi.mocked(revalidatePath)).toHaveBeenCalledTimes(4);
      // Un seul rapport en base (pas de doublon).
      expect(await countConditionReports(booking.bookingId)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Multi-tenant (3 tests).
  // -------------------------------------------------------------------------
  describe('Multi-tenant', () => {
    it('aucun booking/rapport/audit/outbox créé dans une autre organisation', async () => {
      if (!testDb || !rawSql) return;
      // Seed deux orgs.
      const ids1 = await seedBaseData();
      const ids2 = await seedBaseData();
      const operator = await makeUser(`mt-operator-${SUFFIX()}@example.com`);
      await addMember(ids1.orgId, operator, 'OWNER');
      mockClerkUser(operator);
      const booking = await seedConfirmedBooking(ids1);

      // Appelle prepareBooking sur org1.
      const fd = makeFormData({
        bookingId: booking.bookingId,
        idempotencyKey: 'key-mt-' + SUFFIX(),
      });
      const result = await prepareBookingAction(ids1.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(true);

      // Vérifie qu'org2 n'a rien reçu.
      expect(await countBookingsInOrg(ids2.orgId)).toBe(0);
      expect(await countOutboxEventsInOrg(ids2.orgId)).toBe(0);
      expect(await countConditionReportsInOrg(ids2.orgId)).toBe(0);
      expect(await countDamageReportsInOrg(ids2.orgId)).toBe(0);
      expect(await countFulfillmentEventsInOrg(ids2.orgId)).toBe(0);
    });

    it("tentative avec bookingId d'une autre organisation → FORBIDDEN (pas de fuite d'existence)", async () => {
      if (!testDb || !rawSql) return;
      // Crée un booking dans org1.
      const ids1 = await seedBaseData();
      const booking1 = await seedConfirmedBooking(ids1);
      // Opérateur membre de org2 (pas org1).
      const ids2 = await seedBaseData();
      const operator = await makeUser(`mt-cross-${SUFFIX()}@example.com`);
      await addMember(ids2.orgId, operator, 'OWNER');
      mockClerkUser(operator);

      // Tente prepareBooking sur org2 avec le bookingId de org1.
      // Le use case Core vérifie organizationId : ORGANIZATION_MISMATCH → FORBIDDEN.
      const fd = makeFormData({
        bookingId: booking1.bookingId,
        idempotencyKey: 'key-cross-org-' + SUFFIX(),
      });
      const result = await prepareBookingAction(ids2.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // ORGANIZATION_MISMATCH est mappé vers FORBIDDEN par action-mapper.
        expect(result.code).toBe('FORBIDDEN');
      }
    });

    it("tentative avec bookingItemId d'une autre organisation → FULFILLMENT_INVALID_TRANSITION ou NOT_FOUND", async () => {
      if (!testDb || !rawSql) return;
      // Crée un booking dans org1 (avec booking_item).
      const ids1 = await seedBaseData();
      const booking1 = await seedConfirmedBooking(ids1);
      // Opérateur membre de org1.
      const operator = await makeUser(`mt-item-${SUFFIX()}@example.com`);
      await addMember(ids1.orgId, operator, 'OWNER');
      mockClerkUser(operator);

      // Crée un deuxième booking dans org2 (avec booking_item).
      const ids2 = await seedBaseData();
      const booking2 = await seedConfirmedBooking(ids2);

      // Prepare le booking de org1 pour que le condition report soit valide (READY_FOR_PICKUP).
      const fdPrepare = makeFormData({
        bookingId: booking1.bookingId,
        idempotencyKey: 'key-prepare-' + SUFFIX(),
      });
      await prepareBookingAction(ids1.orgId, EMPTY_PREV, fdPrepare);

      // Tente createConditionReport sur org1 avec bookingId de org1 mais bookingItemId de org2.
      // Le booking_item de org2 n'appartient pas au booking de org1 → BOOKING_ITEM_MISMATCH.
      const fd = makeFormData({
        bookingId: booking1.bookingId,
        bookingItemId: booking2.bookingItemId,
        phase: 'PICKUP',
        condition: 'GOOD',
        idempotencyKey: 'key-cross-item-' + SUFFIX(),
      });
      const result = await createConditionReportAction(ids1.orgId, EMPTY_PREV, fd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // BOOKING_ITEM_MISMATCH est mappé vers FULFILLMENT_INVALID_TRANSITION.
        expect(result.code).toBe('FULFILLMENT_INVALID_TRANSITION');
      }
    });
  });
});
