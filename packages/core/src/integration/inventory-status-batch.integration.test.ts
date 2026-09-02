import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { categories, createDatabase, inventoryMovements } from '@uttily/database';
import {
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  createInventoryItem,
  createLocation,
  createOrganizationForUser,
  createProduct,
  deleteInventoryItem,
  listInventoryItems,
  listVariants,
  provisionUserFromOidc,
  updateInventoryItemsStatusBatch,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('inventory_status_batch');
  if (context) db = createDatabase(context.databaseUrl);
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db) return;
  await db.execute(
    sql`TRUNCATE TABLE idempotency_records, inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('db not initialized');
  return provisionUserFromOidc(db, {
    oidcSubject: `inventory-status-batch-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createOrganization(email: string): Promise<{
  organizationId: string;
  locationId: string;
}> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: `Batch status ${email}`,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, {
    organizationId: organization.id,
    name: 'Établissement principal',
    timeZone: 'Europe/Paris',
  });
  return { organizationId: organization.id, locationId: location.id };
}

async function categoryId(slug: string): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  if (!category) throw new Error(`Catégorie absente: ${slug}`);
  return category.id;
}

async function createItem(
  organizationId: string,
  locationId: string,
  familySlug: string,
  suffix: string,
  status: 'ACTIVE' | 'RETIRED' = 'ACTIVE',
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const product = await createProduct(db, {
    organizationId,
    categoryId: await categoryId(familySlug),
    name: `Produit ${familySlug} ${suffix}`,
    slug: `batch-status-${familySlug}-${suffix}`,
    description: 'Produit de test',
  });
  const [variant] = await listVariants(db, organizationId, product.id);
  if (!variant) throw new Error(`Variante absente: ${familySlug}`);
  const item = await createInventoryItem(db, {
    organizationId,
    productVariantId: variant.id,
    internalSku: `STATUS-${familySlug}-${suffix}`,
    currentLocationId: locationId,
    condition: 'GOOD',
    status,
  });
  return item.id;
}

async function movementCount(itemIds: string[]): Promise<number> {
  if (!db) throw new Error('db not initialized');
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.inventoryItemId, itemIds));
  return Number(rows[0]?.count ?? 0);
}

describe.skipIf(shouldSkipIntegrationTests())(
  'changement groupé de statut des exemplaires — PostgreSQL',
  () => {
    it('accepte les huit familles actives sans toucher à la condition ni aux mouvements', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('all-families@example.com');
      const itemIds: string[] = [];

      for (const [index, familySlug] of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.entries()) {
        itemIds.push(await createItem(organizationId, locationId, familySlug, String(index)));
      }

      const result = await updateInventoryItemsStatusBatch(db, {
        organizationId,
        inventoryItemIds: itemIds,
        status: 'RETIRED',
        idempotencyKey: 'all-active-families-status',
      });

      expect(result).toMatchObject({
        status: 'RETIRED',
        updatedCount: 8,
        noOpCount: 0,
      });
      expect(await movementCount(itemIds)).toBe(0);
      const items = await listInventoryItems(db, organizationId);
      expect(items).toHaveLength(8);
      expect(items.every((item) => item.status === 'RETIRED')).toBe(true);
      expect(items.every((item) => item.condition === 'GOOD')).toBe(true);
    });

    it('est tout-ou-rien lorsqu’un exemplaire est supprimé ou appartient à un autre tenant', async () => {
      if (!db) return;
      const orgA = await createOrganization('tenant-a@example.com');
      const orgB = await createOrganization('tenant-b@example.com');
      const itemA = await createItem(orgA.organizationId, orgA.locationId, 'bike', 'a');
      const deletedItem = await createItem(
        orgA.organizationId,
        orgA.locationId,
        'kayak',
        'deleted',
      );
      const itemB = await createItem(orgB.organizationId, orgB.locationId, 'ski', 'b');

      await deleteInventoryItem(db, orgA.organizationId, deletedItem);
      await expect(
        updateInventoryItemsStatusBatch(db, {
          organizationId: orgA.organizationId,
          inventoryItemIds: [itemA, deletedItem],
          status: 'LOST',
          idempotencyKey: 'deleted-item-status',
        }),
      ).rejects.toThrow('exemplaires sont introuvables');

      await expect(
        updateInventoryItemsStatusBatch(db, {
          organizationId: orgA.organizationId,
          inventoryItemIds: [itemA, itemB],
          status: 'LOST',
          idempotencyKey: 'cross-tenant-status',
        }),
      ).rejects.toThrow('exemplaires sont introuvables');

      const itemsA = await listInventoryItems(db, orgA.organizationId);
      const itemsB = await listInventoryItems(db, orgB.organizationId);
      expect(itemsA.find((item) => item.id === itemA)?.status).toBe('ACTIVE');
      expect(itemsB.find((item) => item.id === itemB)?.status).toBe('ACTIVE');
      expect(await movementCount([itemA, deletedItem, itemB])).toBe(0);
    });

    it('rejoue la même sélection sans effet et rejette un statut ou une sélection différente', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('replay@example.com');
      const first = await createItem(organizationId, locationId, 'surf', 'first');
      const second = await createItem(organizationId, locationId, 'paddleboard', 'second');
      const input = {
        organizationId,
        inventoryItemIds: [first, second],
        status: 'LOST' as const,
        idempotencyKey: 'replay-status',
      };

      const initial = await updateInventoryItemsStatusBatch(db, input);
      const replay = await updateInventoryItemsStatusBatch(db, {
        ...input,
        inventoryItemIds: [second, first],
      });
      expect(replay).toEqual(initial);
      expect(await movementCount([first, second])).toBe(0);

      await expect(
        updateInventoryItemsStatusBatch(db, { ...input, status: 'RETIRED' }),
      ).rejects.toThrow('sélection ou un statut différent');
      await expect(
        updateInventoryItemsStatusBatch(db, {
          ...input,
          inventoryItemIds: [first],
        }),
      ).rejects.toThrow('sélection ou un statut différent');
    });

    it('retourne un no-op explicite quand tous les exemplaires ont déjà le statut demandé', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('noop@example.com');
      const itemIds = [
        await createItem(organizationId, locationId, 'canoe', 'one', 'RETIRED'),
        await createItem(organizationId, locationId, 'pedalboat', 'two', 'RETIRED'),
      ];

      const input = {
        organizationId,
        inventoryItemIds: itemIds,
        status: 'RETIRED' as const,
        idempotencyKey: 'noop-status',
      };
      const result = await updateInventoryItemsStatusBatch(db, input);
      expect(result).toMatchObject({ updatedCount: 0, noOpCount: 2 });
      expect(await updateInventoryItemsStatusBatch(db, input)).toEqual(result);
    });
  },
);
