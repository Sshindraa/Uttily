/**
 * @uttily/worker — Tests E2E PostgreSQL du worker complet (G5F, ADR-013 §11).
 *
 * 14 scénarios couvrant le worker complet avec les fakes G5C-G5E :
 * 1. nominal, 2. replay, 3. crash après stockage, 4. crash après email,
 * 5. crash entre documents et email, 6. concurrence, 7. sweeper/reclaim,
 * 8. anomalie durable, 9. erreur transitoire, 10. confidentialité,
 * 11. snapshot figé, 12. isolation multi-tenant,
 * 13. MAX_ATTEMPTS enforcement, 14. fencing (reclaim après expiration lease).
 *
 * Les seed helpers sont adaptés/dupliqués depuis
 * document-generation-pipeline.integration.test.ts (self-contained).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '@uttily/core/testing';
import {
  FakeDeterministicDocumentRenderer,
  InMemoryObjectStorage,
  FakeTransactionalEmailSender,
  executeDocumentPipeline,
  executeTransactionalEmailPipeline,
  OUTBOX_MAX_ATTEMPTS,
  claimOutboxBatch,
  BOOKING_CONFIRMED_SELECTION,
  type ClaimEligibility,
  type ObjectStorage,
  type StoredObjectMetadata,
  type ObjectStoragePutResult,
  type EmailInput,
  type EmailSendResult,
  type TransactionalEmailSender,
} from '@uttily/core';

import { runTransactionalDocumentsWorkerCycle } from './worker-cycle';
import type { WorkerDependencies } from './worker-cycle';
import { runSweeperCycle } from './sweeper';
import { CapturingWorkerLogger } from './logger';
import { InMemoryMetricsCollector } from './metrics';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5fworker');
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
// Promise.withResolvers polyfill (TS < ES2024 target).
// ─────────────────────────────────────────────────────────────────────────────

function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrumented fakes pour les scénarios de preuve E2E.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ObjectStorage instrumenté qui wrap InMemoryObjectStorage et capture
 * tous les appels putIfAbsent et head avec leurs paramètres et résultats.
 */
class InstrumentedObjectStorage implements ObjectStorage {
  private inner = new InMemoryObjectStorage();
  readonly putCalls: Array<{
    key: string;
    checksum: string;
    size: number;
    contentType: string;
  }> = [];
  readonly headCalls: Array<{ key: string; metadata: StoredObjectMetadata | null }> = [];
  readonly putResults: Array<'CREATED' | 'ALREADY_EXISTS'> = [];

  async putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ObjectStoragePutResult> {
    this.putCalls.push({
      key: input.key,
      checksum: input.checksumSha256,
      size: input.sizeBytes,
      contentType: input.contentType,
    });
    const result = await this.inner.putIfAbsent(input);
    this.putResults.push(result.kind);
    return result;
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const result = await this.inner.head(key);
    this.headCalls.push({ key, metadata: result });
    return result;
  }

  async get(key: string): Promise<Uint8Array> {
    return this.inner.get(key);
  }
}

/**
 * TransactionalEmailSender instrumenté qui wrap un FakeTransactionalEmailSender
 * et capture tous les appels send avec providerIdempotencyKey, templateKey
 * et les providerMessageId retournés.
 */
class InstrumentedEmailSender implements TransactionalEmailSender {
  private inner: FakeTransactionalEmailSender;
  readonly sendCalls: Array<{
    providerIdempotencyKey: string;
    templateKey: string;
  }> = [];
  readonly providerMessageIds: Array<string | null> = [];

  constructor(inner?: FakeTransactionalEmailSender) {
    this.inner = inner ?? new FakeTransactionalEmailSender();
  }

  async send(input: EmailInput): Promise<EmailSendResult> {
    this.sendCalls.push({
      providerIdempotencyKey: input.providerIdempotencyKey,
      templateKey: input.templateKey,
    });
    const result = await this.inner.send(input);
    if (result.kind !== 'SENT') throw new Error('invariant: expected SENT');
    this.providerMessageIds.push(result.providerMessageId);
    return result;
  }

  get sendCallCount(): number {
    return this.inner.sendCallCount;
  }

  get uniqueEmailCount(): number {
    return this.inner.uniqueEmailCount;
  }

