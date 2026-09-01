import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import postgres from 'postgres';
import { createDatabase, runMigrations, assertLocalhost } from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import {
  createOrganizationForUser,
  createLocation,
  provisionUserFromOidc,
  createProduct,
  publishProduct,
  createInventoryItem,
  createBookingDraftWithHold,
  FakeStripeAdapter,
  type AuthenticatedUser,
} from '@uttily/core';
import type { CreateBookingDraftInput } from '@uttily/core';
import { eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : Clerk, getDb, next/cache et @/lib/stripe.
//
// initiatePaymentAction dépend de Clerk, du singleton `getDb()` et de
// `getStripeAdapter()`. On mocke les trois pour contrôler l'identité, brancher
// une base de test PostgreSQL réelle et substituer le FakeStripeAdapter.
// ---------------------------------------------------------------------------

vi.mock('@clerk/nextjs/server', () => ({
  currentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

let testDb: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { getAuthenticatedUser: actual.getAuthenticatedUser };
});

const fakeAdapter = new FakeStripeAdapter({ environment: 'TEST' });

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => fakeAdapter,
}));

const { currentUser } = await import('@clerk/nextjs/server');
const { initiatePaymentAction } = await import('./payments');

// ---------------------------------------------------------------------------
// Setup base de test (réplique du pattern catalog.test.ts).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttuly_test_payments';

process.env.STRIPE_ENVIRONMENT = 'TEST';

function shouldSkipIntegrationTests(): boolean {
  if (isCi) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

let adminUrl: string | null = null;
let adminSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isCi) throw new Error("CI: DATABASE_URL est requise pour les tests d'action.");
    return;
  }

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

  assertLocalhost(url);
  adminUrl = url;

  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
    adminSql = null;
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  const testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
  testDb = createDatabase(testUrl);
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
  // Réinitialise toutes les tables liées au flux de paiement et de réservation.
  await testDb.execute(
    sql`TRUNCATE TABLE
      payment_attempts, payments, payment_webhook_events, organization_payment_accounts,
      allocations, booking_draft_lines, booking_drafts, inventory_blocks,
      inventory_movements, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships, organizations,
      users, idempotency_records
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

async function getCategoryId(slug = 'equipment'): Promise<string> {
  if (!testDb) throw new Error('db not initialized');
  const { categories } = await import('@uttily/database');
  const [cat] = await testDb.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  if (!cat) throw new Error(`Catégorie seed "${slug}" introuvable.`);
  return cat.id;
}

/** Période standard : 10–12 février 2026 (3 jours civils Europe/Paris). */
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

interface BaseIds {
  orgId: string;
  locationId: string;
  customerUserId: string;
  variantId: string;
}

/**
 * Crée les données de base : organisation (owner), lieu, produit PUBLISHED,
 * variante (prix 5000, EUR, active) et 3 exemplaires physiques.
 */
async function seedBaseData(owner: AuthenticatedUser): Promise<BaseIds> {
  if (!testDb || !rawSql) throw new Error('db not initialized');
  const sql = rawSql;
  const { organization } = await createOrganizationForUser(testDb, owner, {
    legalName: 'Payments Test Org',
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(testDb, {
    organizationId: organization.id,
    name: 'Annecy',
    timeZone: 'Europe/Paris',
  });
  const categoryId = await getCategoryId('kayak');
  const product = await createProduct(testDb, {
    organizationId: organization.id,
    categoryId,
    name: 'Kayak',
    description: 'Kayak test',
  });
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${organization.id}, ${product.id}, ${'product-photos/' + product.id + '-' + _pi},
        'image/jpeg', 102400, 800, 600, ${('000' + _pi).repeat(16).slice(0, 64)},
        ${_pi}, 'AVAILABLE'
      )
    `;
  }
  await publishProduct(testDb, organization.id, product.id);
  // createVariant ne prend pas de prix — on insère la variante avec son prix
  // via SQL brut (comme les tests d'intégration core).
  const variantRow = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i];
    if (cond === undefined) continue;
    await createInventoryItem(testDb, {
      organizationId: organization.id,
      productVariantId: variantRow.id,
      internalSku: `KAY-PAY-${i}`,
      currentLocationId: location.id,
      condition: cond,
      status: 'ACTIVE',
    });
  }
  return {
    orgId: organization.id,
    locationId: location.id,
    customerUserId: owner.id,
    variantId: variantRow.id,
  };
}

/**
 * Crée un brouillon HELD réel via createBookingDraftWithHold.
 * Le customer est un utilisateur distinct du loueur.
 */
async function createHeldDraft(ids: BaseIds, customerUserId: string): Promise<string> {
  if (!testDb) throw new Error('db not initialized');
  const input: CreateBookingDraftInput = {
    pricingMode: 'LEGACY',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'held-payments-test',
  };
  const result = await createBookingDraftWithHold(testDb, input);
  if (result.kind !== 'SUCCESS') throw new Error('Failed to create held draft');
  return result.body.draftId;
}

