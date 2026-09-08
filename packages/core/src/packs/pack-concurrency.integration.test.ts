import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { createAtomicPackHold, PackAllocationError } from './pack-atomic-hold';

describe('Pack Orchestrator — Concurrency & Atomic Hold Integration Tests', () => {
  let context: IntegrationTestContext | null = null;
  let db: DatabaseClient | null = null;
  let rawSql: ReturnType<typeof postgres> | null = null;

  let orgId: string;
  let locationId: string;
  let seedCount = 0;

  const HOLD_START = new Date('2026-11-15T09:00:00.000Z');
  const HOLD_END = new Date('2026-11-15T18:00:00.000Z');
  const EXPIRES_AT = new Date(Date.now() + 15 * 60 * 1000);

  beforeAll(async () => {
    if (shouldSkipIntegrationTests()) return;
    context = await setupIntegrationTestDb('pack_concurrency');
    if (context) {
      db = createDatabase(context.databaseUrl);
      rawSql = postgres(context.databaseUrl, { max: 10 });
    }
  });

  afterAll(async () => {
    if (db) await db.$client.end();
    if (rawSql) await rawSql.end();
    if (context) await context.cleanup();
  });

  beforeEach(async () => {
    if (!db || !rawSql) return;

    seedCount++;
    const suffix = `${seedCount}-${Date.now().toString(36)}`;

    await db.execute(
      sql`TRUNCATE TABLE
        inventory_blocks,
        inventory_movements,
        inventory_items,
        product_variants,
        products,
        categories,
        locations,
        organizations,
        users
        RESTART IDENTITY CASCADE`,
    );

    const orgRow = await rawSql`
      INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
      VALUES ('Pack Concurrency Org', ${`org-pack-${suffix}`}, true, 'EUR')
      RETURNING id
    `.then((r) => r[0]!);
    orgId = orgRow.id;

    const locRow = await rawSql`
      INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
      VALUES (${orgId}, 'Station Annecy', ${`loc-pack-${suffix}`}, 'Europe/Paris', 'EUR')
      RETURNING id
    `.then((r) => r[0]!);
    locationId = locRow.id;
  });

  async function createTestItems(count: number): Promise<string[]> {
    if (!rawSql) throw new Error('DB not initialized');
    const suffix = `${seedCount}-${randomUUID().slice(0, 8)}`;

    const catRow = await rawSql`
      INSERT INTO categories (name, slug)
      VALUES ('Vélos & Matériel', ${`cat-${suffix}`})
      RETURNING id
    `.then((r) => r[0]!);

    const prodRow = await rawSql`
      INSERT INTO products (organization_id, category_id, name, slug, publication_status)
      VALUES (${orgId}, ${catRow.id}, 'Matériel Pack', ${`prod-${suffix}`}, 'DRAFT')
      RETURNING id
    `.then((r) => r[0]!);

    const varRow = await rawSql`
      INSERT INTO product_variants (product_id, name, is_active, daily_price_amount_minor, currency)
      VALUES (${prodRow.id}, 'Standard', true, 5000, 'EUR')
      RETURNING id
    `.then((r) => r[0]!);

    const itemIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const itemRow = await rawSql`
        INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, status, condition)
        VALUES (${orgId}, ${varRow.id}, ${locationId}, ${`SKU-${suffix}-${i}`}, 'ACTIVE', 'GOOD')
        RETURNING id
      `.then((r) => r[0]!);
      itemIds.push(itemRow.id);
    }
    return itemIds;
  }

  it('course concurrente sur 2 éléments : 1 seul gagne, 0 réservation partielle pour le perdant', async () => {
    if (shouldSkipIntegrationTests() || !db || !rawSql) return;

    // 3 items au total : item[0], item[1], item[2]
    // Pack A veut [item[0], item[1]]
    // Pack B veut [item[1], item[2]]  -> conflit sur item[1]
    const items = await createTestItems(3);
    const draftIdA = randomUUID();
    const draftIdB = randomUUID();

    const [resA, resB] = await Promise.allSettled([
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[0]!, items[1]!],
        draftId: draftIdA,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[1]!, items[2]!],
        draftId: draftIdB,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
    ]);

    // Exactement 1 succès et 1 échec
    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // L'échec doit être un CONCURRENCY_CONFLICT
    const rejectedError = (failures[0] as PromiseRejectedResult).reason;
    expect(rejectedError).toBeInstanceOf(PackAllocationError);
    expect((rejectedError as PackAllocationError).code).toBe('CONCURRENCY_CONFLICT');

    // Vérifier en base : les blocs actifs en base appartiennent exclusivement au pack gagnant
    const activeBlocks = await rawSql`
      SELECT source_id, inventory_item_id FROM inventory_blocks
      WHERE status = 'ACTIVE'
    `;
    expect(activeBlocks.length).toBe(2);

    // Le perdant ne doit avoir AUCUN bloc créé (0 réservation partielle)
    const winningDraftId =
      (successes[0] as PromiseFulfilledResult<{ holdBlockIds: string[] }>).value.holdBlockIds
        .length > 0
        ? activeBlocks[0]!.source_id
        : null;
    const losingDraftId = winningDraftId === draftIdA ? draftIdB : draftIdA;

    const loserBlocks = activeBlocks.filter((b) => b.source_id === losingDraftId);
    expect(loserBlocks.length).toBe(0);
  });

  it('course concurrente sur 3 éléments (2 vélos + 1 remorque) : exclusion stricte et atomique', async () => {
    if (shouldSkipIntegrationTests() || !db || !rawSql) return;

    // 5 items : items[0..4]
    // Pack A veut [item[0], item[1], item[2]] (2 vélos + remorque)
    // Pack B veut [item[2], item[3], item[4]] (conflit sur l'unique remorque item[2])
    const items = await createTestItems(5);
    const draftIdA = randomUUID();
    const draftIdB = randomUUID();

    const [resA, resB] = await Promise.allSettled([
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[0]!, items[1]!, items[2]!],
        draftId: draftIdA,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[2]!, items[3]!, items[4]!],
        draftId: draftIdB,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
    ]);

    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect((failures[0] as PromiseRejectedResult).reason.code).toBe('CONCURRENCY_CONFLICT');

    // Vérification en base : exactement 3 blocs actifs
    const activeBlocks = await rawSql`
      SELECT source_id, inventory_item_id FROM inventory_blocks
      WHERE status = 'ACTIVE'
    `;
    expect(activeBlocks.length).toBe(3);

    const winningDraftId = activeBlocks[0]!.source_id;
    const losingDraftId = winningDraftId === draftIdA ? draftIdB : draftIdA;

    const loserBlocks = activeBlocks.filter((b) => b.source_id === losingDraftId);
    expect(loserBlocks.length).toBe(0);
  });

  it('course concurrente sur 5 éléments : tout-ou-rien sous charge concurrente', async () => {
    if (shouldSkipIntegrationTests() || !db || !rawSql) return;

    // 9 items : items[0..8]
    // Pack A : items[0, 1, 2, 3, 4]
    // Pack B : items[4, 5, 6, 7, 8] (item 4 est partagé)
    const items = await createTestItems(9);
    const draftIdA = randomUUID();
    const draftIdB = randomUUID();

    const [resA, resB] = await Promise.allSettled([
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[0]!, items[1]!, items[2]!, items[3]!, items[4]!],
        draftId: draftIdA,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: [items[4]!, items[5]!, items[6]!, items[7]!, items[8]!],
        draftId: draftIdB,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
    ]);

    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect((failures[0] as PromiseRejectedResult).reason.code).toBe('CONCURRENCY_CONFLICT');

    // Exactement 5 blocs actifs créés, 0 pour le perdant
    const activeBlocks = await rawSql`
      SELECT source_id, inventory_item_id FROM inventory_blocks
      WHERE status = 'ACTIVE'
    `;
    expect(activeBlocks.length).toBe(5);

    const winningDraftId = activeBlocks[0]!.source_id;
    const losingDraftId = winningDraftId === draftIdA ? draftIdB : draftIdA;

    const loserBlocks = activeBlocks.filter((b) => b.source_id === losingDraftId);
    expect(loserBlocks.length).toBe(0);
  });

  it('deux requêtes simultanées sur EXACTEMENT les 3 mêmes exemplaires', async () => {
    if (shouldSkipIntegrationTests() || !db || !rawSql) return;

    const items = await createTestItems(3);
    const draftIdA = randomUUID();
    const draftIdB = randomUUID();

    const [resA, resB] = await Promise.allSettled([
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: items,
        draftId: draftIdA,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
      createAtomicPackHold(db, {
        organizationId: orgId,
        inventoryItemIds: items,
        draftId: draftIdB,
        startAt: HOLD_START,
        endAt: HOLD_END,
        expiresAt: EXPIRES_AT,
      }),
    ]);

    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect((failures[0] as PromiseRejectedResult).reason.code).toBe('CONCURRENCY_CONFLICT');

    const activeBlocks = await rawSql`
      SELECT count(*) FROM inventory_blocks WHERE status = 'ACTIVE'
    `;
    expect(Number(activeBlocks[0]!.count)).toBe(3);
  });
});