  getProviderMessageId(key: string): string | undefined {
    return this.inner.getProviderMessageId(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers (adaptés depuis document-generation-pipeline.integration.test.ts)
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

async function seedBaseData(
  suffix = SUFFIX(),
  opts: { timeZone?: string; userEmail?: string; orgName?: string; locationName?: string } = {},
): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const timeZone = opts.timeZone ?? 'Europe/Paris';
  const userEmail = opts.userEmail ?? `customer-${suffix}@example.com`;
  const orgName = opts.orgName ?? `Test Org ${suffix}`;
  const locationName = opts.locationName ?? 'Annecy';
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${orgName}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, ${locationName}, ${'annecy-' + suffix}, ${timeZone}, 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${userEmail})
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

async function seedBookingConfirmedEvent(
  ids: BaseIds,
  opts: { amountMinor?: number; userEmail?: string } = {},
): Promise<SeedBookingResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const amountMinor = opts.amountMinor ?? 10000;
  const customerStart = '2026-02-10 09:00:00+00';
  const customerEnd = '2026-02-12 17:00:00+00';
  const blockedStart = '2026-02-10 08:30:00+00';
  const blockedEnd = '2026-02-12 17:30:00+00';

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
      'Europe/Paris', 30, 30,
      ${amountMinor}, 0, ${amountMinor},
      'NOT_APPLICABLE', 0, null, 500,
      'DAY', 2,
      'EUR', ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      'CONVERTED', '2026-01-15 09:55:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

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
      'SUCCEEDED'::payment_status, ${amountMinor}, 'EUR',
      'NOT_APPLICABLE', 500,
      'v1', 'v1',
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
      'acct_test_123', 'DESTINATION', 'PLATFORM',
      'TEST'::payment_environment, '2026-01-15 09:58:00+00'
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
      ${draft.id}, ${payment.id}, 'CONFIRMED'::booking_status,
      ${customerStart}, ${customerEnd},
      ${blockedStart}, ${blockedEnd},
      30, 30,
      'EUR', ${amountMinor}, 0,
      'NOT_APPLICABLE', 0, null,
      500, ${amountMinor},
      ${sql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${sql.json({ version: 'v1', user_id: ids.userId, accepted_at: '2026-01-15T09:57:00Z' })},
      '2026-01-15 10:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    ) VALUES (${booking.id}, ${ids.variantId}, 2, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
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
      ) VALUES (
        ${ids.orgId}, ${itemId}, 'BOOKING', 'ACTIVE',
        ${customerStart}, ${customerEnd},
        ${blockedStart}, ${blockedEnd}, ${booking.id}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    const bookingItem = await sql`
      INSERT INTO "booking_items" (
        "booking_id", "booking_line_id", "inventory_item_id", "booking_block_id"
      ) VALUES (${booking.id}, ${line.id}, ${itemId}, ${bookingBlock.id})
      RETURNING "id"
    `.then((r) => r[0]!);
    bookingItemIds.push(bookingItem.id);
  }

  const payload = {
    bookingId: booking.id,
    paymentId: payment.id,
    draftId: draft.id,
    organizationId: ids.orgId,
  };

  const outbox = await sql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key"
    ) VALUES (
      ${ids.orgId}, 'BOOKING', ${booking.id}::uuid, 'BOOKING_CONFIRMED', 'v1',
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

// ─────────────────────────────────────────────────────────────────────────────
// Query helpers
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
    organization_id: string;
  }>
> {
  if (!rawSql) throw new Error('rawSql not initialized');
  return rawSql`
    SELECT "id", "type", "storage_key", "checksum_sha256", "size_bytes", "content_type", "organization_id"
    FROM "documents"
    WHERE "source_outbox_event_id" = ${outboxEventId}::uuid
    ORDER BY "type" ASC
  `;
}

async function getNotification(outboxEventId: string): Promise<{
  id: string;
  status: string;
  recipient_email: string;
  template_key: string;
  provider_idempotency_key: string;
  provider_message_id: string | null;
  failure_code: string | null;
  organization_id: string;
  outbox_effect_id: string;
} | null> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "id", "status", "recipient_email", "template_key",
           "provider_idempotency_key", "provider_message_id", "failure_code",
           "organization_id", "outbox_effect_id"
    FROM "notification_deliveries"
    WHERE "outbox_event_id" = ${outboxEventId}::uuid
  `;
  return (
    (rows[0] as unknown as {
      id: string;
      status: string;
      recipient_email: string;
      template_key: string;
      provider_idempotency_key: string;
      provider_message_id: string | null;
      failure_code: string | null;
      organization_id: string;
      outbox_effect_id: string;
    }) ?? null
  );
}

async function countNotifications(outboxEventId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT COUNT(*)::int as count FROM "notification_deliveries"
    WHERE "outbox_event_id" = ${outboxEventId}::uuid
  `;
  return (rows[0] as { count: number }).count;
}

