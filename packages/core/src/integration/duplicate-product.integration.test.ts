import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  createDatabase,
  categories,
  inventoryItems,
  pricingPlans,
  productPhotos,
  productVariants,
  products,
} from '@uttily/database';
import {
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  createCategory,
  createLocation,
  createOrganizationForUser,
  createProduct,
  createVariant,
  deactivateCategory,
  duplicateProduct,
  listVariants,
  provisionUserFromOidc,
  saveDailyPricingPlanDraft,
  activateDailyPricingPlan,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';

let ctx: IntegrationTestContext | null = null;
let db: ReturnType<typeof createDatabase> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('duplicate_product');
  if (ctx) db = createDatabase(ctx.databaseUrl);
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!db) return;
  await db.execute(sql`TRUNCATE TABLE organizations, users RESTART IDENTITY CASCADE`);
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('db not initialized');
  return provisionUserFromOidc(db, {
    oidcSubject: `duplicate-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createOrg(email: string): Promise<{ organizationId: string; locationId: string }> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: `Duplicate ${email}`,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, {
    organizationId: organization.id,
    name: 'Site principal',
    timeZone: 'Europe/Paris',
  });
  return { organizationId: organization.id, locationId: location.id };
}

async function countForProduct(table: typeof productPhotos, productId: string): Promise<number> {
  if (!db) throw new Error('db not initialized');
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.productId, productId));
  return Number(row?.count ?? 0);
}

describe.skipIf(shouldSkipIntegrationTests())('Controlled product duplication — PostgreSQL', () => {
  it('duplique les huit familles actives en ne copiant que le catalogue', async () => {
    if (!db) return;
    const { organizationId, locationId } = await createOrg('all-families@example.com');
    const categoryRows = await db.select().from(categories);
    const categoryBySlug = new Map(categoryRows.map((category) => [category.slug, category]));

    for (const [index, familySlug] of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.entries()) {
      const category = categoryBySlug.get(familySlug);
      if (!category) throw new Error(`Catégorie absente: ${familySlug}`);

      const source = await createProduct(db, {
        organizationId,
        categoryId: category.id,
        name: `Source ${familySlug}`,
        description: `Description ${familySlug}`,
        slug: `source-${familySlug}`,
      });
      const sourceVariant = await createVariant(db, {
        organizationId,
        productId: source.id,
        name: `Option ${familySlug}`,
        skuSuffix: `OPT-${index}`,
        attributes: { family: familySlug, capacity: 'double' },
      });

      if (index === 0) {
        await db
          .update(productVariants)
          .set({ dailyPriceAmountMinor: 2500, currency: 'EUR' })
          .where(eq(productVariants.id, sourceVariant.id));
        const plan = await saveDailyPricingPlanDraft(db, {
          organizationId,
          variantId: sourceVariant.id,
          locationId,
          priceAmountMinor: 2500,
          currency: 'EUR',
        });
        await activateDailyPricingPlan(db, organizationId, plan.id);
        await db.execute(sql`
          INSERT INTO product_photos (
            organization_id, product_id, storage_key, content_type,
            byte_size, width_px, height_px, checksum_sha256, sort_order, file_state
          ) VALUES (
            ${organizationId}, ${source.id}, ${`product-photos/${source.id}`}, 'image/jpeg',
            102400, 800, 600, ${'1'.repeat(64)}, 0, 'AVAILABLE'
          )
        `);
        await db.execute(sql`
          INSERT INTO inventory_items (
            organization_id, product_variant_id, internal_sku, current_location_id
          ) VALUES (${organizationId}, ${sourceVariant.id}, 'SOURCE-STOCK-001', ${locationId})
        `);
      }

      const copy = await duplicateProduct(db, {
        organizationId,
        sourceProductId: source.id,
        idempotencyKey: `duplicate-${familySlug}`,
      });
      expect(copy).toMatchObject({
        organizationId,
        categoryId: category.id,
        name: `Source ${familySlug} (copie)`,
        slug: `source-${familySlug}-copy`,
        description: `Description ${familySlug}`,
        publicationStatus: 'DRAFT',
      });

      const sourceVariants = await listVariants(db, organizationId, source.id);
      const copiedVariants = await listVariants(db, organizationId, copy.id);
      expect(
        copiedVariants.map(({ name, skuSuffix, attributes, isActive }) => ({
          name,
          skuSuffix,
          attributes,
          isActive,
        })),
      ).toEqual(
        sourceVariants.map(({ name, skuSuffix, attributes, isActive }) => ({
          name,
          skuSuffix,
          attributes,
          isActive,
        })),
      );
      expect(await countForProduct(productPhotos, copy.id)).toBe(0);

      const copiedVariantIds = copiedVariants.map((variant) => variant.id);
      expect(copiedVariantIds).not.toHaveLength(0);
      const copiedStock = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryItems)
        .where(inArray(inventoryItems.productVariantId, copiedVariantIds));
      expect(Number(copiedStock[0]?.count ?? 0)).toBe(0);
      const copiedPrices = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pricingPlans)
        .where(inArray(pricingPlans.productVariantId, copiedVariantIds));
      expect(Number(copiedPrices[0]?.count ?? 0)).toBe(0);
      expect(copy.publicationStatus).toBe('DRAFT');
    }
  });

  it('est idempotente, attribue un slug suivant et protège le tenant', async () => {
    if (!db) return;
    const orgA = await createOrg('idempotency-a@example.com');
    const orgB = await createOrg('idempotency-b@example.com');
    const [bikeCategory] = await db.select().from(categories).where(eq(categories.slug, 'bike'));
    if (!bikeCategory) throw new Error('Catégorie bike absente');
    const source = await createProduct(db, {
      organizationId: orgA.organizationId,
      categoryId: bikeCategory.id,
      name: 'Vélo source',
      slug: 'velo-source',
    });

    const first = await duplicateProduct(db, {
      organizationId: orgA.organizationId,
      sourceProductId: source.id,
      idempotencyKey: 'same-request',
    });
    const replay = await duplicateProduct(db, {
      organizationId: orgA.organizationId,
      sourceProductId: source.id,
      idempotencyKey: 'same-request',
    });
    expect(replay.id).toBe(first.id);

    const second = await duplicateProduct(db, {
      organizationId: orgA.organizationId,
      sourceProductId: source.id,
      idempotencyKey: 'second-request',
    });
    expect(second.slug).toBe('velo-source-copy-2');
    await expect(
      duplicateProduct(db, {
        organizationId: orgA.organizationId,
        sourceProductId: source.id,
        idempotencyKey: 'same-request',
        name: 'Autre copie',
      }),
    ).rejects.toThrow(/idempotence/);

    await expect(
      duplicateProduct(db, {
        organizationId: orgB.organizationId,
        sourceProductId: source.id,
        idempotencyKey: 'wrong-tenant',
      }),
    ).rejects.toThrow(/introuvable/);
  });

  it('refuse le fallback, le slug historique et les catégories inconnues', async () => {
    if (!db) return;
    const { organizationId } = await createOrg('rejected-families@example.com');
    const categoryRows = await db.select().from(categories);
    const rejected = [
      categoryRows.find((category) => category.slug === 'equipment'),
      categoryRows.find((category) => category.slug === 'paddle'),
      await createCategory(db, { slug: 'duplicate-unknown', name: 'Unknown' }),
      await createCategory(db, { slug: 'duplicate-inactive', name: 'Inactive' }),
    ];
    const inactive = rejected[3];
    if (inactive) await deactivateCategory(db, inactive.id);

    for (const [index, category] of rejected.entries()) {
      if (!category) throw new Error('Catégorie de rejet absente');
      const [source] = await db
        .insert(products)
        .values({
          organizationId,
          categoryId: category.id,
          name: `Historique ${index}`,
          slug: `historique-${index}`,
          description: '',
          publicationStatus: 'ARCHIVED',
        })
        .returning();
      if (!source) throw new Error('Produit historique absent');
      await expect(
        duplicateProduct(db, {
          organizationId,
          sourceProductId: source.id,
          idempotencyKey: `rejected-${index}`,
        }),
      ).rejects.toThrow(/familles commerciales actives/);
    }

    const historical = await db
      .select({ id: products.id, publicationStatus: products.publicationStatus })
      .from(products)
      .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)));
    expect(historical).toHaveLength(4);
    expect(historical.every((product) => product.publicationStatus === 'ARCHIVED')).toBe(true);
  });
});
