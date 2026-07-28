import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';
import { createDatabase } from '@uttily/database';
import {
  createOrganizationForUser,
  createLocation,
  provisionUserFromOidc,
  createProduct,
  listVariants,
  createInventoryItem,
  createInventoryBlock,
  getInventoryBlock,
  listBlocksForItem,
  releaseBlock,
  expireBlock,
  convertBlock,
  findAvailableItems,
  CatalogError,
  type AuthenticatedUser,
} from '../index';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: ReturnType<typeof createDatabase> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('availability');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
  }
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  // Garde de sécurité : ne devrait plus être atteint car describe.skipIf
  // (shouldSkipIntegrationTests) skipe toute la suite quand la base est absente
  // ou SKIP_INTEGRATION_TESTS=1, et setupIntegrationTestDb throw si la base est
  // injoignable. Conservé par défense en profondeur.
  if (!ctx || !db) return;
  // TRUNCATE réinitialise aussi les séquences (RESTART IDENTITY).
  // Les catégories seedées ne sont pas tronquées.
  await db.execute(
    (await import('drizzle-orm'))
      .sql`TRUNCATE TABLE inventory_blocks, inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('db not initialized');
  return provisionUserFromOidc(db, {
    oidcSubject: `clerk-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function setupOrgWithLocation(
  email: string,
  orgName: string,
  locationName = 'Shop Principal',
): Promise<{ user: AuthenticatedUser; organizationId: string; locationId: string }> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: orgName,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, {
    organizationId: organization.id,
    name: locationName,
    timeZone: 'Europe/Paris',
  });
  return { user, organizationId: organization.id, locationId: location.id };
}

async function createProductForOrg(
  organizationId: string,
  name: string,
  categoryIdOrSlug = 'surf',
): Promise<{ productId: string; variantId: string }> {
  if (!db) throw new Error('db not initialized');
  let categoryId = categoryIdOrSlug;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryIdOrSlug)) {
    const { categories } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const [cat] = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, categoryIdOrSlug))
      .limit(1);
    if (!cat) throw new Error(`Catégorie seed "${categoryIdOrSlug}" introuvable.`);
    categoryId = cat.id;
  }
  const product = await createProduct(db, {
    organizationId,
    categoryId,
    name,
    description: 'Description de test',
  });
  const variants = await listVariants(db, organizationId, product.id);
  return { productId: product.id, variantId: variants[0]!.id };
}

async function setupItem(organizationId: string, locationId: string, sku: string) {
  if (!db) throw new Error('db not initialized');
  const { variantId } = await createProductForOrg(organizationId, `Product ${sku}`);
  const item = await createInventoryItem(db, {
    organizationId,
    productVariantId: variantId,
    internalSku: sku,
    currentLocationId: locationId,
  });
  return item;
}

// Périodes de test utilitaires.
const DAY = 24 * 60 * 60 * 1000;
function baseDates() {
  const start = new Date('2025-09-01T10:00:00Z');
  const end = new Date('2025-09-03T10:00:00Z');
  return { start, end };
}

