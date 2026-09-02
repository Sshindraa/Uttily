import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { categories, createDatabase, inventoryMovements } from '@uttily/database';
import {
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  createInventoryItem,
  createLocation,
  createOrganizationForUser,
  createProduct,
  listInventoryItems,
  listVariants,
  provisionUserFromOidc,
  transferInventoryItemsBatch,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';

let context: IntegrationTestContext | null = null;
let db: ReturnType<typeof createDatabase> | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('inventory_transfer_batch');
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
    oidcSubject: `inventory-transfer-batch-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createOrganization(email: string): Promise<{
  organizationId: string;
  sourceLocationId: string;
  destinationLocationId: string;
}> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: `Batch transfer ${email}`,
    defaultCurrency: 'EUR',
  });
  const source = await createLocation(db, {
    organizationId: organization.id,
    name: 'Établissement source',
    timeZone: 'Europe/Paris',
  });
  const destination = await createLocation(db, {
    organizationId: organization.id,
    name: 'Établissement cible',
    timeZone: 'Europe/Paris',
  });
  return {
    organizationId: organization.id,
    sourceLocationId: source.id,
    destinationLocationId: destination.id,
  };
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
): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const product = await createProduct(db, {
    organizationId,
    categoryId: await categoryId(familySlug),
    name: `Produit ${familySlug} ${suffix}`,
    slug: `batch-transfer-${familySlug}-${suffix}`,
    description: 'Produit de test',
  });
  const [variant] = await listVariants(db, organizationId, product.id);
  if (!variant) throw new Error(`Variante absente: ${familySlug}`);
  const item = await createInventoryItem(db, {
    organizationId,
    productVariantId: variant.id,
    internalSku: `TRANSFER-${familySlug}-${suffix}`,
    currentLocationId: locationId,
    condition: 'GOOD',
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

describe.skipIf(shouldSkipIntegrationTests())('transfert groupé d’exemplaires — PostgreSQL', () => {
  it('transfère les exemplaires des huit familles actives', async () => {
    if (!db) return;
    const { organizationId, sourceLocationId, destinationLocationId } = await createOrganization(
      'all-families@example.com',
    );
    const itemIds: string[] = [];

    for (const [index, familySlug] of COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.entries()) {
      itemIds.push(await createItem(organizationId, sourceLocationId, familySlug, String(index)));
    }

    const result = await transferInventoryItemsBatch(db, {
      organizationId,
      inventoryItemIds: itemIds,
      toLocationId: destinationLocationId,
      idempotencyKey: 'all-active-families-transfer',
    });

    expect(result.transferredCount).toBe(8);
    expect(result.noOpCount).toBe(0);
    expect(result.movementIds).toHaveLength(8);
    expect(await movementCount(itemIds)).toBe(8);

    const items = await listInventoryItems(db, organizationId);
    expect(items).toHaveLength(8);
    expect(items.every((item) => item.currentLocationId === destinationLocationId)).toBe(true);
    expect(items.every((item) => item.condition === 'GOOD' && item.status === 'ACTIVE')).toBe(true);
  });

  it('est tout-ou-rien lorsqu’un mouvement entre en conflit avant l’écriture', async () => {
    if (!db) return;
    const { organizationId, sourceLocationId, destinationLocationId } =
      await createOrganization('atomic@example.com');
    const firstItemId = await createItem(organizationId, sourceLocationId, 'kayak', 'first');
    const secondItemId = await createItem(organizationId, sourceLocationId, 'surf', 'second');
    const itemIds = [firstItemId, secondItemId];
    const idempotencyKey = 'atomic-transfer-conflict';

    await db.insert(inventoryMovements).values({
      inventoryItemId: firstItemId,
      fromLocationId: sourceLocationId,
      toLocationId: destinationLocationId,
      reason: 'Mouvement existant',
      idempotencyKey,
    });

    await expect(
      transferInventoryItemsBatch(db, {
        organizationId,
        inventoryItemIds: itemIds,
        toLocationId: destinationLocationId,
        idempotencyKey,
      }),
    ).rejects.toThrow("clé d'idempotence");

    const items = await listInventoryItems(db, organizationId);
    expect(items.every((item) => item.currentLocationId === sourceLocationId)).toBe(true);
    expect(await movementCount(itemIds)).toBe(1);
  });

  it('rejoue l’opération sans doubler les mouvements et rejette un autre destinataire', async () => {
    if (!db) return;
    const { organizationId, sourceLocationId, destinationLocationId } =
      await createOrganization('replay@example.com');
    const itemIds = [
      await createItem(organizationId, sourceLocationId, 'paddleboard', 'one'),
      await createItem(organizationId, sourceLocationId, 'snowboard', 'two'),
    ];
    const input = {
      organizationId,
      inventoryItemIds: itemIds,
      toLocationId: destinationLocationId,
      idempotencyKey: 'replay-transfer',
    };

    const first = await transferInventoryItemsBatch(db, input);
    const replay = await transferInventoryItemsBatch(db, input);
    expect(replay).toEqual(first);
    expect(await movementCount(itemIds)).toBe(2);

    const otherLocation = await createLocation(db, {
      organizationId,
      name: 'Troisième établissement',
      timeZone: 'Europe/Paris',
    });
    await expect(
      transferInventoryItemsBatch(db, { ...input, toLocationId: otherLocation.id }),
    ).rejects.toThrow('paramètres différents');
    expect(await movementCount(itemIds)).toBe(2);
  });

  it('refuse une destination ou des exemplaires d’un autre tenant', async () => {
    if (!db) return;
    const orgA = await createOrganization('tenant-a@example.com');
    const orgB = await createOrganization('tenant-b@example.com');
    const itemA = await createItem(orgA.organizationId, orgA.sourceLocationId, 'bike', 'a');
    const itemB = await createItem(orgB.organizationId, orgB.sourceLocationId, 'ski', 'b');

    await expect(
      transferInventoryItemsBatch(db, {
        organizationId: orgA.organizationId,
        inventoryItemIds: [itemA],
        toLocationId: orgB.destinationLocationId,
        idempotencyKey: 'wrong-destination-tenant',
      }),
    ).rejects.toThrow('Établissement de destination introuvable');

    await expect(
      transferInventoryItemsBatch(db, {
        organizationId: orgA.organizationId,
        inventoryItemIds: [itemA, itemB],
        toLocationId: orgA.destinationLocationId,
        idempotencyKey: 'wrong-item-tenant',
      }),
    ).rejects.toThrow('exemplaires sont introuvables');

    const itemsA = await listInventoryItems(db, orgA.organizationId);
    const itemsB = await listInventoryItems(db, orgB.organizationId);
    expect(itemsA[0]?.currentLocationId).toBe(orgA.sourceLocationId);
    expect(itemsB[0]?.currentLocationId).toBe(orgB.sourceLocationId);
    expect(await movementCount([itemA, itemB])).toBe(0);
  });

  it('retourne un no-op explicite sans créer de mouvement', async () => {
    if (!db) return;
    const { organizationId, destinationLocationId } = await createOrganization('noop@example.com');
    const itemIds = [
      await createItem(organizationId, destinationLocationId, 'canoe', 'one'),
      await createItem(organizationId, destinationLocationId, 'pedalboat', 'two'),
    ];
    const input = {
      organizationId,
      inventoryItemIds: itemIds,
      toLocationId: destinationLocationId,
      idempotencyKey: 'noop-transfer',
    };

    const result = await transferInventoryItemsBatch(db, input);
    expect(result.transferredCount).toBe(0);
    expect(result.noOpCount).toBe(2);
    expect(result.movementIds).toEqual([]);
    expect(await movementCount(itemIds)).toBe(0);
    expect(await transferInventoryItemsBatch(db, input)).toEqual(result);
  });
});
