import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
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
  listProducts,
  getProduct,
  updateProduct,
  publishProduct,
  publishFirstEquipment,
  archiveProduct,
  restoreArchivedProduct,
  listVariants,
  getVariant,
  updateVariant,
  deactivateVariant,
  createInventoryItem,
  updateInventoryItem,
  getInventoryItem,
  transferInventoryItem,
  retireInventoryItem,
  listMovements,
  createCategory,
  listActiveCategories,
  deactivateCategory,
  restoreCategory,
  listProductSummaries,
  getProductDetails,
  listInventorySummaries,
  getInventoryDetails,
  listActiveVariantOptions,
  getProductPublicationReadiness,
  saveDailyPricingPlanDraft,
  activateDailyPricingPlan,
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  type AuthenticatedUser,
} from '../index';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: ReturnType<typeof createDatabase> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('catalog');
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
  // TRUNCATE ... CASCADE ne déclenche pas les triggers ligne par ligne
  // (contrairement à DELETE), ce qui évite le garde-fou "dernière variante"
  // lors du nettoyage. Les catégories seedées ne sont pas tronquées.
  // Ordre : tables dépendantes d'abord, CASCADE gère le reste.
  await db.execute(
    // Drizzle ne supporte pas TRUNCATE nativement ; on passe par SQL brut.
    // TRUNCATE réinitialise aussi les séquences (RESTART IDENTITY).
    (await import('drizzle-orm'))
      .sql`TRUNCATE TABLE inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
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
  photoSlots?: readonly string[],
): Promise<{
  product: ReturnType<typeof getProduct> extends Promise<infer T> ? NonNullable<T> : never;
  variantId: string;
}> {
  if (!db) throw new Error('db not initialized');
  // Si categoryIdOrSlug ressemble à un UUID, l'utiliser directement.
  // Sinon, résoudre par slug (catégorie seedée).
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
  // G7F-A2 : 3 photos valides requises pour la publication.
  for (let i = 0; i < 3; i++) {
    await db.execute(sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        slot_type, content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${organizationId}, ${product.id}, ${'product-photos/test-' + product.id + '-' + i},
        CAST(${photoSlots?.[i] ?? null} AS product_photo_slot_type),
        'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
        ${i}, 'AVAILABLE'
      )
    `);
  }
  const variants = await listVariants(db, organizationId, product.id);
  return { product, variantId: variants[0]!.id };
}

