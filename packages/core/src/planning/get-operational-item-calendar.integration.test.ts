import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { categories, createDatabase } from '@uttily/database';
import {
  createInventoryBlock,
  createInventoryItem,
  createLocation,
  createOrganizationForUser,
  createProduct,
  getOperationalItemCalendar,
  listVariants,
  provisionUserFromOidc,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('item_calendar');
  if (context) db = createDatabase(context.databaseUrl);
});

afterAll(async () => {
  if (db) await db.$client.end();
  db = null;
  if (context) await context.cleanup();
  context = null;
});

beforeEach(async () => {
  if (!db) return;
  await db.execute(
    sql`TRUNCATE TABLE manual_block_series_occurrences, manual_block_series, inventory_blocks, inventory_movements, inventory_items, product_variants, products, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('database unavailable');
  return provisionUserFromOidc(db, {
    oidcSubject: `calendar-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createItem(
  organizationId: string,
  locationId: string,
  sku: string,
): Promise<{ id: string; locationId: string }> {
  if (!db) throw new Error('database unavailable');
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, 'kayak'))
    .limit(1);
  if (!category) throw new Error('kayak category missing');
  const product = await createProduct(db, {
    organizationId,
    categoryId: category.id,
    name: `Kayak ${sku}`,
    description: 'Calendrier test',
  });
  const variants = await listVariants(db, organizationId, product.id);
  const variant = variants[0];
  if (!variant) throw new Error('variant missing');
  const item = await createInventoryItem(db, {
    organizationId,
    productVariantId: variant.id,
    internalSku: sku,
    currentLocationId: locationId,
  });
  return { id: item.id, locationId };
}

describe.skipIf(shouldSkipIntegrationTests())('getOperationalItemCalendar — PostgreSQL', () => {
  it('filtre tenant/item/établissement et tronque les holds', async () => {
    if (!db) return;
    const user = await createUser('calendar-owner@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Calendar Org',
      defaultCurrency: 'EUR',
    });
    const paris = await createLocation(db, {
      organizationId: organization.id,
      name: 'Paris',
      timeZone: 'Europe/Paris',
    });
    const lyon = await createLocation(db, {
      organizationId: organization.id,
      name: 'Lyon',
      timeZone: 'Europe/Paris',
    });
    const parisItem = await createItem(organization.id, paris.id, 'CAL-PARIS');
    const lyonItem = await createItem(organization.id, lyon.id, 'CAL-LYON');
    const from = new Date('2031-10-24T10:00:00.000Z');
    const to = new Date('2031-10-24T12:00:00.000Z');

    const hold = await createInventoryBlock(db, {
      organizationId: organization.id,
      inventoryItemId: parisItem.id,
      type: 'HOLD',
      customerStartAt: new Date('2031-10-24T10:30:00.000Z'),
      customerEndAt: new Date('2031-10-24T11:30:00.000Z'),
      blockedStartAt: new Date('2031-10-24T09:00:00.000Z'),
      blockedEndAt: new Date('2031-10-24T13:00:00.000Z'),
      expiresAt: new Date('2031-10-24T10:45:00.000Z'),
    });
    await createInventoryBlock(db, {
      organizationId: organization.id,
      inventoryItemId: lyonItem.id,
      type: 'HOLD',
      customerStartAt: from,
      customerEndAt: to,
      blockedStartAt: from,
      blockedEndAt: to,
      expiresAt: new Date('2031-10-24T10:30:00.000Z'),
    });

    const calendar = await getOperationalItemCalendar(db, organization.id, parisItem.id, {
      locationId: paris.id,
      from,
      to,
    });
    expect(calendar).not.toBeNull();
    expect(calendar).toMatchObject({
      locationId: paris.id,
      locationTimeZone: 'Europe/Paris',
      item: { id: parisItem.id, locationId: paris.id },
    });
    expect(calendar!.events).toHaveLength(1);
    expect(calendar!.events[0]).toMatchObject({
      type: 'HOLD',
      holdId: hold.id,
      inventoryItemId: parisItem.id,
      startAt: from,
      endAt: to,
      holdExpiresAt: new Date('2031-10-24T10:45:00.000Z'),
    });

    await expect(
      getOperationalItemCalendar(db, organization.id, parisItem.id, {
        locationId: lyon.id,
        from,
        to,
      }),
    ).resolves.toBeNull();
  });

  it('ne révèle pas un exemplaire d’une autre organisation', async () => {
    if (!db) return;
    const firstUser = await createUser('calendar-first@example.com');
    const secondUser = await createUser('calendar-second@example.com');
    const first = await createOrganizationForUser(db, firstUser, {
      legalName: 'First Calendar Org',
      defaultCurrency: 'EUR',
    });
    const second = await createOrganizationForUser(db, secondUser, {
      legalName: 'Second Calendar Org',
      defaultCurrency: 'EUR',
    });
    const firstLocation = await createLocation(db, {
      organizationId: first.organization.id,
      name: 'First',
      timeZone: 'UTC',
    });
    const secondLocation = await createLocation(db, {
      organizationId: second.organization.id,
      name: 'Second',
      timeZone: 'UTC',
    });
    const foreignItem = await createItem(second.organization.id, secondLocation.id, 'CAL-FOREIGN');

    await expect(
      getOperationalItemCalendar(db, first.organization.id, foreignItem.id, {
        locationId: firstLocation.id,
        from: new Date('2031-10-24T00:00:00.000Z'),
        to: new Date('2031-10-25T00:00:00.000Z'),
      }),
    ).resolves.toBeNull();
  });
});
