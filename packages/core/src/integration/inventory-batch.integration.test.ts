import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { categories, createDatabase, inventoryItems, idempotencyRecords } from '@uttily/database';
import {
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  createInventoryItemsBatch,
  createLocation,
  createOrganizationForUser,
  createProduct,
  provisionUserFromOidc,
  buildInventoryBatchSku,
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
  ctx = await setupIntegrationTestDb('inventory_batch');
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
  await db.execute(
    sql`TRUNCATE TABLE idempotency_records, inventory_movements, inventory_items, product_variants, products, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('db not initialized');
  return provisionUserFromOidc(db, {
    oidcSubject: `inventory-batch-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createOrg(email: string): Promise<{ organizationId: string; locationId: string }> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: `Inventory batch ${email}`,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, {
    organizationId: organization.id,
    name: 'Site principal',
    timeZone: 'Europe/Paris',
  });
  return { organizationId: organization.id, locationId: location.id };
}

async function getCategoryId(slug: string): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug));
  if (!category) throw new Error(`Catégorie absente: ${slug}`);
  return category.id;
}

async function createVariantForOrg(
  organizationId: string,
  familySlug: string,
  suffix: string,
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const product = await createProduct(db, {
    organizationId,
    categoryId: await getCategoryId(familySlug),
    name: `Produit ${familySlug} ${suffix}`,
    slug: `product-${familySlug}-${suffix}`,
    description: 'Description de test',
  });
  return product.id;
}

async function getStandardVariantId(productId: string): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM product_variants WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`,
  );
  if (!rows[0]) throw new Error('Variante Standard absente');
  return rows[0].id;
}

async function countItems(organizationId: string): Promise<number> {
  if (!db) throw new Error('db not initialized');
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryItems)
    .where(eq(inventoryItems.organizationId, organizationId));
  return Number(row?.count ?? 0);
}

describe.skipIf(shouldSkipIntegrationTests())(
  'création en série des exemplaires — PostgreSQL',
  () => {
    it('accepte les huit familles actives et produit des SKU déterministes', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrg('all-families@example.com');

      for (const [index, familySlug] of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.entries()) {
        const productId = await createVariantForOrg(organizationId, familySlug, String(index));
        const variantId = await getStandardVariantId(productId);
        const input = {
          organizationId,
          productVariantId: variantId,
          currentLocationId: locationId,
          count: 2,
          prefix: familySlug,
          idempotencyKey: `active-family-${familySlug}`,
        };

        const first = await createInventoryItemsBatch(db, input);
        const replay = await createInventoryItemsBatch(db, input);

        expect(first).toEqual(replay);
        expect(first.createdCount).toBe(2);
        expect(first.internalSkus).toEqual([
          buildInventoryBatchSku(familySlug, 1, input.idempotencyKey),
          buildInventoryBatchSku(familySlug, 2, input.idempotencyKey),
        ]);
      }

      expect(await countItems(organizationId)).toBe(COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.length * 2);
    });

    it('est tout-ou-rien lorsqu’un SKU du lot entre en conflit', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrg('atomicity@example.com');
      const productId = await createVariantForOrg(organizationId, 'kayak', 'atomicity');
      const variantId = await getStandardVariantId(productId);
      const idempotencyKey = 'atomic-conflict';
      const conflictingSku = buildInventoryBatchSku('KAYAK', 2, idempotencyKey);

      await db.execute(sql`
        INSERT INTO inventory_items (
          organization_id, product_variant_id, internal_sku, current_location_id,
          condition, status
        ) VALUES (
          ${organizationId}, ${variantId}, ${conflictingSku}, ${locationId}, 'NEW', 'ACTIVE'
        )
      `);

      await expect(
        createInventoryItemsBatch(db, {
          organizationId,
          productVariantId: variantId,
          currentLocationId: locationId,
          count: 3,
          prefix: 'KAYAK',
          idempotencyKey,
        }),
      ).rejects.toThrow('SKU généré');

      expect(await countItems(organizationId)).toBe(1);
    });

    it('rejoue sans doublon et rejette la même clé avec des paramètres différents', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrg('replay@example.com');
      const productId = await createVariantForOrg(organizationId, 'surf', 'replay');
      const variantId = await getStandardVariantId(productId);
      const input = {
        organizationId,
        productVariantId: variantId,
        currentLocationId: locationId,
        count: 3,
        prefix: 'SURF',
        idempotencyKey: 'replay-key',
      };

      const first = await createInventoryItemsBatch(db, input);
      const replay = await createInventoryItemsBatch(db, input);
      expect(replay).toEqual(first);
      expect(await countItems(organizationId)).toBe(3);

      await expect(createInventoryItemsBatch(db, { ...input, count: 4 })).rejects.toThrow(
        'paramètres différents',
      );
      expect(await countItems(organizationId)).toBe(3);

      const [idempotency] = await db
        .select({ status: idempotencyRecords.status })
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.key, input.idempotencyKey));
      expect(idempotency?.status).toBe('COMPLETED');
    });

    it('protège le tenant, la variante, l’établissement et la limite existante', async () => {
      if (!db) return;
      const orgA = await createOrg('tenant-a@example.com');
      const orgB = await createOrg('tenant-b@example.com');
      const productId = await createVariantForOrg(orgA.organizationId, 'ski', 'tenant');
      const variantId = await getStandardVariantId(productId);

      await expect(
        createInventoryItemsBatch(db, {
          organizationId: orgB.organizationId,
          productVariantId: variantId,
          currentLocationId: orgB.locationId,
          count: 1,
          idempotencyKey: 'wrong-tenant-variant',
        }),
      ).rejects.toThrow('Variante introuvable');

      await expect(
        createInventoryItemsBatch(db, {
          organizationId: orgA.organizationId,
          productVariantId: variantId,
          currentLocationId: orgB.locationId,
          count: 1,
          idempotencyKey: 'wrong-tenant-location',
        }),
      ).rejects.toThrow('Établissement introuvable');

      await expect(
        createInventoryItemsBatch(db, {
          organizationId: orgA.organizationId,
          productVariantId: variantId,
          currentLocationId: orgA.locationId,
          count: 51,
          idempotencyKey: 'too-many',
        }),
      ).rejects.toThrow('compris entre 1 et 50');

      expect(await countItems(orgA.organizationId)).toBe(0);
      expect(await countItems(orgB.organizationId)).toBe(0);
    });
  },
);
