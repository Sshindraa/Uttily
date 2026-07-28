import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  createProduct,
  publishProduct,
  archiveProduct,
  createVariant,
  listVariants,
  createInventoryItem,
  listMovements,
  type AuthenticatedUser,
} from '@uttily/core';
import { eq, sql } from 'drizzle-orm';

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

// Importe les actions APRÈS les mocks pour qu'elles utilisent les versions mockées.
const { currentUser } = await import('@clerk/nextjs/server');
const {
  createProductAction,
  updateProductAction,
  publishProductAction,
  archiveProductAction,
  restoreArchivedProductAction,
} = await import('./products');
const { createVariantAction, updateVariantAction, deactivateVariantAction } =
  await import('./variants');
const { createInventoryItemAction, transferInventoryItemAction, retireInventoryItemAction } =
  await import('./inventory');

// ---------------------------------------------------------------------------
// Setup base de test (réplique minimale de setupIntegrationTestDb).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttily_test_actions';

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
    // DATABASE_URL défini mais base injoignable en local : échec explicite,
    // pas de faux vert (skip silencieux).
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
  // Garde de sécurité : ne devrait plus être atteint car describe.skipIf
  // (shouldSkipIntegrationTests) skipe toute la suite quand la base est absente
  // ou SKIP_INTEGRATION_TESTS=1, et le setup throw si la base est injoignable.
  // Conservé par défense en profondeur.
  if (!testDb) return;
  vi.mocked(currentUser).mockReset();
  // TRUNCATE réinitialise les tables (RESTART IDENTITY). Les catégories
  // seedées ne sont pas tronquées.
  await testDb.execute(
    sql`TRUNCATE TABLE inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
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

/** Ajoute une membership avec un rôle donné (pour tester STAFF/MANAGER). */
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

async function getCategoryId(slug = 'surf'): Promise<string> {
  if (!testDb) throw new Error('db not initialized');
  const { categories } = await import('@uttily/database');
  const [cat] = await testDb.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  if (!cat) throw new Error(`Catégorie seed "${slug}" introuvable.`);
  return cat.id;
}

function makeFormData(data: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(data)) {
    fd.set(key, value);
  }
  return fd;
}

const EMPTY_PREV = { ok: true as const, data: null as never };

// ---------------------------------------------------------------------------
// Tests de frontière — createProductAction.
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Server Actions — frontière catalogue', () => {
  it('utilisateur non authentifié → UNAUTHENTICATED', async () => {
    if (!testDb) return;
    mockClerkUser(null);
    const categoryId = await getCategoryId();
    const fd = makeFormData({
      categoryId,
      name: 'Test Product',
    });
    const result = await createProductAction(
      '00000000-0000-0000-0000-000000000001',
      EMPTY_PREV,
      fd,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNAUTHENTICATED');
    }
  });

  it('STAFF sur mutation → FORBIDDEN', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-staff@example.com');
    const { organizationId } = await makeOrg(owner, 'Staff Org');
    const staff = await makeUser('staff@example.com');
    await addMember(organizationId, staff, 'STAFF');
    mockClerkUser(staff);

    const categoryId = await getCategoryId();
    const fd = makeFormData({
      categoryId,
      name: 'Test Product',
    });
    const result = await createProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FORBIDDEN');
    }
  });

  it('MANAGER autorisé → ok: true avec données', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-mgr@example.com');
    const { organizationId } = await makeOrg(owner, 'Manager Org');
    const manager = await makeUser('manager@example.com');
    await addMember(organizationId, manager, 'MANAGER');
    mockClerkUser(manager);

    const categoryId = await getCategoryId();
    const fd = makeFormData({
      categoryId,
      name: 'Manager Product',
      description: 'Une description',
    });
    const result = await createProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Manager Product');
      expect(result.data.publicationStatus).toBe('DRAFT');
    }
  });

  it("organizationId bindé sur une org dont l'utilisateur n'est pas manager → FORBIDDEN", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-fake@example.com');
    await makeOrg(owner, 'Real Org A');
    mockClerkUser(owner);
    // L'utilisateur est OWNER de orgA mais pas de orgB.
    const fd = makeFormData({
      categoryId: await getCategoryId(),
      name: 'Fake Org Product',
    });
    // Tente d'appeler l'action avec organizationId = orgB (binding).
    // L'utilisateur n'a pas de membership sur orgB → FORBIDDEN.
    const result = await createProductAction(
      '00000000-0000-0000-0000-000000000099',
      EMPTY_PREV,
      fd,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Pas de membership sur l'org bindée → AuthorizationError → FORBIDDEN.
      expect(result.code).toBe('FORBIDDEN');
    }
  });

  it('slug dupliqué → CONFLICT_SLUG', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-slug@example.com');
    const { organizationId } = await makeOrg(owner, 'Slug Conflict Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    // Premier produit.
    await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Duplicate Slug',
      description: 'Desc',
    });

    // Deuxième produit avec le même slug auto-généré.
    const fd = makeFormData({
      categoryId,
      name: 'Duplicate Slug',
    });
    const result = await createProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CONFLICT_SLUG');
    }
  });

  it('publication incomplète → PUBLISH_INCOMPLETE', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-pub@example.com');
    const { organizationId } = await makeOrg(owner, 'Publish Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    // Crée un produit sans description (incomplet pour la publication).
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Unpublished',
      description: '',
    });

    const fd = makeFormData({
      productId: product.id,
    });
    const result = await publishProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PUBLISH_INCOMPLETE');
    }
  });

  it("clé de transfert propagée telle quel jusqu'au domaine", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-transfer@example.com');
    const { organizationId, locationId } = await makeOrg(owner, 'Transfer Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Transfer Product',
      description: 'Desc',
    });
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    // Crée un deuxième établissement pour le transfert.
    const location2 = await createLocation(testDb, {
      organizationId,
      name: 'Shop Secondaire',
      timeZone: 'Europe/Paris',
    });

    const item = await createInventoryItem(testDb, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'TR-001',
      currentLocationId: locationId,
    });

    const idempotencyKey = 'transfer-key-abc-123';
    const fd = makeFormData({
      itemId: item.id,
      toLocationId: location2.id,
      idempotencyKey,
      reason: 'Déplacement test',
    });
    const result = await transferInventoryItemAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.movement).not.toBeNull();
      expect(result.data.movement?.idempotencyKey).toBe(idempotencyKey);
    }

    // Vérifie aussi via listMovements que la clé est persistée.
    const movements = await listMovements(testDb, organizationId, item.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]!.idempotencyKey).toBe(idempotencyKey);
  });

  it('validation formData : nom trop court → VALIDATION avec fieldErrors', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-val@example.com');
    const { organizationId } = await makeOrg(owner, 'Validation Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const fd = makeFormData({
      categoryId,
      name: 'A', // < 2 caractères
    });
    const result = await createProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.name).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Tests cross-tenant et distinction NOT_FOUND vs FORBIDDEN.
  // -------------------------------------------------------------------------

  it("cross-tenant au niveau action : update d'un produit d'une autre org → NOT_FOUND", async () => {
    if (!testDb) return;
    const ownerA = await makeUser('owner-cross-a@example.com');
    const { organizationId: orgA } = await makeOrg(ownerA, 'Cross Tenant Org A');
    const ownerB = await makeUser('owner-cross-b@example.com');
    const { organizationId: orgB } = await makeOrg(ownerB, 'Cross Tenant Org B');

    // Crée un produit dans orgB.
    const categoryId = await getCategoryId();
    const productB = await createProduct(testDb, {
      organizationId: orgB,
      categoryId,
      name: 'Product B',
      description: 'Desc B',
    });

    // ownerA (manager de orgA) tente d'update le produit de orgB
    // en passant organizationId = orgA au binding mais productId = produit de orgB.
    mockClerkUser(ownerA);
    const fd = makeFormData({
      productId: productB.id,
      name: 'Hijacked Name',
    });
    const result = await updateProductAction(orgA, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Le domaine updateProduct(db, orgA, productIdDeB) ne trouve pas le produit
      // dans orgA → AuthorizationError('Produit introuvable.') → NOT_FOUND.
      // Pas de fuite d'existence du produit de orgB.
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it("update d'un produit inexistant (UUID aléatoire) → NOT_FOUND", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-notfound@example.com');
    const { organizationId } = await makeOrg(owner, 'Not Found Org');
    mockClerkUser(owner);

    const fd = makeFormData({
      productId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'New Name',
    });
    const result = await updateProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  // -------------------------------------------------------------------------
  // Tests de validation supplémentaires.
  // -------------------------------------------------------------------------

  it("transfer sans clé d'idempotence → VALIDATION avec fieldErrors.idempotencyKey", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-idem@example.com');
    const { organizationId, locationId } = await makeOrg(owner, 'Idempotency Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Idempotency Product',
      description: 'Desc',
    });
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    const location2 = await createLocation(testDb, {
      organizationId,
      name: 'Shop Secondaire',
      timeZone: 'Europe/Paris',
    });

    const item = await createInventoryItem(testDb, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'IDEM-001',
      currentLocationId: locationId,
    });

    // idempotencyKey vide.
    const fd = makeFormData({
      itemId: item.id,
      toLocationId: location2.id,
      idempotencyKey: '',
    });
    const result = await transferInventoryItemAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.idempotencyKey).toBeDefined();
    }
  });

  it('validation enum inventory : condition invalide → VALIDATION avec fieldErrors.condition', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-enum@example.com');
    const { organizationId, locationId } = await makeOrg(owner, 'Enum Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Enum Product',
      description: 'Desc',
    });
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    const fd = makeFormData({
      productVariantId: variantId,
      internalSku: 'ENUM-001',
      currentLocationId: locationId,
      condition: 'INVALID',
    });
    const result = await createInventoryItemAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION');
      expect(result.fieldErrors?.condition).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Tests de succès pour les actions non couvertes.
  // -------------------------------------------------------------------------

  it("updateProductAction succès : créer un produit, l'update avec un nouveau nom → ok: true", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-update@example.com');
    const { organizationId } = await makeOrg(owner, 'Update Success Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Original Name',
      description: 'Desc',
    });

    const fd = makeFormData({
      productId: product.id,
      name: 'Updated Name',
    });
    const result = await updateProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Updated Name');
    }
  });

  it("archiveProductAction succès : créer + publier un produit, l'archiver → ok: true avec ARCHIVED", async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-archive@example.com');
    const { organizationId } = await makeOrg(owner, 'Archive Success Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Archive Product',
      description: 'Desc',
    });
    // Publie le produit (la variante Standard est créée automatiquement).
    await publishProduct(testDb, organizationId, product.id);

    const fd = makeFormData({
      productId: product.id,
    });
    const result = await archiveProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.publicationStatus).toBe('ARCHIVED');
    }
  });

  it('deactivateVariantAction succès : créer un produit, créer une 2e variante, désactiver la 2e → ok: true', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-deact@example.com');
    const { organizationId } = await makeOrg(owner, 'Deactivate Success Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Deactivate Product',
      description: 'Desc',
    });
    // createProduct crée automatiquement une variante "Standard".
    // Crée une 2e variante pour pouvoir la désactiver (la 1re reste active).
    const variant2 = await createVariant(testDb, {
      organizationId,
      productId: product.id,
      name: 'Premium',
    });

    const fd = makeFormData({
      variantId: variant2.id,
    });
    const result = await deactivateVariantAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isActive).toBe(false);
    }
  });

  it('retireInventoryItemAction succès : créer un exemplaire, le retirer → ok: true avec RETIRED', async () => {
    if (!testDb) return;
    const owner = await makeUser('owner-retire@example.com');
    const { organizationId, locationId } = await makeOrg(owner, 'Retire Success Org');
    mockClerkUser(owner);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Retire Product',
      description: 'Desc',
    });
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    const item = await createInventoryItem(testDb, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RET-001',
      currentLocationId: locationId,
    });

    const fd = makeFormData({
      itemId: item.id,
    });
    const result = await retireInventoryItemAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('RETIRED');
    }
  });

  // -------------------------------------------------------------------------
  // Tests de succès pour les actions restantes non couvertes.
  // -------------------------------------------------------------------------

  it('createVariantAction : MANAGER crée une variante avec succès', async () => {
    if (!testDb) return;
    const owner = await makeUser('variant-create@example.com');
    const { organizationId } = await makeOrg(owner, 'Variant Create Org');
    const manager = await makeUser('variant-create-mgr@example.com');
    await addMember(organizationId, manager, 'MANAGER');
    mockClerkUser(manager);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Variant Create Product',
      description: 'Desc',
    });

    const fd = makeFormData({
      productId: product.id,
      name: 'Grande',
      skuSuffix: 'GR',
    });
    const result = await createVariantAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Grande');
      expect(result.data.skuSuffix).toBe('GR');
    }
  });

  it("updateVariantAction : MANAGER update le nom d'une variante avec succès", async () => {
    if (!testDb) return;
    const owner = await makeUser('variant-update@example.com');
    const { organizationId } = await makeOrg(owner, 'Variant Update Org');
    const manager = await makeUser('variant-update-mgr@example.com');
    await addMember(organizationId, manager, 'MANAGER');
    mockClerkUser(manager);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Variant Update Product',
      description: 'Desc',
    });
    // createProduct crée automatiquement une variante "Standard".
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    const fd = makeFormData({
      variantId,
      name: 'Standard Renamed',
    });
    const result = await updateVariantAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Standard Renamed');
    }
  });

  it('createInventoryItemAction : MANAGER crée un exemplaire avec succès', async () => {
    if (!testDb) return;
    const owner = await makeUser('inventory-create@example.com');
    const { organizationId, locationId } = await makeOrg(owner, 'Inventory Create Org');
    const manager = await makeUser('inventory-create-mgr@example.com');
    await addMember(organizationId, manager, 'MANAGER');
    mockClerkUser(manager);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Inventory Create Product',
      description: 'Desc',
    });
    const variants = await listVariants(testDb, organizationId, product.id);
    const variantId = variants[0]!.id;

    const fd = makeFormData({
      productVariantId: variantId,
      internalSku: 'SKU-TEST-001',
      currentLocationId: locationId,
      condition: 'NEW',
      status: 'ACTIVE',
    });
    const result = await createInventoryItemAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.internalSku).toBe('SKU-TEST-001');
    }
  });

  it('restoreArchivedProductAction : MANAGER restaure un produit archivé avec succès', async () => {
    if (!testDb) return;
    const owner = await makeUser('restore@example.com');
    const { organizationId } = await makeOrg(owner, 'Restore Success Org');
    const manager = await makeUser('restore-mgr@example.com');
    await addMember(organizationId, manager, 'MANAGER');
    mockClerkUser(manager);

    const categoryId = await getCategoryId();
    const product = await createProduct(testDb, {
      organizationId,
      categoryId,
      name: 'Restore Product',
      description: 'Desc',
    });
    // Publie le produit puis l'archive pour pouvoir le restaurer.
    await publishProduct(testDb, organizationId, product.id);
    await archiveProduct(testDb, organizationId, product.id);

    const fd = makeFormData({
      productId: product.id,
    });
    const result = await restoreArchivedProductAction(organizationId, EMPTY_PREV, fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.publicationStatus).toBe('PUBLISHED');
    }
  });
});