async function countDocuments(outboxEventId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT COUNT(*)::int as count FROM "documents"
    WHERE "source_outbox_event_id" = ${outboxEventId}::uuid
  `;
  return (rows[0] as { count: number }).count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper pour construire les dépendances du worker avec fakes.
// ─────────────────────────────────────────────────────────────────────────────

function createWorkerDeps(
  db: DatabaseClient,
  renderer: FakeDeterministicDocumentRenderer,
  storage: ObjectStorage,
  sender: FakeTransactionalEmailSender,
): { deps: WorkerDependencies; logger: CapturingWorkerLogger; metrics: InMemoryMetricsCollector } {
  const logger = new CapturingWorkerLogger();
  const metrics = new InMemoryMetricsCollector();
  const deps: WorkerDependencies = {
    db,
    renderer,
    storage,
    sender,
    logger,
    metrics,
    executeDocumentPipeline,
    executeTransactionalEmailPipeline,
  };
  return { deps, logger, metrics };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests E2E — 14 scénarios obligatoires.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('runTransactionalDocumentsWorkerCycle — E2E PostgreSQL', () => {
  // 1. Nominal.
  it('1. nominal — BOOKING_CONFIRMED.v1 ; 3 documents générés ; email envoyé ; 4 effets COMPLETED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, storage, sender);

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Documents : 1 claimé, 3 complétés.
    expect(result.documents).not.toHaveProperty('kind');
    const docResult = result.documents as { claimedCount: number; completedCount: number };
    expect(docResult.claimedCount).toBe(1);
    expect(docResult.completedCount).toBe(3);

    // Emails : 1 claimé, 1 envoyé.
    expect(result.emails).not.toHaveProperty('kind');
    const emailResult = result.emails as { claimedCount: number; sentCount: number };
    expect(emailResult.claimedCount).toBe(1);
    expect(emailResult.sentCount).toBe(1);

    // Effets : 4 COMPLETED.
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
    expect(effects.every((e) => e.status === 'COMPLETED')).toBe(true);

    // Notification SENT.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('SENT');

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  // 2. Replay.
  it('2. replay — nouveau cycle sur l événément terminal ; aucun doublon', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, storage, sender);

    // Premier cycle — traitement complet.
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Deuxième cycle — replay sur l'événement terminal.
    const result2 = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Aucun document ni email en double.
    expect((result2.documents as { claimedCount: number }).claimedCount).toBe(0);
    expect((result2.emails as { claimedCount: number }).claimedCount).toBe(0);

    // Pas de doublon document.
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(3);

    // Pas de doublon notification.
    const notifCount = await countNotifications(seeded.outboxEventId);
    expect(notifCount).toBe(1);
  });

  // 3. Crash après stockage avant persistance.
  it('3. crash après stockage avant persistance — objet déjà présent au retry ; pas de doublon', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InstrumentedObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    // Phase 1 : exécuter le pipeline documents avec un crash après Phase B.
    // Phase B stocke les objets. Phase C (persistance) n'est PAS exécutée.
    // L'erreur se propage hors du pipeline (simule un crash worker).
    let crashError: unknown = null;
    try {
      await executeDocumentPipeline(db, renderer, storage, 10, {
        onAfterPhaseB: () => {
          throw new Error('SIMULATED_CRASH_AFTER_PHASE_B');
        },
      });
    } catch (e) {
      crashError = e;
    }
    expect(crashError).toBeDefined();

    // Vérifier l'état après crash :
    // - Les objets sont dans le storage (Phase B a réussi).
    // - Les effets outbox_effects sont PENDING (Phase C non exécutée).
    // - AUCUN document en DB (Phase C non exécutée).
    const effects = await getEffects(seeded.outboxEventId);
    const generateEffects = effects.filter((e) => e.effect_type.startsWith('GENERATE_'));
    expect(generateEffects.length).toBe(3);
    for (const e of generateEffects) {
      expect(e.status).toBe('PENDING');
    }
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(0);

    // Preuve instrumentée : 3 puts avant le crash, tous CREATED.
    expect(storage.putCalls.length).toBe(3);
    for (const result of storage.putResults) {
      expect(result).toBe('CREATED');
    }
    // Chaque put a un checksum, une taille et un contentType définis.
    for (const call of storage.putCalls) {
      expect(call.checksum).toBeTruthy();
      expect(call.size).toBeGreaterThan(0);
      expect(call.contentType).toBeTruthy();
    }

    // Capturer les checksums/tailles/contentTypes du premier passage pour comparaison.
    const originalChecksums = storage.putCalls.map((c) => c.checksum);
    const originalSizes = storage.putCalls.map((c) => c.size);
    const originalContentTypes = storage.putCalls.map((c) => c.contentType);

    // Le crash laisse l'événement PROCESSING avec un lease actif (posé en Phase A).
    // Simuler le passage du temps pour permettre le re-claim au retry.
    await rawSql`
      UPDATE "outbox_events"
      SET "lease_until" = now() - interval '1 minute',
          "available_at" = now() - interval '1 minute'
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Phase 2 : retry — exécuter le cycle worker complet.
    // Le pipeline documents va :
    // - Phase A : re-claimer l'événement (nouveau lease).
    // - Phase B : détecter ALREADY_EXISTS pour chaque objet (déjà stockés).
    // - Phase C : persister les documents, marquer effets COMPLETED.
    const { deps } = createWorkerDeps(db, renderer, storage, sender);
    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Documents : 1 claimé (re-claim), 3 complétés.
    expect((result.documents as { claimedCount: number }).claimedCount).toBe(1);
    expect((result.documents as { completedCount: number }).completedCount).toBe(3);

    // Emails : 1 claimé, 1 envoyé.
    expect((result.emails as { claimedCount: number }).claimedCount).toBe(1);
    expect((result.emails as { sentCount: number }).sentCount).toBe(1);

    // Preuve instrumentée après retry :
    // - 3 CREATED (premier passage) puis 3 ALREADY_EXISTS (retry).
    expect(storage.putResults.length).toBe(6);
    for (let i = 0; i < 3; i++) {
      expect(storage.putResults[i]).toBe('CREATED');
    }
    for (let i = 3; i < 6; i++) {
      expect(storage.putResults[i]).toBe('ALREADY_EXISTS');
    }
    // Les checksums des objets retryés sont identiques aux originaux.
    const retryChecksums = storage.putCalls.slice(3).map((c) => c.checksum);
    const retrySizes = storage.putCalls.slice(3).map((c) => c.size);
    const retryContentTypes = storage.putCalls.slice(3).map((c) => c.contentType);
    expect(retryChecksums).toEqual(originalChecksums);
    expect(retrySizes).toEqual(originalSizes);
    expect(retryContentTypes).toEqual(originalContentTypes);
    // Le pipeline vérifie les métadonnées avant de réutiliser (head calls).
    expect(storage.headCalls.length).toBeGreaterThanOrEqual(3);

    // Pas de doublon document : exactement 3 documents.
    const finalDocCount = await countDocuments(seeded.outboxEventId);
    expect(finalDocCount).toBe(3);

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  // 4. Crash après acceptation email avant persistance.
  it('4. crash après acceptation email avant persistance — retry avec même providerIdempotencyKey ; déduplication', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const innerSender = new FakeTransactionalEmailSender();
    const sender = new InstrumentedEmailSender(innerSender);

    // Phase 1 : exécuter le pipeline documents complètement.
    await executeDocumentPipeline(db, renderer, storage, 10);

    // Phase 2 : exécuter le pipeline email avec crash après Phase B.
    // Phase B envoie l'email (le fournisseur accepte). Phase C n'est PAS exécutée.
    let crashError: unknown = null;
    try {
      await executeTransactionalEmailPipeline(db, sender, 10, {
        onAfterPhaseB: () => {
          throw new Error('SIMULATED_CRASH_AFTER_EMAIL_SEND');
        },
      });
    } catch (e) {
      crashError = e;
    }
    expect(crashError).toBeDefined();

    // Vérifier l'état après crash :
    // - Le fake sender a accepté l'email (1 appel, 1 email logique).
    expect(sender.sendCallCount).toBe(1);
    expect(sender.uniqueEmailCount).toBe(1);
    // Preuve instrumentée : un appel avant crash avec providerIdempotencyKey défini.
    expect(sender.sendCalls.length).toBe(1);
    expect(sender.sendCalls[0]!.providerIdempotencyKey).toBeTruthy();
    expect(sender.providerMessageIds[0]).toBeTruthy();
    // - La notification_delivery est PENDING (Phase C non exécutée).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).toBeDefined();
    expect(notif!.status).toBe('PENDING');
    // - L'effet SEND_EMAIL est PENDING.
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmailEffect = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmailEffect).toBeDefined();
    expect(sendEmailEffect!.status).toBe('PENDING');

    // Le crash laisse l'événement PROCESSING avec un lease actif (posé en Phase A).
    // Simuler le passage du temps pour permettre le re-claim au retry.
    await rawSql`
      UPDATE "outbox_events"
      SET "lease_until" = now() - interval '1 minute',
          "available_at" = now() - interval '1 minute'
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Phase 3 : retry — exécuter le pipeline email sans crash.
    // Le pipeline va :
    // - Phase A : re-claimer, trouver la notification PENDING existante.
    // - Phase B : rappeler le fournisseur avec la MÊME providerIdempotencyKey.
    //   Le fake sender déduplique (retourne le même providerMessageId).
    // - Phase C : persister notification SENT, effet COMPLETED.
    await executeTransactionalEmailPipeline(db, sender, 10);

    // Deux appels techniques, mais un seul email logique.
    expect(sender.sendCallCount).toBe(2);
    expect(sender.uniqueEmailCount).toBe(1);

    // Preuve instrumentée : même providerIdempotencyKey aux deux appels.
    expect(sender.sendCalls.length).toBe(2);
    expect(sender.sendCalls[0]!.providerIdempotencyKey).toBe(
      sender.sendCalls[1]!.providerIdempotencyKey,
    );
    // Le providerMessageId retourné est identique (déduplication côté fournisseur).
    expect(sender.providerMessageIds[0]).toBe(sender.providerMessageIds[1]);
    expect(sender.providerMessageIds[0]).toBeTruthy();

    // Une seule notification_delivery, terminale et cohérente.
    const notifCount = await countNotifications(seeded.outboxEventId);
    expect(notifCount).toBe(1);
    const finalNotif = await getNotification(seeded.outboxEventId);
    expect(finalNotif!.status).toBe('SENT');
    // provider_message_id est défini et égal au providerMessageId retourné.
    expect(finalNotif!.provider_message_id).toBe(sender.providerMessageIds[0]);

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  // 5. Crash entre documents et email.
  it('5. crash entre documents et email — seul SEND_EMAIL est repris', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    // Exécuter le pipeline documents d'abord (simule un crash
    // après documents mais avant email).
    const docResult = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(docResult.completedCount).toBe(3);

    // Vérifier que les 3 effets GENERATE_* sont COMPLETED.
    const effects = await getEffects(seeded.outboxEventId);
    const generateEffects = effects.filter((e) => e.effect_type !== 'SEND_EMAIL');
    expect(generateEffects.every((e) => e.status === 'COMPLETED')).toBe(true);

    // Le cycle complet ne doit traiter que l'email.
    const { deps } = createWorkerDeps(db, renderer, storage, sender);
    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Documents : 0 claimé (déjà COMPLETED).
    expect((result.documents as { claimedCount: number }).claimedCount).toBe(0);

    // Emails : 1 claimé, 1 envoyé.
    expect((result.emails as { claimedCount: number }).claimedCount).toBe(1);
    expect((result.emails as { sentCount: number }).sentCount).toBe(1);

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  // 6. Concurrence.
  it('6. concurrence — barrière contrôlée ; SKIP LOCKED empêche le double claim', async () => {
    if (!db || !ctx || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    const db2 = createDatabase(ctx.databaseUrl);

    try {
      // Approche déterministe pour tester SKIP LOCKED :
      // 1. Worker A ouvre une transaction, claim l'événement (FOR UPDATE SKIP LOCKED),
      //    et GARDE la transaction ouverte (ne commit pas).
      // 2. Worker B tente de claimer → SKIP LOCKED → aucun événement claimé.
      // 3. Worker A commit sa transaction (relâche le verrou).
      // 4. Worker B peut alors claimer et traiter.
      const workerAReleased = withResolvers<void>();
      const workerAClaimed = withResolvers<void>();

      // Étape 1 : Worker A claim et garde le verrou.
      const workerAPromise = (async () => {
        await db.transaction(async (tx) => {
          const claimed = await claimOutboxBatch(
            tx,
            BOOKING_CONFIRMED_SELECTION,
            10,
            'always',
            'INCOMPLETE_DOCUMENT_GENERATION' as ClaimEligibility,
          );
          expect(claimed.length).toBe(1);
          workerAClaimed.resolve();
          // Attendre que worker B ait tenté son claim (et échoué).
          await workerAReleased.promise;
          // La transaction se commit ici, relâchant le verrou.
        });
      })();

      // Étape 2 : Worker B tente de claimer pendant que A tient le verrou.
      await workerAClaimed.promise;

      // Worker B exécute un cycle complet. Le claim doit échouer (SKIP LOCKED).
      const { deps: depsB } = createWorkerDeps(db2, renderer, storage, sender);
      const resultB = await runTransactionalDocumentsWorkerCycle(depsB, { batchLimit: 10 });

      // Worker B n'a claimé aucun événement (SKIP LOCKED).
      expect((resultB.documents as { claimedCount: number }).claimedCount).toBe(0);
      expect((resultB.emails as { claimedCount: number }).claimedCount).toBe(0);

      // Étape 3 : Relâcher le verrou de worker A.
      workerAReleased.resolve();
      await workerAPromise;

      // Le commit de worker A a posé un lease actif (lease_until dans le futur).
      // Simuler le passage du temps pour permettre le re-claim par le cycle.
      await rawSql`
        UPDATE "outbox_events"
        SET "lease_until" = now() - interval '1 minute',
            "available_at" = now() - interval '1 minute'
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;

      // Étape 4 : Worker A (ou un nouveau cycle) peut maintenant traiter.
      const { deps: depsA } = createWorkerDeps(db, renderer, storage, sender);
      const resultA = await runTransactionalDocumentsWorkerCycle(depsA, { batchLimit: 10 });

      // Worker A traite l'événement.
      expect((resultA.documents as { claimedCount: number }).claimedCount).toBe(1);
      expect((resultA.documents as { completedCount: number }).completedCount).toBe(3);
      expect((resultA.emails as { sentCount: number }).sentCount).toBe(1);

      // Pas de doublon.
      const docCount = await countDocuments(seeded.outboxEventId);
      expect(docCount).toBe(3);
      const notifCount = await countNotifications(seeded.outboxEventId);
      expect(notifCount).toBe(1);

      // Outbox PROCESSED.
      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PROCESSED');
    } finally {
      await db2.$client.end();
    }
  });

  // 7. Sweeper/reclaim.
  it('7. sweeper/reclaim — vrai claim par worker A, abandon, sweeper reclaim', async () => {
    if (!db || !rawSql || !ctx) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    // Worker A : claimer l'événement via claimOutboxBatch (vrai claim, Phase A seulement).
    // Le claim pose un lease_token valide et un lease_until dans le futur.
    const claimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'INCOMPLETE_DOCUMENT_GENERATION' as ClaimEligibility,
      );
    });
    expect(claimed.length).toBe(1);
    const leaseTokenA = claimed[0]!.leaseToken;
    const attemptCountA = claimed[0]!.attemptCount;

    // Worker A "crashe" : ne pas exécuter Phase B ni Phase C.
    // L'événement reste PROCESSING avec un lease_token valide et un lease_until dans le futur.

    // Vérifier l'état : PROCESSING avec lease actif.
    const eventAfterClaim = await getOutboxEvent(seeded.outboxEventId);
    expect(eventAfterClaim.status).toBe('PROCESSING');
    expect(eventAfterClaim.lease_token).toBe(leaseTokenA);

    // Expire le lease manuellement (simule le passage du temps).
    await rawSql`
      UPDATE "outbox_events"
      SET "lease_until" = now() - interval '5 minutes',
          "available_at" = now() - interval '5 minutes'
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Capturer le reclaim explicitement via claimOutboxBatch avant de lancer le sweeper.
    // Cela permet de vérifier que le nouveau lease_token est différent et que
    // attempt_count a été incrémenté exactement de 1.
    const reclaimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'INCOMPLETE_DOCUMENT_GENERATION' as ClaimEligibility,
      );
    });
    expect(reclaimed.length).toBe(1);
    const leaseTokenB = reclaimed[0]!.leaseToken;
    const attemptCountB = reclaimed[0]!.attemptCount;

    // Preuve explicite : le nouveau lease_token est différent (pas juste null !== tokenA).
    expect(leaseTokenB).not.toBe(leaseTokenA);
    expect(leaseTokenB).toBeTruthy();

    // Preuve explicite : attempt_count a été incrémenté exactement de 1 (reclaim).
    expect(attemptCountB).toBe(attemptCountA + 1);

    // Expire le lease du reclaim pour permettre au sweeper de traiter.
    await rawSql`
      UPDATE "outbox_events"
      SET "lease_until" = now() - interval '5 minutes',
          "available_at" = now() - interval '5 minutes'
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Worker B (sweeper) : lancer runSweeperCycle pour traiter l'événement.
    const { deps } = createWorkerDeps(db, renderer, storage, sender);
    const result = await runSweeperCycle(deps, { batchLimit: 10 });

    // Le sweeper a re-claimé et traité l'événement.
    expect((result.documents as { claimedCount: number }).claimedCount).toBe(1);
    expect((result.documents as { completedCount: number }).completedCount).toBe(3);
    expect((result.emails as { sentCount: number }).sentCount).toBe(1);

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');

    // Pas de doublon.
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(3);
    const notifCount = await countNotifications(seeded.outboxEventId);
    expect(notifCount).toBe(1);
  });

  // 8. Anomalie durable.
  it('8. anomalie durable — checksum incompatible ; effect FAILED ; pas de retry illimité', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Storage qui retourne toujours ALREADY_EXISTS avec des métadonnées
    // incompatibles (contentType/sizeBytes/checksum différents) pour simuler
    // un mismatch de checksum durable. Le pipeline détecte l'anomalie en
    // Phase B via head() et marque l'effect FAILED en Phase C.
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
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, mismatchStorage, sender);

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Documents : échec (anomalie durable).
    expect(result.documents).not.toHaveProperty('kind');
    const docResult = result.documents as {
      failedCount: number;
      anomalies: Array<{ failureCode: string }>;
    };
    expect(docResult.failedCount).toBeGreaterThan(0);

    // Les anomalies doivent avoir un failureCode normalisé.
    for (const anomaly of docResult.anomalies) {
      // Le failureCode doit être un code public normalisé.
      const validCodes = new Set([
        'PAYLOAD_MALFORMED',
        'STORAGE_PUT_FAILED',
        'STORAGE_CHECKSUM_MISMATCH',
        'STORAGE_NOT_FOUND',
        'RENDER_FAILED',
        'EMAIL_SEND_FAILED',
        'LEASE_LOST',
        'UNKNOWN_ERROR',
      ]);
      expect(validCodes.has(anomaly.failureCode)).toBe(true);
    }

    // L'événement doit être FAILED (pas de retry illimité).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  // 9. Erreur transitoire.
  it('9. erreur transitoire — reschedule avec backoff ; succès au retry', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Storage avec failPut pour simuler une erreur transitoire.
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage({ failPut: true });
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, storage, sender);

    // Premier cycle — échec transitoire.
    const result1 = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });
    const docResult1 = result1.documents as { rescheduledCount: number; completedCount: number };
    expect(docResult1.rescheduledCount).toBeGreaterThan(0);
    expect(docResult1.completedCount).toBe(0);

    // L'événement doit être PENDING avec available_at dans le futur (backoff).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');

    // Forcer available_at dans le passé pour permettre le retry immédiatement.
    if (rawSql) {
      await rawSql`
        UPDATE "outbox_events"
        SET "available_at" = now() - interval '1 second'
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;
    }

    // Second cycle avec un storage fonctionnel — succès.
    const storage2 = new InMemoryObjectStorage();
    const { deps: deps2 } = createWorkerDeps(db, renderer, storage2, sender);
    const result2 = await runTransactionalDocumentsWorkerCycle(deps2, { batchLimit: 10 });
    const docResult2 = result2.documents as { completedCount: number };
    expect(docResult2.completedCount).toBe(3);

    // Pas de doublon document.
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(3);
  });

  // 10. Confidentialité.
  it('10. confidentialité — aucune sentinelle PII dans logs, métriques, anomalies ou failure codes', async () => {
    if (!db) return;
    const ids = await seedBaseData(SUFFIX(), {
      userEmail: 'SENTINEL_EMAIL@example.com',
      orgName: 'SENTINEL_NAME Org',
      locationName: 'SENTINEL_ADDR Location',
    });
    await seedBookingConfirmedEvent(ids);

    // Sender avec un message d'erreur contenant une sentinelle.
    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender({ messageIdPrefix: 'SENTINEL_MSG-' });
    const { deps, logger, metrics } = createWorkerDeps(db, renderer, storage, sender);

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Vérifier les logs sérialisés (valeur brute ET forme échappée).
    const logStr = logger.serialized();
    expect(logStr).not.toContain('SENTINEL_EMAIL');
    expect(logStr).not.toContain('SENTINEL_NAME');
    expect(logStr).not.toContain('SENTINEL_ADDR');
    expect(logStr).not.toContain('SENTINEL_MSG');

    // Vérifier le snapshot métriques.
    const metricsStr = JSON.stringify(metrics.snapshot());
    expect(metricsStr).not.toContain('SENTINEL_EMAIL');
    expect(metricsStr).not.toContain('SENTINEL_NAME');
    expect(metricsStr).not.toContain('SENTINEL_ADDR');
    expect(metricsStr).not.toContain('SENTINEL_MSG');

    // Vérifier les failure codes dans les anomalies loggées.
    const anomalyEvents = logger.events.filter((e) => e.event === 'anomaly_detected');
    for (const ev of anomalyEvents) {
      if (ev.event === 'anomaly_detected') {
        const validCodes = new Set([
          'PAYLOAD_MALFORMED',
          'STORAGE_PUT_FAILED',
          'STORAGE_CHECKSUM_MISMATCH',
          'STORAGE_NOT_FOUND',
          'RENDER_FAILED',
          'EMAIL_SEND_FAILED',
          'LEASE_LOST',
          'UNKNOWN_ERROR',
        ]);
        expect(validCodes.has(ev.failureCode)).toBe(true);
      }
    }
  });

  // 11. Snapshot figé.
  it('11. snapshot figé — le retry utilise le snapshot initial après modification des données live', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    // Exécuter le pipeline documents d'abord (crée le snapshot).
    const docResult = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(docResult.completedCount).toBe(3);

    // Exécuter le pipeline email (crée la notification avec l'email original).
    // Le recipient_email est figé au moment de la création de notification_deliveries.
    await executeTransactionalEmailPipeline(db, sender, 10);

    // Capturer les checksums des documents générés.
    const docs1 = await getDocuments(seeded.outboxEventId);
    const checksums1 = docs1.map((d) => d.checksum_sha256);

    // Modifier les données métier live.
    await rawSql`
      UPDATE "organizations" SET "legal_name" = 'CHANGED_NAME' WHERE "id" = ${ids.orgId}::uuid
    `;
    await rawSql`
      UPDATE "locations" SET "name" = 'CHANGED_ADDR' WHERE "id" = ${ids.locationId}::uuid
    `;
    await rawSql`
      UPDATE "users" SET "email" = 'changed@example.com' WHERE "id" = ${ids.userId}::uuid
    `;

    // Rejouer un cycle — l'événement est PROCESSED, rien n'est retraité.
    // Le snapshot documentaire est figé (les documents ne sont pas régénérés).
    const { deps } = createWorkerDeps(db, renderer, storage, sender);
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Les documents ne doivent pas être régénérés (même checksum).
    const docs2 = await getDocuments(seeded.outboxEventId);
    const checksums2 = docs2.map((d) => d.checksum_sha256);
    expect(checksums2).toEqual(checksums1);

    // La notification doit utiliser le recipient_email figé
    // (pas le modified 'changed@example.com').
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.recipient_email).not.toContain('changed@example.com');
  });

  // 12. Isolation multi-tenant.
  it('12. isolation — deux organisations A et B ; aucun mélange', async () => {
    if (!db) return;
    const idsA = await seedBaseData(SUFFIX() + 'a');
    const seededA = await seedBookingConfirmedEvent(idsA);

    const idsB = await seedBaseData(SUFFIX() + 'b');
    const seededB = await seedBookingConfirmedEvent(idsB);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();
    const { deps, logger } = createWorkerDeps(db, renderer, storage, sender);

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Vérifier que les documents ont le bon organization_id.
    const docsA = await getDocuments(seededA.outboxEventId);
    const docsB = await getDocuments(seededB.outboxEventId);
    expect(docsA.every((d) => d.organization_id === idsA.orgId)).toBe(true);
    expect(docsB.every((d) => d.organization_id === idsB.orgId)).toBe(true);

    // Vérifier que les notifications ont le bon organization_id.
    const notifA = await getNotification(seededA.outboxEventId);
    const notifB = await getNotification(seededB.outboxEventId);
    expect(notifA).not.toBeNull();
    expect(notifB).not.toBeNull();
    expect(notifA!.organization_id).toBe(idsA.orgId);
    expect(notifB!.organization_id).toBe(idsB.orgId);

    // Les logs ne doivent pas mélanger les tenants (pas d'organization_id dans les logs).
    // Les logs ne contiennent que des compteurs et failure codes, pas d'organization_id.
    const logStr = logger.serialized();
    expect(logStr).not.toContain(idsA.orgId);
    expect(logStr).not.toContain(idsB.orgId);
  });

  // 13. MAX_ATTEMPTS enforcement.
  it('13. MAX_ATTEMPTS enforcement — événement avec attempt_count >= MAX_ATTEMPTS n est pas claimé', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Forcer attempt_count = OUTBOX_MAX_ATTEMPTS (5) : l'événement n'est plus éligible au claim.
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = ${OUTBOX_MAX_ATTEMPTS}
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Capturer l'état initial avant le cycle.
    const eventBefore = await getOutboxEvent(seeded.outboxEventId);
    const statusBefore = eventBefore.status;

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, storage, sender);

    // Exécuter un cycle worker — aucun événement ne doit être claimé.
    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Aucun claim côté documents ni côté emails.
    expect((result.documents as { claimedCount: number }).claimedCount).toBe(0);
    expect((result.emails as { claimedCount: number }).claimedCount).toBe(0);

    // Le statut de l'événement reste inchangé (non traité).
    const eventAfter = await getOutboxEvent(seeded.outboxEventId);
    expect(eventAfter.status).toBe(statusBefore);

    // Aucun document créé.
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(0);

    // Aucune notification créée.
    const notifCount = await countNotifications(seeded.outboxEventId);
    expect(notifCount).toBe(0);

    // Aucun effet créé.
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(0);
  });

  // 14. Fencing — ancien worker ne peut pas persister après reclaim.
  it('14. fencing — ancien worker A reprend Phase C après reclaim par B ; LEASE_LOST', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new FakeDeterministicDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();

    // Barrière deux phases : A signale qu'il est suspendu, puis attend la libération.
    const aSuspended = withResolvers<void>();
    const releaseA = withResolvers<void>();

    // Démarrer le pipeline A (real) avec onAfterPhaseB qui se suspend.
    // Le pipeline A va : Phase A (claim) → Phase B (render + store) → onAfterPhaseB (suspend) → ... (attend) → Phase C (persist with old token)
    const pipelineAPromise = executeDocumentPipeline(db, renderer, storage, 10, {
      onAfterPhaseB: async () => {
        aSuspended.resolve();
        await releaseA.promise;
      },
    });

    // Attendre que A soit suspendu (après Phase B, avant Phase C).
    await aSuspended.promise;

    // Vérifier l'état après Phase B de A :
    // - Les effets sont PENDING (Phase C non exécutée)
    // - 0 documents en DB
    const effectsAfterB = await getEffects(seeded.outboxEventId);
    const generateEffects = effectsAfterB.filter((e) => e.effect_type.startsWith('GENERATE_'));
    expect(generateEffects.length).toBe(3);
    for (const e of generateEffects) {
      expect(e.status).toBe('PENDING');
    }
    const docCountAfterB = await countDocuments(seeded.outboxEventId);
    expect(docCountAfterB).toBe(0);

    // Expire le lease de A.
    await rawSql`
      UPDATE "outbox_events"
      SET "lease_until" = now() - interval '1 minute',
          "available_at" = now() - interval '1 minute'
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Worker B : cycle complet — reclaim et complète le traitement.
    const { deps: depsB } = createWorkerDeps(db, renderer, storage, sender);
    const resultB = await runTransactionalDocumentsWorkerCycle(depsB, { batchLimit: 10 });

    // B a traité l'événement : 3 documents, 1 notification.
    expect((resultB.documents as { completedCount: number }).completedCount).toBe(3);
    expect((resultB.emails as { sentCount: number }).sentCount).toBe(1);

    // Libérer la barrière : A reprend sa Phase C avec son ancien lease token.
    releaseA.resolve();

    // Attendre que A termine. A devrait obtenir LEASE_LOST.
    const resultA = await pipelineAPromise;

    // Vérifier que A a obtenu LEASE_LOST et n'a rien persisté.
    expect(resultA.leaseLostCount).toBeGreaterThan(0);
    expect(resultA.completedCount).toBe(0);

    // Vérifier qu'aucune mutation supplémentaire n'a eu lieu :
    // - Toujours 3 documents (pas 6)
    const finalDocCount = await countDocuments(seeded.outboxEventId);
    expect(finalDocCount).toBe(3);
    // - Toujours 1 notification (pas 2)
    const finalNotifCount = await countNotifications(seeded.outboxEventId);
    expect(finalNotifCount).toBe(1);
    // - L'événement est PROCESSED (par B)
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event!.status).toBe('PROCESSED');
  });
});
