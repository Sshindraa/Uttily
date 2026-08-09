import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  runMigrations,
  organizationMemberships,
  organizationPaymentAccounts,
  assertLocalhost,
} from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import {
  createOrganizationForUser,
  provisionUserFromOidc,
  FakeStripeAdapter,
  ConnectedAccountError,
  AuthorizationError,
  type AuthenticatedUser,
} from '@uttily/core';
import { eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : Clerk, getDb, next/cache et @/lib/stripe.
//
// Les Server Actions d'onboarding dépendent de Clerk (`getAuthenticatedUser`),
// du singleton `getDb()` et de `getStripeAdapter()`. On mocke les trois pour
// contrôler l'identité, brancher une base de test PostgreSQL réelle et
// substituer le FakeStripeAdapter (déterministe, aucune API Stripe réelle).
// ---------------------------------------------------------------------------

vi.mock('@clerk/nextjs/server', () => ({
  currentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock next/headers — headers() retourne une Promise<ReadonlyHeaders>.
// En test, on simule un host localhost:3000 pour que l'origin passée par les
// tests (http://localhost:3000) corresponde au host de la requête.
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'localhost:3000' })),
}));

let testDb: DatabaseClient | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { getAuthenticatedUser: actual.getAuthenticatedUser };
});

// FakeStripeAdapter déterministe — aucune API Stripe réelle (ADR-010).
// Configuré avec environment: 'TEST' pour correspondre à STRIPE_ENVIRONMENT.
const fakeAdapter = new FakeStripeAdapter({ environment: 'TEST' });

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => fakeAdapter,
}));

// Importe les actions APRÈS les mocks.
const { currentUser } = await import('@clerk/nextjs/server');
const {
  getConnectedAccountReadinessAction,
  createConnectedAccountAction,
  createOnboardingLinkAction,
} = await import('./connected-accounts');

// ---------------------------------------------------------------------------
// Setup base de test (réplique du pattern catalog.test.ts).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttuly_test_connected_accounts';

// L'environnement Stripe est lu par les actions via process.env.
process.env.STRIPE_ENVIRONMENT = 'TEST';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false. En local, skip si DATABASE_URL absente
 * ou SKIP_INTEGRATION_TESTS=1.
 */
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
});

