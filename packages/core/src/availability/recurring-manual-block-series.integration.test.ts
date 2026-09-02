import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  createDatabase,
  inventoryBlocks,
  manualBlockSeries,
  manualBlockSeriesOccurrences,
} from '@uttily/database';
import {
  createInventoryItem,
  createLocation,
  createManualBlock,
  createOrganizationForUser,
  createProduct,
  createRecurringManualBlockSeries,
  deleteRecurringManualBlockSeries,
  listVariants,
  provisionUserFromOidc,
  releaseRecurringManualBlockOccurrence,
  resumeRecurringManualBlockSeries,
  suspendRecurringManualBlockSeries,
  updateRecurringManualBlockSeries,
  type AuthenticatedUser,
} from '../index';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';

const isCi = process.env.CI === '1' || process.env.CI === 'true';
let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;

beforeAll(async () => {
  context = await setupIntegrationTestDb('recurring_manual_blocks');
  if (context) db = createDatabase(context.databaseUrl);
  else if (isCi) throw new Error("CI: la base d'intégration est requise.");
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
    sql`TRUNCATE TABLE manual_block_series_occurrences, manual_block_series, inventory_blocks, idempotency_records, inventory_items, product_variants, products, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
});

async function createUser(email: string): Promise<AuthenticatedUser> {
  if (!db) throw new Error('db not initialized');
  return provisionUserFromOidc(db, {
    oidcSubject: `recurring-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
}

async function createSetup(
  email: string,
  name: string,
  timeZone = 'Europe/Paris',
): Promise<{
  organizationId: string;
  locationId: string;
  itemId: string;
  user: AuthenticatedUser;
}> {
  if (!db) throw new Error('db not initialized');
  const user = await createUser(email);
  const { organization } = await createOrganizationForUser(db, user, {
    legalName: name,
    defaultCurrency: 'EUR',
  });
  const location = await createLocation(db, { organizationId: organization.id, name, timeZone });
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, 'kayak'))
    .limit(1);
  if (!category) throw new Error('category kayak missing');
  const product = await createProduct(db, {
    organizationId: organization.id,
    categoryId: category.id,
    name: `Kayak ${name}`,
  });
  const [variant] = await listVariants(db, organization.id, product.id);
  if (!variant) throw new Error('variant missing');
  const item = await createInventoryItem(db, {
    organizationId: organization.id,
    productVariantId: variant.id,
    internalSku: `REC-${name.replace(/[^A-Z]/gi, '').toUpperCase()}`,
    currentLocationId: location.id,
  });
  return { organizationId: organization.id, locationId: location.id, itemId: item.id, user };
}

function schedule(overrides: Partial<Parameters<typeof createRecurringManualBlockSeries>[1]> = {}) {
  return {
    organizationId: '00000000-0000-0000-0000-000000000001',
    inventoryItemId: '00000000-0000-0000-0000-000000000002',
    locationId: '00000000-0000-0000-0000-000000000003',
    frequency: 'WEEKLY' as const,
    startDate: '2030-01-07',
    endDate: '2030-01-21',
    startTime: '10:00',
    endTime: '12:00',
    timeZone: 'Europe/Paris',
    idempotencyKey: 'recurring-series-key',
    ...overrides,
  };
}