describe.skipIf(shouldSkipIntegrationTests())('Availability integration — InventoryBlock', () => {
  // -------------------------------------------------------------------------
  // 1. CRUD basique
  // -------------------------------------------------------------------------
  it('crée un bloc, le lit, liste les blocs d’un item', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-crud@example.com',
      'Block CRUD Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-CRUD-001');
    const { start, end } = baseDates();

    const block = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(block.id).toBeDefined();
    expect(block.status).toBe('ACTIVE');
    expect(block.type).toBe('HOLD');

    const fetched = await getInventoryBlock(db, organizationId, block.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(block.id);

    const blocks = await listBlocksForItem(db, organizationId, item.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe(block.id);
  });

  // -------------------------------------------------------------------------
  // 2. Contrainte d'exclusion : chevauchement rejeté
  // -------------------------------------------------------------------------
  it('contrainte d’exclusion : deux blocs ACTIVE chevauchants rejetés', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-excl@example.com',
      'Block Excl Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-EXCL-001');
    const { start, end } = baseDates();

    await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });

    // Second bloc chevauchant → CONFLICT_BLOCK.
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'BOOKING',
        customerStartAt: new Date(start.getTime() + DAY),
        customerEndAt: new Date(end.getTime() + DAY),
        blockedStartAt: new Date(start.getTime() + DAY),
        blockedEndAt: new Date(end.getTime() + DAY),
      }),
    ).rejects.toThrow(/blocage actif existe déjà/);
  });

  // -------------------------------------------------------------------------
  // 3. Périodes non chevauchantes : autorisées
  // -------------------------------------------------------------------------
  it('périodes disjointes : deux blocs sur le même item réussissent', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-disjoint@example.com',
      'Block Disjoint Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-DJ-001');

    const s1 = new Date('2025-09-01T10:00:00Z');
    const e1 = new Date('2025-09-03T10:00:00Z');
    const s2 = new Date('2025-09-05T10:00:00Z');
    const e2 = new Date('2025-09-07T10:00:00Z');

    const b1 = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: s1,
      customerEndAt: e1,
      blockedStartAt: s1,
      blockedEndAt: e1,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const b2 = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'BOOKING',
      customerStartAt: s2,
      customerEndAt: e2,
      blockedStartAt: s2,
      blockedEndAt: e2,
    });
    expect(b1.id).not.toBe(b2.id);
    const blocks = await listBlocksForItem(db, organizationId, item.id);
    expect(blocks).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 4. Statut RELEASED ne bloque pas
  // -------------------------------------------------------------------------
  it('statut RELEASED : un bloc libéré ne bloque plus un nouveau bloc', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-release@example.com',
      'Block Release Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-REL-001');
    const { start, end } = baseDates();

    const block = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const released = await releaseBlock(db, organizationId, block.id);
    expect(released.status).toBe('RELEASED');

    // Nouveau bloc chevauchant → doit réussir (RELEASED ne bloque plus).
    const newBlock = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'BOOKING',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
    });
    expect(newBlock.status).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------
  // 5. Statut EXPIRED ne bloque pas
  // -------------------------------------------------------------------------
  it('statut EXPIRED : un bloc expiré ne bloque plus un nouveau bloc', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-expire@example.com',
      'Block Expire Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-EXP-001');
    const { start, end } = baseDates();

    // Crée un hold avec expiresAt dans le passé.
    const pastExpiry = new Date(Date.now() - 60 * 1000);
    const block = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: pastExpiry,
    });
    const expired = await expireBlock(db, organizationId, block.id);
    expect(expired.status).toBe('EXPIRED');

    // Nouveau bloc chevauchant → doit réussir (EXPIRED ne bloque plus).
    const newBlock = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'BOOKING',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
    });
    expect(newBlock.status).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------
  // 6. Statut CONVERTED ne bloque pas
  // -------------------------------------------------------------------------
  it('statut CONVERTED : un hold converti ne bloque plus, le BOOKING prend le relais', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-convert@example.com',
      'Block Convert Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-CNV-001');
    const { start, end } = baseDates();

    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const booking = await convertBlock(db, organizationId, hold.id, 'BOOKING');
    expect(booking.type).toBe('BOOKING');
    expect(booking.status).toBe('ACTIVE');

    // Le hold original est maintenant CONVERTED.
    const sourceBlock = await getInventoryBlock(db, organizationId, hold.id);
    expect(sourceBlock!.status).toBe('CONVERTED');

    // Un nouveau bloc chevauchant doit échouer : le BOOKING (ACTIVE) bloque.
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: start,
        blockedEndAt: end,
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ).rejects.toThrow(/blocage actif existe déjà/);
  });

  // -------------------------------------------------------------------------
  // 7. findAvailableItems
  // -------------------------------------------------------------------------
  it('findAvailableItems : seuls les items sans blocs chevauchants sont retournés', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-find@example.com',
      'Block Find Org',
    );
    const item1 = await setupItem(organizationId, locationId, 'AVAIL-001');
    const item2 = await setupItem(organizationId, locationId, 'AVAIL-002');
    const item3 = await setupItem(organizationId, locationId, 'AVAIL-003');
    const { start, end } = baseDates();

    // item1 : bloc chevauchant la période de recherche.
    await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item1.id,
      type: 'BOOKING',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
    });
    // item2 : bloc sur une période disjointe (ne chevauche pas la recherche).
    await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item2.id,
      type: 'BOOKING',
      customerStartAt: new Date('2025-10-01T10:00:00Z'),
      customerEndAt: new Date('2025-10-03T10:00:00Z'),
      blockedStartAt: new Date('2025-10-01T10:00:00Z'),
      blockedEndAt: new Date('2025-10-03T10:00:00Z'),
    });
    // item3 : aucun bloc.

    const available = await findAvailableItems(db, organizationId, locationId, start, end);
    const availableIds = available.map((a) => a.id);
    expect(availableIds).not.toContain(item1.id);
    expect(availableIds).toContain(item2.id);
    expect(availableIds).toContain(item3.id);
  });

  // -------------------------------------------------------------------------
  // 8. Multi-tenant
  // -------------------------------------------------------------------------
  it('multi-tenant : un bloc de l’org A ne bloque pas l’org B', async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('mt-a@example.com', 'MT Org A');
    const setupB = await setupOrgWithLocation('mt-b@example.com', 'MT Org B');
    const itemA = await setupItem(setupA.organizationId, setupA.locationId, 'MT-A-001');
    const itemB = await setupItem(setupB.organizationId, setupB.locationId, 'MT-B-001');
    const { start, end } = baseDates();

    // Bloc sur l'item de l'org A.
    await createInventoryBlock(db, {
      organizationId: setupA.organizationId,
      inventoryItemId: itemA.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });

    // Bloc sur l'item de l'org B pour la même période → doit réussir.
    const blockB = await createInventoryBlock(db, {
      organizationId: setupB.organizationId,
      inventoryItemId: itemB.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(blockB.status).toBe('ACTIVE');

    // getInventoryBlock d'une autre org retourne null.
    const crossRead = await getInventoryBlock(db, setupA.organizationId, blockB.id);
    expect(crossRead).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. Test de concurrence critique
  // -------------------------------------------------------------------------
  it('concurrence : deux blocs simultanés sur le même item → un seul réussit', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-conc@example.com',
      'Block Conc Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-CONC-001');
    const { start, end } = baseDates();

    const results = await Promise.allSettled([
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: start,
        blockedEndAt: end,
        expiresAt: new Date(Date.now() + 600_000),
      }),
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: start,
        blockedEndAt: end,
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Le rejet doit être un CONFLICT_BLOCK.
    const rej = rejected[0] as PromiseRejectedResult;
    expect(rej.reason.message).toMatch(/blocage actif existe déjà/);

    // Un seul bloc en base.
    const blocks = await listBlocksForItem(db, organizationId, item.id);
    expect(blocks).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 10. Validation des périodes
  // -------------------------------------------------------------------------
  it('validation : blockedStartAt > customerStartAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-val1@example.com',
      'Block Val1 Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-VAL-001');
    const { start, end } = baseDates();

    // blockedStartAt après customerStartAt → invalide.
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: new Date(start.getTime() + DAY),
        blockedEndAt: end,
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ).rejects.toThrow(/date de début de blocage/);
  });

  it('validation : blockedEndAt < customerEndAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-val2@example.com',
      'Block Val2 Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-VAL-002');
    const { start, end } = baseDates();

    // blockedEndAt avant customerEndAt → invalide.
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: start,
        blockedEndAt: new Date(end.getTime() - DAY),
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ).rejects.toThrow(/date de fin de blocage/);
  });

  // -------------------------------------------------------------------------
  // 11. Transitions de statut invalides
  // -------------------------------------------------------------------------
  it('transition invalide : libérer un bloc CONVERTED rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-trans@example.com',
      'Block Trans Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-TRANS-001');
    const { start, end } = baseDates();

    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: new Date(Date.now() + 600_000),
    });
    await convertBlock(db, organizationId, hold.id, 'BOOKING');

    // Le hold est maintenant CONVERTED → releaseBlock doit échouer.
    await expect(releaseBlock(db, organizationId, hold.id)).rejects.toThrow(/Transition invalide/);
  });

  it('transition invalide : convertir un bloc non-HOLD rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-trans2@example.com',
      'Block Trans2 Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-TRANS-002');
    const { start, end } = baseDates();

    // Crée un bloc BOOKING directement.
    const booking = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'BOOKING',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
    });

    // Tenter de convertir un BOOKING → doit échouer.
    await expect(convertBlock(db, organizationId, booking.id, 'BOOKING')).rejects.toThrow(
      /Transition invalide/,
    );
  });

  it('BLOCK_NOT_FOUND : getInventoryBlock d’un bloc inexistant retourne null', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('block-nf@example.com', 'Block NF Org');
    const result = await getInventoryBlock(
      db,
      organizationId,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(result).toBeNull();
  });

  it('expireBlock : expiresAt dans le futur rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'block-exp-fut@example.com',
      'Block Exp Fut Org',
    );
    const item = await setupItem(organizationId, locationId, 'BLK-EXP-FUT-001');
    const { start, end } = baseDates();
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000);

    const block = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: start,
      customerEndAt: end,
      blockedStartAt: start,
      blockedEndAt: end,
      expiresAt: futureExpiry,
    });

    await expect(expireBlock(db, organizationId, block.id)).rejects.toThrow(
      /pas encore expiré|Transition invalide/,
    );
  });

  // -------------------------------------------------------------------------
  // Tests de validation des dates inversées
  // -------------------------------------------------------------------------
  it('validation : blockedEndAt <= blockedStartAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-inv1@example.com',
      'Blk Inv1 Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk Inv1 Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'INV-BLK-1',
      currentLocationId: locationId,
    });
    const start = new Date('2026-08-01T10:00:00Z');
    const end = new Date('2026-08-01T08:00:00Z'); // avant le début
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'MANUAL_BLOCK',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: start,
        blockedEndAt: end,
      }),
    ).rejects.toThrow(/fin de blocage/);
  });

  it('validation : customerEndAt <= customerStartAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-inv2@example.com',
      'Blk Inv2 Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk Inv2 Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'INV-BLK-2',
      currentLocationId: locationId,
    });
    const start = new Date('2026-08-01T10:00:00Z');
    const end = new Date('2026-08-01T08:00:00Z');
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'MANUAL_BLOCK',
        customerStartAt: start,
        customerEndAt: end,
        blockedStartAt: new Date('2026-08-01T06:00:00Z'),
        blockedEndAt: new Date('2026-08-01T12:00:00Z'),
      }),
    ).rejects.toThrow(/fin client/);
  });

  // -------------------------------------------------------------------------
  // Test : cross-org block creation rejeté
  // -------------------------------------------------------------------------
  it("multi-tenant : créer un bloc sur un item d'une autre org échoue", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('blk-xorg-a@example.com', 'Blk XOrg A');
    const setupB = await setupOrgWithLocation('blk-xorg-b@example.com', 'Blk XOrg B');
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Blk XOrg Product A');
    const item = await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantId,
      internalSku: 'XORG-BLK-1',
      currentLocationId: setupA.locationId,
    });
    // Org B tente de créer un bloc sur l'item de l'Org A.
    await expect(
      createInventoryBlock(db, {
        organizationId: setupB.organizationId,
        inventoryItemId: item.id,
        type: 'MANUAL_BLOCK',
        customerStartAt: new Date('2026-08-01T10:00:00Z'),
        customerEndAt: new Date('2026-08-01T12:00:00Z'),
        blockedStartAt: new Date('2026-08-01T09:00:00Z'),
        blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Test : convertBlock avec type non-BOOKING rejeté
  // -------------------------------------------------------------------------
  it('convertBlock vers un type non-BOOKING rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-conv-type@example.com',
      'Blk Conv Type Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk Conv Type Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'CONV-TYPE-1',
      currentLocationId: locationId,
    });
    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      expiresAt: new Date(Date.now() + 600_000),
    });
    await expect(convertBlock(db, organizationId, hold.id, 'MAINTENANCE')).rejects.toThrow(
      /BOOKING/,
    );
  });

  // -------------------------------------------------------------------------
  // Test : concurrence sur convertBlock
  // -------------------------------------------------------------------------
  it('concurrence : deux conversions du même hold, une seule réussit', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-conv-conc@example.com',
      'Blk Conv Conc Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk Conv Conc Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'CONV-CONC-1',
      currentLocationId: locationId,
    });
    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const results = await Promise.allSettled([
      convertBlock(db, organizationId, hold.id, 'BOOKING'),
      convertBlock(db, organizationId, hold.id, 'BOOKING'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Concurrence : release vs convert
  // -------------------------------------------------------------------------
  it('concurrence : release vs convert, une seule transition gagne', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-rc@example.com',
      'Blk RC Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk RC Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RC-1',
      currentLocationId: locationId,
    });
    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const results = await Promise.allSettled([
      releaseBlock(db, organizationId, hold.id),
      convertBlock(db, organizationId, hold.id, 'BOOKING'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Le rejet doit être une CatalogError avec code BLOCK_INVALID_TRANSITION.
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(CatalogError);
    expect((rejectedReason as CatalogError).code).toBe('BLOCK_INVALID_TRANSITION');
    // L'état final du bloc doit être cohérent : soit RELEASED/EXPIRED, soit CONVERTED.
    const finalBlock = await getInventoryBlock(db, organizationId, hold.id);
    expect(finalBlock).not.toBeNull();
    expect(['RELEASED', 'EXPIRED', 'CONVERTED']).toContain(finalBlock!.status);
    // Si le bloc est CONVERTED, il doit y avoir exactement un bloc BOOKING.
    if (finalBlock!.status === 'CONVERTED') {
      const blocks = await listBlocksForItem(db, organizationId, hold.inventoryItemId);
      const bookingBlocks = blocks.filter((b) => b.type === 'BOOKING');
      expect(bookingBlocks.length).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // Concurrence : expire vs convert
  // -------------------------------------------------------------------------
  it('concurrence : expire vs convert, une seule transition gagne', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-ec@example.com',
      'Blk EC Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk EC Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'EC-1',
      currentLocationId: locationId,
    });
    // Crée un hold déjà expiré (expiresAt dans le passé).
    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      expiresAt: new Date(Date.now() - 1000),
    });
    const results = await Promise.allSettled([
      expireBlock(db, organizationId, hold.id),
      convertBlock(db, organizationId, hold.id, 'BOOKING'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Le rejet doit être une CatalogError avec code BLOCK_INVALID_TRANSITION.
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(CatalogError);
    expect((rejectedReason as CatalogError).code).toBe('BLOCK_INVALID_TRANSITION');
    // L'état final du bloc doit être cohérent : soit RELEASED/EXPIRED, soit CONVERTED.
    const finalBlock = await getInventoryBlock(db, organizationId, hold.id);
    expect(finalBlock).not.toBeNull();
    expect(['RELEASED', 'EXPIRED', 'CONVERTED']).toContain(finalBlock!.status);
  });

  // -------------------------------------------------------------------------
  // Invariant HOLD/expiresAt
  // -------------------------------------------------------------------------
  it('validation : HOLD sans expiresAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-hold-noexp@example.com',
      'Blk HoldNoExp',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk HoldNoExp Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'HOLD-NOEXP-1',
      currentLocationId: locationId,
    });
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'HOLD',
        customerStartAt: new Date('2026-08-01T10:00:00Z'),
        customerEndAt: new Date('2026-08-01T12:00:00Z'),
        blockedStartAt: new Date('2026-08-01T09:00:00Z'),
        blockedEndAt: new Date('2026-08-01T13:00:00Z'),
        // pas d'expiresAt
      }),
    ).rejects.toThrow(/expiration/);
  });

  it('validation : BOOKING avec expiresAt rejeté', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-booking-exp@example.com',
      'Blk BookingExp',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk BookingExp Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'BOOKING-EXP-1',
      currentLocationId: locationId,
    });
    await expect(
      createInventoryBlock(db, {
        organizationId,
        inventoryItemId: item.id,
        type: 'BOOKING',
        customerStartAt: new Date('2026-08-01T10:00:00Z'),
        customerEndAt: new Date('2026-08-01T12:00:00Z'),
        blockedStartAt: new Date('2026-08-01T09:00:00Z'),
        blockedEndAt: new Date('2026-08-01T13:00:00Z'),
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ).rejects.toThrow(/expiration/);
  });

  // -------------------------------------------------------------------------
  // findAvailableItems : période invalide
  // -------------------------------------------------------------------------
  it('findAvailableItems : période inversée rejetée', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-fai@example.com',
      'Blk FAI Org',
    );
    await expect(
      findAvailableItems(
        db,
        organizationId,
        locationId,
        new Date('2026-08-01T12:00:00Z'),
        new Date('2026-08-01T10:00:00Z'),
      ),
    ).rejects.toThrow(/invalide/);
  });

  // -------------------------------------------------------------------------
  // expireBlock refuse PAYMENT_PROCESSING
  // -------------------------------------------------------------------------
  it('expireBlock refuse un hold PAYMENT_PROCESSING', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-pp@example.com',
      'Blk PP Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk PP Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'PP-1',
      currentLocationId: locationId,
    });
    const hold = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'HOLD',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
      expiresAt: new Date(Date.now() - 1000),
    });
    // Passe manuellement le statut à PAYMENT_PROCESSING via SQL.
    const { sql } = await import('drizzle-orm');
    await db.execute(
      sql`UPDATE inventory_blocks SET status = 'PAYMENT_PROCESSING' WHERE id = ${hold.id}`,
    );
    await expect(expireBlock(db, organizationId, hold.id)).rejects.toThrow(/Transition invalide/);
  });

  // -------------------------------------------------------------------------
  // Soft-delete : un bloc supprimé ne bloque plus
  // -------------------------------------------------------------------------
  it('soft-delete : un bloc supprimé ne bloque plus la création ni la disponibilité', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'blk-softdel@example.com',
      'Blk SoftDel Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Blk SoftDel Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'SOFTDEL-1',
      currentLocationId: locationId,
    });
    // Crée un bloc MANUAL_BLOCK.
    const block = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'MANUAL_BLOCK',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
    });
    // Vérifie que l'item n'est PAS disponible sur cette période.
    const availBefore = await findAvailableItems(
      db,
      organizationId,
      locationId,
      new Date('2026-08-01T10:00:00Z'),
      new Date('2026-08-01T12:00:00Z'),
    );
    expect(availBefore.find((i) => i.id === item.id)).toBeUndefined();
    // Soft-delete le bloc via SQL direct.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE inventory_blocks SET deleted_at = NOW() WHERE id = ${block.id}`);
    // Vérifie que l'item EST MAINTENANT disponible.
    const availAfter = await findAvailableItems(
      db,
      organizationId,
      locationId,
      new Date('2026-08-01T10:00:00Z'),
      new Date('2026-08-01T12:00:00Z'),
    );
    expect(availAfter.find((i) => i.id === item.id)).toBeDefined();
    // Vérifie qu'un nouveau bloc peut être créé sur la même période.
    const newBlock = await createInventoryBlock(db, {
      organizationId,
      inventoryItemId: item.id,
      type: 'MANUAL_BLOCK',
      customerStartAt: new Date('2026-08-01T10:00:00Z'),
      customerEndAt: new Date('2026-08-01T12:00:00Z'),
      blockedStartAt: new Date('2026-08-01T09:00:00Z'),
      blockedEndAt: new Date('2026-08-01T13:00:00Z'),
    });
    expect(newBlock.id).not.toBe(block.id);
  });
});