afterAll(async () => {
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
  // Réinitialise les tables liées à l'onboarding. Les catégories seedées
  // ne sont pas touchées.
  await testDb.execute(
    sql`TRUNCATE TABLE organization_payment_accounts, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
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
): Promise<{ organizationId: string }> {
  if (!testDb) throw new Error('db not initialized');
  const { organization } = await createOrganizationForUser(testDb, user, {
    legalName,
    defaultCurrency: 'EUR',
  });
  return { organizationId: organization.id };
}

/** Ajoute une membership avec un rôle donné. */
async function addMember(
  organizationId: string,
  user: AuthenticatedUser,
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF',
): Promise<void> {
  if (!testDb) throw new Error('db not initialized');
  await testDb
    .insert(organizationMemberships)
    .values({
      organizationId,
      userId: user.id,
      role,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();
}

/** Compte les lignes de compte connecté pour une org en DB. */
async function countPaymentAccounts(organizationId: string): Promise<number> {
  if (!testDb) throw new Error('db not initialized');
  const rows = await testDb
    .select({ id: organizationPaymentAccounts.id })
    .from(organizationPaymentAccounts)
    .where(eq(organizationPaymentAccounts.organizationId, organizationId));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Tests d'intégration PostgreSQL — Server Actions d'onboarding Stripe.
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Server Actions — onboarding compte connecté (intégration PostgreSQL)',
  () => {
    it('Test 1 : getConnectedAccountReadinessAction — pas de compte → notConfigured = true', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-readiness@example.com');
      const { organizationId } = await makeOrg(owner, 'Readiness Org');
      mockClerkUser(owner);

      const readiness = await getConnectedAccountReadinessAction(organizationId);
      expect(readiness.notConfigured).toBe(true);
      expect(readiness.ready).toBe(false);
      expect(readiness.organizationPaymentAccountId).toBeNull();
      expect(readiness.providerAccountId).toBeNull();
    });

    it('Test 2 : createConnectedAccountAction — crée le compte, vérifie la ligne en DB', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-create@example.com');
      const { organizationId } = await makeOrg(owner, 'Create Org');
      mockClerkUser(owner);

      const result = await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-1',
      });
      expect(result.organizationPaymentAccountId).toBeTruthy();
      expect(result.providerAccountId).toMatch(/^acct_/);
      expect(result.onboardingStatus).toBe('PENDING');
      expect(result.chargesEnabled).toBe(false);

      // La ligne existe en DB pour (org, STRIPE, TEST).
      const count = await countPaymentAccounts(organizationId);
      expect(count).toBe(1);
    });

    it('Test 3 : createConnectedAccountAction — compte déjà existant → ACCOUNT_ALREADY_EXISTS', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-duplicate@example.com');
      const { organizationId } = await makeOrg(owner, 'Duplicate Org');
      mockClerkUser(owner);

      await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-dup-1',
      });

      try {
        await createConnectedAccountAction(organizationId, {
          country: 'FR',
          idempotencyKey: 'create-ca-dup-2',
        });
        expect.unreachable('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(ConnectedAccountError);
        expect((e as ConnectedAccountError).code).toBe('ACCOUNT_ALREADY_EXISTS');
      }
    });

    it('Test 4 : createConnectedAccountAction — utilisateur non OWNER → erreur (FORBIDDEN)', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-staff2@example.com');
      const { organizationId } = await makeOrg(owner, 'Staff Forbidden Org');
      const staff = await makeUser('staff2@example.com');
      // ROLE_MANAGERS = ['OWNER'] uniquement — STAFF n'est pas autorisé.
      await addMember(organizationId, staff, 'STAFF');
      mockClerkUser(staff);

      try {
        await createConnectedAccountAction(organizationId, {
          country: 'FR',
          idempotencyKey: 'create-ca-staff-1',
        });
        expect.unreachable('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(AuthorizationError);
      }
    });

    it('Test 5 : createOnboardingLinkAction — compte PENDING → lien généré, statut → SUBMITTED', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-link@example.com');
      const { organizationId } = await makeOrg(owner, 'Link Org');
      mockClerkUser(owner);

      await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-link-1',
      });

      const link = await createOnboardingLinkAction(organizationId, {
        idempotencyKey: 'onboarding-link-1',
        origin: 'http://localhost:3000',
      });
      expect(link.url).toMatch(/^https:\/\//);
      expect(link.expiresAt).toBeGreaterThan(0);

      // Le statut d'onboarding doit être passé à SUBMITTED en DB.
      const rows = await testDb
        .select({ status: organizationPaymentAccounts.onboardingStatus })
        .from(organizationPaymentAccounts)
        .where(eq(organizationPaymentAccounts.organizationId, organizationId))
        .limit(1);
      expect(rows[0]?.status).toBe('SUBMITTED');
    });

    it('Test 6 : createOnboardingLinkAction — compte non trouvé → erreur ACCOUNT_NOT_FOUND', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-nolink@example.com');
      const { organizationId } = await makeOrg(owner, 'No Account Org');
      mockClerkUser(owner);

      // Aucun compte connecté créé pour cette org.
      try {
        await createOnboardingLinkAction(organizationId, {
          idempotencyKey: 'onboarding-link-missing',
          origin: 'http://localhost:3000',
        });
        expect.unreachable('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(ConnectedAccountError);
        expect((e as ConnectedAccountError).code).toBe('ACCOUNT_NOT_FOUND');
      }
    });

    it('Test 7 : createOnboardingLinkAction — compte déjà ENABLED → erreur VALIDATION', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-enabled@example.com');
      const { organizationId } = await makeOrg(owner, 'Enabled Org');
      mockClerkUser(owner);

      await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-enabled-1',
      });

      // Force le statut à ENABLED en DB pour simuler un onboarding complété.
      await testDb
        .update(organizationPaymentAccounts)
        .set({ onboardingStatus: 'ENABLED', updatedAt: new Date() })
        .where(eq(organizationPaymentAccounts.organizationId, organizationId));

      try {
        await createOnboardingLinkAction(organizationId, {
          idempotencyKey: 'onboarding-link-enabled',
          origin: 'http://localhost:3000',
        });
        expect.unreachable('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(ConnectedAccountError);
        expect((e as ConnectedAccountError).code).toBe('VALIDATION');
      }
    });

    it('Test 8 : getConnectedAccountReadinessAction — après création, compte PENDING → ready = false', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-pending@example.com');
      const { organizationId } = await makeOrg(owner, 'Pending Org');
      mockClerkUser(owner);

      await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-pending-1',
      });

      const readiness = await getConnectedAccountReadinessAction(organizationId);
      expect(readiness.notConfigured).toBe(false);
      expect(readiness.ready).toBe(false);
      expect(readiness.onboardingStatus).toBe('PENDING');
      expect(readiness.chargesEnabled).toBe(false);
    });

    it('Test 9 : multi-tenant — org A crée un compte, org B ne voit pas le compte de org A', async () => {
      if (!testDb) return;
      const ownerA = await makeUser('owner-a@example.com');
      const { organizationId: orgA } = await makeOrg(ownerA, 'Org A');
      const ownerB = await makeUser('owner-b@example.com');
      const { organizationId: orgB } = await makeOrg(ownerB, 'Org B');

      // Org A crée son compte.
      mockClerkUser(ownerA);
      await createConnectedAccountAction(orgA, {
        country: 'FR',
        idempotencyKey: 'create-ca-orgA-1',
      });

      // Org B interroge sa readiness — ne doit pas voir le compte de A.
      mockClerkUser(ownerB);
      const readinessB = await getConnectedAccountReadinessAction(orgB);
      expect(readinessB.notConfigured).toBe(true);
      expect(readinessB.providerAccountId).toBeNull();

      // Aucune ligne en DB pour org B.
      const countB = await countPaymentAccounts(orgB);
      expect(countB).toBe(0);
      // Une ligne pour org A.
      const countA = await countPaymentAccounts(orgA);
      expect(countA).toBe(1);
    });

    it('Test 10 : TEST/LIVE — créer un compte TEST, vérifier qu’un compte LIVE n’existe pas (isolation environment)', async () => {
      if (!testDb) return;
      const owner = await makeUser('owner-env@example.com');
      const { organizationId } = await makeOrg(owner, 'Env Isolation Org');
      mockClerkUser(owner);

      // Crée le compte en environnement TEST.
      await createConnectedAccountAction(organizationId, {
        country: 'FR',
        idempotencyKey: 'create-ca-env-test-1',
      });

      // L'environnement TEST est configuré → compte présent.
      const readinessTest = await getConnectedAccountReadinessAction(organizationId);
      expect(readinessTest.notConfigured).toBe(false);

      // Bascule temporairement l'environnement lu par l'action sur LIVE.
      // getConnectedAccountReadiness ne fait aucun appel provider — elle lit
      // uniquement la DB par (org, STRIPE, environment). Aucun compte LIVE
      // n'a été créé → notConfigured = true (isolation par environment).
      const previous = process.env.STRIPE_ENVIRONMENT;
      process.env.STRIPE_ENVIRONMENT = 'LIVE';
      try {
        const readinessLive = await getConnectedAccountReadinessAction(organizationId);
        expect(readinessLive.notConfigured).toBe(true);
        expect(readinessLive.environment).toBe('LIVE');
      } finally {
        process.env.STRIPE_ENVIRONMENT = previous ?? 'TEST';
      }
    });
  },
);
