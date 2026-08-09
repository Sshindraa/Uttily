/**
 * @uttily/worker — Test d'intégration PostgreSQL du pipeline avec le vrai PdfLibDocumentRenderer (G5H-C2C-B2).
 *
 * Ce test utilise le VRAI `PdfLibDocumentRenderer` (pas un fake) avec un
 * `InMemoryObjectStorage` (fake) et un `FakeTransactionalEmailSender` (fake).
 *
 * Vérifications :
 * 1. Trois effets GENERATE_* sont COMPLETED après exécution du pipeline documents.
 * 2. L'effet SEND_EMAIL reste PENDING (traité séparément par le pipeline email).
 * 3. Trois documents existent avec contentType: 'application/pdf'.
 * 4. Checksums et sizes sont cohérents (SHA-256, non vides).
 * 5. Replay (re-exécution) → mêmes objets, mêmes checksums, pas de STORAGE_CHECKSUM_MISMATCH.
 * 6. Pas de mutation cross-tenant.
 *
 * Les seed helpers sont dupliqués depuis worker-e2e.integration.test.ts (self-contained).
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
  InMemoryObjectStorage,
  FakeTransactionalEmailSender,
  executeDocumentPipeline,
  executeTransactionalEmailPipeline,
  type ObjectStorage,
} from '@uttily/core';

import { runTransactionalDocumentsWorkerCycle } from '../worker-cycle';
import type { WorkerDependencies } from '../worker-cycle';
import { CapturingWorkerLogger } from '../logger';
import { InMemoryMetricsCollector } from '../metrics';
import { PdfLibDocumentRenderer } from './pdf-lib-document-renderer';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5hpdfpipeline');
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
// Seed helpers (adaptés depuis worker-e2e.integration.test.ts)
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

async function countDocuments(outboxEventId: string): Promise<number> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT COUNT(*)::int as count FROM "documents"
    WHERE "source_outbox_event_id" = ${outboxEventId}::uuid
  `;
  return (rows[0] as { count: number }).count;
}

async function getOutboxEvent(outboxEventId: string): Promise<{
  status: string;
  attempt_count: number;
  processed_at: Date | null;
}> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "status", "attempt_count", "processed_at"
    FROM "outbox_events"
    WHERE "id" = ${outboxEventId}::uuid
  `;
  return rows[0] as { status: string; attempt_count: number; processed_at: Date | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper pour construire les dépendances du worker avec le vrai PdfLibDocumentRenderer.
// ─────────────────────────────────────────────────────────────────────────────

function createWorkerDeps(
  db: DatabaseClient,
  renderer: PdfLibDocumentRenderer,
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('PdfLibDocumentRenderer — pipeline d intégration PostgreSQL', () => {
  // ── 1. Nominal : 3 documents PDF générés, SEND_EMAIL reste PENDING ──
  it('génère 3 documents PDF avec le vrai PdfLibDocumentRenderer ; SEND_EMAIL reste PENDING', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new PdfLibDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // Exécuter uniquement le pipeline documents (pas l'email).
    const docResult = await executeDocumentPipeline(db, renderer, storage, 10);

    expect(docResult.claimedCount).toBe(1);
    expect(docResult.completedCount).toBe(3);
    expect(docResult.failedCount).toBe(0);

    // Vérifier les effets.
    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);

    const generateEffects = effects.filter((e) => e.effect_type.startsWith('GENERATE_'));
    expect(generateEffects).toHaveLength(3);
    expect(generateEffects.every((e) => e.status === 'COMPLETED')).toBe(true);

    const sendEmailEffect = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmailEffect).toBeDefined();
    expect(sendEmailEffect!.status).toBe('PENDING');

    // Vérifier les documents.
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.content_type === 'application/pdf')).toBe(true);

    // Vérifier les checksums et sizes.
    for (const doc of docs) {
      expect(doc.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(doc.size_bytes)).toBeGreaterThan(0);
      expect(doc.storage_key).toBeTruthy();
      expect(doc.organization_id).toBe(ids.orgId);
    }
    // Le PDF réel produit par pdf-lib fait ~200 KB, bien supérieur à 0.
    const totalSize = docs.reduce((sum, d) => sum + Number(d.size_bytes), 0);
    expect(totalSize).toBeGreaterThan(100000);

    // Les trois types de documents doivent être distincts.
    const docTypes = docs.map((d) => d.type);
    expect(new Set(docTypes).size).toBe(3);

    // Les checksums doivent être distincts (templates différents).
    const checksums = docs.map((d) => d.checksum_sha256);
    expect(new Set(checksums).size).toBe(3);
  });

  // ── 2. Replay : mêmes objets, mêmes checksums, pas de STORAGE_CHECKSUM_MISMATCH ──
  it('replay — re-exécution produit les mêmes checksums sans STORAGE_CHECKSUM_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new PdfLibDocumentRenderer();
    const storage = new InMemoryObjectStorage();

    // Premier cycle : génère les documents.
    const docResult1 = await executeDocumentPipeline(db, renderer, storage, 10);
    expect(docResult1.completedCount).toBe(3);

    const docs1 = await getDocuments(seeded.outboxEventId);

    // Re-exécuter le pipeline documents (replay).
    // L'événement est maintenant PROCESSING avec un lease ; expirer le lease pour permettre le re-claim.
    // Nuller lease_token ET lease_until pour respecter la CHECK constraint.
    if (rawSql) {
      await rawSql`
        UPDATE "outbox_events"
        SET "lease_token" = NULL,
            "lease_until" = NULL,
            "status" = 'PENDING',
            "available_at" = now() - interval '1 minute'
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;
    }

    const docResult2 = await executeDocumentPipeline(db, renderer, storage, 10);
    // Le replay ne doit pas échouer.
    expect(docResult2.failedCount).toBe(0);
    // Pas d'anomalie STORAGE_CHECKSUM_MISMATCH.
    expect(
      docResult2.anomalies.filter((a) => a.failureCode === 'STORAGE_CHECKSUM_MISMATCH'),
    ).toHaveLength(0);

    // Les documents doivent être identiques (mêmes checksums, mêmes sizes, mêmes keys).
    const docs2 = await getDocuments(seeded.outboxEventId);
    expect(docs2).toHaveLength(3);

    // Trier par type pour comparer dans le même ordre.
    const sortedDocs1 = [...docs1].sort((a, b) => a.type.localeCompare(b.type));
    const sortedDocs2 = [...docs2].sort((a, b) => a.type.localeCompare(b.type));

    for (let i = 0; i < sortedDocs1.length; i++) {
      expect(sortedDocs2[i]!.checksum_sha256).toBe(sortedDocs1[i]!.checksum_sha256);
      expect(Number(sortedDocs2[i]!.size_bytes)).toBe(Number(sortedDocs1[i]!.size_bytes));
      expect(sortedDocs2[i]!.storage_key).toBe(sortedDocs1[i]!.storage_key);
    }

    // Pas de doublon de documents.
    const docCount = await countDocuments(seeded.outboxEventId);
    expect(docCount).toBe(3);
  });

  // ── 3. Cycle complet worker : documents + email ──
  it('cycle complet worker — 3 documents PDF + 1 email envoyé ; 4 effets COMPLETED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const renderer = new PdfLibDocumentRenderer();
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

    // Documents : 3 PDFs.
    const docs = await getDocuments(seeded.outboxEventId);
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.content_type === 'application/pdf')).toBe(true);

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  // ── 4. Isolation multi-tenant ──
  it('isolation multi-tenant — deux organisations ; aucun mélange de documents', async () => {
    if (!db) return;
    const idsA = await seedBaseData(SUFFIX() + 'a');
    const seededA = await seedBookingConfirmedEvent(idsA);

    const idsB = await seedBaseData(SUFFIX() + 'b');
    const seededB = await seedBookingConfirmedEvent(idsB);

    const renderer = new PdfLibDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const sender = new FakeTransactionalEmailSender();
    const { deps } = createWorkerDeps(db, renderer, storage, sender);

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    // Vérifier que les documents ont le bon organization_id.
    const docsA = await getDocuments(seededA.outboxEventId);
    const docsB = await getDocuments(seededB.outboxEventId);

    expect(docsA).toHaveLength(3);
    expect(docsB).toHaveLength(3);
    expect(docsA.every((d) => d.organization_id === idsA.orgId)).toBe(true);
    expect(docsB.every((d) => d.organization_id === idsB.orgId)).toBe(true);

    // Les storage_keys ne doivent pas se chevaucher.
    const keysA = new Set(docsA.map((d) => d.storage_key));
    const keysB = new Set(docsB.map((d) => d.storage_key));
    for (const key of keysA) {
      expect(keysB.has(key)).toBe(false);
    }
  });

  // ── 5. Déterminisme : deux seedings produisent des checksums PDF valides ──
  it('déterminisme — deux seedings produisent des checksums PDF valides', async () => {
    if (!db) return;
    // Premier seeding.
    const ids1 = await seedBaseData('deterministic1', {
      userEmail: 'deterministic1@example.com',
      orgName: 'Deterministic Org',
      locationName: 'Test Location',
    });
    const seeded1 = await seedBookingConfirmedEvent(ids1, { amountMinor: 10000 });

    const renderer1 = new PdfLibDocumentRenderer();
    const storage1 = new InMemoryObjectStorage();

    await executeDocumentPipeline(db, renderer1, storage1, 10);
    const docs1 = await getDocuments(seeded1.outboxEventId);
    const checksums1 = [...docs1]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((d) => d.checksum_sha256);

    // Deuxième seeding avec des données identiques (emails différents pour la contrainte unique).
    const ids2 = await seedBaseData('deterministic2', {
      userEmail: 'deterministic2@example.com',
      orgName: 'Deterministic Org',
      locationName: 'Test Location',
    });
    const seeded2 = await seedBookingConfirmedEvent(ids2, { amountMinor: 10000 });

    const renderer2 = new PdfLibDocumentRenderer();
    const storage2 = new InMemoryObjectStorage();

    await executeDocumentPipeline(db, renderer2, storage2, 10);
    const docs2 = await getDocuments(seeded2.outboxEventId);
    const checksums2 = [...docs2]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((d) => d.checksum_sha256);

    // Les checksums PDF sont déterministes pour un même snapshot.
    // Les UUIDs diffèrent entre les deux seedings, donc les checksums diffèrent,
    // mais chaque checksum doit être un SHA-256 valide.
    expect(checksums1).toHaveLength(3);
    expect(checksums2).toHaveLength(3);
    for (const c of [...checksums1, ...checksums2]) {
      expect(c).toMatch(/^[0-9a-f]{64}$/);
    }
    // Les trois checksums d'un même seeding sont distincts (templates différents).
    expect(new Set(checksums1).size).toBe(3);
    expect(new Set(checksums2).size).toBe(3);
  });
});
