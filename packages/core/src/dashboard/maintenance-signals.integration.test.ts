import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { listMaintenanceDashboardSignals } from './maintenance-signals';
import type { MaintenanceDashboardMaintenanceSignal } from './types';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;
let seedCounter = 0;

interface OrganizationFixture {
  organizationId: string;
  locationId: string;
  productId: string;
  variantId: string;
}

interface ItemFixture {
  inventoryItemId: string;
}

const asOf = new Date('2026-08-09T12:00:00.000Z');
const hour = 60 * 60 * 1000;

beforeAll(async () => {
  context = await setupIntegrationTestDb('g7g_maintenance_dashboard');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
  }
});

afterAll(async () => {
  if (db) await db.$client.end();
  if (rawSql) await rawSql.end();
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db) return;
  await db.execute(
    sql`TRUNCATE TABLE
      inventory_blocks,
      inventory_items,
      product_variants,
      products,
      locations,
      organizations
      RESTART IDENTITY CASCADE`,
  );
});

async function seedOrganization(timeZone: string, label: string): Promise<OrganizationFixture> {
  if (!rawSql) throw new Error('rawSql absent');
  const suffix = `${Date.now().toString(36)}-${seedCounter++}`;
  const organization = await rawSql`
    INSERT INTO organizations (legal_name, slug, default_currency)
    VALUES (${`${label} ${suffix}`}, ${`${label.toLowerCase().replaceAll(' ', '-')}-${suffix}`}, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await rawSql`
    INSERT INTO locations (
      organization_id, name, slug, time_zone, operating_currency
    )
    VALUES (
      ${organization.id}, ${`${label} Location`}, ${`location-${suffix}`}, ${timeZone}, 'EUR'
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const category = await rawSql`
    SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1
  `.then((rows) => rows[0]!);
  const product = await rawSql`
    INSERT INTO products (organization_id, category_id, name, slug)
    VALUES (
      ${organization.id}, ${category.id}, ${`${label} Product`}, ${`product-${suffix}`}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  const variant = await rawSql`
    INSERT INTO product_variants (product_id, name, is_active, currency)
    VALUES (${product.id}, 'Standard', true, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);

  return {
    organizationId: String(organization.id),
    locationId: String(location.id),
    productId: String(product.id),
    variantId: String(variant.id),
  };
}

async function seedItem(
  organization: OrganizationFixture,
  internalSku: string,
  options?: {
    condition?: 'NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'BROKEN';
    status?: 'ACTIVE' | 'RETIRED' | 'LOST';
    deletedAt?: Date | null;
  },
): Promise<ItemFixture> {
  if (!rawSql) throw new Error('rawSql absent');
  const item = await rawSql`
    INSERT INTO inventory_items (
      organization_id, product_variant_id, internal_sku,
      current_location_id, condition, status, deleted_at
    )
    VALUES (
      ${organization.organizationId}, ${organization.variantId}, ${internalSku},
      ${organization.locationId}, ${options?.condition ?? 'GOOD'},
      ${options?.status ?? 'ACTIVE'}, ${options?.deletedAt ?? null}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  return { inventoryItemId: String(item.id) };
}

async function seedMaintenanceBlock(
  organization: OrganizationFixture,
  item: ItemFixture,
  input: {
    blockedStartAt: Date;
    blockedEndAt: Date;
    type?: 'MAINTENANCE' | 'BOOKING';
    status?: 'ACTIVE' | 'PAYMENT_PROCESSING' | 'RELEASED';
    deletedAt?: Date | null;
  },
): Promise<string> {
  if (!rawSql) throw new Error('rawSql absent');
  const block = await rawSql`
    INSERT INTO inventory_blocks (
      organization_id, inventory_item_id, type, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      deleted_at
    )
    VALUES (
      ${organization.organizationId}, ${item.inventoryItemId},
      ${input.type ?? 'MAINTENANCE'}, ${input.status ?? 'ACTIVE'},
      ${input.blockedStartAt}, ${input.blockedEndAt},
      ${input.blockedStartAt}, ${input.blockedEndAt},
      ${input.deletedAt ?? null}
    )
    RETURNING id
  `.then((rows) => rows[0]!);
  return String(block.id);
}

describe.skipIf(shouldSkipIntegrationTests())('listMaintenanceDashboardSignals PostgreSQL', () => {
  it('isole le tenant et applique tous les filtres, bornes et ordre final', async () => {
    if (!db) throw new Error('db absent');
    if (!rawSql) throw new Error('rawSql absent');

    const organizationA = await seedOrganization('Europe/Paris', 'Tenant A');
    const organizationB = await seedOrganization('America/New_York', 'Tenant B');

    const brokenOnly = await seedItem(organizationA, 'A-000', { condition: 'BROKEN' });
    const brokenWithMaintenance = await seedItem(organizationA, 'A-001', {
      condition: 'BROKEN',
    });
    const upcoming = await seedItem(organizationA, 'A-002');
    const retiredWithMaintenance = await seedItem(organizationA, 'A-003', {
      condition: 'BROKEN',
      status: 'RETIRED',
    });
    const deletedItem = await seedItem(organizationA, 'A-004', {
      condition: 'BROKEN',
      deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const startsAtAsOf = await seedItem(organizationA, 'A-005');
    const endsAtAsOf = await seedItem(organizationA, 'A-006');
    const startsAfterWindow = await seedItem(organizationA, 'A-007');
    const paymentProcessing = await seedItem(organizationA, 'A-008');
    const wrongType = await seedItem(organizationA, 'A-009');
    const deletedBlockItem = await seedItem(organizationA, 'A-010');
    const tenantBItem = await seedItem(organizationB, 'B-001', { condition: 'BROKEN' });

    const activeBlock = await seedMaintenanceBlock(organizationA, brokenWithMaintenance, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
    });
    const secondUpcomingBlock = await seedMaintenanceBlock(organizationA, brokenWithMaintenance, {
      blockedStartAt: new Date(asOf.getTime() + 2 * hour),
      blockedEndAt: new Date(asOf.getTime() + 3 * hour),
    });
    const upcomingBlock = await seedMaintenanceBlock(organizationA, upcoming, {
      blockedStartAt: new Date(asOf.getTime() + 24 * hour),
      blockedEndAt: new Date(asOf.getTime() + 25 * hour),
    });
    const retiredActiveBlock = await seedMaintenanceBlock(organizationA, retiredWithMaintenance, {
      blockedStartAt: new Date(asOf.getTime() - 2 * hour),
      blockedEndAt: new Date(asOf.getTime() + 2 * hour),
    });
    await seedMaintenanceBlock(organizationA, startsAtAsOf, {
      blockedStartAt: asOf,
      blockedEndAt: new Date(asOf.getTime() + hour),
    });
    await seedMaintenanceBlock(organizationA, endsAtAsOf, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: asOf,
    });
    await seedMaintenanceBlock(organizationA, startsAfterWindow, {
      blockedStartAt: new Date(asOf.getTime() + 24 * hour + 1),
      blockedEndAt: new Date(asOf.getTime() + 25 * hour + 1),
    });
    await seedMaintenanceBlock(organizationA, paymentProcessing, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
      status: 'PAYMENT_PROCESSING',
    });
    await seedMaintenanceBlock(organizationA, wrongType, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
      type: 'BOOKING',
    });
    await seedMaintenanceBlock(organizationA, deletedBlockItem, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
      deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const tenantBBlock = await seedMaintenanceBlock(organizationB, tenantBItem, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
    });
    await seedMaintenanceBlock(organizationA, deletedItem, {
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
    });

    const signals = await listMaintenanceDashboardSignals(db, organizationA.organizationId, {
      asOf,
    });

    expect(signals.map((signal) => [signal.kind, signal.inventoryItemId])).toEqual([
      ['ACTIVE_MAINTENANCE', retiredWithMaintenance.inventoryItemId],
      ['ACTIVE_MAINTENANCE', brokenWithMaintenance.inventoryItemId],
      ['ACTIVE_MAINTENANCE', startsAtAsOf.inventoryItemId],
      ['BROKEN_ITEM', brokenOnly.inventoryItemId],
      ['BROKEN_ITEM', brokenWithMaintenance.inventoryItemId],
      ['UPCOMING_MAINTENANCE', brokenWithMaintenance.inventoryItemId],
      ['UPCOMING_MAINTENANCE', upcoming.inventoryItemId],
    ]);
    expect(
      signals.find(
        (signal) =>
          signal.kind !== 'BROKEN_ITEM' &&
          signal.inventoryItemId === retiredWithMaintenance.inventoryItemId,
      ),
    ).toMatchObject({ maintenanceBlockId: retiredActiveBlock });

    const active = signals.find(
      (signal) => signal.kind !== 'BROKEN_ITEM' && signal.maintenanceBlockId === activeBlock,
    );
    expect(active).toMatchObject({
      kind: 'ACTIVE_MAINTENANCE',
      internalSku: 'A-001',
      productName: 'Tenant A Product',
      variantName: 'Standard',
      locationName: 'Tenant A Location',
      locationTimeZone: 'Europe/Paris',
      blockedStartAt: new Date(asOf.getTime() - hour),
      blockedEndAt: new Date(asOf.getTime() + hour),
    });

    const upcomingSignal = signals.find(
      (signal): signal is MaintenanceDashboardMaintenanceSignal =>
        signal.kind !== 'BROKEN_ITEM' && signal.maintenanceBlockId === upcomingBlock,
    );
    expect(upcomingSignal?.kind).toBe('UPCOMING_MAINTENANCE');
    expect(upcomingSignal?.blockedStartAt).toEqual(new Date(asOf.getTime() + 24 * hour));
    expect(
      signals.some(
        (signal) =>
          signal.kind !== 'BROKEN_ITEM' && signal.maintenanceBlockId === secondUpcomingBlock,
      ),
    ).toBe(true);

    const broken = signals.find(
      (signal) =>
        signal.kind === 'BROKEN_ITEM' &&
        signal.inventoryItemId === brokenWithMaintenance.inventoryItemId,
    );
    expect(broken).toBeDefined();
    expect(broken && 'maintenanceBlockId' in broken).toBe(false);

    expect(signals.some((signal) => signal.inventoryItemId === deletedItem.inventoryItemId)).toBe(
      false,
    );
    expect(signals.some((signal) => signal.inventoryItemId === endsAtAsOf.inventoryItemId)).toBe(
      false,
    );
    expect(
      signals.some((signal) => signal.inventoryItemId === startsAfterWindow.inventoryItemId),
    ).toBe(false);
    expect(
      signals.some((signal) => signal.inventoryItemId === paymentProcessing.inventoryItemId),
    ).toBe(false);
    expect(signals.some((signal) => signal.inventoryItemId === wrongType.inventoryItemId)).toBe(
      false,
    );
    expect(
      signals.some((signal) => signal.inventoryItemId === deletedBlockItem.inventoryItemId),
    ).toBe(false);
    expect(signals.some((signal) => signal.inventoryItemId === tenantBItem.inventoryItemId)).toBe(
      false,
    );

    const tenantBSignals = await listMaintenanceDashboardSignals(db, organizationB.organizationId, {
      asOf,
    });
    expect(tenantBSignals.map((signal) => [signal.kind, signal.inventoryItemId])).toEqual([
      ['ACTIVE_MAINTENANCE', tenantBItem.inventoryItemId],
      ['BROKEN_ITEM', tenantBItem.inventoryItemId],
    ]);
    expect(tenantBSignals[0]).toMatchObject({
      maintenanceBlockId: tenantBBlock,
      locationTimeZone: 'America/New_York',
    });

    const limited = await listMaintenanceDashboardSignals(db, organizationA.organizationId, {
      asOf,
      limit: 4,
    });
    expect(limited.map((signal) => signal.kind)).toEqual([
      'ACTIVE_MAINTENANCE',
      'ACTIVE_MAINTENANCE',
      'ACTIVE_MAINTENANCE',
      'BROKEN_ITEM',
    ]);
    expect(limited).toHaveLength(4);
  });
});