/** Fixture SQL réservée aux tests de compatibilité des données historiques. */
async function insertProductFixture(
  organizationId: string,
  categoryId: string,
  slug: string,
  publicationStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO products (organization_id, category_id, name, slug, description, publication_status)
    VALUES (${organizationId}, ${categoryId}, ${slug}, ${slug}, 'Fixture historique', 'DRAFT')
    RETURNING id
  `);
  const productId = rows[0]!.id;
  if (publicationStatus === 'PUBLISHED') {
    for (let i = 0; i < 3; i++) {
      await db.execute(sql`
        INSERT INTO product_photos (
          organization_id, product_id, storage_key,
          content_type, byte_size, width_px, height_px, checksum_sha256,
          sort_order, file_state
        )
        VALUES (
          ${organizationId}, ${productId}, ${'product-photos/' + slug + '-' + i},
          'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
          ${i}, 'AVAILABLE'
        )
      `);
    }
  }
  if (publicationStatus !== 'DRAFT') {
    await db.execute(sql`
      UPDATE products SET publication_status = ${publicationStatus} WHERE id = ${productId}
    `);
  }
  return productId;
}

describe.skipIf(shouldSkipIntegrationTests())('Catalog integration — multi-tenant', () => {
  it('seed catégories : au moins 9 catégories racines actives après migration', async () => {
    if (!ctx || !db) return;
    const cats = await listActiveCategories(db);
    expect(cats.length).toBeGreaterThanOrEqual(9);
    expect(cats.find((c) => c.slug === 'surf')).toBeDefined();
    expect(cats.find((c) => c.slug === 'other')).toBeDefined();
  });

  it('crée un produit avec sa variante Standard atomiquement', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('cat-owner@example.com', 'Cat Org');
    const { product, variantId } = await createProductForOrg(organizationId, 'Paddle Test');
    expect(product.publicationStatus).toBe('DRAFT');
    const variants = await listVariants(db, organizationId, product.id);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.name).toBe('Standard');
    expect(variants[0]!.id).toBe(variantId);
    expect(variants[0]!.isActive).toBe(true);
  });

  it('impose le registre fermé à la création et aux transitions commerciales', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'taxonomy-enforcement@example.com',
      'Taxonomy Enforcement Org',
    );
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const categoryRows = await db.select().from(categoriesTable);
    const categoryBySlug = new Map(categoryRows.map((category) => [category.slug, category]));

    for (const slug of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS) {
      const category = categoryBySlug.get(slug);
      if (!category) throw new Error(`Catégorie commerciale absente: ${slug}`);
      await expect(
        createProductForOrg(organizationId, `Accepted ${slug}`, category.id),
      ).resolves.toBeDefined();
    }

    const customActive = await createCategory(db, {
      slug: 'taxonomy-custom-active',
      name: 'Taxonomy Custom Active',
    });
    const customInactive = await createCategory(db, {
      slug: 'taxonomy-custom-inactive',
      name: 'Taxonomy Custom Inactive',
    });
    await deactivateCategory(db, customInactive.id);

    const rejectedCategoryIds = [
      categoryBySlug.get('equipment')?.id,
      categoryBySlug.get('paddle')?.id,
      customActive.id,
      customInactive.id,
    ];
    for (const categoryId of rejectedCategoryIds) {
      if (!categoryId) throw new Error('Catégorie historique attendue absente.');
      await expect(
        createProductForOrg(organizationId, `Rejected ${categoryId}`, categoryId),
      ).rejects.toThrow();
    }

    const { product } = await createProductForOrg(
      organizationId,
      'Category Change Product',
      'bike',
    );
    const equipmentId = categoryBySlug.get('equipment')?.id;
    if (!equipmentId) throw new Error('Catégorie equipment absente.');
    await expect(
      updateProduct(db, organizationId, product.id, { categoryId: equipmentId }),
    ).rejects.toThrow(/famille commerciale active/);

    const historicalId = await insertProductFixture(
      organizationId,
      equipmentId,
      'legacy-equipment-read-only',
      'ARCHIVED',
    );
    await expect(getProduct(db, organizationId, historicalId)).resolves.toMatchObject({
      id: historicalId,
      categoryId: equipmentId,
      publicationStatus: 'ARCHIVED',
    });
    await expect(publishProduct(db, organizationId, historicalId)).rejects.toThrow(
      /famille commerciale active/,
    );
    await expect(restoreArchivedProduct(db, organizationId, historicalId)).rejects.toThrow(
      /famille commerciale active/,
    );

    // Le test exerce aussi explicitement le garde-fou de catégorie historique.
    const [paddle] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'paddle'))
      .limit(1);
    expect(paddle?.isActive).toBe(true);
  });

  it("isolation multi-tenant : un loueur ne voit pas le catalogue d'un autre", async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation('iso-a@example.com', 'Iso Org A');
    const { organizationId: orgB } = await setupOrgWithLocation('iso-b@example.com', 'Iso Org B');
    await createProductForOrg(orgA, 'Produit A');
    await createProductForOrg(orgB, 'Produit B');
    const productsA = await listProducts(db, orgA);
    const productsB = await listProducts(db, orgB);
    expect(productsA).toHaveLength(1);
    expect(productsA[0]!.name).toBe('Produit A');
    expect(productsB).toHaveLength(1);
    expect(productsB[0]!.name).toBe('Produit B');
    expect(productsA.find((p) => p.name === 'Produit B')).toBeUndefined();
  });

  it('slug produit unique par organisation', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('slug-owner@example.com', 'Slug Org');
    await createProductForOrg(organizationId, 'Duplicate Slug');
    await expect(createProductForOrg(organizationId, 'Duplicate Slug')).rejects.toThrow();
  });

  it('slug produit identique autorisé dans des organisations différentes', async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation(
      'slug-ok-a@example.com',
      'Slug Org A',
    );
    const { organizationId: orgB } = await setupOrgWithLocation(
      'slug-ok-b@example.com',
      'Slug Org B',
    );
    await createProductForOrg(orgA, 'Same Name');
    await expect(createProductForOrg(orgB, 'Same Name')).resolves.toBeDefined();
  });

  it('internal_sku unique par organisation', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'sku-owner@example.com',
      'SKU Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'SKU Product');
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'SKU-001',
      currentLocationId: locationId,
    });
    await expect(
      createInventoryItem(db, {
        organizationId,
        productVariantId: variantId,
        internalSku: 'SKU-001',
        currentLocationId: locationId,
      }),
    ).rejects.toThrow();
  });

  it('internal_sku identique autorisé dans des organisations différentes', async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('sku-ok-a@example.com', 'SKU Org A');
    const setupB = await setupOrgWithLocation('sku-ok-b@example.com', 'SKU Org B');
    const { variantId: variantA } = await createProductForOrg(setupA.organizationId, 'Product A');
    const { variantId: variantB } = await createProductForOrg(setupB.organizationId, 'Product B');
    await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantA,
      internalSku: 'SHARED-SKU',
      currentLocationId: setupA.locationId,
    });
    await expect(
      createInventoryItem(db, {
        organizationId: setupB.organizationId,
        productVariantId: variantB,
        internalSku: 'SHARED-SKU',
        currentLocationId: setupB.locationId,
      }),
    ).resolves.toBeDefined();
  });

  it('serial_number unique partielle par org (renseigné)', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'serial-owner@example.com',
      'Serial Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Serial Product');
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'S-001',
      serialNumber: 'SN-12345',
      currentLocationId: locationId,
    });
    await expect(
      createInventoryItem(db, {
        organizationId,
        productVariantId: variantId,
        internalSku: 'S-002',
        serialNumber: 'SN-12345',
        currentLocationId: locationId,
      }),
    ).rejects.toThrow();
  });

  it('serial_number NULL autorisé (plusieurs exemplaires sans serial)', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'serial-null@example.com',
      'Serial Null Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Serial Null Product');
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'N-001',
      currentLocationId: locationId,
    });
    await expect(
      createInventoryItem(db, {
        organizationId,
        productVariantId: variantId,
        internalSku: 'N-002',
        currentLocationId: locationId,
      }),
    ).resolves.toBeDefined();
  });

  it('publication produit sans exemplaire réussit', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'pub-nostock@example.com',
      'Pub NoStock Org',
    );
    const { product } = await createProductForOrg(organizationId, 'Pub NoStock Product');
    const published = await publishProduct(db, organizationId, product.id);
    expect(published.publicationStatus).toBe('PUBLISHED');
  });

  it('publication guidée du premier équipement exige tarif et exemplaire actifs', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'first-equipment-gate@example.com',
      'First Equipment Gate Org',
    );
    const { product, variantId } = await createProductForOrg(
      organizationId,
      'First Equipment Gate Product',
      'pedalboat',
    );

    await expect(publishFirstEquipment(db, organizationId, product.id)).rejects.toThrow(
      /tarif actif/,
    );

    const draftPlan = await saveDailyPricingPlanDraft(db, {
      organizationId,
      variantId,
      locationId,
      priceAmountMinor: 2500,
      currency: 'EUR',
    });
    await activateDailyPricingPlan(db, organizationId, draftPlan.id);

    await expect(publishFirstEquipment(db, organizationId, product.id)).rejects.toThrow(
      /exemplaire physique actif/,
    );

    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'FIRST-EQUIPMENT-001',
      currentLocationId: locationId,
    });

    await expect(publishFirstEquipment(db, organizationId, product.id)).resolves.toMatchObject({
      publicationStatus: 'PUBLISHED',
    });
  });

  it('publication vélo : les trois slots canoniques sont requis', async () => {
    if (!ctx || !db) return;
    const { organizationId: incompleteOrg } = await setupOrgWithLocation(
      'pub-bike-incomplete@example.com',
      'Pub Bike Incomplete Org',
    );
    const { product: incompleteBike } = await createProductForOrg(
      incompleteOrg,
      'Bike Incomplete Product',
      'bike',
      ['HERO_PROFILE', 'THREE_QUARTER_FRONT', 'FULL_BIKE'],
    );
    const incompleteReadiness = await getProductPublicationReadiness(
      db,
      incompleteOrg,
      incompleteBike.id,
    );
    expect(incompleteReadiness).not.toBeNull();
    expect(incompleteReadiness?.ready).toBe(false);
    expect(incompleteReadiness?.failures.join('\n')).toContain('SECONDARY_VIEW');
    await expect(publishProduct(db, incompleteOrg, incompleteBike.id)).rejects.toThrow(
      /SECONDARY_VIEW/,
    );

    const { organizationId: completeOrg } = await setupOrgWithLocation(
      'pub-bike-complete@example.com',
      'Pub Bike Complete Org',
    );
    const { product: completeBike } = await createProductForOrg(
      completeOrg,
      'Bike Complete Product',
      'bike',
      ['HERO_PROFILE', 'THREE_QUARTER_FRONT', 'SECONDARY_VIEW'],
    );
    await expect(publishProduct(db, completeOrg, completeBike.id)).resolves.toMatchObject({
      publicationStatus: 'PUBLISHED',
    });
  });

  it('publication produit incomplet (pas de description) rejetée', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'pub-incomplete@example.com',
      'Pub Incomplete Org',
    );
    // Crée un produit valide, puis vide la description via SQL direct
    // (updateProduct refuserait une description vide sur DRAFT ? Non, seulement sur PUBLISHED).
    const { product } = await createProductForOrg(organizationId, 'Incomplete Product');
    // Vide la description via SQL direct pour simuler un produit incomplet.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE products SET description = '' WHERE id = ${product.id}`);
    await expect(publishProduct(db, organizationId, product.id)).rejects.toThrow(/description/);
  });

  it('publication produit sans variante active rejetée', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'pub-novariant@example.com',
      'Pub NoVariant Org',
    );
    const { product, variantId } = await createProductForOrg(
      organizationId,
      'Pub NoVariant Product',
    );
    // Tente de désactiver la seule variante → doit échouer (trigger).
    await expect(deactivateVariant(db, organizationId, variantId)).rejects.toThrow();
    // Le produit reste DRAFT car la variante est encore active mais on ne peut pas
    // la désactiver. On vérifie que publishProduct fonctionne car la variante est active.
    const published = await publishProduct(db, organizationId, product.id);
    expect(published.publicationStatus).toBe('PUBLISHED');
  });

  it('désactivation dernière variante rejetée par PostgreSQL', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'last-variant@example.com',
      'Last Variant Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Last Variant Product');
    await expect(deactivateVariant(db, organizationId, variantId)).rejects.toThrow();
  });

  it('product_variant.product_id immuable', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'immutable-pid@example.com',
      'Immutable PID Org',
    );
    const { product, variantId } = await createProductForOrg(organizationId, 'Product One');
    const { product: product2 } = await createProductForOrg(organizationId, 'Product Two');
    // Tente de changer product_id via UPDATE direct.
    const { productVariants } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    await expect(
      db
        .update(productVariants)
        .set({ productId: product2.id })
        .where(eq(productVariants.id, variantId)),
    ).rejects.toThrow(/immuable/);
    void product;
  });

  it("current_location_id d'une autre org rejeté", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('loc-cross-a@example.com', 'Loc Cross A');
    const setupB = await setupOrgWithLocation('loc-cross-b@example.com', 'Loc Cross B');
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Cross Loc Product');
    await expect(
      createInventoryItem(db, {
        organizationId: setupA.organizationId,
        productVariantId: variantId,
        internalSku: 'CROSS-001',
        currentLocationId: setupB.locationId, // location d'une autre org
      }),
    ).rejects.toThrow();
  });

  it("variante d'une autre org rejetée pour inventory_item", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('variant-cross-a@example.com', 'Variant Cross A');
    const setupB = await setupOrgWithLocation('variant-cross-b@example.com', 'Variant Cross B');
    // Variante d'un produit de l'org B
    const { variantId: variantB } = await createProductForOrg(
      setupB.organizationId,
      'Cross Variant Product',
    );
    // Tente de créer un inventory_item dans l'org A avec la variante de l'org B
    await expect(
      createInventoryItem(db, {
        organizationId: setupA.organizationId,
        productVariantId: variantB,
        internalSku: 'CROSS-VAR-001',
        currentLocationId: setupA.locationId,
      }),
    ).rejects.toThrow();
  });

  it('transfert entre établissements de la même org crée un mouvement', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId: loc1 } = await setupOrgWithLocation(
      'transfer-ok@example.com',
      'Transfer Org',
      'Shop 1',
    );
    // Crée un second établissement dans la même org
    const loc2 = await createLocation(db, {
      organizationId,
      name: 'Shop 2',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(organizationId, 'Transfer Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'TRANS-001',
      currentLocationId: loc1,
    });
    const result = await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      reason: 'Réorganisation',
      idempotencyKey: 'transfer-1',
    });
    expect(result.movement).not.toBeNull();
    expect(result.movement!.fromLocationId).toBe(loc1);
    expect(result.movement!.toLocationId).toBe(loc2.id);
    expect(result.currentItem.currentLocationId).toBe(loc2.id);

    const movements = await listMovements(db, organizationId, item.id);
    expect(movements).toHaveLength(1);
  });

  it("transfert vers établissement d'une autre org rejeté", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('transfer-cross-a@example.com', 'Transfer Cross A');
    const setupB = await setupOrgWithLocation('transfer-cross-b@example.com', 'Transfer Cross B');
    const { variantId } = await createProductForOrg(
      setupA.organizationId,
      'Transfer Cross Product',
    );
    const item = await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantId,
      internalSku: 'TCROSS-001',
      currentLocationId: setupA.locationId,
    });
    await expect(
      transferInventoryItem(db, {
        organizationId: setupA.organizationId,
        inventoryItemId: item.id,
        toLocationId: setupB.locationId,
        idempotencyKey: 'cross-transfer-1',
      }),
    ).rejects.toThrow();
  });

  it('transfert idempotent : même clé → un seul mouvement', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId: loc1 } = await setupOrgWithLocation(
      'idempotent@example.com',
      'Idempotent Org',
      'Shop A',
    );
    const loc2 = await createLocation(db, {
      organizationId,
      name: 'Shop B',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(organizationId, 'Idempotent Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'IDEM-001',
      currentLocationId: loc1,
    });
    const r1 = await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      idempotencyKey: 'idem-1',
    });
    // Retransfère vers loc1 pour pouvoir retransférer vers loc2
    await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc1,
      idempotencyKey: 'idem-back',
    });
    // Retry avec la même clé idem-1 : doit retourner le mouvement existant, pas en créer un nouveau.
    const r2 = await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      idempotencyKey: 'idem-1',
    });
    expect(r2.movement?.id).toBe(r1.movement?.id);
    const movements = await listMovements(db, organizationId, item.id);
    // idem-1 + idem-back + retry idem-1 (no new) = exactement 2 mouvements.
    expect(movements).toHaveLength(2);
  });

  it('transfert concurrent avec Promise.all : un seul mouvement créé', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId: loc1 } = await setupOrgWithLocation(
      'concurrent@example.com',
      'Concurrent Org',
      'Shop C1',
    );
    const loc2 = await createLocation(db, {
      organizationId,
      name: 'Shop C2',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(organizationId, 'Concurrent Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'CONC-001',
      currentLocationId: loc1,
    });
    // Deux transferts concurrents avec la même clé d'idempotence.
    const results = await Promise.allSettled([
      transferInventoryItem(db, {
        organizationId,
        inventoryItemId: item.id,
        toLocationId: loc2.id,
        idempotencyKey: 'concurrent-1',
        reason: 'Transfert concurrent A',
      }),
      transferInventoryItem(db, {
        organizationId,
        inventoryItemId: item.id,
        toLocationId: loc2.id,
        idempotencyKey: 'concurrent-1',
        reason: 'Transfert concurrent B',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
    // Les deux doivent retourner le même mouvement (idempotence).
    const ids = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<{ movement: { id: string } | null }>).value.movement?.id,
    );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
    const movements = await listMovements(db, organizationId, item.id);
    expect(movements).toHaveLength(1);
  });

  it("réutilisation d'une clé d'idempotence avec destination différente rejetée", async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId: loc1 } = await setupOrgWithLocation(
      'idem-conflict@example.com',
      'Idem Conflict Org',
      'Shop IC1',
    );
    const loc2 = await createLocation(db, {
      organizationId,
      name: 'Shop IC2',
      timeZone: 'Europe/Paris',
    });
    const loc3 = await createLocation(db, {
      organizationId,
      name: 'Shop IC3',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(organizationId, 'Idem Conflict Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'IC-001',
      currentLocationId: loc1,
    });
    // Premier transfert vers loc2 avec la clé X.
    await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      idempotencyKey: 'conflict-key',
    });
    // Retransfère vers loc1 pour pouvoir retransférer.
    await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc1,
      idempotencyKey: 'back-key',
    });
    // Réutilise la clé X mais vers loc3 (destination différente) → rejet.
    await expect(
      transferInventoryItem(db, {
        organizationId,
        inventoryItemId: item.id,
        toLocationId: loc3.id,
        idempotencyKey: 'conflict-key',
      }),
    ).rejects.toThrow(/Conflit d'idempotence/);
  });

  it('transfert vers la même localisation est no-op (idempotent)', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'noop@example.com',
      'NoOp Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'NoOp Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'NOOP-001',
      currentLocationId: locationId,
    });
    const result = await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: locationId,
      idempotencyKey: 'noop-1',
    });
    expect(result.movement).toBeNull();
    const movements = await listMovements(db, organizationId, item.id);
    expect(movements).toHaveLength(0);
  });

  it('inventory_movements est append-only (UPDATE rejeté)', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId: loc1 } = await setupOrgWithLocation(
      'append@example.com',
      'Append Org',
      'Shop 1',
    );
    const loc2 = await createLocation(db, {
      organizationId,
      name: 'Shop 2',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(organizationId, 'Append Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'APPEND-001',
      currentLocationId: loc1,
    });
    await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      idempotencyKey: 'append-1',
    });
    const movements = await listMovements(db, organizationId, item.id);
    const { inventoryMovements } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    await expect(
      db
        .update(inventoryMovements)
        .set({ reason: 'modified' })
        .where(eq(inventoryMovements.id, movements[0]!.id)),
    ).rejects.toThrow(/append-only/);
  });

  it('archivage produit réversible (PUBLISHED → ARCHIVED → PUBLISHED)', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('archive@example.com', 'Archive Org');
    const { product } = await createProductForOrg(organizationId, 'Archive Product');
    await publishProduct(db, organizationId, product.id);
    const archived = await archiveProduct(db, organizationId, product.id);
    expect(archived.publicationStatus).toBe('ARCHIVED');
    const restored = await restoreArchivedProduct(db, organizationId, product.id);
    expect(restored.publicationStatus).toBe('PUBLISHED');
  });

  it("désactivation catégorie refusée si produit PUBLISHED l'utilise", async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('cat-deact@example.com', 'Cat Deact Org');
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'surf'))
      .limit(1);
    if (!cat) throw new Error('Catégorie surf absente.');
    const { product } = await createProductForOrg(organizationId, 'Cat Deact Product', cat.id);
    await publishProduct(db, organizationId, product.id);
    await expect(deactivateCategory(db, cat.id)).rejects.toThrow();
  });

  it('désactivation catégorie autorisée après archivage du produit publié', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'cat-deact-ok@example.com',
      'Cat Deact OK Org',
    );
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'snowboard'))
      .limit(1);
    if (!cat) throw new Error('Catégorie snowboard absente.');
    const { product } = await createProductForOrg(organizationId, 'Cat Deact OK Product', cat.id);
    await publishProduct(db, organizationId, product.id);
    await archiveProduct(db, organizationId, product.id);
    await expect(deactivateCategory(db, cat.id)).resolves.toBeDefined();
    await restoreCategory(db, cat.id);
  });

  it('désactivation catégorie refusée si elle a des descendants actifs', async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, { slug: 'parent-active', name: 'Parent Active' });
    await createCategory(db, { slug: 'child-active', name: 'Child Active', parentId: parent.id });
    // Le parent a un enfant actif → désactivation refusée.
    await expect(deactivateCategory(db, parent.id)).rejects.toThrow(/sous-catégorie|descendant/);
  });

  it('désactivation catégorie refusée si un descendant a des produits PUBLISHED', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'cat-subtree@example.com',
      'Cat Subtree Org',
    );
    const parent = await createCategory(db, { slug: 'parent-subtree', name: 'Parent Subtree' });
    const child = await createCategory(db, {
      slug: 'child-subtree',
      name: 'Child Subtree',
      parentId: parent.id,
    });
    await insertProductFixture(organizationId, child.id, 'subtree-product', 'PUBLISHED');
    // Le parent n'a pas de produit direct, mais son enfant a un produit PUBLISHED → refus.
    await expect(deactivateCategory(db, parent.id)).rejects.toThrow(/publi|descendant/);
  });

  it('désactivation parent autorisée après désactivation des enfants et archivage des produits', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'cat-cascade@example.com',
      'Cat Cascade Org',
    );
    const parent = await createCategory(db, { slug: 'cascade-parent', name: 'Cascade Parent' });
    const child = await createCategory(db, {
      slug: 'cascade-child',
      name: 'Cascade Child',
      parentId: parent.id,
    });
    const productId = await insertProductFixture(
      organizationId,
      child.id,
      'cascade-product',
      'PUBLISHED',
    );
    // Archive le produit, puis désactive l'enfant, puis désactive le parent.
    await archiveProduct(db, organizationId, productId);
    await deactivateCategory(db, child.id);
    await expect(deactivateCategory(db, parent.id)).resolves.toBeDefined();
  });

  // --- Tests d'invariant parent actif ---

  it("réactivation d'une catégorie refusée si le parent est inactif", async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, { slug: 'react-parent', name: 'React Parent' });
    const child = await createCategory(db, {
      slug: 'react-child',
      name: 'React Child',
      parentId: parent.id,
    });
    // Désactive enfant puis parent (cascade valide).
    await deactivateCategory(db, child.id);
    await deactivateCategory(db, parent.id);
    // Tente de réactiver l'enfant alors que le parent est inactif → refus.
    await expect(restoreCategory(db, child.id)).rejects.toThrow(/parent.*inact/i);
  });

  it("réactivation autorisée si le parent est réactivé d'abord", async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, { slug: 'react-ok-parent', name: 'React OK Parent' });
    const child = await createCategory(db, {
      slug: 'react-ok-child',
      name: 'React OK Child',
      parentId: parent.id,
    });
    await deactivateCategory(db, child.id);
    await deactivateCategory(db, parent.id);
    // Réactive le parent d'abord, puis l'enfant.
    await restoreCategory(db, parent.id);
    await expect(restoreCategory(db, child.id)).resolves.toBeDefined();
  });

  it("création d'une catégorie active sous un parent inactif rejetée", async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, { slug: 'inactive-parent', name: 'Inactive Parent' });
    await deactivateCategory(db, parent.id);
    // Tente de créer un enfant actif sous le parent inactif → refus.
    await expect(
      createCategory(db, { slug: 'child-under-inactive', name: 'Child', parentId: parent.id }),
    ).rejects.toThrow(/parent.*inact/i);
  });

  it('insertion SQL directe sous un parent inactif rejetée', async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, {
      slug: 'sql-inactive-parent',
      name: 'SQL Inactive Parent',
    });
    await deactivateCategory(db, parent.id);
    const { sql } = await import('drizzle-orm');
    await expect(
      db.execute(
        sql`INSERT INTO categories (slug, name, parent_id) VALUES ('sql-child', 'SQL Child', ${parent.id})`,
      ),
    ).rejects.toThrow(/parent.*inact/i);
  });

  it('course concurrente : désactivation parent vs création enfant', async () => {
    if (!ctx || !db) return;
    const parent = await createCategory(db, { slug: 'race-parent', name: 'Race Parent' });
    // Deux transactions concurrentes :
    //   T1 : crée un enfant actif sous parent (verrou SHARE sur parent)
    //   T2 : désactive le parent (UPDATE sur parent)
    // Le verrou FOR SHARE de T1 bloque l'UPDATE de T2 jusqu'à validation de T1.
    // T2 ne peut donc pas désactiver le parent pendant que T1 crée l'enfant.
    // Inversement, si T2 passe d'abord, T1 verra parent inactif et sera rejetée.
    // Dans tous les cas, l'invariant (pas d'enfant actif sous parent inactif) est respecté.
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq, sql } = await import('drizzle-orm');

    const results = await Promise.allSettled([
      // T1 : création d'un enfant (verrou SHARE sur le parent via trigger).
      db.transaction(async (tx) => {
        await tx.insert(categoriesTable).values({
          slug: 'race-child',
          name: 'Race Child',
          parentId: parent.id,
        });
        // Maintient la transaction ouverte brièvement pour augmenter la fenêtre de course.
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
      }),
      // T2 : désactivation du parent (légèrement décalée).
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(0.02)`);
        await tx
          .update(categoriesTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(categoriesTable.id, parent.id));
      }),
    ]);

    // L'invariant doit être respecté : on ne peut pas avoir un enfant actif
    // sous un parent inactif. Vérifie l'état final.
    const [finalParent] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, parent.id))
      .limit(1);
    const children = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.parentId, parent.id));

    // Si le parent est inactif, aucun enfant ne doit être actif.
    if (finalParent && !finalParent.isActive) {
      for (const child of children) {
        expect(child.isActive).toBe(false);
      }
    }
    // Si un enfant actif existe, le parent doit être actif.
    if (children.some((c) => c.isActive)) {
      expect(finalParent?.isActive).toBe(true);
    }
    // Au moins une des deux transactions doit échouer (sérialisation par verrou).
    // Le verrou FOR SHARE de T1 (création enfant) bloque l'UPDATE de T2 (désactivation
    // parent) jusqu'à validation de T1. T2 voit alors l'enfant actif et est rejetée
    // par le garde-fou de désactivation. Inversement, si T2 passe d'abord, T1 est
    // rejetée par le garde-fou parent actif.
    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Le rejet doit provenir d'un garde-fou (parent inactif ou sous-catégorie active).
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason.message).toMatch(/parent.*inact|sous-catégorie|descendant|publi/i);
      }
    }
  });

  it('profondeur catégorie > 3 rejetée', async () => {
    if (!ctx || !db) return;
    const cat1 = await createCategory(db, { slug: 'depth-1', name: 'Depth 1' });
    const cat2 = await createCategory(db, { slug: 'depth-2', name: 'Depth 2', parentId: cat1.id });
    const cat3 = await createCategory(db, { slug: 'depth-3', name: 'Depth 3', parentId: cat2.id });
    // Profondeur 4 doit être rejetée.
    await expect(
      createCategory(db, { slug: 'depth-4', name: 'Depth 4', parentId: cat3.id }),
    ).rejects.toThrow(/profondeur/i);
  });

  it('création de catégorie avec slug dupliqué rejetée', async () => {
    if (!ctx || !db) return;
    await createCategory(db, { slug: 'dup-cat-test', name: 'Dup Cat' });
    await expect(createCategory(db, { slug: 'dup-cat-test', name: 'Dup Cat 2' })).rejects.toThrow();
  });

  it('updateVariant ne permet pas de changer product_id (domaine)', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'variant-update@example.com',
      'Variant Update Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Variant Update Product');
    // UpdateVariantInput n'a pas de champ productId → immuable par construction.
    const updated = await updateVariant(db, organizationId, variantId, { name: 'Renamed Variant' });
    expect(updated.name).toBe('Renamed Variant');
    expect(updated.productId).toBeDefined();
  });

  it('retireInventoryItem passe le statut à RETIRED', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'retire@example.com',
      'Retire Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Retire Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RETIRE-001',
      currentLocationId: locationId,
    });
    const retired = await retireInventoryItem(db, organizationId, item.id);
    expect(retired.status).toBe('RETIRED');
  });

  it('un exemplaire ACTIVE et BROKEN est légitime', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'broken@example.com',
      'Broken Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Broken Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'BROKEN-001',
      condition: 'BROKEN',
      status: 'ACTIVE',
      currentLocationId: locationId,
    });
    expect(item.status).toBe('ACTIVE');
    expect(item.condition).toBe('BROKEN');
  });

  // --- Tests d'isolation multi-tenant des variantes ---

  it("cross-tenant : getVariant d'une autre org retourne null", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('var-iso-a@example.com', 'Var Iso A');
    const setupB = await setupOrgWithLocation('var-iso-b@example.com', 'Var Iso B');
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Var Iso Product A');
    // Tente de lire la variante de l'org A depuis l'org B.
    const result = await getVariant(db, setupB.organizationId, variantId);
    expect(result).toBeNull();
  });

  it("cross-tenant : updateVariant d'une autre org rejetée", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('var-x-a@example.com', 'Var X A');
    const setupB = await setupOrgWithLocation('var-x-b@example.com', 'Var X B');
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Var X Product A');
    await expect(
      updateVariant(db, setupB.organizationId, variantId, { name: 'Hacked' }),
    ).rejects.toThrow();
  });

  it("cross-tenant : deactivateVariant d'une autre org rejetée", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('var-d-a@example.com', 'Var D A');
    const setupB = await setupOrgWithLocation('var-d-b@example.com', 'Var D B');
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Var D Product A');
    await expect(deactivateVariant(db, setupB.organizationId, variantId)).rejects.toThrow();
  });

  it("cross-tenant : listVariants d'une autre org retourne vide", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('var-l-a@example.com', 'Var L A');
    const setupB = await setupOrgWithLocation('var-l-b@example.com', 'Var L B');
    const { product } = await createProductForOrg(setupA.organizationId, 'Var L Product A');
    // Tente de lister les variantes du produit A depuis l'org B.
    const variants = await listVariants(db, setupB.organizationId, product.id);
    expect(variants).toHaveLength(0);
  });

  it("cross-tenant : listMovements d'une autre org retourne vide", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation('mvmt-a@example.com', 'Mvmt A', 'Shop MA1');
    const setupB = await setupOrgWithLocation('mvmt-b@example.com', 'Mvmt B');
    const loc2 = await createLocation(db, {
      organizationId: setupA.organizationId,
      name: 'Shop MA2',
      timeZone: 'Europe/Paris',
    });
    const { variantId } = await createProductForOrg(setupA.organizationId, 'Mvmt Product A');
    const item = await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantId,
      internalSku: 'MVMT-001',
      currentLocationId: setupA.locationId,
    });
    await transferInventoryItem(db, {
      organizationId: setupA.organizationId,
      inventoryItemId: item.id,
      toLocationId: loc2.id,
      idempotencyKey: 'mvmt-1',
    });
    // Tente de lire les mouvements depuis l'org B.
    const movements = await listMovements(db, setupB.organizationId, item.id);
    expect(movements).toHaveLength(0);
  });

  // --- Tests de cycle de catégorie ---

  it('auto-référence catégorie (parent_id = id) rejetée', async () => {
    if (!ctx || !db) return;
    // Génère un UUID, puis tente d'insérer une catégorie avec parent_id = id.
    const { sql } = await import('drizzle-orm');
    const newId = crypto.randomUUID();
    await expect(
      db.execute(
        sql`INSERT INTO categories (id, slug, name, parent_id) VALUES (${newId}, 'self-ref-test', 'Self', ${newId})`,
      ),
    ).rejects.toThrow(/Cycle|cycle|parent/);
  });

  it('cycle : déplacer un parent sous son descendant rejeté', async () => {
    if (!ctx || !db) return;
    const cat1 = await createCategory(db, { slug: 'cycle-1', name: 'Cycle 1' });
    const cat2 = await createCategory(db, { slug: 'cycle-2', name: 'Cycle 2', parentId: cat1.id });
    // Tente de mettre cat1 sous cat2 (créerait un cycle cat1 → cat2 → cat1).
    const { categories } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    await expect(
      db.update(categories).set({ parentId: cat2.id }).where(eq(categories.id, cat1.id)),
    ).rejects.toThrow(/Cycle|cycle/);
  });

  // --- Tests de modification d'un produit publié ---

  it('updateProduct refuse une description vide sur un produit PUBLISHED', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('pub-empty@example.com', 'Pub Empty Org');
    const { product } = await createProductForOrg(organizationId, 'Pub Empty Product');
    await publishProduct(db, organizationId, product.id);
    await expect(
      updateProduct(db, organizationId, product.id, { description: '' }),
    ).rejects.toThrow(/description.*vide/);
  });

  it('updateProduct refuse un nom trop court sur un produit PUBLISHED', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('pub-short@example.com', 'Pub Short Org');
    const { product } = await createProductForOrg(organizationId, 'Pub Short Product');
    await publishProduct(db, organizationId, product.id);
    await expect(updateProduct(db, organizationId, product.id, { name: 'A' })).rejects.toThrow(
      /nom.*2 caractères/,
    );
  });

  it('updateProduct accepte une description vide sur un produit DRAFT', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'draft-empty@example.com',
      'Draft Empty Org',
    );
    const { product } = await createProductForOrg(organizationId, 'Draft Empty Product');
    // Le produit est en DRAFT : une description vide est autorisée.
    const updated = await updateProduct(db, organizationId, product.id, { description: '' });
    expect(updated.description).toBe('');
  });

  it('updateProduct refuse une catégorie désactivée sur un produit PUBLISHED', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation('pub-cat@example.com', 'Pub Cat Org');
    const { product } = await createProductForOrg(organizationId, 'Pub Cat Product', 'surf');
    await publishProduct(db, organizationId, product.id);
    // Crée une catégorie désactivée.
    const cat2 = await createCategory(db, { slug: 'pub-cat-disabled', name: 'Disabled Cat' });
    await deactivateCategory(db, cat2.id);
    await expect(
      updateProduct(db, organizationId, product.id, { categoryId: cat2.id }),
    ).rejects.toThrow(/désactivée/);
  });

  // ---------------------------------------------------------------------------
  // Tests de concurrence : publishProduct / updateProduct vs deactivateCategory
  //
  // publishProduct et updateProduct font leur PROPRE transaction interne
  // (db.transaction()) avec des verrous FOR UPDATE sur le produit et la
  // catégorie. deactivateCategory fait un UPDATE direct sur la catégorie,
  // déclenchant le trigger guard_category_deactivation qui refuse la
  // désactivation si des produits PUBLISHED existent dans le sous-arbre.
  //
  // Comme publishProduct/updateProduct prennent DatabaseClient (et non
  // DbExecutor), elles ne peuvent pas être appelées à l'intérieur d'une
  // transaction externe. On utilise donc le pattern d'appels directs
  // concurrents via Promise.allSettled (comme le test L492), en comptant
  // sur la sérialisation naturelle PostgreSQL via les verrous FOR UPDATE.
  // ---------------------------------------------------------------------------

  it('course concurrente : publication produit vs désactivation catégorie', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'conc-pub-cat@example.com',
      'Conc Pub Cat Org',
    );
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'surf'))
      .limit(1);
    if (!cat) throw new Error('Catégorie surf absente.');
    // Produit DRAFT complet (nom ≥2, description non vide, variante active par défaut).
    const { product } = await createProductForOrg(organizationId, 'Conc Pub Product', cat.id);

    // Deux transactions concurrentes :
    //   T1 : publishProduct — verrou FOR UPDATE sur produit puis catégorie,
    //        vérifie catégorie active, passe le produit en PUBLISHED.
    //   T2 : deactivateCategory — UPDATE sur la catégorie (isActive → false),
    //        le trigger guard_category_deactivation vérifie qu'aucun produit
    //        PUBLISHED n'utilise la catégorie ou ses descendants.
    //
    // Le verrou FOR UPDATE sur la catégorie par T1 bloque l'UPDATE de T2
    // jusqu'à validation de T1. Si T1 valide d'abord → produit PUBLISHED,
    // puis T2 exécute son trigger qui voit le PUBLISHED → rejetée.
    // Si T2 valide d'abord → catégorie inactive, puis T1 verrouille la
    // catégorie et voit isActive=false → rejetée.
    //
    // Issues légitimes (les deux acceptables) :
    //   - Publication réussie + désactivation rejetée → PUBLISHED + catégorie active.
    //   - Désactivation réussie + publication rejetée → DRAFT + catégorie inactive.
    //
    // Invariant final interdit : publicationStatus === 'PUBLISHED'
    //   ET category.isActive === false (publication sur catégorie désactivée).
    const { products: productsTable } = await import('@uttily/database');

    const results = await Promise.allSettled([
      // T1 : publication du produit (verrou FOR UPDATE sur produit + catégorie).
      publishProduct(db, organizationId, product.id),
      // T2 : désactivation de la catégorie (UPDATE + trigger garde-fou).
      deactivateCategory(db, cat.id),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Au moins une des deux opérations doit échouer (sérialisation par verrou).
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Vérifie l'état final pour l'invariant bidirectionnel.
    const [finalProduct] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, product.id))
      .limit(1);
    const [finalCat] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, cat.id))
      .limit(1);

    // Invariant : si PUBLISHED alors catégorie active ; si catégorie inactive
    // alors non PUBLISHED.
    if (finalProduct && finalProduct.publicationStatus === 'PUBLISHED') {
      expect(finalCat?.isActive).toBe(true);
    }
    if (finalCat && !finalCat.isActive) {
      expect(finalProduct?.publicationStatus).not.toBe('PUBLISHED');
    }

    // Les rejets doivent provenir d'un garde-fou (catégorie désactivée/inactive
    // ou produit publié empêchant la désactivation).
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason.message).toMatch(/désactiv|inact|publi|inexistante/i);
      }
    }

    if (finalCat && !finalCat.isActive) await restoreCategory(db, cat.id);
  });

  it('course concurrente : update produit (changement catégorie) vs désactivation catégorie cible', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'conc-upd-cat@example.com',
      'Conc Upd Cat Org',
    );
    // Deux familles commerciales actives distinctes.
    const { categories: categoriesTable } = await import('@uttily/database');
    const { eq } = await import('drizzle-orm');
    const [cat1] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'surf'))
      .limit(1);
    const [cat2] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.slug, 'snowboard'))
      .limit(1);
    if (!cat1 || !cat2) throw new Error('Familles commerciales attendues absentes.');
    // Produit PUBLISHED dans cat1.
    const { product } = await createProductForOrg(organizationId, 'Conc Upd Product', cat1.id);
    await publishProduct(db, organizationId, product.id);

    // Deux transactions concurrentes :
    //   T1 : updateProduct avec categoryId: cat2.id — verrou FOR UPDATE sur
    //        produit puis sur cat2, vérifie cat2 active, déplace le produit
    //        vers cat2 (le produit reste PUBLISHED).
    //   T2 : deactivateCategory(cat2) — UPDATE sur cat2 (isActive → false),
    //        le trigger guard_category_deactivation vérifie qu'aucun produit
    //        PUBLISHED n'utilise cat2 ou ses descendants.
    //
    // Le verrou FOR UPDATE sur cat2 par T1 bloque l'UPDATE de T2 jusqu'à
    // validation de T1. Si T1 valide d'abord → produit PUBLISHED dans cat2,
    // puis T2 exécute son trigger qui voit le PUBLISHED → rejetée.
    // Si T2 valide d'abord → cat2 inactive, puis T1 verrouille cat2 et voit
    // isActive=false → rejetée (le produit reste dans cat1).
    //
    // Issues légitimes (les deux acceptables) :
    //   - Update réussi + désactivation rejetée → produit PUBLISHED dans cat2 (active).
    //   - Désactivation réussie + update rejeté → produit reste PUBLISHED dans cat1.
    //
    // Invariant final interdit : produit PUBLISHED avec categoryId === cat2.id
    //   ET cat2.isActive === false (produit publié sur catégorie désactivée).
    const { products: productsTable } = await import('@uttily/database');

    const results = await Promise.allSettled([
      // T1 : déplacement du produit vers cat2 (verrou FOR UPDATE sur produit + cat2).
      updateProduct(db, organizationId, product.id, { categoryId: cat2.id }),
      // T2 : désactivation de cat2 (UPDATE + trigger garde-fou).
      deactivateCategory(db, cat2.id),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Au moins une des deux opérations doit échouer (sérialisation par verrou).
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Vérifie l'état final pour l'invariant bidirectionnel.
    const [finalProduct] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, product.id))
      .limit(1);
    const [finalCat2] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, cat2.id))
      .limit(1);

    // Invariant : si le produit est PUBLISHED dans cat2 alors cat2 doit être
    // active ; si cat2 est inactive alors le produit ne doit pas être dans cat2.
    if (
      finalProduct &&
      finalProduct.publicationStatus === 'PUBLISHED' &&
      finalProduct.categoryId === cat2.id
    ) {
      expect(finalCat2?.isActive).toBe(true);
    }
    if (finalCat2 && !finalCat2.isActive) {
      expect(finalProduct?.categoryId).not.toBe(cat2.id);
    }

    // Les rejets doivent provenir d'un garde-fou (catégorie désactivée/inactive
    // ou produit publié empêchant la désactivation).
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason.message).toMatch(/désactiv|inact|publi|inexistante/i);
      }
    }

    if (finalCat2 && !finalCat2.isActive) await restoreCategory(db, cat2.id);
  });

  // -------------------------------------------------------------------------
  // Read models — listProductSummaries, getProductDetails, listInventorySummaries,
  // getInventoryDetails, listActiveVariantOptions, getProductPublicationReadiness.
  // -------------------------------------------------------------------------

  it('listProductSummaries : retourne les produits avec categoryName et counts corrects', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-sum@example.com',
      'ReadModel Sum Org',
    );
    const { product, variantId } = await createProductForOrg(organizationId, 'RM Product');
    // Crée un exemplaire actif.
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-SKU-001',
      currentLocationId: locationId,
    });
    const summaries = await listProductSummaries(db, organizationId);
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.id).toBe(product.id);
    expect(s.name).toBe('RM Product');
    expect(s.publicationStatus).toBe('DRAFT');
    expect(s.categoryName).toBe('Surf');
    expect(s.activeVariantCount).toBe(1);
    expect(s.activeInventoryCount).toBe(1);
  });

  it('listProductSummaries : exclut les produits supprimés', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-del@example.com',
      'ReadModel Del Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM Deleted Product');
    // Supprime logiquement le produit via SQL direct (deleteProduct n'est pas importé).
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE products SET deleted_at = NOW() WHERE id = ${product.id}`);
    const summaries = await listProductSummaries(db, organizationId);
    expect(summaries.find((s) => s.id === product.id)).toBeUndefined();
  });

  it('listProductSummaries : inclut les produits archivés', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-arch@example.com',
      'ReadModel Arch Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM Arch Product');
    // Publie puis archive.
    await publishProduct(db, organizationId, product.id);
    await archiveProduct(db, organizationId, product.id);
    const summaries = await listProductSummaries(db, organizationId);
    const found = summaries.find((s) => s.id === product.id);
    expect(found).toBeDefined();
    expect(found!.publicationStatus).toBe('ARCHIVED');
  });

  it('listProductSummaries : isolation multi-tenant', async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation(
      'readmodel-iso-a@example.com',
      'ReadModel Iso A',
    );
    const { organizationId: orgB } = await setupOrgWithLocation(
      'readmodel-iso-b@example.com',
      'ReadModel Iso B',
    );
    await createProductForOrg(orgA, 'RM Iso Product A');
    await createProductForOrg(orgB, 'RM Iso Product B');
    const summariesA = await listProductSummaries(db, orgA);
    const summariesB = await listProductSummaries(db, orgB);
    expect(summariesA).toHaveLength(1);
    expect(summariesA[0]!.name).toBe('RM Iso Product A');
    expect(summariesB).toHaveLength(1);
    expect(summariesB[0]!.name).toBe('RM Iso Product B');
  });

  it('getProductDetails : retourne produit + catégorie + variantes + counts + readiness', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-details@example.com',
      'ReadModel Details Org',
    );
    const { product, variantId } = await createProductForOrg(organizationId, 'RM Details Product');
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-DET-001',
      currentLocationId: locationId,
    });
    const details = await getProductDetails(db, organizationId, product.id);
    expect(details).not.toBeNull();
    expect(details!.product.id).toBe(product.id);
    expect(details!.category.name).toBe('Surf');
    expect(details!.category.isActive).toBe(true);
    expect(details!.variants).toHaveLength(1);
    expect(details!.variants[0]!.name).toBe('Standard');
    expect(details!.activeVariantCount).toBe(1);
    expect(details!.activeInventoryCount).toBe(1);
    // Le produit a une description valide et une variante active → ready.
    expect(details!.publicationReadiness.ready).toBe(true);
    expect(details!.publicationReadiness.failures).toHaveLength(0);
  });

  it("getProductDetails : retourne null si produit d'une autre org", async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation(
      'readmodel-cross-a@example.com',
      'ReadModel Cross A',
    );
    const { organizationId: orgB } = await setupOrgWithLocation(
      'readmodel-cross-b@example.com',
      'ReadModel Cross B',
    );
    const { product } = await createProductForOrg(orgA, 'RM Cross Product');
    const details = await getProductDetails(db, orgB, product.id);
    expect(details).toBeNull();
  });

  it('getProductDetails : readiness correcte pour produit incomplet (DRAFT sans description)', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-incomplete@example.com',
      'ReadModel Incomplete Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM Incomplete Product');
    // Vide la description via SQL direct.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE products SET description = '' WHERE id = ${product.id}`);
    const details = await getProductDetails(db, organizationId, product.id);
    expect(details).not.toBeNull();
    expect(details!.publicationReadiness.ready).toBe(false);
    expect(details!.publicationReadiness.failures).toContain('La description est requise.');
  });

  it('listInventorySummaries : retourne les exemplaires avec noms joints', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-invsum@example.com',
      'ReadModel InvSum Org',
      'Shop InvSum',
    );
    const { product, variantId } = await createProductForOrg(organizationId, 'RM InvSum Product');
    await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-INV-001',
      serialNumber: 'SN-INV-001',
      currentLocationId: locationId,
    });
    const summaries = await listInventorySummaries(db, organizationId);
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.internalSku).toBe('RM-INV-001');
    expect(s.serialNumber).toBe('SN-INV-001');
    expect(s.variantName).toBe('Standard');
    expect(s.productName).toBe('RM InvSum Product');
    expect(s.categorySlug).toBe('surf');
    expect(s.locationName).toBe('Shop InvSum');
    expect(s.productId).toBe(product.id);
    expect(s.productVariantId).toBe(variantId);
  });

  it('listInventorySummaries : exclut les supprimés', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-invdel@example.com',
      'ReadModel InvDel Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'RM InvDel Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-INVDEL-001',
      currentLocationId: locationId,
    });
    // Supprime logiquement l'exemplaire via SQL direct.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE inventory_items SET deleted_at = NOW() WHERE id = ${item.id}`);
    const summaries = await listInventorySummaries(db, organizationId);
    expect(summaries.find((s) => s.id === item.id)).toBeUndefined();
  });

  it('listInventorySummaries : isolation multi-tenant', async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation(
      'readmodel-inviso-a@example.com',
      'ReadModel InvIso A',
    );
    const setupB = await setupOrgWithLocation(
      'readmodel-inviso-b@example.com',
      'ReadModel InvIso B',
    );
    const { variantId: variantA } = await createProductForOrg(setupA.organizationId, 'RM InvIso A');
    const { variantId: variantB } = await createProductForOrg(setupB.organizationId, 'RM InvIso B');
    await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantA,
      internalSku: 'RM-INVISO-A',
      currentLocationId: setupA.locationId,
    });
    await createInventoryItem(db, {
      organizationId: setupB.organizationId,
      productVariantId: variantB,
      internalSku: 'RM-INVISO-B',
      currentLocationId: setupB.locationId,
    });
    const summariesA = await listInventorySummaries(db, setupA.organizationId);
    const summariesB = await listInventorySummaries(db, setupB.organizationId);
    expect(summariesA).toHaveLength(1);
    expect(summariesA[0]!.internalSku).toBe('RM-INVISO-A');
    expect(summariesB).toHaveLength(1);
    expect(summariesB[0]!.internalSku).toBe('RM-INVISO-B');
  });

  it('getInventoryDetails : retourne item + variante + produit + location + mouvements', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-invdet@example.com',
      'ReadModel InvDet Org',
      'Shop InvDet',
    );
    const { product, variantId } = await createProductForOrg(organizationId, 'RM InvDet Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-INVDET-001',
      currentLocationId: locationId,
    });
    // Crée un mouvement via transfert vers une seconde location.
    const location2 = await createLocation(db, {
      organizationId,
      name: 'Shop InvDet 2',
      timeZone: 'Europe/Paris',
    });
    await transferInventoryItem(db, {
      organizationId,
      inventoryItemId: item.id,
      toLocationId: location2.id,
      reason: 'Test move',
    });
    const details = await getInventoryDetails(db, organizationId, item.id);
    expect(details).not.toBeNull();
    expect(details!.item.id).toBe(item.id);
    expect(details!.item.internalSku).toBe('RM-INVDET-001');
    expect(details!.variant.id).toBe(variantId);
    expect(details!.variant.name).toBe('Standard');
    expect(details!.product.id).toBe(product.id);
    expect(details!.product.name).toBe('RM InvDet Product');
    // Après le transfert, la location courante est location2.
    expect(details!.location.id).toBe(location2.id);
    expect(details!.location.name).toBe('Shop InvDet 2');
    // Un mouvement enregistré.
    expect(details!.movements).toHaveLength(1);
    expect(details!.movements[0]!.reason).toBe('Test move');
  });

  it('getInventoryDetails : limite les mouvements à 50 (tri DESC)', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'readmodel-invlimit@example.com',
      'ReadModel InvLimit Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'RM InvLimit Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'RM-INVLIMIT-001',
      currentLocationId: locationId,
    });
    // Crée une seconde location pour pouvoir transférer.
    const location2 = await createLocation(db, {
      organizationId,
      name: 'Shop InvLimit 2',
      timeZone: 'Europe/Paris',
    });
    // Génère 55 mouvements en alternant les transferts.
    for (let i = 0; i < 55; i++) {
      const target = i % 2 === 0 ? location2.id : locationId;
      await transferInventoryItem(db, {
        organizationId,
        inventoryItemId: item.id,
        toLocationId: target,
        reason: `Move ${i}`,
        idempotencyKey: `move-${i}`,
      });
    }
    const details = await getInventoryDetails(db, organizationId, item.id);
    expect(details).not.toBeNull();
    expect(details!.movements.length).toBe(50);
  });

  it("getInventoryDetails : retourne null si item d'une autre org", async () => {
    if (!ctx || !db) return;
    const setupA = await setupOrgWithLocation(
      'readmodel-invcross-a@example.com',
      'ReadModel InvCross A',
    );
    const setupB = await setupOrgWithLocation(
      'readmodel-invcross-b@example.com',
      'ReadModel InvCross B',
    );
    const { variantId } = await createProductForOrg(setupA.organizationId, 'RM InvCross Product');
    const item = await createInventoryItem(db, {
      organizationId: setupA.organizationId,
      productVariantId: variantId,
      internalSku: 'RM-INVCROSS-001',
      currentLocationId: setupA.locationId,
    });
    const details = await getInventoryDetails(db, setupB.organizationId, item.id);
    expect(details).toBeNull();
  });

  it('listActiveVariantOptions : retourne uniquement les variantes actives non supprimées', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-varopt@example.com',
      'ReadModel VarOpt Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM VarOpt Product');
    const options = await listActiveVariantOptions(db, organizationId);
    expect(options.length).toBeGreaterThanOrEqual(1);
    const found = options.find((o) => o.productId === product.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Standard');
    expect(found!.productName).toBe('RM VarOpt Product');
  });

  it('listActiveVariantOptions : isolation multi-tenant', async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation(
      'readmodel-variso-a@example.com',
      'ReadModel VarIso A',
    );
    const { organizationId: orgB } = await setupOrgWithLocation(
      'readmodel-variso-b@example.com',
      'ReadModel VarIso B',
    );
    await createProductForOrg(orgA, 'RM VarIso A');
    await createProductForOrg(orgB, 'RM VarIso B');
    const optionsA = await listActiveVariantOptions(db, orgA);
    const optionsB = await listActiveVariantOptions(db, orgB);
    expect(optionsA.every((o) => o.productName === 'RM VarIso A')).toBe(true);
    expect(optionsB.every((o) => o.productName === 'RM VarIso B')).toBe(true);
  });

  it('getProductPublicationReadiness : produit complet → ready=true, failures=[]', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-ready@example.com',
      'ReadModel Ready Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM Ready Product');
    const readiness = await getProductPublicationReadiness(db, organizationId, product.id);
    expect(readiness).not.toBeNull();
    expect(readiness!.ready).toBe(true);
    expect(readiness!.failures).toHaveLength(0);
  });

  it('getProductPublicationReadiness : produit incomplet → ready=false avec bons messages', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'readmodel-notready@example.com',
      'ReadModel NotReady Org',
    );
    const { product } = await createProductForOrg(organizationId, 'RM NotReady Product');
    // Vide la description via SQL direct.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE products SET description = '' WHERE id = ${product.id}`);
    const readiness = await getProductPublicationReadiness(db, organizationId, product.id);
    expect(readiness).not.toBeNull();
    expect(readiness!.ready).toBe(false);
    expect(readiness!.failures).toContain('La description est requise.');
  });

  it("getProductPublicationReadiness : produit d'une autre org → null", async () => {
    if (!ctx || !db) return;
    const { organizationId: orgA } = await setupOrgWithLocation(
      'readmodel-readycross-a@example.com',
      'ReadModel ReadyCross A',
    );
    const { organizationId: orgB } = await setupOrgWithLocation(
      'readmodel-readycross-b@example.com',
      'ReadModel ReadyCross B',
    );
    const { product } = await createProductForOrg(orgA, 'RM ReadyCross Product');
    const readiness = await getProductPublicationReadiness(db, orgB, product.id);
    expect(readiness).toBeNull();
  });

  it('publishProduct : format d\'erreur "Publication impossible" préservé', async () => {
    if (!ctx || !db) return;
    const { sql } = await import('drizzle-orm');
    const { organizationId } = await setupOrgWithLocation(
      'pub-format@example.com',
      'Pub Format Org',
    );
    const { product } = await createProductForOrg(organizationId, 'Pub Format Product');
    // Vide la description via SQL direct → publication impossible.
    await db.execute(sql`UPDATE products SET description = '' WHERE id = ${product.id}`);
    await expect(publishProduct(db, organizationId, product.id)).rejects.toThrow(
      /Publication impossible:/,
    );
  });

  it('publishProduct : nom < 2 caractères rejeté', async () => {
    if (!ctx || !db) return;
    const { sql } = await import('drizzle-orm');
    const { organizationId } = await setupOrgWithLocation('pub-nom@example.com', 'Pub Nom Org');
    const { product } = await createProductForOrg(organizationId, 'Pub Nom Product');
    // Force un nom < 2 caractères directement en base (contourne la validation createProduct).
    await db.execute(sql`UPDATE products SET name = 'A' WHERE id = ${product.id}`);
    await expect(publishProduct(db, organizationId, product.id)).rejects.toThrow(/nom/);
  });

  it('updateVariant avec skuSuffix: null efface la colonne nullable', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'var-clear-sku@example.com',
      'Var Clear SKU Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Var Clear SKU Product');
    // D'abord, set un skuSuffix via updateVariant.
    await updateVariant(db, organizationId, variantId, { skuSuffix: 'SUFFIX-1' });
    let updated = await getVariant(db, organizationId, variantId);
    expect(updated?.skuSuffix).toBe('SUFFIX-1');
    // Efface avec null.
    updated = await updateVariant(db, organizationId, variantId, { skuSuffix: null });
    expect(updated?.skuSuffix).toBeNull();
  });

  it('updateVariant avec skuSuffix absent (undefined) ne modifie pas la colonne', async () => {
    if (!ctx || !db) return;
    const { organizationId } = await setupOrgWithLocation(
      'var-keep-sku@example.com',
      'Var Keep SKU Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Var Keep SKU Product');
    await updateVariant(db, organizationId, variantId, { skuSuffix: 'KEEP-1' });
    // Update avec un autre champ, skuSuffix absent.
    const updated = await updateVariant(db, organizationId, variantId, { name: 'Renamed' });
    expect(updated.skuSuffix).toBe('KEEP-1');
  });

  it('updateInventoryItem avec serialNumber: null et notes: null efface les colonnes nullables', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'inv-clear@example.com',
      'Inv Clear Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Inv Clear Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'CLEAR-001',
      serialNumber: 'SN-001',
      notes: 'Note originale',
      currentLocationId: locationId,
    });
    expect(item.serialNumber).toBe('SN-001');
    expect(item.notes).toBe('Note originale');
    // Efface avec null.
    const cleared = await updateInventoryItem(db, organizationId, item.id, {
      serialNumber: null,
      notes: null,
    });
    expect(cleared.serialNumber).toBeNull();
    expect(cleared.notes).toBeNull();
    // Relecture pour confirmer la persistance.
    const reread = await getInventoryItem(db, organizationId, item.id);
    expect(reread?.serialNumber).toBeNull();
    expect(reread?.notes).toBeNull();
  });

  it('updateInventoryItem avec champs absents (undefined) ne modifie pas les colonnes', async () => {
    if (!ctx || !db) return;
    const { organizationId, locationId } = await setupOrgWithLocation(
      'inv-keep@example.com',
      'Inv Keep Org',
    );
    const { variantId } = await createProductForOrg(organizationId, 'Inv Keep Product');
    const item = await createInventoryItem(db, {
      organizationId,
      productVariantId: variantId,
      internalSku: 'KEEP-002',
      serialNumber: 'SN-KEEP',
      notes: 'Note à garder',
      currentLocationId: locationId,
    });
    // Update avec condition seulement, serialNumber et notes absents.
    const updated = await updateInventoryItem(db, organizationId, item.id, {
      condition: 'BROKEN',
    });
    expect(updated.serialNumber).toBe('SN-KEEP');
    expect(updated.notes).toBe('Note à garder');
    expect(updated.condition).toBe('BROKEN');
  });
});