describe.skipIf(shouldSkipIntegrationTests())('blocages manuels récurrents — PostgreSQL', () => {
  it('matérialise atomiquement une série, puis rejoue sans doublon', async () => {
    if (!db) return;
    const setup = await createSetup('recurring-create@example.com', 'Recurring Create');
    const input = schedule({
      organizationId: setup.organizationId,
      inventoryItemId: setup.itemId,
      locationId: setup.locationId,
      actorUserId: setup.user.id,
    });

    const first = await createRecurringManualBlockSeries(db, input);
    const replay = await createRecurringManualBlockSeries(db, input);
    expect(replay).toEqual(first);
    expect(first.occurrenceCount).toBe(3);

    const seriesRows = await db
      .select()
      .from(manualBlockSeries)
      .where(eq(manualBlockSeries.organizationId, setup.organizationId));
    const occurrenceRows = await db
      .select()
      .from(manualBlockSeriesOccurrences)
      .where(eq(manualBlockSeriesOccurrences.seriesId, first.seriesId));
    const blockRows = await db
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.organizationId, setup.organizationId));
    expect(seriesRows).toHaveLength(1);
    expect(occurrenceRows).toHaveLength(3);
    expect(blockRows).toHaveLength(3);
    expect(
      blockRows.every((block) => block.type === 'MANUAL_BLOCK' && block.expiresAt === null),
    ).toBe(true);
  });

  it('annule toute la transaction lorsqu’une occurrence entre en conflit', async () => {
    if (!db) return;
    const setup = await createSetup('recurring-conflict@example.com', 'Recurring Conflict');
    await createManualBlock(db, {
      organizationId: setup.organizationId,
      inventoryItemId: setup.itemId,
      locationId: setup.locationId,
      startAt: '2030-01-14T10:30',
      endAt: '2030-01-14T11:30',
      idempotencyKey: 'existing-conflict-block',
    });

    await expect(
      createRecurringManualBlockSeries(
        db,
        schedule({
          organizationId: setup.organizationId,
          inventoryItemId: setup.itemId,
          locationId: setup.locationId,
          idempotencyKey: 'series-conflict-key',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_BLOCK' });

    const seriesRows = await db
      .select()
      .from(manualBlockSeries)
      .where(eq(manualBlockSeries.organizationId, setup.organizationId));
    const blockRows = await db
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.organizationId, setup.organizationId));
    expect(seriesRows).toHaveLength(0);
    expect(blockRows).toHaveLength(1);
  });

  it('isole le tenant et sérialise deux créations concurrentes', async () => {
    if (!db) return;
    const first = await createSetup('recurring-tenant-a@example.com', 'Tenant A');
    const second = await createSetup('recurring-tenant-b@example.com', 'Tenant B');
    await expect(
      createRecurringManualBlockSeries(
        db,
        schedule({
          organizationId: first.organizationId,
          inventoryItemId: second.itemId,
          locationId: second.locationId,
          idempotencyKey: 'cross-tenant-key',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Recrée une seule organisation de données pour tester la concurrence sur le même item.
    await db.execute(
      sql`TRUNCATE TABLE manual_block_series_occurrences, manual_block_series, inventory_blocks, idempotency_records, inventory_items, product_variants, products, locations, organization_memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const concurrentSetup = await createSetup('recurring-concurrent@example.com', 'Concurrent');
    const baseInput = schedule({
      organizationId: concurrentSetup.organizationId,
      inventoryItemId: concurrentSetup.itemId,
      locationId: concurrentSetup.locationId,
    });
    const [left, right] = await Promise.all([
      createRecurringManualBlockSeries(db, baseInput),
      createRecurringManualBlockSeries(db, baseInput),
    ]);
    expect(left.seriesId).toBe(right.seriesId);
    const concurrentSeries = await db
      .select()
      .from(manualBlockSeries)
      .where(eq(manualBlockSeries.organizationId, concurrentSetup.organizationId));
    expect(concurrentSeries).toHaveLength(1);
  });

  it('modifie uniquement les occurrences futures, puis suspend, libère et supprime explicitement', async () => {
    if (!db) return;
    const setup = await createSetup('recurring-lifecycle@example.com', 'Lifecycle');
    const created = await createRecurringManualBlockSeries(
      db,
      schedule({
        organizationId: setup.organizationId,
        inventoryItemId: setup.itemId,
        locationId: setup.locationId,
        startDate: '2030-02-04',
        endDate: '2030-02-18',
        idempotencyKey: 'lifecycle-create',
      }),
    );
    const before = await db
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.organizationId, setup.organizationId));
    const pastBlock = before.find((block) =>
      block.blockedStartAt.toISOString().startsWith('2030-02-04'),
    );
    expect(pastBlock).toBeDefined();

    const updated = await updateRecurringManualBlockSeries(
      db,
      {
        organizationId: setup.organizationId,
        seriesId: created.seriesId,
        startTime: '11:00',
        endTime: '13:00',
        idempotencyKey: 'lifecycle-update',
      },
      { now: new Date('2030-02-10T00:00:00.000Z') },
    );
    expect(updated.updatedOccurrenceIds).toHaveLength(2);
    const afterUpdate = await db
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.organizationId, setup.organizationId));
    expect(
      afterUpdate.find((block) => block.id === pastBlock!.id)!.blockedStartAt.toISOString(),
    ).toBe(pastBlock!.blockedStartAt.toISOString());
    expect(
      afterUpdate
        .filter((block) => block.id !== pastBlock!.id)
        .every((block) => block.blockedStartAt.toISOString().includes('10:00:00.000Z')),
    ).toBe(true);

    const suspended = await suspendRecurringManualBlockSeries(db, {
      organizationId: setup.organizationId,
      seriesId: created.seriesId,
      idempotencyKey: 'lifecycle-suspend',
    });
    expect(suspended.status).toBe('SUSPENDED');
    const releasedOccurrenceId = created.createdOccurrenceIds[0]!;
    await releaseRecurringManualBlockOccurrence(db, {
      organizationId: setup.organizationId,
      seriesId: created.seriesId,
      occurrenceId: releasedOccurrenceId,
      idempotencyKey: 'lifecycle-release-occurrence',
    });
    const deleted = await deleteRecurringManualBlockSeries(db, {
      organizationId: setup.organizationId,
      seriesId: created.seriesId,
      idempotencyKey: 'lifecycle-delete',
    });
    expect(deleted.status).toBe('DELETED');
    const persistedBlocks = await db
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.organizationId, setup.organizationId));
    expect(persistedBlocks.some((block) => block.status === 'RELEASED')).toBe(true);
    expect(persistedBlocks.some((block) => block.status === 'ACTIVE')).toBe(true);
  });

  it('reprend une série suspendue sans libérer son audit', async () => {
    if (!db) return;
    const setup = await createSetup('recurring-resume@example.com', 'Resume');
    const created = await createRecurringManualBlockSeries(
      db,
      schedule({
        organizationId: setup.organizationId,
        inventoryItemId: setup.itemId,
        locationId: setup.locationId,
        startDate: '2030-03-04',
        endDate: '2030-03-11',
        idempotencyKey: 'resume-create',
      }),
    );
    await suspendRecurringManualBlockSeries(db, {
      organizationId: setup.organizationId,
      seriesId: created.seriesId,
      idempotencyKey: 'resume-suspend',
    });
    await updateRecurringManualBlockSeries(db, {
      organizationId: setup.organizationId,
      seriesId: created.seriesId,
      endDate: '2030-03-25',
      idempotencyKey: 'resume-extend',
    });
    const resumed = await resumeRecurringManualBlockSeries(
      db,
      {
        organizationId: setup.organizationId,
        seriesId: created.seriesId,
        idempotencyKey: 'resume-resume',
      },
      { now: new Date('2030-03-01T00:00:00.000Z') },
    );
    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.createdOccurrenceIds).toHaveLength(2);
  });
});
