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
  updateInventoryItemsConditionBatch,
  type AuthenticatedUser,
  type InventoryCondition,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('inventory_condition_batch');
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
    oidcSubject: `inventory-condition-batch-${email}`,
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
    legalName: `Batch condition ${email}`,
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
  condition: InventoryCondition = 'GOOD',
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const product = await createProduct(db, {
    organizationId,
    categoryId: await categoryId(familySlug),
    name: `Produit ${familySlug} ${suffix}`,
    slug: `batch-condition-${familySlug}-${suffix}`,
    description: 'Produit de test',
  });
  const [variant] = await listVariants(db, organizationId, product.id);
  if (!variant) throw new Error(`Variante absente: ${familySlug}`);
  const item = await createInventoryItem(db, {
    organizationId,
    productVariantId: variant.id,
    internalSku: `CONDITION-${familySlug}-${suffix}`,
    currentLocationId: locationId,
    condition,
    status: 'ACTIVE',
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
  'mise à jour groupée de l’état physique — PostgreSQL',
  () => {
    it('accepte les huit familles sans toucher au statut, au lieu ni aux mouvements', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('all-families@example.com');
      const itemIds: string[] = [];

      for (const [index, familySlug] of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.entries()) {
        itemIds.push(await createItem(organizationId, locationId, familySlug, String(index)));
      }

      const result = await updateInventoryItemsConditionBatch(db, {
        organizationId,
        inventoryItemIds: itemIds,
        condition: 'FAIR',
        idempotencyKey: 'all-active-families-condition',
      });

      expect(result).toMatchObject({
        condition: 'FAIR',
        updatedCount: 8,
        noOpCount: 0,
      });
      expect(await movementCount(itemIds)).toBe(0);
      const items = await listInventoryItems(db, organizationId);
      expect(items).toHaveLength(8);
      expect(items.every((item) => item.condition === 'FAIR')).toBe(true);
      expect(items.every((item) => item.status === 'ACTIVE')).toBe(true);
      expect(items.every((item) => item.currentLocationId === locationId)).toBe(true);
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
        updateInventoryItemsConditionBatch(db, {
          organizationId: orgA.organizationId,
          inventoryItemIds: [itemA, deletedItem],
          condition: 'BROKEN',
          idempotencyKey: 'deleted-item-condition',
        }),
      ).rejects.toThrow('exemplaires sont introuvables');

      await expect(
        updateInventoryItemsConditionBatch(db, {
          organizationId: orgA.organizationId,
          inventoryItemIds: [itemA, itemB],
          condition: 'POOR',
          idempotencyKey: 'cross-tenant-condition',
        }),
      ).rejects.toThrow('exemplaires sont introuvables');

      const itemsA = await listInventoryItems(db, orgA.organizationId);
      const itemsB = await listInventoryItems(db, orgB.organizationId);
      expect(itemsA.find((item) => item.id === itemA)?.condition).toBe('GOOD');
      expect(itemsB.find((item) => item.id === itemB)?.condition).toBe('GOOD');
      expect(await movementCount([itemA, deletedItem, itemB])).toBe(0);
    });

    it('rejoue la même sélection sans effet et rejette un état ou une sélection différente', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('replay@example.com');
      const first = await createItem(organizationId, locationId, 'surf', 'first');
      const second = await createItem(organizationId, locationId, 'paddleboard', 'second');
      const input = {
        organizationId,
        inventoryItemIds: [first, second],
        condition: 'POOR' as const,
        idempotencyKey: 'replay-condition',
      };

      const initial = await updateInventoryItemsConditionBatch(db, input);
      const replay = await updateInventoryItemsConditionBatch(db, {
        ...input,
        inventoryItemIds: [second, first],
      });
      expect(replay).toEqual(initial);
      expect(await movementCount([first, second])).toBe(0);

      await expect(
        updateInventoryItemsConditionBatch(db, { ...input, condition: 'BROKEN' }),
      ).rejects.toThrow('sélection ou un état différent');
      await expect(
        updateInventoryItemsConditionBatch(db, {
          ...input,
          inventoryItemIds: [first],
        }),
      ).rejects.toThrow('sélection ou un état différent');
    });

    it('retourne un no-op explicite quand tous les exemplaires ont déjà l’état demandé', async () => {
      if (!db) return;
      const { organizationId, locationId } = await createOrganization('noop@example.com');
      const itemIds = [
        await createItem(organizationId, locationId, 'canoe', 'one', 'BROKEN'),
        await createItem(organizationId, locationId, 'pedalboat', 'two', 'BROKEN'),
      ];

      const input = {
        organizationId,
        inventoryItemIds: itemIds,
        condition: 'BROKEN' as const,
        idempotencyKey: 'noop-condition',
      };
      const result = await updateInventoryItemsConditionBatch(db, input);
      expect(result).toMatchObject({ updatedCount: 0, noOpCount: 2 });
      expect(await updateInventoryItemsConditionBatch(db, input)).toEqual(result);
    });
  },
);
