import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { categories, createDatabase } from '@uttily/database';
import {
  COMMERCIAL_EQUIPMENT_FAMILY_SLUGS,
  createInventoryItem,
  createLocation,
  createManualBlock,
  createOrganizationForUser,
  createProduct,
  getOperationalPlanning,
  listVariants,
  provisionUserFromOidc,
  releaseManualBlock,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('planning_manual_blocks');
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
  if (!db) return;
  await db.execute(
    sql`TRUNCATE TABLE inventory_blocks, inventory_movements, inventory_items, product_variants, products, location_opening_hours, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
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

async function createOrganizationWithLocation(
  email: string,
  timeZone: string,
  name: string,
): Promise<{ organizationId: string; location: { id: string; name: string; timeZone: string } }> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: name,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, {
    organizationId: organization.id,
    name,
    timeZone,
  });
  return { organizationId: organization.id, location };
}

async function createItem(
  organizationId: string,
  locationId: string,
  categorySlug: string,
  sku: string,
) {
  if (!db) throw new Error('db not initialized');
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, categorySlug))
    .limit(1);
  if (!category) throw new Error(`Catégorie seed "${categorySlug}" introuvable.`);

  const product = await createProduct(db, {
    organizationId,
    categoryId: category.id,
    name: `Produit ${categorySlug} ${sku}`,
    description: 'Produit de test planning',
  });
  const variants = await listVariants(db, organizationId, product.id);
  const variant = variants[0];
  if (!variant) throw new Error(`Variante absente pour ${categorySlug}.`);

  return createInventoryItem(db, {
    organizationId,
    productVariantId: variant.id,
    internalSku: sku,
    currentLocationId: locationId,
  });
}

describe.skipIf(shouldSkipIntegrationTests())('Planning — visibilité des blocages manuels', () => {
  it('filtre par établissement/exemplaire, convertit le fuseau, tronque et masque un bloc libéré', async () => {
    if (!db) return;
    const first = await createOrganizationWithLocation(
      'planning-paris@example.com',
      'Europe/Paris',
      'Paris',
    );
    const secondLocation = await createLocation(db, {
      organizationId: first.organizationId,
      name: 'New York',
      timeZone: 'America/New_York',
    });
    const parisItem = await createItem(first.organizationId, first.location.id, 'kayak', 'PLAN-PARIS');
    const newYorkItem = await createItem(
      first.organizationId,
      secondLocation.id,
      'canoe',
      'PLAN-NY',
    );

    const from = new Date('2026-08-03T00:00:00.000Z');
    const to = new Date('2026-08-03T02:00:00.000Z');
    const parisBlock = await createManualBlock(db, {
      organizationId: first.organizationId,
      inventoryItemId: parisItem.id,
      locationId: first.location.id,
      startAt: '2026-08-03T01:30',
      endAt: '2026-08-03T04:30',
      idempotencyKey: 'planning-paris-block',
    });
    await createManualBlock(db, {
      organizationId: first.organizationId,
      inventoryItemId: newYorkItem.id,
      locationId: secondLocation.id,
      startAt: '2026-08-02T20:00',
      endAt: '2026-08-03T00:30',
      idempotencyKey: 'planning-new-york-block',
    });

    const parisPlanning = await getOperationalPlanning(db, first.organizationId, {
      locationId: first.location.id,
      inventoryItemId: parisItem.id,
      from,
      to,
    });
    const parisEvents = parisPlanning.events.filter((event) => event.type === 'MANUAL_BLOCK');
    expect(parisEvents).toHaveLength(1);
    expect(parisEvents[0]).toMatchObject({
      id: `manual_block_${parisBlock.blockId}`,
      manualBlockId: parisBlock.blockId,
      inventoryItemId: parisItem.id,
      categorySlug: 'kayak',
      locationId: first.location.id,
      locationTimeZone: 'Europe/Paris',
      startAt: from,
      endAt: to,
      status: 'ACTIVE',
    });
    expect(parisPlanning.stats).toMatchObject({
      totalRentals: 0,
      totalMaintenances: 0,
      totalManualBlocks: 1,
    });

    const wrongItemPlanning = await getOperationalPlanning(db, first.organizationId, {
      locationId: first.location.id,
      inventoryItemId: newYorkItem.id,
      from,
      to,
    });
    expect(wrongItemPlanning.events.filter((event) => event.type === 'MANUAL_BLOCK')).toHaveLength(0);

    const newYorkPlanning = await getOperationalPlanning(db, first.organizationId, {
      locationId: secondLocation.id,
      inventoryItemId: newYorkItem.id,
      from,
      to,
    });
    expect(newYorkPlanning.events.filter((event) => event.type === 'MANUAL_BLOCK')).toHaveLength(1);
    expect(newYorkPlanning.locationTimeZone).toBe('America/New_York');

    await releaseManualBlock(db, first.organizationId, parisBlock.blockId);
    const afterRelease = await getOperationalPlanning(db, first.organizationId, {
      locationId: first.location.id,
      inventoryItemId: parisItem.id,
      from,
      to,
    });
    expect(afterRelease.events.filter((event) => event.type === 'MANUAL_BLOCK')).toHaveLength(0);
    expect(afterRelease.stats.totalManualBlocks).toBe(0);
  });

  it('expose les blocages actifs pour les huit familles commerciales sans modifier les compteurs existants', async () => {
    if (!db) return;
    const setup = await createOrganizationWithLocation(
      'planning-eight-families@example.com',
      'Europe/Paris',
      'Familles',
    );
    const slugs = [...COMMERCIAL_EQUIPMENT_FAMILY_SLUGS];
    const from = new Date('2026-09-07T00:00:00.000Z');
    const to = new Date('2026-09-08T00:00:00.000Z');

    for (const [index, categorySlug] of slugs.entries()) {
      const item = await createItem(
        setup.organizationId,
        setup.location.id,
        categorySlug,
        `PLAN-${String(index + 1).padStart(2, '0')}`,
      );
      await createManualBlock(db, {
        organizationId: setup.organizationId,
        inventoryItemId: item.id,
        locationId: setup.location.id,
        startAt: '2026-09-07T10:00',
        endAt: '2026-09-07T12:00',
        idempotencyKey: `planning-family-${categorySlug}`,
      });
    }

    const planning = await getOperationalPlanning(db, setup.organizationId, {
      locationId: setup.location.id,
      from,
      to,
    });
    const manualEvents = planning.events.filter((event) => event.type === 'MANUAL_BLOCK');
    expect(manualEvents).toHaveLength(8);
    expect(new Set(manualEvents.map((event) => event.categorySlug))).toEqual(new Set(slugs));
    expect(planning.stats).toMatchObject({
      totalRentals: 0,
      totalPickups: 0,
      totalReturns: 0,
      totalMaintenances: 0,
      totalManualBlocks: 8,
    });
  });
});
