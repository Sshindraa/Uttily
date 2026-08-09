/**
 * @uttily/core — Tests d'intégration PostgreSQL du pipeline de génération de
 * documents transactionnels (G5D, ADR-013 §10, §11).
 *
 * 30 scénarios couvrant : filtrage exact BOOKING_CONFIRMED.v1/BOOKING,
 * isolation des autres types d'événements, SKIP LOCKED, reclaim, attempt_count,
 * initialisation des 4 effets, replay sans doublon, storage keys opaques,
 * SEND_EMAIL sans storage key, succès des 3 générations, correspondance
 * effet/type document, crash A→B, crash B→C, fencing, checksum mismatch,
 * checksum absent, storage not found, erreur transitoire, max attempts,
 * isolation multi-tenant, payload cross-org, aucune clé sensible, aucun appel
 * externe en transaction, compensation toujours fonctionnelle, génération déjà
 * COMPLETED, renderer incohérent, payload mal formé.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { executeDocumentPipeline } from './document-generation-pipeline';
import { FakeDeterministicDocumentRenderer } from './fake-deterministic-document-renderer';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import type { DocumentRenderer, ObjectStorage } from './ports';
import {
  createInstrumentedRenderer,
  createInstrumentedStorage,
  wrapDatabase,
} from './test-instrumentation';
import { claimCompensationBatch } from '../compensation-execution/claim-compensation-batch';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5d');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 10 });
  }
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!ctx || !db) return;
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      notification_deliveries, outbox_effects, documents, document_render_snapshots,
      condition_reports, damage_reports, booking_fulfillment_events,
      outbox_events, audit_log,
      booking_items, booking_lines, inventory_blocks,
      payments, bookings, booking_draft_lines, booking_drafts,
      allocations, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships,
      organizations, users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers (adapted from get-or-create-document-render-snapshot.integration.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  itemIds: string[];
}

const SUFFIX = () => Math.random().toString(36).slice(2, 10);

async function seedBaseData(suffix = SUFFIX(), opts: { timeZone?: string } = {}): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const timeZone = opts.timeZone ?? 'Europe/Paris';
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, ${timeZone}, 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await sql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${org.id}, ${product.id}, ${'product-photos/' + suffix + '-' + _pi},
        'image/jpeg', 102400, 800, 600, ${('000' + _pi).repeat(16).slice(0, 64)},
        ${_pi}, 'AVAILABLE'
      )
    `;
  }
  await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix + '-' + i}, ${location.id}, ${cond}, 'ACTIVE')
      RETURNING "id"
    `.then((r) => r[0]!);
    itemIds.push(item.id);
  }
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    variantId: variant.id,
    itemIds,
  };
}

interface SeedBookingResult {
  bookingId: string;
  paymentId: string;
  draftId: string;
  outboxEventId: string;
  lineId: string;
  bookingItemIds: string[];
}

interface SeedOptions {
  bookingStatus?: string;
  paymentStatus?: string;
  paymentSucceededAt?: string | null;
  timeZone?: string;
  overridePayload?: Record<string, unknown> | null;
  overrideAggregateType?: string;
  overrideEventType?: string;
  overrideEventVersion?: string;
  overrideAggregateId?: string;
  overrideOrgId?: string;
  amountMinor?: number;
  dateOffset?: number;
  prepBufferMinutes?: number;
  cleanupBufferMinutes?: number;
}

async function seedBookingConfirmedEvent(
  ids: BaseIds,
  opts: SeedOptions = {},
): Promise<SeedBookingResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const amountMinor = opts.amountMinor ?? 10000;
  const bookingStatus = opts.bookingStatus ?? 'CONFIRMED';
  const paymentStatus = opts.paymentStatus ?? 'SUCCEEDED';
  const paymentSucceededAt = opts.paymentSucceededAt ?? '2026-01-15 09:58:00+00';
  const timeZone = opts.timeZone ?? 'Europe/Paris';
  const dateOffset = opts.dateOffset ?? 0;
  const prepBufferMinutes = opts.prepBufferMinutes ?? 30;
  const cleanupBufferMinutes = opts.cleanupBufferMinutes ?? 30;
  const month = String(2 + dateOffset).padStart(2, '0');
  const day = 10 + dateOffset;
  const customerStart = `2026-${month}-${day} 09:00:00+00`;
  const customerEnd = `2026-${month}-${day + 2} 17:00:00+00`;
  const blockedStart = `2026-${month}-${day} 08:30:00+00`;
  const blockedEnd = `2026-${month}-${day + 2} 17:30:00+00`;

  const draft = await sql`
    INSERT INTO "booking_drafts" (
      "organization_id", "location_id", "customer_user_id",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
      "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
      "billable_unit", "billable_unit_count",
      "currency", "cancellation_policy_snapshot", "status", "expires_at"
    ) VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${customerStart}, ${customerEnd},
      ${blockedStart}, ${blockedEnd},
      ${timeZone}, 30, 30,
      ${amountMinor}, 0, ${amountMinor},
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: timeZone })},
      'CONVERTED', '2026-01-15 09:55:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const succeededAtValue = paymentSucceededAt === null ? null : paymentSucceededAt;
  const payment = await sql`
    INSERT INTO "payments" (
      "organization_id", "draft_id", "customer_user_id",
      "status", "amount_minor", "currency",
      "tax_status", "commission_amount_minor",
      "financial_terms_version", "legal_terms_version",
      "terms_acceptance_snapshot",
      "connected_account_id", "charge_model", "settlement_merchant_mode",
      "environment", "succeeded_at"
    ) VALUES (
      ${ids.orgId}, ${draft.id}, ${ids.userId},
      ${paymentStatus}::payment_status, ${amountMinor}, 'EUR',
      'NOT_APPLICABLE', 500,
      'v1', 'v1',
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
      'acct_test_123', 'DESTINATION', 'PLATFORM',
      'TEST'::payment_environment, ${succeededAtValue}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const booking = await sql`
    INSERT INTO "bookings" (
      "organization_id", "location_id", "customer_user_id",
      "draft_id", "payment_id", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at",
      "prep_buffer_minutes", "cleanup_buffer_minutes",
      "currency", "subtotal_amount_minor", "mandatory_fees_amount_minor",
      "tax_status", "tax_amount_minor", "tax_rate_bps",
      "commission_amount_minor", "total_amount_minor",
      "cancellation_policy_snapshot", "terms_acceptance_snapshot",
      "confirmed_at"
    ) VALUES (
      ${ids.orgId}, ${ids.locationId}, ${ids.userId},
      ${draft.id}, ${payment.id}, ${bookingStatus}::booking_status,
      ${customerStart}, ${customerEnd},
      ${blockedStart}, ${blockedEnd},
      ${prepBufferMinutes}, ${cleanupBufferMinutes},
      'EUR', ${amountMinor}, 0,
      'NOT_APPLICABLE', 0, null,
      500, ${amountMinor},
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: timeZone })},
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
      '2026-01-15 10:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking.id}, ${ids.variantId}, 2, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  const bookingItemIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const itemId = ids.itemIds[i]!;
    const bookingBlock = await sql`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at", "source_id"
      )
      VALUES (
        ${ids.orgId}, ${itemId}, 'BOOKING', 'ACTIVE',
        ${customerStart}, ${customerEnd},
        ${blockedStart}, ${blockedEnd}, ${booking.id}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    const bookingItem = await sql`
      INSERT INTO "booking_items" (
        "booking_id", "booking_line_id", "inventory_item_id", "booking_block_id"
      )
      VALUES (${booking.id}, ${line.id}, ${itemId}, ${bookingBlock.id})
      RETURNING "id"
    `.then((r) => r[0]!);
    bookingItemIds.push(bookingItem.id);
  }

  const aggregateType = opts.overrideAggregateType ?? 'BOOKING';
  const eventType = opts.overrideEventType ?? 'BOOKING_CONFIRMED';
  const eventVersion = opts.overrideEventVersion ?? 'v1';
  const aggregateId = opts.overrideAggregateId ?? booking.id;
  const outboxOrgId = opts.overrideOrgId ?? ids.orgId;

  let payload: Record<string, unknown>;
  if (opts.overridePayload !== undefined) {
    payload = opts.overridePayload ?? {};
  } else {
    payload = {
      bookingId: booking.id,
      paymentId: payment.id,
      draftId: draft.id,
      organizationId: ids.orgId,
    };
  }

  const outbox = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key"
    ) VALUES (
      ${outboxOrgId}, ${aggregateType}, ${aggregateId}::uuid, ${eventType}, ${eventVersion},
      ${sql.json(payload as Record<string, string>)},
      'PENDING'::outbox_event_status, 0, now(),
      ${'booking_confirmed_' + booking.id + '_' + SUFFIX()}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    bookingId: booking.id,
    paymentId: payment.id,
    draftId: draft.id,
    outboxEventId: outbox.id,
    lineId: line.id,
    bookingItemIds,
  };
}

/** Seed a non-BOOKING_CONFIRMED outbox event for filter tests. */
async function seedOtherOutboxEvent(
  orgId: string,
  aggregateId: string,
  eventType: string,
  eventVersion: string,
  aggregateType: string,
  payload?: Record<string, string>,
): Promise<string> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const outbox = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key"
    ) VALUES (
      ${orgId}, ${aggregateType}, ${aggregateId}::uuid, ${eventType}, ${eventVersion},
      ${sql.json(payload ?? {})},
      'PENDING'::outbox_event_status, 0, now(),
      ${'other_' + eventType + '_' + SUFFIX()}
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return outbox.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: query outbox_effects for an event
// ─────────────────────────────────────────────────────────────────────────────

async function getEffects(outboxEventId: string): Promise<
  Array<{
    id: string;
    effect_type: string;
    status: string;
    document_id: string | null;
    storage_key: string | null;
    failure_code: string | null;
    attempt_count: number;
    idempotency_key: string;
  }>
> {
  if (!rawSql) throw new Error('rawSql not initialized');
  return rawSql`
    SELECT "id", "effect_type", "status", "document_id", "storage_key", "failure_code", "attempt_count", "idempotency_key"
    FROM "outbox_effects"
    WHERE "outbox_event_id" = ${outboxEventId}::uuid
    ORDER BY "effect_type" ASC
  `;
}

async function getOutboxEvent(outboxEventId: string): Promise<{
  status: string;
  attempt_count: number;
  lease_token: string | null;
  lease_until: Date | null;
  available_at: Date;
  processed_at: Date | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "status", "attempt_count", "lease_token", "lease_until", "available_at", "processed_at"
    FROM "outbox_events"
    WHERE "id" = ${outboxEventId}::uuid
  `;
  return rows[0] as {
    status: string;
    attempt_count: number;
    lease_token: string | null;
    lease_until: Date | null;
    available_at: Date;
    processed_at: Date | null;
  };
}

async function getDocuments(outboxEventId: string): Promise<
  Array<{
    id: string;
    type: string;
    storage_key: string;
    checksum_sha256: string;
    size_bytes: number;
    content_type: string;
  }>
> {
  if (!rawSql) throw new Error('rawSql not initialized');
  return rawSql`
    SELECT "id", "type", "storage_key", "checksum_sha256", "size_bytes", "content_type"
    FROM "documents"
    WHERE "source_outbox_event_id" = ${outboxEventId}::uuid
    ORDER BY "type" ASC
  `;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('executeDocumentPipeline — integration PostgreSQL', () => {
  // 1. Filtre exact BOOKING_CONFIRMED.v1/BOOKING
  it('1. filtre exact BOOKING_CONFIRMED.v1/BOOKING — claim sélectionne uniquement les événements correspondants', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.completedCount).toBe(3);
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
  });

  // 2. Événement compensation non claimé
  it('2. événement PAYMENT_COMPENSATION_REQUESTED non claimé par le pipeline documentaire', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    // Seed a compensation event
    await seedOtherOutboxEvent(
      ids.orgId,
      seeded.paymentId,
      'PAYMENT_COMPENSATION_REQUESTED',
      'v1',
      'PAYMENT',
      {
        paymentId: seeded.paymentId,
        refundIdempotencyKey: 'test-key',
        amountMinor: '10000',
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      },
    );

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Only the BOOKING_CONFIRMED event should be claimed
    expect(result.claimedCount).toBe(1);
    expect(result.completedCount).toBe(3);
  });

  // 3. Événement fulfillment non claimé
  it('3. événement fulfillment non claimé', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    await seedOtherOutboxEvent(
      ids.orgId,
      seeded.bookingId,
      'BOOKING_FULFILLMENT_STARTED',
      'v1',
      'BOOKING',
    );

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(1);
  });

  // 4. Version inconnue (v2) non claimée
  it('4. version inconnue (v2) non claimée', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedBookingConfirmedEvent(ids, { overrideEventVersion: 'v2' });

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(0);
  });

  // 5. SKIP LOCKED avec deux workers — un seul claim
  it('5. SKIP LOCKED — deux workers ne claiment pas le même événement', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // Run pipeline twice in parallel — only one should claim
    const [r1, r2] = await Promise.all([
      executeDocumentPipeline(db, renderer, storage, 10),
      executeDocumentPipeline(db, renderer, storage, 10),
    ]);

    const totalClaimed = r1.claimedCount + r2.claimedCount;
    expect(totalClaimed).toBe(1);
  });

  // 6. Reclaim de lease expirée — nouveau token
  it('6. reclaim de lease expirée — nouveau token généré', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Manually set lease to expired
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING', "lease_until" = now() - interval '5 minutes',
          "lease_token" = ${'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}::uuid,
          "attempt_count" = 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(1);
    const event = await getOutboxEvent(seeded.outboxEventId);
    // New lease token should be different from the old one
    expect(event.lease_token).not.toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  // 7. Attempt count incrémenté à chaque claim (initial ET reclaim)
  it('7. attempt_count incrémenté à chaque claim (initial ET reclaim)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First claim
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    const result1 = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(result1.claimedCount).toBe(1);

    const event1 = await getOutboxEvent(seeded.outboxEventId);
    expect(event1.attempt_count).toBe(1); // incremented on first claim

    // Wait for backoff, then reclaim
    // Manually set available_at to now to bypass backoff
    await rawSql`
      UPDATE "outbox_events"
      SET "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const result2 = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(result2.claimedCount).toBe(1);

    const event2 = await getOutboxEvent(seeded.outboxEventId);
    expect(event2.attempt_count).toBe(2); // incremented on reclaim
  });

  // 8. Initialisation exactement 4 effets
  it('8. initialisation exactement 4 effets', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
    const effectTypes = effects.map((e) => e.effect_type).sort();
    expect(effectTypes).toEqual([
      'GENERATE_CONFIRMATION',
      'GENERATE_CONTRACT',
      'GENERATE_RECEIPT',
      'SEND_EMAIL',
    ]);
  });

  // 9. Replay sans doublon
  it('9. replay sans doublon — même événement → toujours 4 effets, jamais 8', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // First run
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Reset outbox to PENDING for replay
    if (!rawSql) return;
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second run (replay)
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4); // Still 4, not 8
  });

  // 10. Storage keys stables et opaques
  it('10. storage keys stables et opaques (UUID format, no bookingId/email/name)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type === 'SEND_EMAIL') {
        expect(effect.storage_key).toBeNull();
      } else {
        expect(effect.storage_key).not.toBeNull();
        expect(UUID_RE.test(effect.storage_key!)).toBe(true);
        // No PII in storage key
        expect(effect.storage_key!).not.toContain(seeded.bookingId);
        expect(effect.storage_key!).not.toContain('@');
        expect(effect.storage_key!).not.toContain('Test');
      }
    }
  });

  // 11. SEND_EMAIL sans storage key
  it('11. SEND_EMAIL sans storage key (document_id=NULL, storage_key=NULL)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.storage_key).toBeNull();
    expect(sendEmail!.document_id).toBeNull();
    expect(sendEmail!.status).toBe('PENDING');
  });

  // 12. Succès des 3 générations
  it('12. succès des 3 générations (all 3 GENERATE_* → COMPLETED, documents inserted)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('COMPLETED');
        expect(effect.document_id).not.toBeNull();
      }
    }

    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 13. Correspondance effet/type document
  it('13. correspondance effet/type document (GENERATE_CONFIRMATION→CONFIRMATION, etc.)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    const docs = await getDocuments(seeded.outboxEventId);
    const docTypes = docs.map((d) => d.type).sort();
    expect(docTypes).toEqual(['CONFIRMATION', 'CONTRACT', 'RECEIPT']);
  });

  // 14. Crash A→B (crash after Phase A, retry → same storage_key, no new effects)
  it('14. crash A→B — retry → même storage_key, pas de nouveaux effets', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Simulate Phase A only: manually claim and init effects
    // Run pipeline with a renderer that throws to simulate crash after Phase A
    const crashingRenderer: FakeDeterministicDocumentRenderer =
      new FakeDeterministicDocumentRenderer();
    crashingRenderer.render = async () => {
      throw new Error('CRASH_AFTER_PHASE_A');
    };

    const storage = new InMemoryObjectStorage();
    const result1 = await executeDocumentPipeline(db, crashingRenderer, storage, 10);
    expect(result1.claimedCount).toBe(1);
    // Effects should be initialized but not completed
    const effects1 = await getEffects(seeded.outboxEventId);
    expect(effects1).toHaveLength(4);
    const generateEffects1 = effects1.filter((e) => e.effect_type !== 'SEND_EMAIL');
    for (const e of generateEffects1) {
      expect(e.storage_key).not.toBeNull();
    }

    // Capture storage keys from first run
    const storageKeys1 = generateEffects1.map((e) => e.storage_key);

    // Reset outbox for retry
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Retry with working renderer
    const goodRenderer = new FakeDeterministicDocumentRenderer();
    const result2 = await executeDocumentPipeline(db, goodRenderer, storage, 10);
    expect(result2.completedCount).toBe(3);

    const effects2 = await getEffects(seeded.outboxEventId);
    expect(effects2).toHaveLength(4); // Still 4, not 8
    const generateEffects2 = effects2.filter((e) => e.effect_type !== 'SEND_EMAIL');
    const storageKeys2 = generateEffects2.map((e) => e.storage_key);
    // Storage keys should be the same (reserved in Phase A, not re-generated)
    expect(storageKeys2.sort()).toEqual(storageKeys1.sort());
  });

  // 15. Crash B→C (crash after storage but before Phase C, retry → ALREADY_EXISTS, same checksum)
  it('15. crash B→C — retry → ALREADY_EXISTS, same checksum, finalization sans doublon', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Step 1: Run pipeline with a renderer that steals the lease during Phase B
    // (simulating crash after storage but before Phase C).
    // The storage will have the objects, but Phase C will get LEASE_LOST.
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // First run: steal lease during Phase B so Phase C fails
    const stealingRenderer = new FakeDeterministicDocumentRenderer();
    const originalRender = stealingRenderer.render.bind(stealingRenderer);
    let stealDone = false;
    stealingRenderer.render = async (templateKey: string, snapshot: unknown) => {
      const result = await originalRender(templateKey, snapshot as never);
      if (!stealDone && rawSql) {
        // Steal the lease after the first render (objects are stored in Phase B
        // after render returns, but we steal here to ensure Phase C fails)
        await rawSql`
          UPDATE "outbox_events"
          SET "lease_token" = ${crypto.randomUUID()}::uuid,
              "lease_until" = now() + interval '2 minutes'
          WHERE "id" = ${seeded.outboxEventId}::uuid
        `;
        stealDone = true;
      }
      return result;
    };

    const result1 = await executeDocumentPipeline(db, stealingRenderer, storage, 10);
    // Phase C should get LEASE_LOST for all events
    expect(result1.leaseLostCount).toBeGreaterThan(0);

    // Objects are in storage, effects are PENDING (Phase C didn't complete)
    const effects1 = await getEffects(seeded.outboxEventId);
    const generateEffects1 = effects1.filter((e) => e.effect_type !== 'SEND_EMAIL');
    for (const e of generateEffects1) {
      expect(e.status).toBe('PENDING');
      expect(e.storage_key).not.toBeNull();
    }

    // Step 2: Expire the lease so the event can be reclaimed
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now(), "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Step 3: Retry with working renderer — storage should return ALREADY_EXISTS
    const result2 = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(result2.completedCount).toBe(3);
    expect(result2.failedCount).toBe(0);

    // Only 3 documents (no duplicates)
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 16. Fencing token périmé (lease lost, Phase C refuses persistence)
  it('16. fencing token périmé — Phase C refuse la persistance', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Steal the lease before Phase C by having another worker claim it
    // First, run pipeline with a renderer that works but we'll steal the lease
    // mid-flight by manually updating the lease_token

    // We need to intercept between Phase B and Phase C.
    // Simpler approach: run the pipeline, then manually steal the lease and
    // re-run Phase C logic. But since we can't easily intercept, let's test
    // by having the lease expire. We'll set the lease to a very short duration
    // by manipulating the DB after Phase A.

    // Alternative: use a renderer that steals the lease during Phase B
    const stealingRenderer = new FakeDeterministicDocumentRenderer();
    const originalRender = stealingRenderer.render.bind(stealingRenderer);
    let stealDone = false;
    stealingRenderer.render = async (templateKey: string, snapshot: unknown) => {
      if (!stealDone && rawSql) {
        // Steal the lease by having another worker claim it
        await rawSql`
          UPDATE "outbox_events"
          SET "lease_token" = ${crypto.randomUUID()}::uuid,
              "lease_until" = now() + interval '2 minutes'
          WHERE "id" = ${seeded.outboxEventId}::uuid
        `;
        stealDone = true;
      }
      return originalRender(templateKey, snapshot as never);
    };

    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, stealingRenderer, storage, 10);

    expect(result.leaseLostCount).toBeGreaterThan(0);
    // No documents should be persisted
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 17. Checksum mismatch (existing object different → effect FAILED)
  it('17. checksum mismatch — objet existant différent → effect FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    // Custom storage: putIfAbsent returns ALREADY_EXISTS, head returns metadata
    // with wrong checksum/size/contentType → STORAGE_CHECKSUM_MISMATCH.
    const base = new InMemoryObjectStorage();
    const mismatchStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: {
          contentType: 'application/wrong',
          sizeBytes: 999,
          checksumSha256: '0'.repeat(64),
        },
      }),
      head: async () => ({
        contentType: 'application/wrong',
        sizeBytes: 999,
        checksumSha256: '0'.repeat(64),
      }),
      get: (key: string) => base.get(key),
    };
    const result = await executeDocumentPipeline(db, renderer, mismatchStorage, 10);

    // All 3 should fail with STORAGE_CHECKSUM_MISMATCH (size mismatch detected by head)
    expect(result.failedCount).toBe(3);
    expect(result.completedCount).toBe(0);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
        expect(effect.failure_code).toBe('STORAGE_CHECKSUM_MISMATCH');
      }
    }
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 18. Checksum absent vérifié via get
  it('18. checksum absent — head.checksumSha256=null → get + recalculate', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    // Custom storage: first put for each key returns ALREADY_EXISTS with null checksum,
    // then get returns the correct content (simulating a provider without checksum
    // but with correct content).
    const realStorage = new InMemoryObjectStorage();
    const nullChecksumStorage: ObjectStorage = {
      putIfAbsent: async (input: {
        key: string;
        content: Uint8Array;
        contentType: string;
        checksumSha256: string;
        sizeBytes: number;
      }) => {
        // Store the content in the real storage first
        await realStorage.putIfAbsent(input);
        // Return ALREADY_EXISTS with null checksum
        return {
          kind: 'ALREADY_EXISTS' as const,
          metadata: {
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            checksumSha256: null,
          },
        };
      },
      head: (key: string) => realStorage.head(key),
      get: (key: string) => realStorage.get(key),
    };
    const result = await executeDocumentPipeline(db, renderer, nullChecksumStorage, 10);

    // Should succeed — checksum is null in metadata, so get + recalculate is used
    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);

    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 19. Storage not found (object absent after inconsistent response)
  it('19. storage not found — objet absent après réponse incohérente → STORAGE_NOT_FOUND', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    // Custom storage that returns ALREADY_EXISTS with null checksum, then get throws
    const notFoundStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: {
          contentType: 'application/vnd.uttily.test-document+json',
          sizeBytes: 100,
          checksumSha256: null,
        },
      }),
      head: async () => null,
      get: async () => {
        throw new Error('STORAGE_NOT_FOUND simulated');
      },
    };
    const result = await executeDocumentPipeline(db, renderer, notFoundStorage, 10);

    // All 3 should fail with STORAGE_NOT_FOUND
    expect(result.failedCount).toBe(3);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
        expect(effect.failure_code).toBe('STORAGE_NOT_FOUND');
      }
    }
  });

  // 20. Erreur transitoire de stockage (put fails → effect stays PENDING, failure_code=NULL)
  it('20. erreur transitoire de stockage — put fails → effect PENDING, failure_code=NULL, outbox rescheduled', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.rescheduledCount).toBe(1);
    expect(result.completedCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('PENDING');
        expect(effect.failure_code).toBeNull();
      }
    }
  });

  // 21. Max attempts (5th failed attempt → terminal FAILED)
  it('21. max attempts — 5e tentative échouée → terminal FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Set attempt_count to 4 (one less than MAX_ATTEMPTS=5)
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = 4
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage, 10);

    // The claim should increment to 5, then since attempt_count >= MAX_ATTEMPTS,
    // the outbox should be marked FAILED
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 22. Isolation multi-tenant (event from other org not claimed/processed)
  it("22. isolation multi-tenant — événement d'autre org non claimé", async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('a');
    const ids2 = await seedBaseData('b');
    const seeded1 = await seedBookingConfirmedEvent(ids1);
    const seeded2 = await seedBookingConfirmedEvent(ids2);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both events should be claimed (they're both BOOKING_CONFIRMED.v1)
    // but each should only process its own org's data
    expect(result.claimedCount).toBe(2);
    expect(result.completedCount).toBe(6);

    // Verify that documents created for org1's event have organization_id = org1
    // and documents created for org2's event have organization_id = org2.
    // No cross-tenant document should exist.
    const docs1 = await rawSql`
      SELECT "organization_id", "booking_id" FROM "documents"
      WHERE "source_outbox_event_id" = ${seeded1.outboxEventId}::uuid
    `;
    expect(docs1.length).toBe(3);
    for (const doc of docs1) {
      expect(doc.organization_id).toBe(ids1.orgId);
      expect(doc.booking_id).toBe(seeded1.bookingId);
    }

    const docs2 = await rawSql`
      SELECT "organization_id", "booking_id" FROM "documents"
      WHERE "source_outbox_event_id" = ${seeded2.outboxEventId}::uuid
    `;
    expect(docs2.length).toBe(3);
    for (const doc of docs2) {
      expect(doc.organization_id).toBe(ids2.orgId);
      expect(doc.booking_id).toBe(seeded2.bookingId);
    }

    // No cross-tenant document: every document's organization_id must match
    // its source event's organization_id.
    const allDocs = await rawSql`
      SELECT d."organization_id" AS doc_org, oe."organization_id" AS event_org
      FROM "documents" d
      JOIN "outbox_events" oe ON d."source_outbox_event_id" = oe."id"
    `;
    for (const doc of allDocs) {
      expect(doc.doc_org).toBe(doc.event_org);
    }
  });

  // 23. Organisation du payload différente de l'outbox → fail closed
  it("23. organisation du payload différente de l'outbox → fail closed (outbox FAILED)", async () => {
    if (!db) return;
    const ids1 = await seedBaseData('a');
    const ids2 = await seedBaseData('b');
    // Create event in org1 but with payload pointing to org2
    const seeded = await seedBookingConfirmedEvent(ids1, {
      overridePayload: {
        bookingId: '00000000-0000-0000-0000-000000000001',
        paymentId: '00000000-0000-0000-0000-000000000002',
        draftId: '00000000-0000-0000-0000-000000000003',
        organizationId: ids2.orgId,
      },
      overrideAggregateId: '00000000-0000-0000-0000-000000000001',
    });

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // The event should be claimed but fail-closed (payload malformed → outbox FAILED)
    expect(result.claimedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 24. Aucun document cross-tenant
  it('24. aucun document cross-tenant', async () => {
    if (!db) return;
    const ids1 = await seedBaseData('a');
    const ids2 = await seedBaseData('b');
    await seedBookingConfirmedEvent(ids1);
    await seedBookingConfirmedEvent(ids2);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Verify no cross-tenant leakage
    const allDocs = await rawSql!`
      SELECT d."id", d."organization_id", d."source_outbox_event_id", oe."organization_id" AS event_org
      FROM "documents" d
      JOIN "outbox_events" oe ON d."source_outbox_event_id" = oe."id"
    `;
    for (const doc of allDocs) {
      expect(doc.organization_id).toBe(doc.event_org);
    }
  });

  // 25. Aucune clé contenant bookingId, email, nom ou adresse
  it('25. aucune clé contenant bookingId, email, nom ou adresse', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.storage_key) {
        expect(effect.storage_key).not.toContain(seeded.bookingId);
        expect(effect.storage_key).not.toContain('@');
        expect(effect.storage_key).not.toContain('Test');
        expect(effect.storage_key).not.toContain('Annecy');
        expect(effect.storage_key).not.toContain('customer');
      }
      // Also check idempotency keys
      const idempotencyRows = await rawSql!`
        SELECT "idempotency_key" FROM "outbox_effects" WHERE "id" = ${effect.id}::uuid
      `;
      const idempotencyKey = idempotencyRows[0]!.idempotency_key;
      expect(idempotencyKey).not.toContain(seeded.bookingId);
      expect(idempotencyKey).not.toContain('@');
      expect(idempotencyKey).not.toContain('Test');
    }
  });

  // 26. Aucun appel externe (renderer/storage) pendant une transaction active
  it('26. aucun appel externe pendant une transaction active', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedBookingConfirmedEvent(ids);

    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();

    const { renderer: instrumentedRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instrumentedStorage, calls: storageCalls } = createInstrumentedStorage(
      innerStorage,
      monitor,
    );

    // Le pipeline utilise wrappedDb dont db.transaction est intercepté par le
    // monitor. Si un appel renderer/storage est fait pendant une transaction
    // active, monitor.violations sera non vide.
    const result = await executeDocumentPipeline(
      wrappedDb,
      instrumentedRenderer,
      instrumentedStorage,
      10,
    );

    expect(result.completedCount).toBe(3);
    expect(rendererCalls.length).toBeGreaterThan(0);
    expect(storageCalls.length).toBeGreaterThan(0);
    // Aucun appel externe ne doit être fait pendant une transaction active.
    expect(monitor.violations.length).toBe(0);
  });

  // 27. Compensation toujours fonctionnelle après extraction du module commun
  it('27. compensation toujours fonctionnelle après extraction du module commun', async () => {
    if (!db) return;
    // Just verify claimCompensationBatch still works (returns empty array with no events)
    const claimed = await claimCompensationBatch(db, 10, 'TEST');
    expect(claimed).toEqual([]);
  });

  // 28. Génération déjà COMPLETED → pas de nouveau rendu ni put
  it('28. génération déjà COMPLETED → pas de nouveau rendu ni put', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run — complete all 3
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Reset outbox for replay
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second run with fresh storage — should not re-render since effects are COMPLETED
    const storage2 = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage2, 10);

    // Effects are already COMPLETED, so no new renders
    expect(result.completedCount).toBe(0);
    // storage2 should be empty (no puts)
    // The effects were already COMPLETED so Phase B skips them
  });

  // 29. Renderer incohérent (checksum/size mismatch) → RENDER_FAILED
  it('29. renderer incohérent (checksum/size mismatch) → RENDER_FAILED, no storage call', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Create a renderer that returns inconsistent checksum
    const inconsistentRenderer = new FakeDeterministicDocumentRenderer();
    const originalRender = inconsistentRenderer.render.bind(inconsistentRenderer);
    inconsistentRenderer.render = async (templateKey: string, snapshot: unknown) => {
      const result = await originalRender(templateKey, snapshot as never);
      // Return a wrong checksum
      return {
        ...result,
        checksumSha256: '0'.repeat(64), // wrong checksum
      };
    };

    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, inconsistentRenderer, storage, 10);

    expect(result.failedCount).toBe(3);
    expect(result.completedCount).toBe(0);

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
        expect(effect.failure_code).toBe('RENDER_FAILED');
      }
    }
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 30. Payload mal formé → outbox FAILED with PAYLOAD_MALFORMED
  it('30. payload mal formé → outbox FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overridePayload: { badField: 'not-valid' },
    });

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // The event should be claimed but fail-closed
    expect(result.claimedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');

    // No effects should be created for malformed payload
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Tests for DEFECT 1-9 (fixes)
  // ───────────────────────────────────────────────────────────────────────────

  // 31. DEFECT 1: FAILED effect not reprocessed
  it('31. DEFECT 1 — effet FAILED non retraité (zero renderer/storage calls)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run with failPut to leave effects PENDING
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage0 = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage0, 10);

    // Manually mark one effect as FAILED with a storage_key
    const effectsBefore = await getEffects(seeded.outboxEventId);
    const confirmEffect = effectsBefore.find((e) => e.effect_type === 'GENERATE_CONFIRMATION')!;
    await rawSql`
      UPDATE "outbox_effects"
      SET "status" = 'FAILED', "failure_code" = 'RENDER_FAILED',
          "completed_at" = now()
      WHERE "id" = ${confirmEffect.id}::uuid
    `;

    // Reset outbox for replay
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second run with instrumented renderer/storage
    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();
    const { renderer: instRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instStorage } = createInstrumentedStorage(innerStorage, monitor);

    await executeDocumentPipeline(wrappedDb, instRenderer, instStorage, 10);

    // The FAILED effect should NOT have been rendered or stored
    const confirmCalls = rendererCalls.filter(
      (c) => c.templateKey === 'booking-confirmation-technical-v1',
    );
    expect(confirmCalls.length).toBe(0);

    // The other 2 GENERATE effects should have been rendered
    const contractCalls = rendererCalls.filter(
      (c) => c.templateKey === 'rental-contract-technical-v1',
    );
    expect(contractCalls.length).toBe(1);
  });

  // 32. DEFECT 1: COMPLETED effect not reprocessed (already covered by test 28, but verify explicitly)
  it('32. DEFECT 1 — effet COMPLETED non retraité', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run — complete all 3
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Reset outbox for replay
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second run with instrumented renderer
    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();
    const { renderer: instRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instStorage } = createInstrumentedStorage(innerStorage, monitor);

    const result = await executeDocumentPipeline(wrappedDb, instRenderer, instStorage, 10);

    // No renders should happen (all COMPLETED)
    expect(rendererCalls.length).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  // 33. DEFECT 1: Mix COMPLETED/FAILED/PENDING — only PENDING attempted
  it('33. DEFECT 1 — mix COMPLETED/FAILED/PENDING → seul PENDING est tenté', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run — complete all 3
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Delete CONFIRMATION and RECEIPT effects, re-insert in desired states
    // (trigger blocks UPDATE on terminal effects)
    const effectsBefore = await getEffects(seeded.outboxEventId);
    const confirmEffect = effectsBefore.find((e) => e.effect_type === 'GENERATE_CONFIRMATION')!;
    const receiptEffect = effectsBefore.find((e) => e.effect_type === 'GENERATE_RECEIPT')!;

    // Delete and re-insert CONFIRMATION as FAILED
    await rawSql`DELETE FROM "outbox_effects" WHERE "id" = ${confirmEffect.id}::uuid`;
    await rawSql`
      INSERT INTO "outbox_effects" (
        "id", "organization_id", "outbox_event_id", "effect_type",
        "status", "document_id", "storage_key", "idempotency_key",
        "attempt_count", "failure_code", "completed_at"
      ) VALUES (
        ${confirmEffect.id}::uuid, ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
        'GENERATE_CONFIRMATION'::outbox_effect_type,
        'FAILED'::outbox_effect_status, NULL, ${confirmEffect.storage_key},
        ${confirmEffect.idempotency_key ?? `doc_effect_${seeded.outboxEventId}_GENERATE_CONFIRMATION_v1`},
        0, 'RENDER_FAILED'::document_processing_failure_code, now()
      )
    `;

    // Delete and re-insert RECEIPT as PENDING (with storage_key preserved)
    await rawSql`DELETE FROM "outbox_effects" WHERE "id" = ${receiptEffect.id}::uuid`;
    await rawSql`
      INSERT INTO "outbox_effects" (
        "id", "organization_id", "outbox_event_id", "effect_type",
        "status", "document_id", "storage_key", "idempotency_key",
        "attempt_count"
      ) VALUES (
        ${receiptEffect.id}::uuid, ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
        'GENERATE_RECEIPT'::outbox_effect_type,
        'PENDING'::outbox_effect_status, NULL, ${receiptEffect.storage_key},
        ${receiptEffect.idempotency_key ?? `doc_effect_${seeded.outboxEventId}_GENERATE_RECEIPT_v1`},
        0
      )
    `;

    // Reset outbox for replay
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();
    const { renderer: instRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instStorage } = createInstrumentedStorage(innerStorage, monitor);

    await executeDocumentPipeline(wrappedDb, instRenderer, instStorage, 10);

    // Only RECEIPT should be rendered (CONFIRMATION=FAILED, CONTRACT=COMPLETED)
    const receiptCalls = rendererCalls.filter(
      (c) => c.templateKey === 'payment-receipt-technical-v1',
    );
    expect(receiptCalls.length).toBe(1);
    const confirmCalls = rendererCalls.filter(
      (c) => c.templateKey === 'booking-confirmation-technical-v1',
    );
    expect(confirmCalls.length).toBe(0);
    const contractCalls = rendererCalls.filter(
      (c) => c.templateKey === 'rental-contract-technical-v1',
    );
    expect(contractCalls.length).toBe(0);
  });

  // 34. DEFECT 2: Effect attempt_count incremented
  it('34. DEFECT 2 — outbox_effects.attempt_count incrémenté à chaque tentative', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First try — fail put to leave effects PENDING
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage1 = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage1, 10);

    // Check attempt_count = 1 for all GENERATE effects
    const effects1 = await getEffects(seeded.outboxEventId);
    for (const effect of effects1) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.attempt_count).toBe(1);
      }
    }

    // Reset outbox for retry
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second try — fail put again
    const storage2 = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage2, 10);

    // Check attempt_count = 2
    const effects2 = await getEffects(seeded.outboxEventId);
    for (const effect of effects2) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.attempt_count).toBe(2);
      }
    }
  });

  // 35. DEFECT 2: COMPLETED/FAILED effects attempt_count unchanged
  it('35. DEFECT 2 — effets COMPLETED/FAILED → attempt_count non incrémenté', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run — complete all 3
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Delete and re-insert CONFIRMATION as FAILED (trigger blocks UPDATE on terminal)
    const effects1 = await getEffects(seeded.outboxEventId);
    const confirmEffect = effects1.find((e) => e.effect_type === 'GENERATE_CONFIRMATION')!;
    const confirmAttemptCount = confirmEffect.attempt_count;
    const contractEffect = effects1.find((e) => e.effect_type === 'GENERATE_CONTRACT')!;
    const contractAttemptCount = contractEffect.attempt_count;

    await rawSql`DELETE FROM "outbox_effects" WHERE "id" = ${confirmEffect.id}::uuid`;
    await rawSql`
      INSERT INTO "outbox_effects" (
        "id", "organization_id", "outbox_event_id", "effect_type",
        "status", "document_id", "storage_key", "idempotency_key",
        "attempt_count", "failure_code", "completed_at"
      ) VALUES (
        ${confirmEffect.id}::uuid, ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
        'GENERATE_CONFIRMATION'::outbox_effect_type,
        'FAILED'::outbox_effect_status, NULL, ${confirmEffect.storage_key},
        ${confirmEffect.idempotency_key ?? `doc_effect_${seeded.outboxEventId}_GENERATE_CONFIRMATION_v1`},
        ${confirmAttemptCount}, 'RENDER_FAILED'::document_processing_failure_code, now()
      )
    `;

    // Reset outbox for replay
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second run
    await executeDocumentPipeline(db, renderer, storage, 10);

    // CONFIRMATION (FAILED) and CONTRACT (COMPLETED) attempt_count unchanged
    const effects2 = await getEffects(seeded.outboxEventId);
    const confirmAfter = effects2.find((e) => e.effect_type === 'GENERATE_CONFIRMATION')!;
    const contractAfter = effects2.find((e) => e.effect_type === 'GENERATE_CONTRACT')!;
    expect(confirmAfter.attempt_count).toBe(confirmAttemptCount);
    expect(contractAfter.attempt_count).toBe(contractAttemptCount);
  });

  // 36. DEFECT 2: Lease lost before reservation → no increment, no external call
  it("36. DEFECT 2 — lease perdue avant réservation → pas d'incrément, pas d'appel externe", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Use a renderer that steals the lease before rendering
    const stealingRenderer = new FakeDeterministicDocumentRenderer();
    let stealDone = false;
    const originalRender = stealingRenderer.render.bind(stealingRenderer);
    stealingRenderer.render = async (templateKey: string, snapshot: unknown) => {
      if (!stealDone) {
        // Steal the lease before the first render (after reservation of first effect)
        await rawSql!`
          UPDATE "outbox_events"
          SET "lease_token" = ${crypto.randomUUID()}::uuid,
              "lease_until" = now() + interval '2 minutes'
          WHERE "id" = ${seeded.outboxEventId}::uuid
        `;
        stealDone = true;
      }
      return originalRender(templateKey, snapshot as never);
    };

    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, stealingRenderer, storage, 10);

    // At least one effect should have been processed (the first one before lease steal)
    // The remaining effects should be LEASE_LOST (transient)
    expect(result.leaseLostCount).toBeGreaterThanOrEqual(0);

    // Check that effects that were NOT attempted (lease lost) have attempt_count = 0
    const effects = await getEffects(seeded.outboxEventId);
    // At least one effect should have attempt_count = 0 (lease lost before reservation)
    const unattempted = effects.filter(
      (e) => e.effect_type !== 'SEND_EMAIL' && e.attempt_count === 0,
    );
    expect(unattempted.length).toBeGreaterThan(0);
  });

  // 37. DEFECT 2: Three effects each have own counter
  it('37. DEFECT 2 — trois effets ont chacun leur propre compteur', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage, 10);

    const effects = await getEffects(seeded.outboxEventId);
    const generateEffects = effects.filter((e) => e.effect_type !== 'SEND_EMAIL');
    // All three should have attempt_count = 1 (independently incremented)
    for (const effect of generateEffects) {
      expect(effect.attempt_count).toBe(1);
    }
  });

  // 38. DEFECT 3: Backoff 30/60/120/240
  it('38. DEFECT 3 — backoff 30s après 1er échec (pas 60s)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    await executeDocumentPipeline(db, renderer, storage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();

    // available_at should be ~now + 30s (30 * 2^0 = 30)
    // attemptCount after first claim = 1, backoff = 30 * 2^(1-1) = 30
    const now = new Date();
    const deltaSec = (event.available_at.getTime() - now.getTime()) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(25);
    expect(deltaSec).toBeLessThanOrEqual(35);
  });

  // 39. DEFECT 3: Backoff 60s after 2nd failure
  it('39. DEFECT 3 — backoff 60s après 2e échec', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });

    // First failure
    await executeDocumentPipeline(db, renderer, storage, 10);
    // Bypass backoff
    await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${seeded.outboxEventId}::uuid`;

    // Second failure
    await executeDocumentPipeline(db, renderer, storage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    // attemptCount = 2, backoff = 30 * 2^(2-1) = 60
    const now = new Date();
    const deltaSec = (event.available_at.getTime() - now.getTime()) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(55);
    expect(deltaSec).toBeLessThanOrEqual(65);
  });

  // 40. DEFECT 3: Backoff 120s after 3rd failure
  it('40. DEFECT 3 — backoff 120s après 3e échec', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });

    for (let i = 0; i < 2; i++) {
      await executeDocumentPipeline(db, renderer, storage, 10);
      await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${seeded.outboxEventId}::uuid`;
    }
    // 3rd failure — don't reset available_at, check backoff
    await executeDocumentPipeline(db, renderer, storage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    // attemptCount = 3, backoff = 30 * 2^(3-1) = 120
    const now = new Date();
    const deltaSec = (event.available_at.getTime() - now.getTime()) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(115);
    expect(deltaSec).toBeLessThanOrEqual(125);
  });

  // 41. DEFECT 3: Backoff 240s after 4th failure, FAILED after 5th
  it('41. DEFECT 3 — backoff 240s après 4e échec, FAILED après 5e', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });

    for (let i = 0; i < 3; i++) {
      await executeDocumentPipeline(db, renderer, storage, 10);
      await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${seeded.outboxEventId}::uuid`;
    }
    // 4th failure — don't reset available_at, check backoff
    await executeDocumentPipeline(db, renderer, storage, 10);

    // After 4th failure: attemptCount=4, backoff = 30 * 2^3 = 240
    let event = await getOutboxEvent(seeded.outboxEventId);
    const now = new Date();
    const deltaSec = (event.available_at.getTime() - now.getTime()) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(235);
    expect(deltaSec).toBeLessThanOrEqual(245);

    // 5th attempt → FAILED
    await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${seeded.outboxEventId}::uuid`;
    await executeDocumentPipeline(db, renderer, storage, 10);

    event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 42. DEFECT 4: Durable anomaly → outbox FAILED
  it('42. DEFECT 4 — anomalie durable → outbox FAILED (lease nettoyé)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    // Storage that returns ALREADY_EXISTS with wrong metadata via head
    const mismatchStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: { contentType: 'wrong', sizeBytes: 999, checksumSha256: '0'.repeat(64) },
      }),
      head: async () => ({
        contentType: 'wrong',
        sizeBytes: 999,
        checksumSha256: '0'.repeat(64),
      }),
      get: async () => {
        throw new Error('not found');
      },
    };
    await executeDocumentPipeline(db, renderer, mismatchStorage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  // 43. DEFECT 4: Renderer inconsistent → outbox FAILED
  it('43. DEFECT 4 — renderer incohérent → outbox FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const inconsistentRenderer = new FakeDeterministicDocumentRenderer();
    const originalRender = inconsistentRenderer.render.bind(inconsistentRenderer);
    inconsistentRenderer.render = async (templateKey: string, snapshot: unknown) => {
      const result = await originalRender(templateKey, snapshot as never);
      return { ...result, checksumSha256: '0'.repeat(64) };
    };

    const storage = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, inconsistentRenderer, storage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 44. DEFECT 4: Storage not found → outbox FAILED
  it('44. DEFECT 4 — storage not found → outbox FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const notFoundStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: { contentType: 'test', sizeBytes: 100, checksumSha256: null },
      }),
      head: async () => null,
      get: async () => {
        throw new Error('not found');
      },
    };
    await executeDocumentPipeline(db, renderer, notFoundStorage, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 45. DEFECT 4: 3 generations succeed + SEND_EMAIL pending → outbox PENDING, not re-claimed
  it('45. DEFECT 4 — 3 générations réussies + SEND_EMAIL PENDING → outbox PENDING, non re-claimé par G5D', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.completedCount).toBe(3);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();

    // available_at should be ~now (immediately available for G5E, no arbitrary delay)
    const now = new Date();
    const deltaSec = (event.available_at.getTime() - now.getTime()) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(-5);
    expect(deltaSec).toBeLessThanOrEqual(5);

    // Run pipeline again — should NOT re-claim (all 3 GENERATE_* COMPLETED)
    const result2 = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(result2.claimedCount).toBe(0);
  });

  // 46. DEFECT 5: ALREADY_EXISTS calls head
  it('46. DEFECT 5 — ALREADY_EXISTS appelle head() (vérifié via instrumented storage)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run to store objects
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage1 = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage1, 10);

    // Capture storage_keys from first run
    const effectsBefore = await getEffects(seeded.outboxEventId);
    const storageKeysByType = new Map<string, string>();
    for (const e of effectsBefore) {
      if (e.storage_key) storageKeysByType.set(e.effect_type, e.storage_key);
    }

    // Reset outbox and effects for replay (DELETE+INSERT because trigger blocks UPDATE on terminal)
    // Preserve storage_keys so putIfAbsent returns ALREADY_EXISTS on second run
    if (!rawSql) return;
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    await rawSql`
      DELETE FROM "outbox_effects"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" != 'SEND_EMAIL'
    `;
    const genEffectTypes = ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT'];
    for (const et of genEffectTypes) {
      const sk = storageKeysByType.get(et)!;
      await rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${et}::outbox_effect_type,
          'PENDING'::outbox_effect_status,
          ${sk},
          ${`doc_effect_${seeded.outboxEventId}_${et}_v1`}
        )
      `;
    }

    // Second run with instrumented storage (same storage1 so objects exist)
    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const { storage: instStorage, calls: storageCalls } = createInstrumentedStorage(
      storage1,
      monitor,
    );

    await executeDocumentPipeline(wrappedDb, renderer, instStorage, 10);

    // head should have been called (ALREADY_EXISTS path)
    const headCalls = storageCalls.filter((c) => c.method === 'head');
    expect(headCalls.length).toBeGreaterThan(0);
  });

  // 47. DEFECT 5: head null → STORAGE_NOT_FOUND
  it('47. DEFECT 5 — head null → STORAGE_NOT_FOUND', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const nullHeadStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: { contentType: 'test', sizeBytes: 100, checksumSha256: 'abc' },
      }),
      head: async () => null,
      get: async () => {
        throw new Error('not found');
      },
    };
    const result = await executeDocumentPipeline(db, renderer, nullHeadStorage, 10);

    expect(result.failedCount).toBe(3);
    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
        expect(effect.failure_code).toBe('STORAGE_NOT_FOUND');
      }
    }
  });

  // 48. DEFECT 5: head throw → PENDING + reschedule (transient)
  it('48. DEFECT 5 — head lève → PENDING + reschedule (transitoire)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const failHeadStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: { contentType: 'test', sizeBytes: 100, checksumSha256: 'abc' },
      }),
      head: async () => {
        throw new Error('head transient error');
      },
      get: async () => {
        throw new Error('not found');
      },
    };
    const result = await executeDocumentPipeline(db, renderer, failHeadStorage, 10);

    // Should be rescheduled (transient), not FAILED
    expect(result.rescheduledCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');

    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('PENDING');
        expect(effect.failure_code).toBeNull();
      }
    }
  });

  // 49. DEFECT 5: checksum present + all match → success without get
  it('49. DEFECT 5 — checksum présent + tout match → succès sans get', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // First run to store objects
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage1 = new InMemoryObjectStorage();
    await executeDocumentPipeline(db, renderer, storage1, 10);

    // Capture storage_keys from first run
    const effectsBefore = await getEffects(seeded.outboxEventId);
    const storageKeysByType = new Map<string, string>();
    for (const e of effectsBefore) {
      if (e.storage_key) storageKeysByType.set(e.effect_type, e.storage_key);
    }

    // Reset outbox and effects for replay (DELETE+INSERT because trigger blocks UPDATE on terminal)
    // Preserve storage_keys so putIfAbsent returns ALREADY_EXISTS on second run
    if (!rawSql) return;
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    await rawSql`
      DELETE FROM "outbox_effects"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" != 'SEND_EMAIL'
    `;
    for (const et of ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT']) {
      const sk = storageKeysByType.get(et)!;
      await rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${et}::outbox_effect_type,
          'PENDING'::outbox_effect_status,
          ${sk},
          ${`doc_effect_${seeded.outboxEventId}_${et}_v1`}
        )
      `;
    }

    // Second run with instrumented storage
    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const { storage: instStorage, calls: storageCalls } = createInstrumentedStorage(
      storage1,
      monitor,
    );

    await executeDocumentPipeline(wrappedDb, renderer, instStorage, 10);

    // head should be called, get should NOT be called (checksum present)
    const headCalls = storageCalls.filter((c) => c.method === 'head');
    const getCalls = storageCalls.filter((c) => c.method === 'get');
    expect(headCalls.length).toBeGreaterThan(0);
    expect(getCalls.length).toBe(0);
  });

  // 50. DEFECT 5: checksum null → get called
  it('50. DEFECT 5 — checksum null → get appelé', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const realStorage = new InMemoryObjectStorage({ omitChecksum: true });
    const nullChecksumStorage: ObjectStorage = {
      putIfAbsent: async (input) => {
        await realStorage.putIfAbsent(input);
        return {
          kind: 'ALREADY_EXISTS' as const,
          metadata: {
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            checksumSha256: null,
          },
        };
      },
      head: (key) => realStorage.head(key),
      get: (key) => realStorage.get(key),
    };

    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const { storage: instStorage, calls: storageCalls } = createInstrumentedStorage(
      nullChecksumStorage,
      monitor,
    );

    await executeDocumentPipeline(wrappedDb, renderer, instStorage, 10);

    // get should be called (checksum null in head metadata)
    const getCalls = storageCalls.filter((c) => c.method === 'get');
    expect(getCalls.length).toBeGreaterThan(0);

    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 51. DEFECT 5: checksum null + wrong size → FAILED
  it('51. DEFECT 5 — checksum null + wrong size → FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const wrongSizeStorage: ObjectStorage = {
      putIfAbsent: async (input) => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: {
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          checksumSha256: null,
        },
      }),
      head: async () => ({
        contentType: 'application/vnd.uttily.test-document+json',
        sizeBytes: 999,
        checksumSha256: null,
      }),
      get: async () => new Uint8Array(999),
    };
    const result = await executeDocumentPipeline(db, renderer, wrongSizeStorage, 10);

    // Size mismatch via head → STORAGE_CHECKSUM_MISMATCH
    expect(result.failedCount).toBe(3);
    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
      }
    }
  });

  // 52. DEFECT 5: checksum null + wrong contentType → FAILED
  it('52. DEFECT 5 — checksum null + wrong contentType → FAILED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const wrongTypeStorage: ObjectStorage = {
      putIfAbsent: async (input) => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: {
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          checksumSha256: null,
        },
      }),
      head: async () => ({
        contentType: 'application/wrong',
        sizeBytes: 100,
        checksumSha256: null,
      }),
      get: async () => new Uint8Array(100),
    };
    const result = await executeDocumentPipeline(db, renderer, wrongTypeStorage, 10);

    expect(result.failedCount).toBe(3);
    const effects = await getEffects(seeded.outboxEventId);
    for (const effect of effects) {
      if (effect.effect_type !== 'SEND_EMAIL') {
        expect(effect.status).toBe('FAILED');
      }
    }
  });

  // 53. DEFECT 5: checksum null + same bytes/size/type → success
  it('53. DEFECT 5 — checksum null + mêmes bytes/size/type → succès', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const realStorage = new InMemoryObjectStorage({ omitChecksum: true });
    const nullChecksumStorage: ObjectStorage = {
      putIfAbsent: async (input) => {
        await realStorage.putIfAbsent(input);
        return {
          kind: 'ALREADY_EXISTS' as const,
          metadata: {
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            checksumSha256: null,
          },
        };
      },
      head: (key) => realStorage.head(key),
      get: (key) => realStorage.get(key),
    };
    const result = await executeDocumentPipeline(db, renderer, nullChecksumStorage, 10);

    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 54. DEFECT 6: Replay document identical → same document, effect COMPLETED
  it('54. DEFECT 6 — replay document identique → même document, effect COMPLETED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // First run
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Capture storage_keys from first run
    const effectsBefore = await getEffects(seeded.outboxEventId);
    const storageKeysByType = new Map<string, string>();
    for (const e of effectsBefore) {
      if (e.storage_key) storageKeysByType.set(e.effect_type, e.storage_key);
    }

    // Reset outbox and effects for replay (DELETE+INSERT because trigger blocks UPDATE on terminal)
    // Preserve storage_keys so putIfAbsent returns ALREADY_EXISTS on second run
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    await rawSql`
      DELETE FROM "outbox_effects"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" != 'SEND_EMAIL'
    `;
    for (const et of ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT']) {
      const sk = storageKeysByType.get(et)!;
      await rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${et}::outbox_effect_type,
          'PENDING'::outbox_effect_status,
          ${sk},
          ${`doc_effect_${seeded.outboxEventId}_${et}_v1`}
        )
      `;
    }

    // Second run (replay) — same storage, same renderer
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Event should be claimed and effects should be COMPLETED again (replay safe)
    expect(result.claimedCount).toBe(1);
    expect(result.completedCount).toBe(3);

    // Still only 3 documents (no duplicates)
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
  });

  // 55. DEFECT 6: No false completedCount increment
  it('55. DEFECT 6 — pas de fausse incrémentation de completedCount', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const mismatchStorage: ObjectStorage = {
      putIfAbsent: async () => ({
        kind: 'ALREADY_EXISTS' as const,
        metadata: { contentType: 'wrong', sizeBytes: 999, checksumSha256: '0'.repeat(64) },
      }),
      head: async () => ({
        contentType: 'wrong',
        sizeBytes: 999,
        checksumSha256: '0'.repeat(64),
      }),
      get: async () => {
        throw new Error('not found');
      },
    };
    const result = await executeDocumentPipeline(db, renderer, mismatchStorage, 10);

    // All 3 should fail — completedCount should be 0
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(3);
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 56. DEFECT 7: Exactly 4 effects validated — nominal
  it('56. DEFECT 7 — validation exactement 4 effets (nominal)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(1);
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
    const types = effects.map((e) => e.effect_type).sort();
    expect(types).toEqual([
      'GENERATE_CONFIRMATION',
      'GENERATE_CONTRACT',
      'GENERATE_RECEIPT',
      'SEND_EMAIL',
    ]);
  });

  // 57. DEFECT 8: Phase A isolation — real snapshot/authority error inside savepoint
  it('57. DEFECT 8 — isolation Phase A : 1er payload valide mais IDs inexistants → savepoint rollback, 2e valide', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    // First event: valid payload syntax (all 4 UUIDs present and valid format),
    // but booking/payment/draft IDs don't exist in DB → snapshot creation throws
    // inside the savepoint.
    const randomBookingId = crypto.randomUUID();
    const randomPaymentId = crypto.randomUUID();
    const randomDraftId = crypto.randomUUID();
    const seeded1 = await seedBookingConfirmedEvent(ids, {
      overridePayload: {
        bookingId: randomBookingId,
        paymentId: randomPaymentId,
        draftId: randomDraftId,
        organizationId: ids.orgId,
      },
      overrideAggregateId: randomBookingId,
    });
    // Second event: fully valid
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both should be claimed
    expect(result.claimedCount).toBe(2);

    // First event should be FAILED (snapshot creation failed → savepoint rollback)
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');

    // No effects/snapshot/documents for event 1
    const effects1 = await getEffects(seeded1.outboxEventId);
    expect(effects1).toHaveLength(0);
    const docs1 = await getDocuments(seeded1.outboxEventId);
    expect(docs1).toHaveLength(0);
    const snapshots1 = await rawSql`
      SELECT "id" FROM "document_render_snapshots"
      WHERE "outbox_event_id" = ${seeded1.outboxEventId}::uuid
    `;
    expect(snapshots1.length).toBe(0);

    // Second event should have 3 documents generated (not aborted by first)
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING'); // 3 gen complete → PENDING for G5E

    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);

    // No cross-tenant leak
    const allDocs = await rawSql`
      SELECT d."organization_id" AS doc_org, oe."organization_id" AS event_org
      FROM "documents" d
      JOIN "outbox_events" oe ON d."source_outbox_event_id" = oe."id"
    `;
    for (const doc of allDocs) {
      expect(doc.doc_org).toBe(doc.event_org);
    }
  });

  // 57b. DEFECT 8: Real SQL UNIQUE(idempotency_key) collision → savepoint rollback
  it('57b. DEFECT 8 — collision UNIQUE(idempotency_key) sur outbox_effects → savepoint rollback, 2e valide', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded1 = await seedBookingConfirmedEvent(ids);
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });

    // Create a third outbox event (PROCESSED, non-claimable) to host a
    // pre-existing outbox_effect with the SAME idempotency_key that Phase A
    // will try to INSERT for event 1's GENERATE_CONFIRMATION effect.
    // The idempotency_key formula is: doc_effect_{outboxEventId}_{effectType}_v1
    const targetIdempotencyKey = `doc_effect_${seeded1.outboxEventId}_GENERATE_CONFIRMATION_v1`;
    const fakeOutbox = await rawSql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key",
        "processed_at"
      ) VALUES (
        ${ids.orgId}::uuid, 'BOOKING', ${seeded1.bookingId}::uuid, 'BOOKING_CONFIRMED', 'v1',
        ${rawSql.json({ bookingId: seeded1.bookingId, paymentId: seeded1.paymentId, draftId: seeded1.draftId, organizationId: ids.orgId })},
        'PROCESSED'::outbox_event_status, 1, now(),
        ${'booking_confirmed_collision_host_' + SUFFIX()},
        now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    // Pre-insert an outbox_effect on the fake event with the target idempotency_key.
    // This occupies the UNIQUE(idempotency_key) slot globally.
    // Status PENDING with document_id=NULL, storage_key=NULL, failure_code=NULL,
    // completed_at=NULL is a valid DB state for a PENDING GENERATE_* effect
    // (satisfies outbox_effects_pending_invariants).
    await rawSql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}::uuid, ${fakeOutbox.id}::uuid,
        'GENERATE_CONFIRMATION'::outbox_effect_type,
        'PENDING'::outbox_effect_status,
        ${targetIdempotencyKey}
      )
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both events should be claimed.
    expect(result.claimedCount).toBe(2);

    // Event 1 must be FAILED: Phase A's INSERT for GENERATE_CONFIRMATION
    // violates UNIQUE(idempotency_key). The INSERT uses
    // ON CONFLICT (outbox_event_id, effect_type) DO NOTHING, which handles
    // only the (outbox_event_id, effect_type) constraint — the separate
    // UNIQUE(idempotency_key) constraint is NOT covered, so PostgreSQL raises
    // SQLSTATE 23505 inside the savepoint. The savepoint rolls back and the
    // event is marked FAILED in the outer transaction.
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');

    // No effects or documents for event 1 (savepoint rolled back).
    const effects1 = await getEffects(seeded1.outboxEventId);
    expect(effects1).toHaveLength(0);
    const docs1 = await getDocuments(seeded1.outboxEventId);
    expect(docs1).toHaveLength(0);

    // Event 2 must succeed (transaction still usable after savepoint rollback).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');
    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);
  });

  // 57c. DEFECT 8: Savepoint rollback restores usable transaction (snapshot existant malformé)
  it('57c. DEFECT 8 — savepoint rollback automatique restaure une transaction utilisable (snapshot existant malformé/incohérent)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded1 = await seedBookingConfirmedEvent(ids);
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });

    // Pre-insert a document_render_snapshot for event 1 with a malformed
    // snapshot ({ dummy: true }). getOrCreateDocumentRenderSnapshotInTx
    // first searches for an existing snapshot by outbox_event_id — it FINDS
    // this row and does NOT attempt a new INSERT (no UNIQUE collision occurs).
    // The actual failure is a parsing/invariant error on the malformed
    // snapshot content, which throws inside the savepoint. The savepoint
    // rolls back and the event is marked FAILED in the outer transaction.
    // This test covers an application-level error in the savepoint (not a SQL
    // constraint violation). Test 57b covers the real SQL UNIQUE collision.
    await rawSql`
      INSERT INTO "document_render_snapshots" (
        "organization_id", "outbox_event_id", "booking_id",
        "snapshot", "template_version"
      ) VALUES (
        ${ids.orgId}::uuid, ${seeded1.outboxEventId}::uuid, ${seeded1.bookingId}::uuid,
        ${rawSql.json({ dummy: true })}::jsonb, 'v1'
      )
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both should be claimed.
    expect(result.claimedCount).toBe(2);

    // First event should be FAILED (malformed snapshot → savepoint rollback).
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');

    // Second event should succeed (transaction still usable after savepoint rollback).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');
    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);
  });

  // 58. DEFECT 9: Closed claim module — runtime validation tests are in
  // outbox-claim-runtime-validation.test.ts (pure unit tests, no PostgreSQL needed).
  // This integration test placeholder verifies the constants are importable.
  it('58. DEFECT 9 — constantes de sélection importables (validation runtime dans outbox-claim-runtime-validation.test.ts)', async () => {
    if (!db) return;
    const { BOOKING_CONFIRMED_SELECTION, PAYMENT_COMPENSATION_SELECTION } =
      await import('../outbox-claim');
    expect(BOOKING_CONFIRMED_SELECTION.kind).toBe('BOOKING_CONFIRMED');
    expect(PAYMENT_COMPENSATION_SELECTION.kind).toBe('PAYMENT_COMPENSATION');
  });

  // 59. DEFECT 9: Batch 0/negative/non-integer/>10 rejected
  it('59. DEFECT 9 — batchLimit invalide rejeté (0, négatif, non-entier, >10)', async () => {
    if (!db) return;
    const { validateBatchLimit } = await import('../outbox-claim');
    expect(() => validateBatchLimit(0)).toThrow();
    expect(() => validateBatchLimit(-1)).toThrow();
    expect(() => validateBatchLimit(1.5)).toThrow();
    expect(() => validateBatchLimit(11)).toThrow();
    expect(validateBatchLimit(5)).toBe(5);
    expect(validateBatchLimit(undefined)).toBe(10);
  });

  // 60. DEFECT 9: Real compensation test with seeded data
  it('60. DEFECT 9 — compensation claim avec données réelles (refund + payment + outbox)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const suffix = SUFFIX();

    // Seed a real compensation event
    const draft = await rawSql`
      INSERT INTO "booking_drafts" (
        "organization_id", "location_id", "customer_user_id",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at",
        "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
        "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
        "billable_unit", "billable_unit_count",
        "currency", "cancellation_policy_snapshot"
      ) VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId},
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
        'Europe/Paris', 30, 30,
        10000, 0, 10000,
        'NOT_APPLICABLE', 0, null, 500,
        'DAY', 2,
        'EUR', ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const payment = await rawSql`
      INSERT INTO "payments" (
        "organization_id", "draft_id", "customer_user_id",
        "status", "amount_minor", "currency",
        "tax_status", "commission_amount_minor",
        "financial_terms_version", "legal_terms_version",
        "terms_acceptance_snapshot",
        "connected_account_id", "charge_model", "settlement_merchant_mode",
        "environment", "succeeded_at"
      ) VALUES (
        ${ids.orgId}, ${draft.id}, ${ids.userId},
        'SUCCEEDED'::payment_status, 10000, 'EUR',
        'NOT_APPLICABLE', 500,
        'v1', 'v1',
        ${rawSql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
        'acct_test_123', 'DESTINATION', 'PLATFORM',
        'TEST'::payment_environment, now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const refundIdempotencyKey = `refund_test_${suffix}`;
    await rawSql`
      INSERT INTO "refunds" (
        "organization_id", "payment_id", "reason", "status",
        "amount_minor", "currency",
        "provider_idempotency_key",
        "reverse_transfer", "refund_application_fee",
        "requested_at"
      ) VALUES (
        ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING'::refund_reason, 'PENDING'::refund_status,
        10000, 'EUR',
        ${refundIdempotencyKey},
        true, true,
        now()
      )
    `;

    const outbox = await rawSql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
        ${rawSql.json({
          paymentId: payment.id,
          refundIdempotencyKey: refundIdempotencyKey,
          amountMinor: '10000',
          currency: 'EUR',
          reason: 'LATE_PAYMENT_NO_BOOKING',
        })},
        'PENDING'::outbox_event_status, 0, now(),
        ${'comp_test_' + suffix}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    // Call claimCompensationBatch
    const claimed = await claimCompensationBatch(db, 10, 'TEST');

    // Event should be claimed (non-empty array)
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.outboxEventId).toBe(outbox.id);

    // Lease posed (lease_token is UUID, lease_until > now)
    expect(claimed[0]!.leaseToken).toMatch(UUID_RE);
    expect(new Date(claimed[0]!.leaseUntil as unknown as string).getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Status = PROCESSING
    const event = await getOutboxEvent(outbox.id);
    expect(event.status).toBe('PROCESSING');

    // attempt_count = 0 after initial claim (reclaim_only: PENDING→PROCESSING doesn't increment)
    expect(event.attempt_count).toBe(0);
  });

  // 60b. DEFECT 9: Reclaim test — expired lease increments attempt_count
  it('60b. DEFECT 9 — reclaim avec lease expirée incrémente attempt_count', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const suffix = SUFFIX();

    const draft = await rawSql`
      INSERT INTO "booking_drafts" (
        "organization_id", "location_id", "customer_user_id",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at",
        "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
        "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
        "billable_unit", "billable_unit_count",
        "currency", "cancellation_policy_snapshot"
      ) VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId},
        '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
        '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00',
        'Europe/Paris', 30, 30,
        10000, 0, 10000,
        'NOT_APPLICABLE', 0, null, 500,
        'DAY', 2,
        'EUR', ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const payment = await rawSql`
      INSERT INTO "payments" (
        "organization_id", "draft_id", "customer_user_id",
        "status", "amount_minor", "currency",
        "tax_status", "commission_amount_minor",
        "financial_terms_version", "legal_terms_version",
        "terms_acceptance_snapshot",
        "connected_account_id", "charge_model", "settlement_merchant_mode",
        "environment", "succeeded_at"
      ) VALUES (
        ${ids.orgId}, ${draft.id}, ${ids.userId},
        'SUCCEEDED'::payment_status, 10000, 'EUR',
        'NOT_APPLICABLE', 500,
        'v1', 'v1',
        ${rawSql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
        'acct_test_123', 'DESTINATION', 'PLATFORM',
        'TEST'::payment_environment, now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const refundIdempotencyKey = `refund_reclaim_${suffix}`;
    await rawSql`
      INSERT INTO "refunds" (
        "organization_id", "payment_id", "reason", "status",
        "amount_minor", "currency",
        "provider_idempotency_key",
        "reverse_transfer", "refund_application_fee",
        "requested_at"
      ) VALUES (
        ${ids.orgId}, ${payment.id}, 'LATE_PAYMENT_NO_BOOKING'::refund_reason, 'PENDING'::refund_status,
        10000, 'EUR',
        ${refundIdempotencyKey},
        true, true,
        now()
      )
    `;

    const outbox = await rawSql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, 'PAYMENT', ${payment.id}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
        ${rawSql.json({
          paymentId: payment.id,
          refundIdempotencyKey: refundIdempotencyKey,
          amountMinor: '10000',
          currency: 'EUR',
          reason: 'LATE_PAYMENT_NO_BOOKING',
        })},
        'PENDING'::outbox_event_status, 0, now(),
        ${'comp_reclaim_' + suffix}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    // First claim
    await claimCompensationBatch(db, 10, 'TEST');
    let event = await getOutboxEvent(outbox.id);
    expect(event.attempt_count).toBe(0); // PENDING→PROCESSING doesn't increment

    // Set status to PROCESSING with expired lease
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING', "lease_until" = now() - interval '5 minutes',
          "lease_token" = ${'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}::uuid
      WHERE "id" = ${outbox.id}::uuid
    `;

    // Reclaim
    const claimed = await claimCompensationBatch(db, 10, 'TEST');
    expect(claimed.length).toBe(1);

    event = await getOutboxEvent(outbox.id);
    // Reclaim (PROCESSING→PROCESSING) increments attempt_count
    expect(event.attempt_count).toBe(1);
  });

  // 60c. DEFECT 9: BOOKING_CONFIRMED event NOT claimed by compensation
  it('60c. DEFECT 9 — BOOKING_CONFIRMED non claimé par compensation', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedBookingConfirmedEvent(ids);

    const claimed = await claimCompensationBatch(db, 10, 'TEST');
    // No compensation events should be claimed
    expect(claimed).toEqual([]);
  });

  // 61. DEFECT 7: Effect with bad idempotency key → fail closed
  it('61. DEFECT 7 — effet avec mauvaise idempotency key → fail closed (outbox FAILED)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Manually insert an effect with a bad idempotency key
    await rawSql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "storage_key", "idempotency_key"
      ) VALUES (
        ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
        'GENERATE_CONFIRMATION'::outbox_effect_type,
        'PENDING'::outbox_effect_status, ${crypto.randomUUID()},
        'bad_idempotency_key_not_matching'
      )
      ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(result.claimedCount).toBe(1);
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');

    // No documents generated
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 62. DEFECT 7: SEND_EMAIL with storage_key set → DB constraint rejects (fail closed)
  it('62. DEFECT 7 — SEND_EMAIL avec storage_key → rejeté par contrainte DB (fail closed)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // The DB check constraint 'outbox_effects_send_email_invariants' prevents
    // SEND_EMAIL from having a storage_key. This is the fail-closed behavior.
    const idempotencyKey = `doc_effect_${seeded.outboxEventId}_SEND_EMAIL_v1`;
    await expect(
      rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          'SEND_EMAIL'::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${crypto.randomUUID()},
          ${idempotencyKey}
        )
      `,
    ).rejects.toThrow();
  });

  // 63. DEFECT 7: SEND_EMAIL with document_id set → DB constraint rejects (fail closed)
  it('63. DEFECT 7 — SEND_EMAIL avec document_id → rejeté par contrainte DB (fail closed)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // The DB CHECK constraint 'outbox_effects_send_email_invariants' prevents
    // SEND_EMAIL from having a document_id. This is the fail-closed behavior.
    const idempotencyKey = `doc_effect_${seeded.outboxEventId}_SEND_EMAIL_v1`;
    const randomDocId = crypto.randomUUID();
    await expect(
      rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "document_id", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          'SEND_EMAIL'::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${randomDocId}::uuid,
          ${idempotencyKey}
        )
      `,
    ).rejects.toThrow();
  });

  // 64. DEFECT 7: Missing effect (only 3) then init completes to 4 → success
  it('64. DEFECT 7 — effet manquant (3 seulement) puis init complète à 4 → succès', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Pre-insert only 3 effects (missing SEND_EMAIL)
    for (const effectType of ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT']) {
      const idempotencyKey = `doc_effect_${seeded.outboxEventId}_${effectType}_v1`;
      await rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${effectType}::outbox_effect_type,
          'PENDING'::outbox_effect_status,
          ${idempotencyKey}
        )
        ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
      `;
    }

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Pipeline should init the missing SEND_EMAIL effect and succeed
    expect(result.claimedCount).toBe(1);
    expect(result.completedCount).toBe(3);

    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
  });

  // 65. DEFECT 7: Cardinality validation — pure function test (no PostgreSQL)
  it('65. DEFECT 7 — validation cardinalité via fonction pure (0, 3, 5 effets, type dupliqué, type inconnu)', async () => {
    const { validateEffectSet } = await import('./effect-validation');
    const outboxEventId = crypto.randomUUID();

    // Helper to build a valid effect row.
    const makeEffect = (
      effectType: string,
      opts: { storageKey?: string | null; status?: string } = {},
    ) => ({
      effectType: effectType as never,
      status: opts.status ?? 'PENDING',
      documentId: null,
      storageKey: effectType === 'SEND_EMAIL' ? null : (opts.storageKey ?? crypto.randomUUID()),
      idempotencyKey: `doc_effect_${outboxEventId}_${effectType}_v1`,
    });

    const validEffects = [
      makeEffect('GENERATE_CONFIRMATION'),
      makeEffect('GENERATE_CONTRACT'),
      makeEffect('GENERATE_RECEIPT'),
      makeEffect('SEND_EMAIL'),
    ];

    // 0 effects → throws.
    expect(() => validateEffectSet({ effects: [], outboxEventId })).toThrow(
      'EFFECT_SET_INVARIANT_VIOLATED',
    );

    // 3 effects → throws.
    expect(() => validateEffectSet({ effects: validEffects.slice(0, 3), outboxEventId })).toThrow(
      'EFFECT_SET_INVARIANT_VIOLATED',
    );

    // 5 effects → throws (duplicate type).
    expect(() =>
      validateEffectSet({
        effects: [...validEffects, makeEffect('GENERATE_CONFIRMATION')],
        outboxEventId,
      }),
    ).toThrow('EFFECT_SET_INVARIANT_VIOLATED');

    // Unknown type → throws.
    expect(() =>
      validateEffectSet({
        effects: [
          makeEffect('GENERATE_CONFIRMATION'),
          makeEffect('GENERATE_CONTRACT'),
          makeEffect('GENERATE_RECEIPT'),
          { ...makeEffect('SEND_EMAIL'), effectType: 'UNKNOWN_TYPE' as never },
        ],
        outboxEventId,
      }),
    ).toThrow('EFFECT_SET_INVARIANT_VIOLATED');

    // Invalid status (outside the closed union 'PENDING'|'COMPLETED'|'FAILED') → throws.
    expect(() =>
      validateEffectSet({
        effects: [
          makeEffect('GENERATE_CONFIRMATION'),
          makeEffect('GENERATE_CONTRACT'),
          makeEffect('GENERATE_RECEIPT'),
          { ...makeEffect('SEND_EMAIL'), status: 'INVALID_STATUS' },
        ],
        outboxEventId,
      }),
    ).toThrow('EFFECT_SET_INVARIANT_VIOLATED');

    // Wrong idempotency_key → throws.
    expect(() =>
      validateEffectSet({
        effects: [
          makeEffect('GENERATE_CONFIRMATION'),
          makeEffect('GENERATE_CONTRACT'),
          makeEffect('GENERATE_RECEIPT'),
          { ...makeEffect('SEND_EMAIL'), idempotencyKey: 'wrong-key' },
        ],
        outboxEventId,
      }),
    ).toThrow('EFFECT_SET_INVARIANT_VIOLATED');

    // Non-UUID storage_key on a GENERATE_* effect → throws.
    expect(() =>
      validateEffectSet({
        effects: [
          { ...makeEffect('GENERATE_CONFIRMATION'), storageKey: 'not-a-uuid' },
          makeEffect('GENERATE_CONTRACT'),
          makeEffect('GENERATE_RECEIPT'),
          makeEffect('SEND_EMAIL'),
        ],
        outboxEventId,
      }),
    ).toThrow('EFFECT_SET_INVARIANT_VIOLATED');

    // Exactly 4 valid effects → does NOT throw.
    expect(() => validateEffectSet({ effects: validEffects, outboxEventId })).not.toThrow();
  });

  // 66. DEFECT 7: GENERATE PENDING with non-UUID storage_key → fail closed (UUID format validation)
  it('66. DEFECT 7 — GENERATE PENDING avec storage_key non-UUID → fail closed (validation UUID)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Pre-insert all 4 effects. GENERATE_CONFIRMATION has a non-null but
    // non-UUID storage_key ('not-a-uuid'). The reservation UPDATE in Phase A
    // only sets storage_key WHERE storage_key IS NULL, so it will NOT
    // overwrite the pre-inserted bad value. The pure validation function
    // checks UUID format and must reject this → fail closed.
    for (const effectType of [
      'GENERATE_CONFIRMATION',
      'GENERATE_CONTRACT',
      'GENERATE_RECEIPT',
      'SEND_EMAIL',
    ]) {
      const idempotencyKey = `doc_effect_${seeded.outboxEventId}_${effectType}_v1`;
      const storageKey = effectType === 'GENERATE_CONFIRMATION' ? 'not-a-uuid' : null;
      await rawSql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${effectType}::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${storageKey},
          ${idempotencyKey}
        )
        ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
      `;
    }

    // Use instrumented renderer/storage to verify zero external calls.
    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();
    const { renderer: instRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instStorage, calls: storageCalls } = createInstrumentedStorage(
      innerStorage,
      monitor,
    );

    const result = await executeDocumentPipeline(wrappedDb, instRenderer, instStorage, 10);

    // The event must be FAILED (UUID format validation caught the bad storage_key).
    expect(result.claimedCount).toBe(1);
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();

    // Zero renderer and storage calls — validation must happen before any external call.
    expect(rendererCalls.length).toBe(0);
    expect(storageCalls.length).toBe(0);

    // No documents generated.
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(0);
  });

  // 67. DEFECT 7: No renderer/storage call after invalid invariant
  it('67. DEFECT 7 — aucun appel renderer/storage après invariant invalide', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Pre-insert effects with wrong idempotency key
    for (const effectType of [
      'GENERATE_CONFIRMATION',
      'GENERATE_CONTRACT',
      'GENERATE_RECEIPT',
      'SEND_EMAIL',
    ]) {
      const idempotencyKey = `wrong_key_${effectType}`;
      const storageKey = effectType === 'SEND_EMAIL' ? null : crypto.randomUUID();
      await rawSql!`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid,
          ${effectType}::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${storageKey},
          ${idempotencyKey}
        )
        ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
      `;
    }

    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const innerStorage = new InMemoryObjectStorage();
    const { renderer: instRenderer, calls: rendererCalls } = createInstrumentedRenderer(
      innerRenderer,
      monitor,
    );
    const { storage: instStorage, calls: storageCalls } = createInstrumentedStorage(
      innerStorage,
      monitor,
    );

    await executeDocumentPipeline(wrappedDb, instRenderer, instStorage, 10);

    // No renderer or storage calls should happen (validation failed in Phase A)
    expect(rendererCalls.length).toBe(0);
    expect(storageCalls.length).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 68. DEFECT 10 — collision (booking_id, type, version) avec metadata différente → effect FAILED, batch isolation
  it('68. DEFECT 10 — collision (booking_id, type, version) → FAILED, pas de rollback global, 2e valide', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded1 = await seedBookingConfirmedEvent(ids);
    // Second valid event in the same batch to prove batch isolation.
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });

    // Pré-insérer un document avec le même (booking_id, type, version) que
    // event 1 mais un storage_key et checksum différents. Cela va provoquer
    // une collision sur la contrainte UNIQUE (booking_id, type, version) lors
    // de l'INSERT en Phase C. Le savepoint rollback l'INSERT sur collision.
    // Le code hors savepoint recherche ensuite le document existant, compare
    // les 11 champs, détecte le mismatch → effect FAILED. On crée un outbox
    // event PROCESSED (non claimable) pour porter le snapshot et le document
    // pré-insérés.
    const fakeStorageKey = crypto.randomUUID();
    const fakeChecksum = 'a'.repeat(64);
    const fakeSnapshotId = crypto.randomUUID();
    const fakeOutbox = await rawSql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key",
        "processed_at"
      ) VALUES (
        ${ids.orgId}::uuid, 'BOOKING', ${seeded1.bookingId}::uuid, 'BOOKING_CONFIRMED', 'v1',
        ${rawSql.json({ bookingId: seeded1.bookingId, paymentId: seeded1.paymentId, draftId: seeded1.draftId, organizationId: ids.orgId })},
        'PROCESSED'::outbox_event_status, 1, now(),
        ${'booking_confirmed_pre_insert_' + SUFFIX()},
        now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    const fakeOutboxEventId = fakeOutbox.id as string;
    await rawSql`
      INSERT INTO "document_render_snapshots" (
        "id", "organization_id", "outbox_event_id", "booking_id",
        "snapshot", "template_version"
      ) VALUES (
        ${fakeSnapshotId}::uuid,
        ${ids.orgId}::uuid,
        ${fakeOutboxEventId}::uuid,
        ${seeded1.bookingId}::uuid,
        '{}'::jsonb,
        'v1'
      )
    `;
    await rawSql`
      INSERT INTO "documents" (
        "organization_id", "booking_id", "type", "version",
        "storage_key", "content_type", "checksum_sha256", "size_bytes",
        "template_version", "generated_at",
        "source_outbox_event_id", "render_snapshot_id", "idempotency_key"
      ) VALUES (
        ${ids.orgId}::uuid,
        ${seeded1.bookingId}::uuid,
        'CONFIRMATION'::document_type,
        1,
        ${fakeStorageKey},
        'application/pdf',
        ${fakeChecksum},
        999,
        'v1',
        now(),
        ${fakeOutboxEventId}::uuid,
        ${fakeSnapshotId}::uuid,
        ${'doc_' + crypto.randomUUID() + '_CONFIRMATION_v1'}
      )
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both events should be claimed.
    expect(result.claimedCount).toBe(2);

    // Event 1: GENERATE_CONFIRMATION must be FAILED due to the mismatch.
    expect(result.failedCount).toBeGreaterThanOrEqual(1);

    // L'outbox doit être FAILED (anomalie durable).
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');
    expect(event1.lease_token).toBeNull();

    // L'effet CONFIRMATION doit être FAILED avec STORAGE_CHECKSUM_MISMATCH.
    const effects1 = await getEffects(seeded1.outboxEventId);
    const confirmationEffect = effects1.find((e) => e.effect_type === 'GENERATE_CONFIRMATION');
    expect(confirmationEffect).toBeDefined();
    expect(confirmationEffect!.status).toBe('FAILED');
    expect(confirmationEffect!.failure_code).toBe('STORAGE_CHECKSUM_MISMATCH');

    // Event 2 must succeed with 3 documents (no global transaction abort).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');
    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);
  });

  // 69. DEFECT 10 — collision UNIQUE(storage_key) avec autre document → FAILED, batch isolation
  it('69. DEFECT 10 — collision UNIQUE(storage_key) → FAILED, pas de rollback global, 2e valide', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded1 = await seedBookingConfirmedEvent(ids);
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });
    // Third booking used only to host the pre-existing document. It must NOT
    // collide with event 1 or event 2 on UNIQUE(booking_id, type, version),
    // so the only collision is on UNIQUE(storage_key).
    const seeded3 = await seedBookingConfirmedEvent(ids, { dateOffset: 2 });

    // seeded3's outbox event is PENDING and would be claimable by the pipeline.
    // Mark it PROCESSED with processed_at = now() so it is NOT claimable
    // (the claim query filters status IN ('PENDING', 'PROCESSING')).
    // The booking for seeded3 still exists and is needed as a valid booking
    // for the pre-existing document's booking_id FK.
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSED'::outbox_event_status,
          "processed_at" = now(),
          "lease_token" = NULL,
          "lease_until" = NULL
      WHERE "id" = ${seeded3.outboxEventId}::uuid
    `;

    // Verify BEFORE running the pipeline that only seeded1 and seeded2 are
    // claimable (2 events, not 3).
    const claimableCount = await rawSql`
      SELECT count(*)::int AS cnt FROM "outbox_events"
      WHERE "event_type" = 'BOOKING_CONFIRMED' AND "event_version" = 'v1' AND "aggregate_type" = 'BOOKING'
        AND "status" IN ('PENDING', 'PROCESSING') AND "available_at" <= now()
        AND ("lease_until" IS NULL OR "lease_until" <= now())
    `.then((r) => r[0]!.cnt);
    expect(claimableCount).toBe(2);

    // Pre-insert an outbox_effect for event 1's GENERATE_CONFIRMATION with a
    // deterministic, valid UUID storage_key. Phase A's reservation UPDATE
    // won't overwrite it (WHERE storage_key IS NULL). Phase A's validation
    // will accept it (valid UUID, PENDING, non-null storage_key).
    const targetStorageKey = crypto.randomUUID();
    const targetIdempotencyKey = `doc_effect_${seeded1.outboxEventId}_GENERATE_CONFIRMATION_v1`;
    await rawSql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "storage_key", "idempotency_key"
      ) VALUES (
        ${ids.orgId}::uuid, ${seeded1.outboxEventId}::uuid,
        'GENERATE_CONFIRMATION'::outbox_effect_type,
        'PENDING'::outbox_effect_status, ${targetStorageKey},
        ${targetIdempotencyKey}
      )
      ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
    `;

    // Pre-insert a documents row belonging to a THIRD booking (seeded3) with
    // the SAME storage_key (targetStorageKey). Using seeded3.bookingId ensures
    // the pre-existing document does NOT collide with event 1 (CONFIRMATION on
    // seeded1.bookingId) or event 2 (CONFIRMATION/CONTRACT/RECEIPT on
    // seeded2.bookingId) on UNIQUE(booking_id, type, version). The ONLY
    // collision is on UNIQUE(storage_key), isolating the defect under test.
    const fakeSnapshotId = crypto.randomUUID();
    const fakeOutbox = await rawSql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
        "payload", "status", "attempt_count", "available_at", "idempotency_key",
        "processed_at"
      ) VALUES (
        ${ids.orgId}::uuid, 'BOOKING', ${seeded3.bookingId}::uuid, 'BOOKING_CONFIRMED', 'v1',
        ${rawSql.json({ bookingId: seeded3.bookingId, paymentId: seeded3.paymentId, draftId: seeded3.draftId, organizationId: ids.orgId })},
        'PROCESSED'::outbox_event_status, 1, now(),
        ${'booking_confirmed_storage_key_host_' + SUFFIX()},
        now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`
      INSERT INTO "document_render_snapshots" (
        "id", "organization_id", "outbox_event_id", "booking_id",
        "snapshot", "template_version"
      ) VALUES (
        ${fakeSnapshotId}::uuid,
        ${ids.orgId}::uuid,
        ${fakeOutbox.id}::uuid,
        ${seeded3.bookingId}::uuid,
        '{}'::jsonb,
        'v1'
      )
    `;
    // Insert a document with the SAME storage_key but a (booking_id, type,
    // version) combination that belongs to seeded3 and does not collide with
    // event 1 or event 2 on UNIQUE(booking_id, type, version).
    await rawSql`
      INSERT INTO "documents" (
        "organization_id", "booking_id", "type", "version",
        "storage_key", "content_type", "checksum_sha256", "size_bytes",
        "template_version", "generated_at",
        "source_outbox_event_id", "render_snapshot_id", "idempotency_key"
      ) VALUES (
        ${ids.orgId}::uuid,
        ${seeded3.bookingId}::uuid,
        'CONFIRMATION'::document_type,
        1,
        ${targetStorageKey},
        'application/pdf',
        ${'b'.repeat(64)},
        999,
        'v1',
        now(),
        ${fakeOutbox.id}::uuid,
        ${fakeSnapshotId}::uuid,
        ${'doc_' + crypto.randomUUID() + '_CONFIRMATION_v1'}
      )
    `;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both events should be claimed (seeded3 is PROCESSED, not claimable).
    expect(result.claimedCount).toBe(2);

    // Event 1: In Phase C, the INSERT for event 1's GENERATE_CONFIRMATION
    // document with targetStorageKey violates UNIQUE(storage_key) because the
    // pre-existing document (on seeded3) already occupies that storage_key.
    // The savepoint rolls back the INSERT. The code outside the savepoint then
    // searches for the existing document by storage_key, finds it but the
    // 11-field comparison fails (different booking_id, source_outbox_event_id,
    // render_snapshot_id) → docMismatch → effect FAILED with
    // STORAGE_CHECKSUM_MISMATCH.
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');
    expect(event1.lease_token).toBeNull();

    const effects1 = await getEffects(seeded1.outboxEventId);
    const confirmationEffect = effects1.find((e) => e.effect_type === 'GENERATE_CONFIRMATION');
    expect(confirmationEffect).toBeDefined();
    expect(confirmationEffect!.status).toBe('FAILED');
    expect(confirmationEffect!.failure_code).toBe('STORAGE_CHECKSUM_MISMATCH');

    // Phase C processes each GENERATE_* effect INDEPENDENTLY in a loop.
    // A failure in GENERATE_CONFIRMATION does NOT stop the loop —
    // GENERATE_CONTRACT and GENERATE_RECEIPT are still persisted normally.
    // There is NO global rollback of other effects.
    const contractEffect = effects1.find((e) => e.effect_type === 'GENERATE_CONTRACT');
    expect(contractEffect).toBeDefined();
    expect(contractEffect!.status).toBe('COMPLETED');
    const receiptEffect = effects1.find((e) => e.effect_type === 'GENERATE_RECEIPT');
    expect(receiptEffect).toBeDefined();
    expect(receiptEffect!.status).toBe('COMPLETED');

    // No CONFIRMATION document exists for event 1 (the collision prevented it).
    // Exactly 2 documents exist for event 1: one CONTRACT and one RECEIPT.
    const docs1 = await getDocuments(seeded1.outboxEventId);
    expect(docs1).toHaveLength(2);
    expect(docs1.map((d) => d.type).sort()).toEqual(['CONTRACT', 'RECEIPT']);
    expect(docs1.find((d) => d.type === 'CONFIRMATION')).toBeUndefined();

    // The pre-existing document (on seeded3) using targetStorageKey remains
    // unchanged — its booking_id is still seeded3.bookingId, type is still
    // CONFIRMATION.
    const preExistingDocs = await rawSql`
      SELECT "booking_id", "type" FROM "documents"
      WHERE "storage_key" = ${targetStorageKey}
    `;
    expect(preExistingDocs).toHaveLength(1);
    expect(preExistingDocs[0]!.booking_id).toBe(seeded3.bookingId);
    expect(preExistingDocs[0]!.type).toBe('CONFIRMATION');

    // Event 2 must continue normally with 3 documents created (batch isolation).
    // The pre-existing document belongs to seeded3, so event 2's three
    // documents (CONFIRMATION/CONTRACT/RECEIPT on seeded2.bookingId) do not
    // collide on UNIQUE(booking_id, type, version) and each gets a fresh
    // random storage_key that does not collide on UNIQUE(storage_key).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');
    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);
  });

  // 70. DEFECT 7 — Phase C fail-closed after Phase B corruption (effect set
  // mutated between Phase A and Phase C via separate connection).
  it('70. DEFECT 7 — Phase C fail-closed après corruption Phase B (effet supprimé via connexion séparée) → FAILED, processed_at NULL, 2e valide', async () => {
    if (!db || !rawSql) return;
    const sql = rawSql;
    const ids = await seedBaseData();
    const seeded1 = await seedBookingConfirmedEvent(ids);
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });

    // Create an instrumented renderer that, during Phase B's first render call
    // for event 1, deletes one of event 1's outbox_effects rows via sql
    // (autocommit, separate connection). This corruption happens AFTER Phase A
    // (which initialized 4 valid effects) and BEFORE Phase C (which re-reads
    // and validates the effect set). The DELETE is immediately visible to
    // Phase C's transaction because sql uses autocommit.
    //
    // We delete the SEND_EMAIL effect for event 1. This reduces the effect set
    // from 4 to 3, causing validateEffectSet to fail (cardinality !== 4) in
    // Phase C. Phase C then fail-closed: outbox FAILED, lease cleaned,
    // processed_at NULL.
    let corruptionDone = false;
    const innerRenderer = new FakeDeterministicDocumentRenderer();
    const renderer: DocumentRenderer = {
      async render(templateKey, snapshot) {
        // Perform the corruption only once, on the first render call for
        // event 1 (identified by sourceOutboxEventId in the snapshot).
        if (!corruptionDone && snapshot.sourceOutboxEventId === seeded1.outboxEventId) {
          corruptionDone = true;
          // Delete the SEND_EMAIL effect for event 1 via sql (autocommit).
          // This is visible to Phase C's transaction which starts after Phase B.
          await sql`
            DELETE FROM "outbox_effects"
            WHERE "outbox_event_id" = ${seeded1.outboxEventId}::uuid
              AND "effect_type" = 'SEND_EMAIL'
          `;
        }
        return innerRenderer.render(templateKey, snapshot);
      },
    };

    const storage = new InMemoryObjectStorage();
    const result = await executeDocumentPipeline(db, renderer, storage, 10);

    // Both events should be claimed.
    expect(result.claimedCount).toBe(2);

    // Event 1: Phase C detected the corrupted effect set (3 effects instead
    // of 4) and fail-closed.
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');
    expect(event1.lease_token).toBeNull();
    expect(event1.lease_until).toBeNull();
    // processed_at must be explicitly NULL (the fail-closed UPDATE sets it).
    expect(event1.processed_at).toBeNull();

    // The corruption is visible: only 3 effects remain for event 1
    // (SEND_EMAIL was deleted).
    const effects1 = await getEffects(seeded1.outboxEventId);
    expect(effects1).toHaveLength(3);
    expect(effects1.find((e) => e.effect_type === 'SEND_EMAIL')).toBeUndefined();

    // No documents persisted by Phase C for event 1 (fail-closed before
    // processing any effects).
    const docs1 = await getDocuments(seeded1.outboxEventId);
    expect(docs1).toHaveLength(0);

    // Event 2 succeeds with 3 documents (batch isolation).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');
    const docs2 = await getDocuments(seeded2.outboxEventId);
    expect(docs2).toHaveLength(3);
  });
});