// ---------------------------------------------------------------------------
// Tests d'intégration PostgreSQL — initiatePaymentAction.
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Server Actions — initiatePaymentAction (intégration PostgreSQL)',
  () => {
    it('Test 1 : utilisateur non authentifié → FAILURE 401', async () => {
      if (!testDb) return;
      mockClerkUser(null);
      const result = await initiatePaymentAction({
        draftId: '00000000-0000-0000-0000-000000000001',
        idempotencyKey: 'init-auth-1',
        termsVersion: 'v1',
      });
      expect(result.kind).toBe('FAILURE');
      if (result.kind === 'FAILURE') {
        expect(result.statusCode).toBe(401);
        expect(result.error).toBe('UNAUTHENTICATED');
      }
    });

    it('Test 2 : brouillon introuvable → FAILURE 404', async () => {
      if (!testDb) return;
      const user = await makeUser('customer-notfound@example.com');
      mockClerkUser(user);
      const result = await initiatePaymentAction({
        draftId: '00000000-0000-0000-0000-000000000099',
        idempotencyKey: 'init-notfound-1',
        termsVersion: 'v1',
      });
      expect(result.kind).toBe('FAILURE');
      if (result.kind === 'FAILURE') {
        expect(result.statusCode).toBe(404);
        expect(result.error).toBe('NOT_FOUND');
      }
    });

    it('Test 3 : brouillon appartenant à un autre user → FAILURE 403', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-pay@example.com');
      const ids = await seedBaseData(owner);
      const customer = await makeUser('customer-pay@example.com');
      const other = await makeUser('other-pay@example.com');

      // Crée un brouillon appartenant à `customer`.
      const draftId = await createHeldDraft(ids, customer.id);

      // `other` tente de payer le brouillon de `customer` → FORBIDDEN.
      mockClerkUser(other);
      const result = await initiatePaymentAction({
        draftId,
        idempotencyKey: 'init-forbidden-1',
        termsVersion: 'v1',
      });
      expect(result.kind).toBe('FAILURE');
      if (result.kind === 'FAILURE') {
        expect(result.statusCode).toBe(403);
        expect(result.error).toBe('FORBIDDEN');
      }
    });

    it('Test 4 : brouillon sans compte connecté → FAILURE (FINANCIAL_TERMS_UNRESOLVED)', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-noterms@example.com');
      const ids = await seedBaseData(owner);
      const customer = await makeUser('customer-noterms@example.com');

      // Aucun compte connecté créé pour cette org → l'action refuse le
      // paiement avant tout appel provider.
      const draftId = await createHeldDraft(ids, customer.id);

      mockClerkUser(customer);
      const result = await initiatePaymentAction({
        draftId,
        idempotencyKey: 'init-noterms-1',
        termsVersion: 'v1',
      });
      expect(result.kind).toBe('FAILURE');
      if (result.kind === 'FAILURE') {
        // Aucun compte connecté n'est disponible ; aucun appel Stripe n'est
        // effectué.
        expect(result.error).toBe('FINANCIAL_TERMS_UNRESOLVED');
      }
    });

    it('Test 5 : isolation multi-tenant — utilisateur de org B sur brouillon de org A → FAILURE 403', async () => {
      if (!testDb) return;
      // Org A avec un brouillon HELD.
      const ownerA = await makeUser('owner-orga@example.com');
      const idsA = await seedBaseData(ownerA);
      const customerA = await makeUser('customer-orga@example.com');
      const draftIdA = await createHeldDraft(idsA, customerA.id);

      // Org B avec un utilisateur distinct.
      const ownerB = await makeUser('owner-orgb@example.com');
      const { organization: orgB } = await createOrganizationForUser(testDb, ownerB, {
        legalName: 'Org B Test',
        defaultCurrency: 'EUR',
      });
      const userB = await makeUser('user-orgb@example.com');
      // L'utilisateur B est membre de org B (pas de org A).
      void orgB; // orgB créé pour isoler le contexte multi-tenant.

      // L'utilisateur de org B tente initiatePaymentAction sur le brouillon de org A.
      mockClerkUser(userB);
      const result = await initiatePaymentAction({
        draftId: draftIdA,
        idempotencyKey: 'init-cross-tenant-1',
        termsVersion: 'v1',
      });
      expect(result.kind).toBe('FAILURE');
      if (result.kind === 'FAILURE') {
        expect(result.statusCode).toBe(403);
        expect(result.error).toBe('FORBIDDEN');
      }
    });

    it('Test 6 : clientSecret absent du schéma DB (payments, payment_attempts, idempotency_records)', async () => {
      if (!testDb || !rawSql) return;
      // P2 : Vérifier qu'aucune colonne client_secret n'existe dans le schéma.
      // Cela valide que le clientSecret (retourné au client mais jamais persisté)
      // ne peut pas fuiter en DB, même partiellement.
      const sql = rawSql;
      const rows = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name IN ('payments', 'payment_attempts', 'idempotency_records')
          AND column_name LIKE '%secret%'
      `;
      expect(rows.length).toBe(0);
    });
  },
);
