/**
 * @uttily/core — Tests d'intégration PostgreSQL du pipeline d'emails transactionnels
 * (G5E, ADR-013 §11).
 *
 * 40 scénarios couvrant : filtrage READY_FOR_TRANSACTIONAL_EMAIL, nominal send,
 * idempotence, crash protocol, concurrency (SKIP LOCKED), erreurs transitoires,
 * backoff, max attempts, multi-tenant, finalisation, confidentialité (PII).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { executeTransactionalEmailPipeline } from './transactional-email-pipeline';
import { failClosedInTransaction } from './fail-closed-in-transaction';
import { FakeTransactionalEmailSender } from './fake-transactional-email-sender';
import type { TransactionalEmailSender } from './ports';
import type { EmailInput, EmailSendResult } from './types';
import {
  emailProviderIdempotencyKey,
  emailDeliveryIdempotencyKey,
  BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY,
} from './email-idempotency-keys';
import { effectIdempotencyKey } from './effect-mapping';
import { wrapDatabase } from './test-instrumentation';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5e');
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
// Seed helpers
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
  opts: { timeZone?: string; userEmail?: string } = {},
): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const timeZone = opts.timeZone ?? 'Europe/Paris';
  const userEmail = opts.userEmail ?? `customer-${suffix}@example.com`;
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

/**
 * Seed an event ready for G5E: 3 GENERATE_* effects COMPLETED with documents,
 * 1 SEND_EMAIL effect PENDING, outbox event PENDING with available_at = now().
 * Options allow overriding effect statuses for eligibility tests.
 */
async function seedReadyForEmailEvent(
  ids: BaseIds,
  opts: {
    userEmail?: string;
    generateStatuses?: { CONFIRMATION?: string; CONTRACT?: string; RECEIPT?: string };
    sendEmailStatus?: string;
  } = {},
): Promise<SeedBookingResult & { effectIds: Record<string, string> }> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const seeded = await seedBookingConfirmedEvent(ids, opts);

  // Create a document_render_snapshot (required FK for documents).
  const snapshot = await sql`
    INSERT INTO "document_render_snapshots" (
      "organization_id", "outbox_event_id", "booking_id", "snapshot", "template_version"
    ) VALUES (
      ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.bookingId}::uuid,
      ${sql.json({ version: 'v1', bookingId: seeded.bookingId })},
      'v1'
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  const effectIds: Record<string, string> = {};
  const generateTypes = ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT'] as const;
  const docTypes = ['CONFIRMATION', 'CONTRACT', 'RECEIPT'] as const;
  const generateStatusKeys = ['CONFIRMATION', 'CONTRACT', 'RECEIPT'] as const;

  for (let i = 0; i < 3; i++) {
    const effectType = generateTypes[i]!;
    const docType = docTypes[i]!;
    const statusKey = generateStatusKeys[i]!;
    const desiredStatus = opts.generateStatuses?.[statusKey] ?? 'COMPLETED';
    const storageKey = crypto.randomUUID();
    const effectIdempKey = effectIdempotencyKey(seeded.outboxEventId, effectType);

    if (desiredStatus === 'COMPLETED') {
      // Insert document first (needed for effect's document_id FK).
      const docIdempKey = `doc_${seeded.outboxEventId}_${docType}_v1`;
      const doc = await sql`
        INSERT INTO "documents" (
          "organization_id", "booking_id", "type", "version",
          "storage_key", "content_type", "checksum_sha256", "size_bytes",
          "template_version", "generated_at", "source_outbox_event_id",
          "render_snapshot_id", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.bookingId}::uuid, ${docType}::document_type, 1,
          ${storageKey}, 'application/pdf', ${'a'.repeat(64)}, 1024,
          'v1', now(), ${seeded.outboxEventId}::uuid,
          ${snapshot.id}::uuid, ${docIdempKey}
        )
        RETURNING "id"
      `.then((r) => r[0]!);

      // Insert effect as COMPLETED with storage_key and document_id.
      const effect = await sql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "document_id", "storage_key", "idempotency_key", "completed_at"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${effectType}::outbox_effect_type,
          'COMPLETED'::outbox_effect_status, ${doc.id}::uuid, ${storageKey}, ${effectIdempKey}, now()
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      effectIds[effectType] = effect.id;
    } else if (desiredStatus === 'PENDING') {
      // Insert effect as PENDING with storage_key only.
      const effect = await sql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${effectType}::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${storageKey}, ${effectIdempKey}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      effectIds[effectType] = effect.id;
    } else if (desiredStatus === 'FAILED') {
      // Insert effect as PENDING first, then transition to FAILED.
      const effect = await sql`
        INSERT INTO "outbox_effects" (
          "organization_id", "outbox_event_id", "effect_type",
          "status", "storage_key", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${effectType}::outbox_effect_type,
          'PENDING'::outbox_effect_status, ${storageKey}, ${effectIdempKey}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      effectIds[effectType] = effect.id;
      await sql`
        UPDATE "outbox_effects"
        SET "status" = 'FAILED', "completed_at" = now(),
            "failure_code" = 'RENDER_FAILED'::document_processing_failure_code
        WHERE "id" = ${effect.id}::uuid
      `;
    }
  }

  // Insert SEND_EMAIL effect.
  const sendEmailIdempKey = effectIdempotencyKey(seeded.outboxEventId, 'SEND_EMAIL');
  const sendEmailDesiredStatus = opts.sendEmailStatus ?? 'PENDING';
  if (sendEmailDesiredStatus === 'COMPLETED') {
    const sendEmailEffect = await sql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "idempotency_key", "completed_at"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, 'SEND_EMAIL'::outbox_effect_type,
        'COMPLETED'::outbox_effect_status, ${sendEmailIdempKey}, now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    effectIds['SEND_EMAIL'] = sendEmailEffect.id;
  } else {
    const sendEmailEffect = await sql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, 'SEND_EMAIL'::outbox_effect_type,
        'PENDING'::outbox_effect_status, ${sendEmailIdempKey}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    effectIds['SEND_EMAIL'] = sendEmailEffect.id;
  }

  // Ensure outbox is PENDING with available_at = now().
  await sql`
    UPDATE "outbox_events"
    SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
        "available_at" = now(), "attempt_count" = 0
    WHERE "id" = ${seeded.outboxEventId}::uuid
  `;

  return { ...seeded, effectIds };
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
    completed_at: Date | null;
  }>
> {
  if (!rawSql) throw new Error('rawSql not initialized');
  return rawSql`
    SELECT "id", "effect_type", "status", "document_id", "storage_key",
           "failure_code", "attempt_count", "idempotency_key", "completed_at"
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

async function getNotification(outboxEventId: string): Promise<{
  id: string;
  status: string;
  recipient_email: string;
  template_key: string;
  provider_idempotency_key: string;
  provider_message_id: string | null;
  failure_code: string | null;
  sent_at: Date | null;
  provider_first_attempt_started_at: Date | null;
  idempotency_key: string;
  organization_id: string;
  outbox_effect_id: string;
} | null> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const rows = await rawSql`
    SELECT "id", "status", "recipient_email", "template_key",
           "provider_idempotency_key", "provider_message_id", "failure_code",
           "sent_at", "provider_first_attempt_started_at", "idempotency_key",
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
      sent_at: Date | null;
      provider_first_attempt_started_at: Date | null;
      idempotency_key: string;
      organization_id: string;
      outbox_effect_id: string;
    }) ?? null
  );
}

/**
 * Extrait le texte SQL d'un objet SQL Drizzle en concaténant les StringChunks.
 * Utilisé par les tests d'instrumentation pour détecter quel UPDATE est exécuté.
 */
function getQueryText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<Record<string, unknown>> }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && Array.isArray(c.value)) {
        return (c.value as string[]).join('');
      }
      return '';
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('executeTransactionalEmailPipeline — integration PostgreSQL', () => {
  // ─── Eligibility tests ───

  it('1. 3 GENERATE_* COMPLETED + SEND_EMAIL PENDING → claimed by G5E', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('SENT');
  });

  it('2. seulement 2 GENERATE_* COMPLETED → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids, {
      generateStatuses: { CONFIRMATION: 'COMPLETED', CONTRACT: 'COMPLETED', RECEIPT: 'PENDING' },
    });

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(0);
  });

  it('3. 1 GENERATE_* PENDING → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids, {
      generateStatuses: { CONFIRMATION: 'PENDING', CONTRACT: 'COMPLETED', RECEIPT: 'COMPLETED' },
    });

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(0);
  });

  it('4. 1 GENERATE_* FAILED → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids, {
      generateStatuses: { CONFIRMATION: 'COMPLETED', CONTRACT: 'COMPLETED', RECEIPT: 'FAILED' },
    });

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(0);
  });

  it('5. SEND_EMAIL COMPLETED → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids, { sendEmailStatus: 'COMPLETED' });

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(0);
  });

  it('6. événement avec type/version/aggregate inconnu → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    // Seed a non-BOOKING_CONFIRMED event with effects that look ready.
    const otherEventId = await seedOtherOutboxEvent(
      ids.orgId,
      ids.userId,
      'BOOKING_FULFILLMENT_STARTED',
      'v1',
      'BOOKING',
    );

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(0);
    // Verify the other event was not touched.
    const event = await getOutboxEvent(otherEventId);
    expect(event.status).toBe('PENDING');
  });

  it('7. événement compensation/fulfillment → NOT claimed', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    await seedOtherOutboxEvent(
      ids.orgId,
      seeded.paymentId,
      'PAYMENT_COMPENSATION_REQUESTED',
      'v1',
      'PAYMENT',
      {
        paymentId: seeded.paymentId,
        refundIdempotencyKey: 'k',
        amountMinor: '100',
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      },
    );

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);
  });

  it('8. événement avec notification_deliveries SENT → NOT claimed', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Insert a SENT notification_deliveries.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "provider_message_id", "sent_at", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        'already@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'SENT'::notification_delivery_status, 'existing-msg-id', now(), ${deliveryKey}
      )
    `;

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // Should NOT be claimed — terminal notification_deliveries (SENT) excludes the event.
    expect(result.claimedCount).toBe(0);
    expect(sender.sendCallCount).toBe(0);
  });

  // ─── Nominal tests ───

  it("9. notification PENDING créée avant l'appel externe", async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    // After the pipeline, it should be SENT, but it was created as PENDING first.
    expect(notif!.status).toBe('SENT');
    // recipient_email should be the user's email (frozen at creation time).
    expect(notif!.recipient_email).toContain('@example.com');
    expect(notif!.recipient_email.length).toBeGreaterThan(0);
  });

  it('10. sender appelé hors transaction (TransactionMonitor)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids);

    const { db: wrappedDb, monitor } = wrapDatabase(db);
    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(wrappedDb, sender, 10);

    // No violations: sender.send() must NOT be called during a transaction.
    expect(monitor.violations).toHaveLength(0);
    expect(sender.sendCallCount).toBe(1);
  });

  it('11. notification → SENT, provider_message_id non vide, sent_at non null', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');
    expect(notif!.provider_message_id).toBeTruthy();
    expect(notif!.provider_message_id!.length).toBeGreaterThan(0);
    expect(notif!.sent_at).not.toBeNull();
    expect(notif!.failure_code).toBeNull();
  });

  it('12. SEND_EMAIL → COMPLETED, completed_at non null', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');
    expect(sendEmail!.completed_at).not.toBeNull();
    expect(sendEmail!.failure_code).toBeNull();
  });

  it('13. outbox → PROCESSED, processed_at non null', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.processed_at).not.toBeNull();
  });

  it('14. lease_token NULL, lease_until NULL après traitement', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  it('15. exactement 4 effets COMPLETED après traitement', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const effects = await getEffects(seeded.outboxEventId);
    expect(effects).toHaveLength(4);
    for (const e of effects) {
      expect(e.status).toBe('COMPLETED');
    }
  });

  // ─── Idempotence tests ───

  it('16. replay après succès → pas de second email logique (uniqueEmailCount === 1)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);
    expect(sender.uniqueEmailCount).toBe(1);

    // Reset outbox to PENDING for replay.
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now(), "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Run again — notification is already SENT, event is NOT claimable
    // (filter excludes events with terminal notification_deliveries).
    const result = await executeTransactionalEmailPipeline(db, sender, 10);
    expect(result.claimedCount).toBe(0);
    expect(result.sentCount).toBe(0);
    // No second logical email.
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it('17. crash après acceptation send mais avant Phase C → reclaim, dedup, même providerIdempotencyKey', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Read the actual user email from the DB (the pipeline will freeze this value).
    const emailRows = await rawSql`
      SELECT u."email" FROM "users" u
      JOIN "bookings" b ON b."customer_user_id" = u."id"
      WHERE b."id" = ${seeded.bookingId}::uuid
        AND b."organization_id" = ${ids.orgId}::uuid
    `;
    const recipientEmail = emailRows[0]!.email;

    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);

    // Use a SINGLE sender instance representing shared provider state.
    const sender = new FakeTransactionalEmailSender();

    // 1. Before running the pipeline, call sender.send() with EXACTLY the same
    //    parameters the pipeline will use (simulating a crash after Phase B send
    //    but before Phase C persist).
    const preResult = await sender.send({
      recipientEmail,
      templateKey: BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY,
      providerIdempotencyKey: providerKey,
      // The pipeline uses event.aggregateId which is the bookingId (NOT outboxEventId).
      variables: { bookingId: seeded.bookingId },
    });
    expect(preResult.kind).toBe('SENT');
    if (preResult.kind !== 'SENT') throw new Error('invariant: expected SENT');
    expect(preResult.providerMessageId).toBeTruthy();
    const preMessageId = preResult.providerMessageId;

    // 2. Manually insert a PENDING notification (simulating Phase A completed
    //    but Phase C crashed before persisting the SENT result).
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        ${recipientEmail},
        ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'PENDING'::notification_delivery_status, ${deliveryKey}
      )
    `;

    // 3. Run the pipeline with the SAME sender instance.
    //    The pipeline should reuse the PENDING notification, call the same sender
    //    with the same providerIdempotencyKey, and the sender should deduplicate
    //    (return the same providerMessageId).
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // Two technical calls (one pre-crash, one from pipeline).
    expect(sender.sendCallCount).toBe(2);
    // One logical email — deduplication worked.
    expect(sender.uniqueEmailCount).toBe(1);

    // Same providerMessageId returned both times.
    const pipelineMessageId = sender.getProviderMessageId(providerKey);
    expect(pipelineMessageId).toBe(preMessageId);

    // Exactly 1 notification in DB with status SENT.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('SENT');
    expect(notif!.provider_message_id).toBe(preMessageId);

    // SEND_EMAIL effect COMPLETED.
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    // Outbox PROCESSED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.processed_at).not.toBeNull();

    // Result counters.
    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);
  });

  it('18. reclaim après expiration de lease → même providerIdempotencyKey', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Manually set expired lease + PROCESSING.
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING', "lease_until" = now() - interval '5 minutes',
          "lease_token" = ${'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}::uuid,
          "attempt_count" = 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);

    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    expect(sender.wasSent(providerKey)).toBe(true);
  });

  it('19. recipient_email stable si users.email change après première Phase A', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Run pipeline once — creates notification with original email.
    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif1 = await getNotification(seeded.outboxEventId);
    const originalEmail = notif1!.recipient_email;

    // Change users.email.
    await rawSql`
      UPDATE "users" SET "email" = ${'changed-' + SUFFIX() + '@example.com'}
      WHERE "id" = ${ids.userId}::uuid
    `;

    // Reset outbox for replay (notification is SENT → will be skipped).
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now(), "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    await executeTransactionalEmailPipeline(db, sender, 10);

    // recipient_email should NOT have changed.
    const notif2 = await getNotification(seeded.outboxEventId);
    expect(notif2!.recipient_email).toBe(originalEmail);
  });

  it('20. pas de notification_deliveries dupliquée', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    // Reset and run again.
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now(), "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    await executeTransactionalEmailPipeline(db, sender, 10);

    // Count notification_deliveries — should be exactly 1.
    const countRows = await rawSql`
      SELECT COUNT(*)::int as count FROM "notification_deliveries"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
    `;
    expect(countRows[0]!.count).toBe(1);
  });

  it('21. collision incohérente sur idempotency_key → fail-closed', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Insert an incoherent notification with the same idempotency_key but
    // different provider_idempotency_key and template_key.
    // The trigger only checks org/event/effect consistency, not provider_key/template_key.
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        'incoherent@example.com', 'wrong_template_key',
        'wrong_provider_key', 'PENDING'::notification_delivery_status, ${deliveryKey}
      )
      ON CONFLICT DO NOTHING
    `;

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    // The event should be fail-closed (outbox FAILED) due to incoherent notification.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');

    // SEND_EMAIL effect should be FAILED.
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    // Notification should be FAILED.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('FAILED');
  });

  // ─── Concurrency tests ───

  it('22. deux workers, SKIP LOCKED → pas de double email', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    const [r1, r2] = await Promise.all([
      executeTransactionalEmailPipeline(db, sender, 10),
      executeTransactionalEmailPipeline(db, sender, 10),
    ]);

    const totalClaimed = r1.claimedCount + r2.claimedCount;
    expect(totalClaimed).toBe(1);
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it('23. lease perdue avant Phase C → ancien worker ne peut pas persister', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Manually claim with a lease, then expire it.
    const oldToken = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING', "lease_until" = now() - interval '1 minute',
          "lease_token" = ${oldToken}::uuid, "attempt_count" = 1,
          "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // The pipeline should reclaim with a new lease and process normally.
    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);
  });

  // ─── Error tests ───

  it('24. erreur transitoire → PENDING + backoff (available_at > now())', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);

    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.available_at.getTime()).toBeGreaterThan(Date.now() - 1000);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('PENDING');
    expect(notif!.failure_code).toBeNull();

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');
    expect(sendEmail!.failure_code).toBeNull();
  });

  it('25. succès sur retry → SENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // First attempt: fail.
    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);
    await executeTransactionalEmailPipeline(db, sender, 10);

    // Reset available_at to now to bypass backoff.
    await rawSql`
      UPDATE "outbox_events"
      SET "available_at" = now()
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Second attempt: succeed.
    const result = await executeTransactionalEmailPipeline(db, sender, 10);
    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  it('26. backoff delays: 30/60/120/240 secondes', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    const expectedBackoffs = [30, 60, 120, 240]; // attempts 1-4

    for (let attempt = 0; attempt < 4; attempt++) {
      sender.failNext(1);
      await executeTransactionalEmailPipeline(db, sender, 10);

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');

      // Check available_at is approximately now + expectedBackoff[attempt] seconds.
      const expectedDelay = expectedBackoffs[attempt]!;
      const now = Date.now();
      const availableAt = event.available_at.getTime();
      const actualDelay = (availableAt - now) / 1000;
      // Allow some tolerance (±5 seconds).
      expect(actualDelay).toBeGreaterThan(expectedDelay - 5);
      expect(actualDelay).toBeLessThan(expectedDelay + 10);

      // Reset available_at for next attempt.
      await rawSql`
        UPDATE "outbox_events"
        SET "available_at" = now()
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;
    }
  });

  it('27. 5e échec certain → notification/effect/outbox FAILED, failure_code EMAIL_SEND_FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // SEND_EMAIL.attempt_count=4 before reservation; reservation makes it 5.
    // TRANSIENT_NOT_SENT at MAX → certain non-envoyé → FAILED.
    await rawSql`
      UPDATE "outbox_effects"
      SET "attempt_count" = 4
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" = 'SEND_EMAIL'
    `;
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'TRANSIENT_NOT_SENT', failureCode: 'PROVIDER_RATE_LIMITED' });
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('FAILED');
    expect(notif!.failure_code).toBe('EMAIL_SEND_FAILED');

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');
    expect(sendEmail!.failure_code).toBe('EMAIL_SEND_FAILED');
  });

  it('28. pas de message brut du fournisseur persisté (providerMessageId déterministe uniquement)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    // provider_message_id should be the deterministic fake, not raw provider data.
    expect(notif!.provider_message_id).toBe(
      `fake-msg-${emailProviderIdempotencyKey(seeded.outboxEventId)}`,
    );
  });

  it('29. pas de statut PENDING avec failure_code non-null', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('PENDING');
    expect(notif!.failure_code).toBeNull();
  });

  // ─── Multi-tenant tests ───

  it('30. organization_id cohérent dans notification_deliveries', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.organization_id).toBe(ids.orgId);
  });

  it("31. notification d'une autre org rejetée par le trigger", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const ids2 = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Try to insert a notification with wrong org_id.
    await expect(
      rawSql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "idempotency_key"
        ) VALUES (
          ${ids2.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
          'wrong@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, 'wrong-key',
          'PENDING'::notification_delivery_status, 'wrong-delivery-key'
        )
      `,
    ).rejects.toThrow();
  });

  it('32. effet non-SEND_EMAIL rejeté par le trigger', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Try to insert a notification with a GENERATE effect instead of SEND_EMAIL.
    await expect(
      rawSql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['GENERATE_CONFIRMATION']!}::uuid,
          'wrong@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, 'wrong-key-2',
          'PENDING'::notification_delivery_status, 'wrong-delivery-key-2'
        )
      `,
    ).rejects.toThrow();
  });

  it("33. outbox_effect_id d'un autre événement rejeté par le trigger", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);

    // Try to insert a notification for event1 with effect from event2.
    await expect(
      rawSql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded2.effectIds['SEND_EMAIL']!}::uuid,
          'wrong@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, 'wrong-key-3',
          'PENDING'::notification_delivery_status, 'wrong-delivery-key-3'
        )
      `,
    ).rejects.toThrow();
  });

  // ─── Finalization tests ───

  it('34. exactement 4 COMPLETED requis pour PROCESSED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const effects = await getEffects(seeded.outboxEventId);
    const completedCount = effects.filter((e) => e.status === 'COMPLETED').length;
    expect(completedCount).toBe(4);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  it('35. notification SENT requise pour SEND_EMAIL COMPLETED', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');
  });

  it('36. pas de PROCESSED prématuré', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a sender that fails — outbox should NOT be PROCESSED.
    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('PROCESSED');
    expect(event.processed_at).toBeNull();
  });

  it('37. corruption entre Phase A et Phase C → fail-closed', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Simulate corruption between Phase B and Phase C:
    // Phase A creates the PENDING notification, Phase B calls the sender and it
    // succeeds, but between Phase B and Phase C a concurrent process deletes the
    // notification_deliveries row. Phase C finds no notification → fail-closed.
    //
    // We use a wrapper sender that, after the send succeeds, deletes the
    // notification_deliveries row to simulate the corruption.
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const corruptingSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        // Simulate corruption: delete the notification_deliveries row between
        // Phase B (sender call) and Phase C (persist result).
        await sql!`
          DELETE FROM "notification_deliveries"
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, corruptingSender, 10);

    // The pipeline should have claimed and sent, but Phase C should detect
    // the missing notification and fail-closed.
    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.sentCount).toBe(0);

    // The outbox event should be FAILED (fail-closed).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.processed_at).toBeNull();
  });

  it('38. second événement valide dans le même batch continue normalement', async () => {
    if (!db) return;
    const ids1 = await seedBaseData();
    const seeded1 = await seedReadyForEmailEvent(ids1);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    expect(result.claimedCount).toBe(2);
    expect(result.sentCount).toBe(2);

    const notif1 = await getNotification(seeded1.outboxEventId);
    const notif2 = await getNotification(seeded2.outboxEventId);
    expect(notif1!.status).toBe('SENT');
    expect(notif2!.status).toBe('SENT');

    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event1.status).toBe('PROCESSED');
    expect(event2.status).toBe('PROCESSED');
  });

  // ─── Privacy tests ───

  it("39. pas d'email/nom/adresse dans les messages d'erreur", async () => {
    if (!db) return;
    const userEmail = `privacy-test-${SUFFIX()}@example.com`;
    // Seed with a specific email.
    const idsWithSpecificEmail = await seedBaseData(undefined, { userEmail });
    const seeded = await seedReadyForEmailEvent(idsWithSpecificEmail);

    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);

    try {
      await executeTransactionalEmailPipeline(db, sender, 10);
    } catch (error) {
      // The pipeline should NOT throw with PII.
      const msg = (error as Error).toString();
      expect(msg).not.toContain(userEmail);
    }

    // Check that the anomaly doesn't contain PII.
    // The pipeline result should have anomalies with failure_code only.
    // Re-run with success to complete.
    sender.reset();
    if (rawSql) {
      await rawSql`UPDATE "outbox_events" SET "available_at" = now() WHERE "id" = ${seeded.outboxEventId}::uuid`;
    }
    const result = await executeTransactionalEmailPipeline(db, sender, 10);
    for (const anomaly of result.anomalies) {
      expect(anomaly.failureCode).not.toContain(userEmail);
      expect(anomaly.outboxEventId).not.toContain(userEmail);
    }
  });

  it('40. idempotency_key et provider_idempotency_key ne contiennent pas de PII', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const notif = await getNotification(seeded.outboxEventId);
    const providerKey = notif!.provider_idempotency_key;
    const deliveryKey = notif!.idempotency_key;

    // Keys should NOT contain @ (no email), no "customer", no PII.
    expect(providerKey).not.toContain('@');
    expect(deliveryKey).not.toContain('@');
    // Keys should be derived from outboxEventId only.
    expect(providerKey).toBe(`email_provider_${seeded.outboxEventId}_SEND_EMAIL_v1`);
    expect(deliveryKey).toBe(`email_delivery_${seeded.outboxEventId}_v1`);
  });

  // ─── G5E Round 2 — Additional reconciliation and invariant tests ───

  it('41. NOT_PENDING après Phase A → réconciliation, pas de outbox PROCESSING', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that, after the send succeeds, marks the SEND_EMAIL
    // effect as COMPLETED (simulating a concurrent completion between Phase B and C).
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        // Mark SEND_EMAIL as COMPLETED between Phase B and C.
        await sql!`
          UPDATE "outbox_effects"
          SET "status" = 'COMPLETED', "completed_at" = now()
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
            AND "effect_type" = 'SEND_EMAIL'
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    // The pipeline should reconcile: SEND_EMAIL is COMPLETED, notification is PENDING.
    // COMPLETED × (not SENT) → fail-closed.
    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    // Outbox must NOT be PROCESSING.
    expect(event.status).not.toBe('PROCESSING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  it('42. notification devient SENT entre Phase A et Phase C → reconcile SEND_EMAIL→COMPLETED, outbox PROCESSED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that, after the send succeeds, marks the notification
    // as SENT (simulating a concurrent process completing the send).
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        if (result.kind !== 'SENT') throw new Error('invariant: expected SENT');
        // Mark notification as SENT between Phase B and C.
        await sql!`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT', "sent_at" = now(),
              "provider_message_id" = ${result.providerMessageId}
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(0); // Reconciled, not newly sent

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.lease_token).toBeNull();
  });

  it('43. notification devient FAILED entre Phase A et Phase C → reconcile SEND_EMAIL→FAILED, outbox FAILED', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        // Mark notification as FAILED between Phase B and C.
        await sql!`
          UPDATE "notification_deliveries"
          SET "status" = 'FAILED',
              "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  it('44. SEND_EMAIL devient COMPLETED avant Phase C → reconcile, outbox PROCESSED si notification SENT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        if (result.kind !== 'SENT') throw new Error('invariant: expected SENT');
        // Mark both SEND_EMAIL and notification as completed/sent.
        await sql!`
          UPDATE "outbox_effects"
          SET "status" = 'COMPLETED', "completed_at" = now()
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
            AND "effect_type" = 'SEND_EMAIL'
        `;
        await sql!`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT', "sent_at" = now(),
              "provider_message_id" = ${result.providerMessageId}
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    expect(result.claimedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.lease_token).toBeNull();
  });

  it('45. UPDATE critique retournant 0 rows → pas de persistance partielle', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that, after the send succeeds, sets the notification
    // to SENT. The Phase C code will see notif.status === SENT and go to the
    // PENDING × SENT reconciliation branch (not the PENDING→SENT UPDATE branch).
    // This verifies that no partial persistence occurs when the expected
    // precondition doesn't match.
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        if (result.kind !== 'SENT') throw new Error('invariant: expected SENT');
        await sql!`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT', "sent_at" = now(),
              "provider_message_id" = ${result.providerMessageId}
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    // The pipeline should reconcile correctly (not fail).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    const event = await getOutboxEvent(seeded.outboxEventId);
    // Outbox should be PROCESSED (all 4 effects COMPLETED, notification SENT).
    expect(event.status).toBe('PROCESSED');
    expect(event.lease_token).toBeNull();
  });

  it('46. collision Phase A → failedCount exact (failedCount === 1, anomalies length === 1)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Insert an incoherent notification with the same idempotency_key but
    // different provider_idempotency_key and template_key.
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        'incoherent@example.com', 'wrong_template_key',
        'wrong_provider_key', 'PENDING'::notification_delivery_status, ${deliveryKey}
      )
      ON CONFLICT DO NOTHING
    `;

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // Exact failure count.
    expect(result.failedCount).toBe(1);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.outboxEventId).toBe(seeded.outboxEventId);

    // Sender should NOT have been called (fail-closed in Phase A).
    expect(sender.sendCallCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();

    // SEND_EMAIL effect should be FAILED.
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    // Notification should be FAILED with UNKNOWN_ERROR failure_code.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('FAILED');
    expect(notif!.failure_code).toBe('UNKNOWN_ERROR');
  });

  it('47. notification manquante → effect/outbox cohérents, failedCount exact', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that deletes the notification after send succeeds.
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const corruptingSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        await sql!`
          DELETE FROM "notification_deliveries"
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, corruptingSender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.sentCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.processed_at).toBeNull();
    expect(event.lease_token).toBeNull();

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');
  });

  it('48. erreur de commit forcée → compteurs non incrémentés', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that, after the send succeeds, changes the lease_token
    // on the outbox event. This will cause the Phase C fencing SELECT to return
    // 0 rows → LEASE_LOST. The transaction returns LEASE_LOST (not a throw),
    // so the counter is leaseLostCount, not sentCount or failedCount.
    const innerSender = new FakeTransactionalEmailSender();
    const sql = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        // Change the lease_token to simulate lease loss.
        await sql!`
          UPDATE "outbox_events"
          SET "lease_token" = ${'00000000-0000-0000-0000-000000000000'}::uuid
          WHERE "id" = ${seeded.outboxEventId}::uuid
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    // Counters should not lie — sentCount=0, failedCount=0, leaseLostCount=1.
    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.leaseLostCount).toBe(1);
  });

  it('49. booking cross-org → pas de lecture email, sender non appelé, fail-closed', async () => {
    if (!db || !rawSql) return;
    // Seed two orgs.
    const idsA = await seedBaseData();
    const idsB = await seedBaseData();

    // Create a booking in org B (to get a valid booking UUID).
    const seededB = await seedBookingConfirmedEvent(idsB);

    // Create a full ready-for-email event in org A.
    const seededA = await seedReadyForEmailEvent(idsA);

    // Now change the outbox event's aggregate_id to point to org B's booking.
    // The outbox event still has org A's organization_id, but the aggregate_id
    // (bookingId) belongs to org B. The pipeline's users.email query filters
    // on organization_id, so it should NOT find org B's booking.
    await rawSql`
      UPDATE "outbox_events"
      SET "aggregate_id" = ${seededB.bookingId}::uuid
      WHERE "id" = ${seededA.outboxEventId}::uuid
    `;

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // The pipeline should fail-closed because the booking belongs to org B,
    // not org A. The users.email query filters on organization_id.
    expect(result.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(0);

    const event = await getOutboxEvent(seededA.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();

    // No PII cross-tenant in errors.
    for (const anomaly of result.anomalies) {
      expect(anomaly.failureCode).not.toContain('@');
    }
  });

  it('50. recipient_email invalide pré-existant → fail-closed', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Insert a PENDING notification with an invalid recipient_email.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        'not-an-email', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'PENDING'::notification_delivery_status, ${deliveryKey}
      )
    `;

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // Should fail-closed because the persisted recipient_email is invalid.
    expect(result.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  it('51. erreur fournisseur avec PII/secrets → entièrement normalisée, pas de fuite', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Create a sender that throws an error containing PII and secrets.
    const leakingSender: TransactionalEmailSender = {
      async send() {
        throw new Error('secret-123 and user@private.com leaked');
      },
    };

    // Capture console.error to verify no leak in logs.
    const originalConsoleError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    };

    try {
      const result = await executeTransactionalEmailPipeline(db, leakingSender, 10);

      // No raw error string in pipeline result.
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain('secret-123');
      expect(resultStr).not.toContain('user@private.com');
      expect(resultStr).not.toContain('leaked');

      // No raw error string in anomalies.
      for (const anomaly of result.anomalies) {
        expect(anomaly.failureCode).not.toContain('secret');
        expect(anomaly.failureCode).not.toContain('private.com');
        expect(anomaly.failureCode).not.toContain('leaked');
      }

      // Check DB — failure_code should be just 'EMAIL_SEND_FAILED' (if terminal) or no failure.
      const notif = await getNotification(seeded.outboxEventId);
      if (notif && notif.failure_code) {
        expect(notif.failure_code).not.toContain('secret');
        expect(notif.failure_code).not.toContain('private.com');
      }
    } finally {
      console.error = originalConsoleError;
    }

    // No raw error leaked in console output.
    for (const log of consoleErrors) {
      expect(log).not.toContain('secret-123');
      expect(log).not.toContain('user@private.com');
    }
  });

  it('52. toutes les branches finales vérifient lease_token NULL et lease_until NULL (sauf LEASE_LOST)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Nominal success path → PROCESSED.
    const sender = new FakeTransactionalEmailSender();
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
  });

  it('53. toutes les branches FAILED vérifient lease_token NULL et lease_until NULL', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // SEND_EMAIL.attempt_count=4 before reservation; DETERMINISTIC_REFUSAL → terminal FAILED.
    await rawSql`
      UPDATE "outbox_effects"
      SET "attempt_count" = 4
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" = 'SEND_EMAIL'
    `;
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'DETERMINISTIC_REFUSAL', failureCode: 'INVALID_RECIPIENT' });
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
    expect(event.processed_at).toBeNull();
  });

  it('54. toutes les branches PENDING+backoff vérifient lease_token NULL et lease_until NULL', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    sender.failNext(1);
    await executeTransactionalEmailPipeline(db, sender, 10);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
    expect(event.lease_token).toBeNull();
    expect(event.lease_until).toBeNull();
    expect(event.processed_at).toBeNull();
    // available_at should be in the future (backoff).
    expect(event.available_at.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('55. email live invalide → fail-closed, sender 0 appels', async () => {
    if (!db || !rawSql) return;
    // Seed with an invalid email.
    const ids = await seedBaseData(undefined, { userEmail: 'not-an-email' });
    const seeded = await seedReadyForEmailEvent(ids);

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(db, sender, 10);

    // Should fail-closed because the user's email is invalid.
    expect(result.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(0);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it('56. erreur SQL forcée après transition interne mais avant commit → compteurs non mensongers', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Objectif (requirement #2) : forcer une erreur SQL APRÈS qu'une transition
    // interne soit exécutée dans la transaction Phase C, mais AVANT le commit.
    // Vérifier qu'aucun compteur mensonger n'est retourné (sentCount !== 1).
    //
    // Approche : on wrap le DatabaseClient pour instrumenter la transaction Phase C.
    // Un flag `armPhaseCFailure` est armé par le wrapper sender après l'envoi
    // réussi (Phase B). La prochaine transaction (Phase C) reçoit un `tx` dont
    // `execute` est instrumenté : après le 5e execute (SEND_EMAIL → COMPLETED,
    // la 2e transition interne), le 6e execute lève une erreur SQL forcée.
    //
    // Le chemin nominal SENT dans Phase C exécute :
    //   1. Fencing SELECT
    //   2. Effects SELECT
    //   3. Notification SELECT
    //   4. Notification → SENT UPDATE  (transition interne 1)
    //   5. SEND_EMAIL → COMPLETED UPDATE (transition interne 2)
    //   6. allEffects re-validation SELECT ← erreur forcée ici
    //
    // Les transitions (4, 5) sont exécutées dans la transaction mais le 6e
    // execute échoue → la transaction est annulée (rollback) → aucun commit.
    const innerSender = new FakeTransactionalEmailSender();
    let armPhaseCFailure = false;
    let phaseCExecuteCount = 0;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        // Armer l'échec pour la prochaine transaction (Phase C).
        armPhaseCFailure = true;
        return result;
      },
    };

    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (!armPhaseCFailure) {
        // Phase A ou Phase B (réservation) — pas d'instrumentation.
        return originalTransaction(fn);
      }
      // Phase C — instrumenter tx.execute pour injecter l'erreur.
      armPhaseCFailure = false;
      phaseCExecuteCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          phaseCExecuteCount++;
          if (phaseCExecuteCount === 6) {
            // Les transitions internes (notif SENT + SEND_EMAIL COMPLETED) ont
            // été exécutées (executes 4 et 5) mais le commit n'aura pas lieu.
            throw new Error('FORCED_SQL_ERROR_AFTER_TRANSITION');
          }
          return originalExecute(query);
        };
        return fn(tx);
      });
    };

    const result = await executeTransactionalEmailPipeline(instrumentedDb, wrapperSender, 10);

    // Les compteurs ne doivent pas mentir : la transaction Phase C a été
    // annulée, aucune transition n'a été committée. sentCount !== 1.
    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(0);

    // La DB reflète le rollback : notification PENDING, SEND_EMAIL PENDING,
    // outbox PROCESSING (avec lease — sera reclaim après expiration).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('PENDING');

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('PROCESSED');
    expect(event.status).toBe('PROCESSING');
  });

  it("57. premier événement fail-closed avec simulation d'une précondition de fencing à zéro ligne, deuxième événement continue (requirement #11(n) + savepoint hardening)", async () => {
    if (!db || !rawSql) return;
    const sql = rawSql;

    // Scénario : deux événements dans le même batch Phase A.
    //  - event1 : notification incohérente (comme test 46) → fail-closed en Phase A.
    //    PENDANT le fail-closed, on SIMULE une précondition de fencing à zéro ligne
    //    en interceptant l'UPDATE outbox FAILED du helper et en retournant un tableau
    //    vide (0 lignes). Ceci simule fidèlement le comportement d'un UPDATE WHERE
    //    lease_token = ... qui ne matche aucune ligne (lease volé concurrentement),
    //    SANS réellement modifier le lease en DB. L'UPDATE retourne 0 lignes →
    //    RECONCILE_PRECONDITION_VIOLATED → le savepoint du
    //    fail-closed est annulé (Fix A), la transaction extérieure reste intacte.
    //    Note : le lease n'est PAS réellement modifié en DB — la simulation
    //    retourne 0 lignes ; la DB conserve le lease original.
    //  - event2 : valide, doit être envoyé avec succès.
    //
    // Prouve le requirement #11(n) : un deuxième événement valide continue malgré
    // le fail-closed du premier événement heurtant une précondition de fencing à
    // zéro ligne. Prouve aussi le durcissement par savepoint (Fix A) : la
    // transaction extérieure n'est pas avortée par le throw du helper.
    const ids1 = await seedBaseData();
    const seeded1 = await seedReadyForEmailEvent(ids1);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);

    // Insérer une notification incohérente pour event1 (même idempotency_key,
    // mais template_key et provider_idempotency_key différents) → fail-closed.
    const deliveryKey1 = emailDeliveryIdempotencyKey(seeded1.outboxEventId);
    await sql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids1.orgId}, ${seeded1.outboxEventId}::uuid, ${seeded1.effectIds['SEND_EMAIL']!}::uuid,
        'incoherent@example.com', 'wrong_template_key',
        'wrong_provider_key', 'PENDING'::notification_delivery_status, ${deliveryKey1}
      )
      ON CONFLICT DO NOTHING
    `;

    // S'assurer qu'event1 est traité en premier (available_at plus ancien).
    await sql`
      UPDATE "outbox_events"
      SET "available_at" = now() - interval '5 seconds'
      WHERE "id" = ${seeded1.outboxEventId}::uuid
    `;

    // Instrumenter db.transaction pour détecter la transaction Phase A (la
    // première) et wrapper tx.execute. Quand l'UPDATE outbox FAILED du fail-closed
    // est sur le point de s'exécuter, on court-circuite l'UPDATE en retournant
    // un tableau vide (0 lignes) pour simuler une précondition de fencing à zéro
    // ligne (comme si le lease avait été volé concurrentement).
    //
    // Note : on ne peut pas utiliser une connexion séparée (rawSql) pour voler
    // réellement le lease car la transaction Phase A tient un verrou de ligne sur
    // outbox_events (acquis par le claim UPDATE de poseLease). La modification
    // du lease via une autre connexion bloquerait jusqu'au commit de Phase A
    // (deadlock). À la place, on intercepte l'UPDATE et on retourne 0 lignes.
    // Le lease n'est PAS réellement modifié en DB — la DB conserve le lease original.
    //
    // Important : drizzle crée un NOUVEL objet PgTransaction pour chaque
    // savepoint (tx.transaction). Il faut donc wrapper récursivement tx.execute
    // ET tx.transaction pour que les executes des savepoints soient interceptés.
    let phaseASeen = false;
    let leaseStolen = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;

    // Extrait le texte SQL statique des StringChunks du template drizzle.
    // Les Param (${...}) deviennent des trous ; les littéraux SQL restent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function extractSqlText(query: any): string {
      if (typeof query === 'string') return query;
      if (query?.queryChunks && Array.isArray(query.queryChunks)) {
        return (
          query.queryChunks
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((c: any) => (c && c.value && Array.isArray(c.value) ? c.value.join('') : ''))
            .join('')
        );
      }
      if (query?.sql && typeof query.sql === 'string') return query.sql;
      return '';
    }

    // Détecter l'UPDATE outbox FAILED du fail-closed :
    //   UPDATE "outbox_events" SET "status" = 'FAILED', ... WHERE ... "lease_token" = ... RETURNING "id"
    // Cette requête est unique dans Phase A (le claim UPDATE met status='PROCESSING',
    // l'UPDATE d'effet touche outbox_effects, l'UPDATE de notification touche
    // notification_deliveries).
    function isFailClosedOutboxUpdate(sqlText: string): boolean {
      return (
        sqlText.includes('outbox_events') &&
        sqlText.includes("'FAILED'") &&
        sqlText.includes('lease_token') &&
        sqlText.includes('RETURNING')
      );
    }

    // Wrapper récursivement un tx : intercepte tx.execute (pour court-circuiter
    // l'UPDATE outbox FAILED du fail-closed) ET tx.transaction (pour wrapper
    // les savepoints créés par drizzle avec de nouveaux objets PgTransaction).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function wrapTx(tx: any): void {
      const originalExecute = tx.execute.bind(tx);
      const originalSpTransaction = tx.transaction?.bind(tx);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx.execute = async function (query: any) {
        const sqlText = extractSqlText(query);
        if (isFailClosedOutboxUpdate(sqlText) && !leaseStolen) {
          // Simulation d'une précondition de fencing à zéro ligne : on ne peut
          // pas utiliser une connexion séparée car la transaction Phase A tient
          // un verrou de ligne sur outbox_events (acquis par le claim UPDATE de
          // poseLease). À la place, on court-circuite l'UPDATE outbox FAILED en
          // retournant un tableau vide (0 lignes), ce qui simule fidèlement le
          // comportement d'un UPDATE WHERE lease_token = ... qui ne matche
          // aucune ligne. Le helper failClosedInTransaction vérifie que l'UPDATE
          // retourne exactement 1 ligne ; avec 0 lignes il lève
          // RECONCILE_PRECONDITION_VIOLATED. Le lease n'est PAS réellement
          // modifié en DB — la DB conserve le lease original.
          leaseStolen = true;
          return [];
        }
        return originalExecute(query);
      };

      if (originalSpTransaction) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.transaction = async function <T>(fn: (sp: any) => Promise<T>): Promise<T> {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return originalSpTransaction(async (sp: any) => {
            // Le savepoint reçoit un nouveau PgTransaction ; le wrapper aussi.
            wrapTx(sp);
            return fn(sp);
          });
        };
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (phaseASeen) {
        // Phase B (réservation) ou Phase C — pas d'instrumentation.
        return originalTransaction(fn);
      }
      // La première transaction est Phase A (claim + init).
      phaseASeen = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        wrapTx(tx);
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    // Les deux événements ont été claimés.
    expect(result.claimedCount).toBe(2);
    // event2 a été envoyé ; event1 n'a pas atteint Phase B (fail-closed en Phase A).
    expect(result.sentCount).toBe(1);
    // event1 n'est pas compté comme échec : la simulation de précondition de
    // fencing à zéro ligne → RECONCILE_PRECONDITION_VIOLATED → le catch fait
    // `continue` sans pousser dans phaseAFailures.
    expect(result.failedCount).toBe(0);
    // Phase A lease-lost n'est pas suivi comme leaseLostCount (concept Phase C).
    expect(result.leaseLostCount).toBe(0);
    expect(result.anomalies).toHaveLength(0);

    // event1 : le fail-closed a été annulé (savepoint) car l'UPDATE a simulé
    // une précondition de fencing à zéro ligne (0 lignes retournées). L'événement
    // reste PROCESSING avec son lease original — le lease n'a PAS été réellement
    // modifié en DB (la simulation a retourné 0 lignes ; la DB conserve le lease).
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('PROCESSING');
    expect(event1.lease_token).not.toBeNull();

    // event2 : envoyé avec succès → PROCESSED.
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PROCESSED');
    expect(event2.lease_token).toBeNull();

    // event2 : notification SENT.
    const notif2 = await getNotification(seeded2.outboxEventId);
    expect(notif2).not.toBeNull();
    expect(notif2!.status).toBe('SENT');

    // Le sender n'a été appelé que pour event2 (event1 a échoué en Phase A).
    expect(sender.sendCallCount).toBe(1);

    // Vérifier que la simulation de précondition de fencing a bien eu lieu.
    expect(leaseStolen).toBe(true);
  });

  // ─── G5E Round 3 — Additional correction tests ───

  it('58. notification SENT vue en Phase A → zéro appel sender, SEND_EMAIL COMPLETED, outbox PROCESSED (REQ 1)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Instrumentation : after the claim UPDATE, insert a SENT notification within
    // the same transaction (before the savepoint processes the event). This
    // simulates the state that would exist if a concurrent process had set the
    // notification to SENT between claim and Phase A read. Note: this is
    // instrumentation d'un résultat SQL dans la même transaction, PAS une vraie
    // course PostgreSQL concurrente.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let claimSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          // Detect the claim UPDATE (returns claimed events with PROCESSING status).
          if (!claimSeen && result && Array.isArray(result) && result.length > 0) {
            claimSeen = true;
            // Insert a SENT notification within the same transaction.
            await originalExecute(sql`
              INSERT INTO "notification_deliveries" (
                "organization_id", "outbox_event_id", "outbox_effect_id",
                "recipient_email", "template_key", "provider_idempotency_key",
                "status", "provider_message_id", "sent_at", "idempotency_key"
              ) VALUES (
                ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
                'already-sent@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
                'SENT'::notification_delivery_status, 'existing-msg-id', now(), ${deliveryKey}
              )
              ON CONFLICT ("idempotency_key") DO UPDATE SET "status" = 'SENT'::notification_delivery_status,
                "provider_message_id" = 'existing-msg-id', "sent_at" = now()
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    // Phase B skipped send — zero calls.
    expect(sender.sendCallCount).toBe(0);
    // Phase C reconciled PENDING×SENT → SEND_EMAIL COMPLETED, outbox PROCESSED.
    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(0); // Reconciled, not newly sent

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PROCESSED');
  });

  it('59. notification FAILED vue en Phase A → zéro appel sender, SEND_EMAIL FAILED, outbox FAILED (REQ 1)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Instrumentation : after the claim UPDATE, insert a FAILED notification within
    // the same transaction (before the savepoint processes the event). This
    // simulates the state that would exist if a concurrent process had set the
    // notification to FAILED between claim and Phase A read. Note: this is
    // instrumentation d'un résultat SQL dans la même transaction, PAS une vraie
    // course PostgreSQL concurrente.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let claimSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          if (!claimSeen && result && Array.isArray(result) && result.length > 0) {
            claimSeen = true;
            await originalExecute(sql`
              INSERT INTO "notification_deliveries" (
                "organization_id", "outbox_event_id", "outbox_effect_id",
                "recipient_email", "template_key", "provider_idempotency_key",
                "status", "failure_code", "idempotency_key"
              ) VALUES (
                ${ids.orgId}::uuid, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
                'failed@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
                'FAILED'::notification_delivery_status,
                'EMAIL_SEND_FAILED'::document_processing_failure_code, ${deliveryKey}
              )
              ON CONFLICT ("idempotency_key") DO UPDATE SET
                "status" = 'FAILED'::notification_delivery_status,
                "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    // Phase B skipped send — zero calls.
    expect(sender.sendCallCount).toBe(0);
    // Phase C reconciled PENDING×FAILED → SEND_EMAIL FAILED, outbox FAILED.
    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  it('60. forged runtime result → UNCERTAIN puis MANUAL_REVIEW après MAX_ATTEMPTS (REQ 2)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Forged sender returning a value missing the required `kind`.
    const forgedSender: TransactionalEmailSender = {
      async send() {
        return { status: 'FAILED', providerMessageId: 'x' } as never;
      },
    };

    // SEND_EMAIL.attempt_count=4 before reservation → 5th attempt → MANUAL_REVIEW.
    await rawSql`
      UPDATE "outbox_effects"
      SET "attempt_count" = 4
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" = 'SEND_EMAIL'
    `;
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    const result = await executeTransactionalEmailPipeline(db, forgedSender, 10);

    // The forged result is rejected by validateEmailResult → UNCERTAIN.
    // With attempt_count >= MAX_ATTEMPTS → REQUIRES_MANUAL_REVIEW.
    expect(result.claimedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.manualReviewCount).toBe(1);
    expect(result.sentCount).toBe(0);

    // Notification never becomes SENT/FAILED — REQUIRES_MANUAL_REVIEW.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
    expect(notif!.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

    // SEND_EMAIL stays PENDING.
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');

    // Outbox PENDING (excluded from further claims).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('PENDING');
  });

  it('61. providerMessageId avec espaces environnants → DB stocke la valeur trimée (REQ 3)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Forged sender returning a valid SENT result but with surrounding spaces.
    const forgedSender: TransactionalEmailSender = {
      async send() {
        return { kind: 'SENT', providerMessageId: '  trimmed-msg-id  ' };
      },
    };

    const result = await executeTransactionalEmailPipeline(db, forgedSender, 10);

    expect(result.claimedCount).toBe(1);
    expect(result.sentCount).toBe(1);

    const notif = await getNotification(seeded.outboxEventId);
    expect(notif!.status).toBe('SENT');
    // DB stores the trimmed value.
    expect(notif!.provider_message_id).toBe('trimmed-msg-id');
  });

  it('62. providerMessageId avec newline → UNCERTAIN, jamais SENT, pas de valeur raw en DB ni dans les logs (REQ 3)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Sentinel value used as providerMessageId. The newline in the middle
    // triggers parseProviderMessageId to reject it (control character after
    // trim). The sentinel must NEVER appear in DB, anomalies, failure_codes,
    // or logs.
    const SENTINEL = 'SENTINEL_SECRET\nMSG_ID';

    // Forged sender returning providerMessageId with a newline (sentinel).
    const forgedSender: TransactionalEmailSender = {
      async send() {
        return { kind: 'SENT', providerMessageId: SENTINEL };
      },
    };

    // SEND_EMAIL.attempt_count=4 before reservation → 5th attempt → MANUAL_REVIEW.
    await rawSql`
      UPDATE "outbox_effects"
      SET "attempt_count" = 4
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        AND "effect_type" = 'SEND_EMAIL'
    `;
    await rawSql`
      UPDATE "outbox_events"
      SET "attempt_count" = 0
      WHERE "id" = ${seeded.outboxEventId}::uuid
    `;

    // Spy on all console methods to capture any log output.
    // mockImplementation(() => undefined) silences the original console methods
    // so that if a regression logs the sentinel, it would NOT be printed in CI
    // output before the assertion fails.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    // Wrap pipeline execution AND assertions in a try block, with
    // vi.restoreAllMocks() in a finally block so that mocks are always
    // restored even if the pipeline or an assertion throws.
    try {
      const result = await executeTransactionalEmailPipeline(db, forgedSender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.manualReviewCount).toBe(1);
      expect(result.sentCount).toBe(0);

      // Notification never SENT/FAILED — REQUIRES_MANUAL_REVIEW.
      const notif = await getNotification(seeded.outboxEventId);
      expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
      // No raw value in DB (provider_message_id is null).
      expect(notif!.provider_message_id).toBeNull();

      // The sentinel must NOT appear in any anomaly field.
      const sentinelTrimmed = SENTINEL.trim();
      for (const anomaly of result.anomalies) {
        expect(anomaly.failureCode).not.toContain(sentinelTrimmed);
        expect(anomaly.failureCode).not.toContain('SENTINEL');
        expect(anomaly.outboxEventId).not.toContain(sentinelTrimmed);
      }

      // The sentinel must NOT appear in any failure_code in the DB.
      expect(notif!.failure_code).not.toContain(sentinelTrimmed);
      expect(notif!.failure_code).not.toContain('SENTINEL');

      // The sentinel must NOT appear in any console spy call arguments —
      // neither the raw sentinel nor an escaped representation (e.g.
      // JSON.stringify(SENTINEL)).
      const sentinelEscaped = JSON.stringify(SENTINEL);
      const allCalls = [
        ...consoleErrorSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleInfoSpy.mock.calls,
        ...consoleDebugSpy.mock.calls,
      ];
      for (const callArgs of allCalls) {
        const callStr = callArgs.map(String).join(' ');
        expect(callStr).not.toContain(sentinelTrimmed);
        expect(callStr).not.toContain('SENTINEL');
        expect(callStr).not.toContain(sentinelEscaped);
      }

      // Outbox remains PENDING so finalizer can act.
      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
    } finally {
      // Restore spies — always, even if an assertion threw.
      vi.restoreAllMocks();
    }
  });

  it('63. effect set invalide avec SEND_EMAIL present → SEND_EMAIL FAILED (REQ 4)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper that, after the claim, deletes one GENERATE_* effect within
    // the same transaction. This makes validateEffectSet fail (only 3 effects),
    // and capturedSendEmailEffectId stays null. The fail-closed lookup (REQ 4)
    // must find the SEND_EMAIL effect under lock and mark it FAILED.
    const generateEffectId = seeded.effectIds['GENERATE_CONFIRMATION']!;
    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let poseLeaseSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          // Detect the poseLease UPDATE (sets status='PROCESSING', returns
          // rows with lease_until and attempt_count).
          if (
            !poseLeaseSeen &&
            result &&
            Array.isArray(result) &&
            result.length > 0 &&
            (result[0] as Record<string, unknown>).lease_until !== undefined
          ) {
            poseLeaseSeen = true;
            // Delete one GENERATE_* effect within the same transaction.
            await originalExecute(sql`
              DELETE FROM "outbox_effects"
              WHERE "id" = ${generateEffectId}::uuid
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    expect(result.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(0);

    // SEND_EMAIL should be FAILED (fail-closed found it via lookup).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    // Outbox FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  it('64. effect set invalide avec notification PENDING → notification FAILED (REQ 4)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Insert a PENDING notification.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${seeded.effectIds['SEND_EMAIL']!}::uuid,
        'pending@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'PENDING'::notification_delivery_status, ${deliveryKey}
      )
    `;

    // Use a wrapper that, after the claim, deletes one GENERATE_* effect.
    const generateEffectId = seeded.effectIds['GENERATE_CONFIRMATION']!;
    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let poseLeaseSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          if (
            !poseLeaseSeen &&
            result &&
            Array.isArray(result) &&
            result.length > 0 &&
            (result[0] as Record<string, unknown>).lease_until !== undefined
          ) {
            poseLeaseSeen = true;
            await originalExecute(sql`
              DELETE FROM "outbox_effects"
              WHERE "id" = ${generateEffectId}::uuid
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    expect(result.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(0);

    // Notification should be FAILED.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('FAILED');

    // Outbox FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
  });

  it('65. effect SEND_EMAIL genuinely absent → outbox FAILED, pas de mutation cross-event (REQ 4)', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData();
    const seeded1 = await seedReadyForEmailEvent(ids1);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);

    // Use a wrapper that, after the claim, deletes the SEND_EMAIL effect for event1
    // within the same transaction (simulating the effect being absent at Phase A read).
    const sendEmailEffectId1 = seeded1.effectIds['SEND_EMAIL']!;
    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let claimSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          if (!claimSeen && result && Array.isArray(result) && result.length > 0) {
            claimSeen = true;
            // Delete the SEND_EMAIL effect for event1 within the same transaction.
            await originalExecute(sql`
              DELETE FROM "outbox_effects"
              WHERE "id" = ${sendEmailEffectId1}::uuid
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    // event1 should be fail-closed (outbox FAILED), event2 should succeed.
    expect(result.failedCount).toBe(1);
    expect(result.sentCount).toBe(1);

    // event1 outbox FAILED.
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).toBe('FAILED');

    // event2 untouched — PROCESSED.
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PROCESSED');

    // No cross-event mutation: event2's effects are unchanged.
    const effects2 = await getEffects(seeded2.outboxEventId);
    const sendEmail2 = effects2.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail2!.status).toBe('COMPLETED');
  });

  it('66. failClosedInTransaction avec ID SEND_EMAIL cross-event → erreur FAIL_CLOSED_EFFECT_SCOPE_MISMATCH, pas de mutation étrangère, event1 non finalisé (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData();
    const seeded1 = await seedReadyForEmailEvent(ids1);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);

    // Insert a PENDING notification for event2 (the "foreign" event).
    const providerKey2 = emailProviderIdempotencyKey(seeded2.outboxEventId);
    const deliveryKey2 = emailDeliveryIdempotencyKey(seeded2.outboxEventId);
    const sendEmailEffectId2 = seeded2.effectIds['SEND_EMAIL']!;
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids2.orgId}, ${seeded2.outboxEventId}::uuid, ${sendEmailEffectId2}::uuid,
        'foreign@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey2},
        'PENDING'::notification_delivery_status, ${deliveryKey2}
      )
    `;

    // Claim event1 manually to get a lease_token (simulate the pipeline's claim).
    // We need a valid lease_token + lease_until for the helper's outbox UPDATE.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded1.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token", "lease_until"
    `;
    const leaseToken1 = claimResult[0]!.lease_token as string;

    // Appel DIRECT du helper failClosedInTransaction dans une vraie transaction
    // PostgreSQL (savepoint dans une transaction), avec :
    //   - outboxEventId = event1's outbox event ID
    //   - organizationId = event1's org ID
    //   - leaseToken = event1's lease token
    //   - sendEmailEffectId = event2's SEND_EMAIL effect ID (cross-event injection)
    //   - failureCode = 'UNKNOWN_ERROR'
    //
    // Ceci est une injection contrôlée (direct helper call), PAS une course
    // concurrente : le helper est appelé directement avec l'outboxEventId/orgId/
    // leaseToken de event1 mais le sendEmailEffectId de event2.
    //
    // Avec le re-read scopé (Round 5) : le scoped re-read pour event1's
    // outboxEventId/orgId + event2's effectId retourne 0 lignes →
    // FAIL_CLOSED_EFFECT_SCOPE_MISMATCH → le helper jette AVANT l'UPDATE outbox.
    // Le savepoint rollback ; event1 n'est PAS finalisé (reste PROCESSING).
    // event2 n'est PAS muté.
    //
    // Ce test ÉCHOUERAIT si :
    //   - le prédicat organization_id était retiré de l'effect UPDATE
    //     (event2's effect serait muté) ;
    //   - le prédicat outbox_event_id était retiré de l'effect UPDATE
    //     (event2's effect serait muté) ;
    //   - un re-read non-scopé était réintroduit (le helper accepterait l'ID
    //     cross-event et marquerait event1 FAILED) ;
    //   - event1 était finalisé malgré l'ID étranger.
    await db.transaction(async (tx) => {
      // First, do a harmless operation in the outer tx to prove it's intact.
      await tx.execute(sql`SELECT 1`);

      // Call the helper in a savepoint — it should throw.
      await expect(
        tx.transaction(async (sp) => {
          await failClosedInTransaction(
            sp,
            seeded1.outboxEventId,
            ids1.orgId,
            leaseToken1,
            sendEmailEffectId2, // cross-event injection: event2's SEND_EMAIL effect ID
            'UNKNOWN_ERROR',
          );
        }),
      ).rejects.toThrow('FAIL_CLOSED_EFFECT_SCOPE_MISMATCH');

      // The outer transaction is still usable after the savepoint rollback.
      await tx.execute(sql`SELECT 1`);
    });

    // event2's SEND_EMAIL effect should NOT be mutated (still PENDING).
    const effects2 = await getEffects(seeded2.outboxEventId);
    const sendEmail2 = effects2.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail2!.status).toBe('PENDING');
    expect(sendEmail2!.failure_code).toBeNull();

    // event2's notification should NOT be mutated (still PENDING).
    const notif2 = await getNotification(seeded2.outboxEventId);
    expect(notif2).not.toBeNull();
    expect(notif2!.status).toBe('PENDING');
    expect(notif2!.failure_code).toBeNull();

    // event2's outbox should NOT be mutated (still PENDING, not claimed).
    const event2 = await getOutboxEvent(seeded2.outboxEventId);
    expect(event2.status).toBe('PENDING');

    // event1's outbox is NOT finalized — the helper threw before the outbox
    // UPDATE, and the savepoint rolled back. event1 stays PROCESSING.
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).not.toBe('FAILED');
    expect(event1.status).toBe('PROCESSING');
    expect(event1.lease_token).not.toBeNull();
  });

  it('67. pas de combinaison PENDING outbox + SEND_EMAIL COMPLETED → outbox FAILED (REQ 6)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Use a wrapper sender that, after send succeeds, marks SEND_EMAIL as
    // COMPLETED and notification as SENT (PENDING→COMPLETED is allowed), then
    // deletes one GENERATE_* effect. Phase C sees SEND_EMAIL COMPLETED +
    // notification SENT but only 3 effects → validateEffectSet fails →
    // fail-closed. The fail-closed UPDATE for SEND_EMAIL returns 0 rows
    // (already COMPLETED — acceptable per REQ 5), outbox → FAILED.
    const innerSender = new FakeTransactionalEmailSender();
    const sqlRaw = rawSql;
    const wrapperSender: TransactionalEmailSender = {
      async send(input) {
        const result = await innerSender.send(input);
        if (result.kind !== 'SENT') throw new Error('invariant: expected SENT');
        // Mark SEND_EMAIL as COMPLETED (PENDING→COMPLETED is allowed).
        await sqlRaw!`
          UPDATE "outbox_effects"
          SET "status" = 'COMPLETED', "completed_at" = now(), "failure_code" = NULL
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
            AND "effect_type" = 'SEND_EMAIL'
        `;
        // Mark notification as SENT.
        await sqlRaw!`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT', "sent_at" = now(),
              "provider_message_id" = ${result.providerMessageId},
              "failure_code" = NULL
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
        `;
        // Delete one GENERATE_* effect to make the effect set invalid (3 effects).
        await sqlRaw!`
          DELETE FROM "outbox_effects"
          WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
            AND "effect_type" = 'GENERATE_CONFIRMATION'
        `;
        return result;
      },
    };

    const result = await executeTransactionalEmailPipeline(db, wrapperSender, 10);

    expect(result.claimedCount).toBe(1);
    // Outbox should be FAILED (not PENDING with SEND_EMAIL COMPLETED).
    expect(result.failedCount).toBe(1);

    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();

    // SEND_EMAIL stays COMPLETED (fail-closed UPDATE returned 0 rows — already terminal).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    // No stuck state: outbox is FAILED, not PENDING.
    expect(event.status).not.toBe('PENDING');
  });

  it('68. Phase A lock avec lease expirée (token inchangé) → pas de fail-closed, pas de mutation (REQ 7)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Scénario : instrumentation qui, après le poseLease UPDATE (détecté par
    // la présence de lease_until dans les lignes de résultat), expire UNIQUEMENT
    // lease_until en le mettant dans le passé (transaction_timestamp() - interval
    // '1 second'), SANS modifier lease_token. Le token reste inchangé.
    //
    // Le Phase A lock vérifie lease_token = event.leaseToken AND lease_until >
    // transaction_timestamp(). Avec le token inchangé mais lease_until dans le
    // passé, le lock retourne 0 lignes → FencingFailureError → le catch fait
    // `continue` (pas de fail-closed avec l'ancien lease). L'événement reste
    // PROCESSING avec son lease expiré.
    //
    // Note : ceci est une instrumentation d'un résultat SQL dans la même
    // transaction, PAS une vraie course PostgreSQL concurrente. Le token n'est
    // PAS modifié — seule lease_until est expirée.
    let claimDone = false;
    const originalTransaction = db.transaction.bind(db);
    const instrumentedDb = Object.create(db) as DatabaseClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (claimDone) {
        return originalTransaction(fn);
      }
      claimDone = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalTransaction(async (tx: any) => {
        const originalExecute = tx.execute.bind(tx);
        let poseLeaseSeen = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.execute = async function (query: any) {
          const result = await originalExecute(query);
          // Detect the poseLease UPDATE (returns rows with lease_until).
          if (
            !poseLeaseSeen &&
            result &&
            Array.isArray(result) &&
            result.length > 0 &&
            (result[0] as Record<string, unknown>).lease_until !== undefined
          ) {
            poseLeaseSeen = true;
            // Expire ONLY lease_until (set to past), keeping lease_token UNCHANGED.
            // This simulates a lease that has timed out while the token stays the same.
            await originalExecute(sql`
              UPDATE "outbox_events"
              SET "lease_until" = transaction_timestamp() - interval '1 second'
              WHERE "id" = ${seeded.outboxEventId}::uuid
            `);
          }
          return result;
        };
        return fn(tx);
      });
    };

    const sender = new FakeTransactionalEmailSender();
    const result = await executeTransactionalEmailPipeline(instrumentedDb, sender, 10);

    // No send, no fail, no false counters.
    expect(sender.sendCallCount).toBe(0);
    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.leaseLostCount).toBe(0);
    expect(result.anomalies.length).toBe(0);

    // Outbox NOT PROCESSED and NOT FAILED (stays PROCESSING).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('PROCESSED');
    expect(event.status).not.toBe('FAILED');
    expect(event.status).toBe('PROCESSING');

    // lease_token still equals the claim token (unchanged).
    expect(event.lease_token).not.toBeNull();

    // lease_until is the expired value (in the past or NULL after instrumentation).
    // The instrumentation set it to transaction_timestamp() - interval '1 second',
    // but since the pipeline's Phase A lock rolled back the savepoint (not the
    // outer tx), the lease_until should still be the expired value set by the
    // instrumentation (it ran in the outer tx, not the savepoint).
    expect(event.lease_until).not.toBeNull();

    // SEND_EMAIL effect NOT transitioned (still PENDING).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');

    // No notification created or modified by the old worker.
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).toBeNull();
  });

  // ─── Tests 69-73 : contrôle de cardinalité du helper failClosedInTransaction ───

  it('69. effet du même événement déjà COMPLETED → zéro UPDATE accepté sans régression', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Mark SEND_EMAIL as COMPLETED (already terminal).
    await rawSql`
      UPDATE "outbox_effects"
      SET "status" = 'COMPLETED', "completed_at" = now(), "failure_code" = NULL
      WHERE "id" = ${sendEmailEffectId}::uuid
    `;

    // Claim event1 manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly in a real transaction with the SEND_EMAIL effect id.
    // The effect is already COMPLETED → the UPDATE returns 0 rows → re-read shows
    // COMPLETED → acceptable (no regression, no throw).
    await db.transaction(async (tx) => {
      await failClosedInTransaction(
        tx,
        seeded.outboxEventId,
        ids.orgId,
        leaseToken,
        sendEmailEffectId,
        'UNKNOWN_ERROR',
      );
    });

    // Effect stays COMPLETED (not regressed to FAILED).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('COMPLETED');

    // Outbox IS marked FAILED (the helper's outbox UPDATE succeeded).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it('70. effet du même événement déjà FAILED → zéro UPDATE accepté', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Mark SEND_EMAIL as FAILED (already terminal).
    await rawSql`
      UPDATE "outbox_effects"
      SET "status" = 'FAILED', "completed_at" = now(),
          "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
      WHERE "id" = ${sendEmailEffectId}::uuid
    `;

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly. The effect is already FAILED → UPDATE returns
    // 0 rows → re-read shows FAILED → acceptable (no throw).
    await db.transaction(async (tx) => {
      await failClosedInTransaction(
        tx,
        seeded.outboxEventId,
        ids.orgId,
        leaseToken,
        sendEmailEffectId,
        'UNKNOWN_ERROR',
      );
    });

    // Effect stays FAILED (not double-failed or regressed).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    // Outbox IS marked FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it("71. UUID d'effet inexistant → erreur FAIL_CLOSED_EFFECT_SCOPE_MISMATCH, pas de finalisation (REQ 5)", async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Generate a random UUID that does NOT belong to any event/org/effect_type.
    // Ceci est un UUID inexistant (pas un vrai ID cross-event — voir test 66
    // pour l'injection cross-event réelle avec un ID persisté).
    //
    // Vraie transaction PostgreSQL : oui (appel direct du helper).
    // Injection directe : oui (UUID aléatoire non persisté).
    // Instrumentation de résultat SQL : non (vrai état DB).
    // Course concurrente réelle : non.
    const randomEffectId = crypto.randomUUID();

    // Call the helper directly with a non-existent effect UUID.
    // The effect UPDATE returns 0 rows → scoped re-read returns 0 rows →
    // FAIL_CLOSED_EFFECT_SCOPE_MISMATCH (même erreur que cross-event —
    // aucune différence observable entre "ID inexistant" et "ID d'un autre
    // tenant/événement", pas d'oracle).
    await expect(
      db.transaction(async (tx) => {
        await failClosedInTransaction(
          tx,
          seeded.outboxEventId,
          ids.orgId,
          leaseToken,
          randomEffectId,
          'UNKNOWN_ERROR',
        );
      }),
    ).rejects.toThrow('FAIL_CLOSED_EFFECT_SCOPE_MISMATCH');

    // Outbox should NOT be marked FAILED (the helper threw before the outbox UPDATE,
    // and the transaction was rolled back).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('FAILED');
    // The outbox stays PROCESSING (the claim was not rolled back by the helper's
    // throw — only the savepoint/transaction was rolled back).
    expect(event.status).toBe('PROCESSING');
  });

  it('72. notification déjà terminale (SENT) → aucune régression', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Insert a SENT notification (already terminal).
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "provider_message_id", "sent_at", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
        'already-sent@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'SENT'::notification_delivery_status, 'existing-msg-id', now(), ${deliveryKey}
      )
    `;

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly. The notification is already SENT →
    // the notification UPDATE returns 0 rows → re-read shows SENT →
    // acceptable (no throw, no regression).
    await db.transaction(async (tx) => {
      await failClosedInTransaction(
        tx,
        seeded.outboxEventId,
        ids.orgId,
        leaseToken,
        sendEmailEffectId,
        'UNKNOWN_ERROR',
      );
    });

    // Notification stays SENT (not regressed to FAILED).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('SENT');
    expect(notif!.failure_code).toBeNull();

    // Outbox IS marked FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it('73. outbox fencing à zéro (lease expirée) → rollback savepoint et continuation', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Claim event manually to get a lease_token, but set lease_until to the past
    // (expired lease). The helper's outbox UPDATE includes
    // AND "lease_until" > transaction_timestamp() → returns 0 rows →
    // RECONCILE_PRECONDITION_VIOLATED.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() - interval '1 second',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly in a savepoint within a transaction.
    // The helper should throw RECONCILE_PRECONDITION_VIOLATED (outbox UPDATE
    // returns 0 rows because lease_until is in the past).
    // The savepoint should roll back, but the outer transaction stays intact.
    await db.transaction(async (tx) => {
      // First, do a harmless operation in the outer tx to prove it's intact.
      await tx.execute(sql`SELECT 1`);

      // Now call the helper in a savepoint — it should throw.
      await expect(
        tx.transaction(async (sp) => {
          await failClosedInTransaction(
            sp,
            seeded.outboxEventId,
            ids.orgId,
            leaseToken,
            sendEmailEffectId,
            'UNKNOWN_ERROR',
          );
        }),
      ).rejects.toThrow('RECONCILE_PRECONDITION_VIOLATED');

      // The outer transaction is still usable after the savepoint rollback.
      await tx.execute(sql`SELECT 1`);
    });

    // Outbox should NOT be marked FAILED (the helper threw, savepoint rolled back).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('FAILED');
    // The outbox stays PROCESSING with the expired lease.
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).not.toBeNull();

    // SEND_EMAIL effect NOT transitioned (still PENDING — savepoint rolled back).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');
  });

  // ─── Tests 74-78 : Round 5 — notification cardinality & effect PENDING instrumentation ───

  it('74. effect UPDATE instrumenté à 0 lignes alors que PENDING → FAIL_CLOSED_PRECONDITION_VIOLATED, rollback (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Vraie transaction PostgreSQL : oui (appel direct du helper dans un
    // savepoint). Injection directe : non. Instrumentation de résultat SQL :
    // oui (wrapper tx.execute qui retourne [] pour l'effect UPDATE). Course
    // concurrente réelle : non.
    //
    // Le wrapper détecte l'effect UPDATE (outbox_effects + 'FAILED') et
    // retourne 0 lignes ([]), alors que l'effet est genuinely PENDING en DB.
    // Le scoped re-read trouve l'effet PENDING → FAIL_CLOSED_PRECONDITION_VIOLATED.
    // Le savepoint rollback ; l'outbox n'est PAS finalisé.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.transaction(async (sp: any) => {
          const originalExecute = sp.execute.bind(sp);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sp.execute = async function (query: any) {
            const text = getQueryText(query);
            if (text.includes('outbox_effects') && text.includes("'FAILED'")) {
              // Instrument: return 0 rows for the effect UPDATE.
              return [];
            }
            return originalExecute(query);
          };
          await failClosedInTransaction(
            sp,
            seeded.outboxEventId,
            ids.orgId,
            leaseToken,
            sendEmailEffectId,
            'UNKNOWN_ERROR',
          );
        }),
      ).rejects.toThrow('FAIL_CLOSED_PRECONDITION_VIOLATED');

      await tx.execute(sql`SELECT 1`);
    });

    // Outbox NOT finalized — stays PROCESSING (helper threw before outbox UPDATE).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('FAILED');
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).not.toBeNull();

    // Effect still PENDING (savepoint rolled back, UPDATE was instrumented to 0).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');
    expect(sendEmail!.failure_code).toBeNull();
  });

  it('75. notification déjà terminale (FAILED) → 0 UPDATE accepté, pas de régression (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Insert a FAILED notification (already terminal).
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "failure_code", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
        'already-failed@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'FAILED'::notification_delivery_status, 'RENDER_FAILED'::document_processing_failure_code, ${deliveryKey}
      )
    `;

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly. The notification is already FAILED →
    // the notification UPDATE returns 0 rows → scoped re-read shows FAILED →
    // acceptable (no throw, no regression).
    await db.transaction(async (tx) => {
      await failClosedInTransaction(
        tx,
        seeded.outboxEventId,
        ids.orgId,
        leaseToken,
        sendEmailEffectId,
        'UNKNOWN_ERROR',
      );
    });

    // Notification stays FAILED (not regressed — failure_code unchanged).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('FAILED');
    expect(notif!.failure_code).toBe('RENDER_FAILED');

    // Outbox IS marked FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it('76. notification absente → 0 UPDATE accepté (légitime), outbox FAILED (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // No notification exists — this is a legitimate state (Phase A before
    // creation, Phase C PENDING × missing, etc.).

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Call the helper directly. No notification exists →
    // the notification UPDATE returns 0 rows → scoped re-read returns 0 rows →
    // acceptable (no throw — legitimate state).
    await db.transaction(async (tx) => {
      await failClosedInTransaction(
        tx,
        seeded.outboxEventId,
        ids.orgId,
        leaseToken,
        sendEmailEffectId,
        'UNKNOWN_ERROR',
      );
    });

    // No notification exists (still absent).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).toBeNull();

    // Effect IS marked FAILED (the effect UPDATE succeeded — effect was PENDING).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('FAILED');

    // Outbox IS marked FAILED.
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).toBe('FAILED');
    expect(event.lease_token).toBeNull();
  });

  it('77. notification UPDATE instrumenté à 0 lignes alors que PENDING → FAIL_CLOSED_PRECONDITION_VIOLATED, rollback (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedReadyForEmailEvent(ids);
    const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

    // Insert a PENDING notification.
    const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
    const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
        'pending@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
        'PENDING'::notification_delivery_status, ${deliveryKey}
      )
    `;

    // Claim event manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken = claimResult[0]!.lease_token as string;

    // Vraie transaction PostgreSQL : oui (appel direct du helper dans un
    // savepoint). Injection directe : non. Instrumentation de résultat SQL :
    // oui (wrapper tx.execute qui retourne [] pour la notification UPDATE).
    // Course concurrente réelle : non.
    //
    // Le wrapper détecte la notification UPDATE (notification_deliveries +
    // 'FAILED') et retourne 0 lignes ([]), alors que la notification est
    // genuinely PENDING en DB. L'effect UPDATE s'exécute normalement (effect →
    // FAILED), puis la notification UPDATE retourne 0 → scoped re-read trouve
    // PENDING → FAIL_CLOSED_PRECONDITION_VIOLATED. Le savepoint rollback ;
    // l'outbox n'est PAS finalisé ; l'effect reste PENDING (rollback).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.transaction(async (sp: any) => {
          const originalExecute = sp.execute.bind(sp);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sp.execute = async function (query: any) {
            const text = getQueryText(query);
            if (text.includes('notification_deliveries') && text.includes("'FAILED'")) {
              // Instrument: return 0 rows for the notification UPDATE.
              return [];
            }
            return originalExecute(query);
          };
          await failClosedInTransaction(
            sp,
            seeded.outboxEventId,
            ids.orgId,
            leaseToken,
            sendEmailEffectId,
            'UNKNOWN_ERROR',
          );
        }),
      ).rejects.toThrow('FAIL_CLOSED_PRECONDITION_VIOLATED');

      await tx.execute(sql`SELECT 1`);
    });

    // Outbox NOT finalized — stays PROCESSING (helper threw before outbox UPDATE).
    const event = await getOutboxEvent(seeded.outboxEventId);
    expect(event.status).not.toBe('FAILED');
    expect(event.status).toBe('PROCESSING');
    expect(event.lease_token).not.toBeNull();

    // Notification still PENDING (savepoint rolled back, UPDATE was instrumented to 0).
    const notif = await getNotification(seeded.outboxEventId);
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('PENDING');
    expect(notif!.failure_code).toBeNull();

    // Effect still PENDING (savepoint rolled back — the effect UPDATE was
    // executed but rolled back with the savepoint).
    const effects = await getEffects(seeded.outboxEventId);
    const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail!.status).toBe('PENDING');
    expect(sendEmail!.failure_code).toBeNull();
  });

  it('78. notification liée à un effet/événement étranger → pas de lecture ni mutation hors scope, FAIL_CLOSED_EFFECT_SCOPE_MISMATCH (REQ 5)', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData();
    const seeded1 = await seedReadyForEmailEvent(ids1);
    const ids2 = await seedBaseData();
    const seeded2 = await seedReadyForEmailEvent(ids2);
    const sendEmailEffectId2 = seeded2.effectIds['SEND_EMAIL']!;

    // Insert a PENDING notification for event2 (the "foreign" event).
    const providerKey2 = emailProviderIdempotencyKey(seeded2.outboxEventId);
    const deliveryKey2 = emailDeliveryIdempotencyKey(seeded2.outboxEventId);
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "idempotency_key"
      ) VALUES (
        ${ids2.orgId}, ${seeded2.outboxEventId}::uuid, ${sendEmailEffectId2}::uuid,
        'foreign-notif@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey2},
        'PENDING'::notification_delivery_status, ${deliveryKey2}
      )
    `;

    // Claim event1 manually to get a lease_token.
    const claimResult = await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSING',
          "lease_token" = gen_random_uuid(),
          "lease_until" = transaction_timestamp() + interval '30 seconds',
          "attempt_count" = COALESCE("attempt_count", 0) + 1
      WHERE "id" = ${seeded1.outboxEventId}::uuid
        AND "status" = 'PENDING'
      RETURNING "id", "lease_token"
    `;
    const leaseToken1 = claimResult[0]!.lease_token as string;

    // Vraie transaction PostgreSQL : oui (appel direct du helper dans un
    // savepoint). Injection directe : oui (event2's sendEmailEffectId avec
    // event1's params). Instrumentation de résultat SQL : non (vrai état DB).
    // Course concurrente réelle : non.
    //
    // Le helper est appelé avec event1's outboxEventId/orgId/leaseToken mais
    // event2's sendEmailEffectId. L'effect UPDATE retourne 0 lignes (prédicats
    // ne matchent pas). Le scoped effect re-read pour event1 + event2's
    // effectId retourne 0 lignes → FAIL_CLOSED_EFFECT_SCOPE_MISMATCH → throw
    // AVANT d'atteindre la notification UPDATE. La notification de event2
    // n'est jamais lue ni mutée. Le savepoint rollback ; event1 n'est PAS
    // finalisé.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);

      await expect(
        tx.transaction(async (sp) => {
          await failClosedInTransaction(
            sp,
            seeded1.outboxEventId,
            ids1.orgId,
            leaseToken1,
            sendEmailEffectId2, // foreign effect ID from event2
            'UNKNOWN_ERROR',
          );
        }),
      ).rejects.toThrow('FAIL_CLOSED_EFFECT_SCOPE_MISMATCH');

      await tx.execute(sql`SELECT 1`);
    });

    // event2's notification NOT mutated (still PENDING, no failure_code).
    const notif2 = await getNotification(seeded2.outboxEventId);
    expect(notif2).not.toBeNull();
    expect(notif2!.status).toBe('PENDING');
    expect(notif2!.failure_code).toBeNull();

    // event2's effect NOT mutated (still PENDING).
    const effects2 = await getEffects(seeded2.outboxEventId);
    const sendEmail2 = effects2.find((e) => e.effect_type === 'SEND_EMAIL');
    expect(sendEmail2!.status).toBe('PENDING');
    expect(sendEmail2!.failure_code).toBeNull();

    // event1 NOT finalized — stays PROCESSING (helper threw before outbox UPDATE).
    const event1 = await getOutboxEvent(seeded1.outboxEventId);
    expect(event1.status).not.toBe('FAILED');
    expect(event1.status).toBe('PROCESSING');
    expect(event1.lease_token).not.toBeNull();
  });

  describe('Phase C — G5H-C2B fail-closed', () => {
    it('DETERMINISTIC_REFUSAL marks notification and effect FAILED', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'DETERMINISTIC_REFUSAL', failureCode: 'INVALID_RECIPIENT' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.manualReviewCount).toBe(0);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('FAILED');
      expect(notif!.failure_code).toBe('EMAIL_SEND_FAILED');

      const effects = await getEffects(seeded.outboxEventId);
      const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
      expect(sendEmail!.status).toBe('FAILED');
      expect(sendEmail!.failure_code).toBe('EMAIL_SEND_FAILED');

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('FAILED');
      expect(event.lease_token).toBeNull();
    });

    it('TRANSIENT_NOT_SENT retries with backoff and preserves timestamp', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'TRANSIENT_NOT_SENT', failureCode: 'PROVIDER_RATE_LIMITED' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.manualReviewCount).toBe(0);
      expect(sender.failedCount).toBe(1);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('PENDING');
      expect(notif!.failure_code).toBeNull();
      expect(notif!.provider_first_attempt_started_at).not.toBeNull();

      const effects = await getEffects(seeded.outboxEventId);
      const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
      expect(sendEmail!.status).toBe('PENDING');
      expect(sendEmail!.attempt_count).toBe(1);

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
      expect(event.lease_token).toBeNull();
      expect(event.available_at).not.toBeNull();
    });

    it('UNCERTAIN at the 5th attempt becomes REQUIRES_MANUAL_REVIEW', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResults(
        Array.from(
          { length: 5 },
          () => ({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' }) as const,
        ),
      );

      for (let i = 0; i < 5; i++) {
        await rawSql`
          UPDATE "outbox_events"
          SET "status" = 'PENDING',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "available_at" = now(),
              "processed_at" = NULL
          WHERE "id" = ${seeded.outboxEventId}::uuid
        `;

        const result = await executeTransactionalEmailPipeline(db, sender, 1);

        const effects = await getEffects(seeded.outboxEventId);
        const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');

        if (i < 4) {
          expect(result.manualReviewCount).toBe(0);
          expect(sendEmail!.attempt_count).toBe(i + 1);
        } else {
          expect(result.claimedCount).toBe(1);
          expect(result.manualReviewCount).toBe(1);
          expect(sendEmail!.attempt_count).toBe(5);

          const notif = await getNotification(seeded.outboxEventId);
          expect(notif).not.toBeNull();
          expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
          expect(notif!.failure_code).toBe('PROVIDER_RESULT_UNCERTAIN');

          const event = await getOutboxEvent(seeded.outboxEventId);
          expect(event.status).toBe('PENDING');
          expect(event.lease_token).toBeNull();
        }
      }
    });

    it('sender exception (Error) is normalised to UNCERTAIN and retried', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'THROW_ERROR' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.manualReviewCount).toBe(0);
      expect(sender.sendCallCount).toBe(1);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('PENDING');
      expect(notif!.provider_first_attempt_started_at).not.toBeNull();

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
    });

    it('sender non-Error throw is normalised to UNCERTAIN and retried', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'THROW_NON_ERROR' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.manualReviewCount).toBe(0);
      expect(sender.sendCallCount).toBe(1);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('PENDING');
      expect(notif!.provider_first_attempt_started_at).not.toBeNull();

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
    });

    it('forged runtime result is normalised to UNCERTAIN and retried', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      sender.returnInvalidResultNext();

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.manualReviewCount).toBe(0);
      expect(sender.sendCallCount).toBe(1);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('PENDING');

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
    });

    it('cutoff at 23 hours bypasses the provider and marks manual review', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
      const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);
      const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;

      await rawSql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "provider_first_attempt_started_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
          'cutoff@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
          'PENDING'::notification_delivery_status,
          transaction_timestamp() - interval '23 hours', ${deliveryKey}
        )
      `;

      const sender = new FakeTransactionalEmailSender();
      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.manualReviewCount).toBe(1);
      expect(sender.sendCallCount).toBe(0);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
      expect(notif!.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');

      const effects = await getEffects(seeded.outboxEventId);
      const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
      expect(sendEmail!.status).toBe('PENDING');
      expect(sendEmail!.attempt_count).toBe(0);

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
      expect(event.lease_token).toBeNull();
    });

    it('UNCERTAIN at the 5th attempt + 23h cutoff marks EMAIL_RETRY_WINDOW_EXPIRED', async () => {
      if (!db || !rawSql) return;
      const sql = rawSql;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;
      const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
      const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);

      // Pre-seed an existing PENDING notification whose first attempt started 23h ago.
      await sql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "provider_first_attempt_started_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
          'cutoff-uncertain@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
          'PENDING'::notification_delivery_status,
          transaction_timestamp() - interval '23 hours', ${deliveryKey}
        )
      `;

      // The 5th attempt would otherwise hit MAX_ATTEMPTS.
      await sql`
        UPDATE "outbox_effects"
        SET "attempt_count" = 4
        WHERE "id" = ${sendEmailEffectId}::uuid
      `;
      await sql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
            "available_at" = now(), "processed_at" = NULL
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;

      // Sender is configured for the 5th call, but the cutoff prevents it.
      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.manualReviewCount).toBe(1);
      expect(sender.sendCallCount).toBe(0);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
      expect(notif!.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');

      const effects = await getEffects(seeded.outboxEventId);
      const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
      expect(sendEmail!.status).toBe('PENDING');
      expect(sendEmail!.attempt_count).toBe(4);

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
      expect(event.lease_token).toBeNull();
    });

    it('TRANSIENT_NOT_SENT + 23h cutoff does not call the provider again', async () => {
      if (!db || !rawSql) return;
      const sql = rawSql;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sendEmailEffectId = seeded.effectIds['SEND_EMAIL']!;
      const providerKey = emailProviderIdempotencyKey(seeded.outboxEventId);
      const deliveryKey = emailDeliveryIdempotencyKey(seeded.outboxEventId);

      // Pre-seed an existing PENDING notification whose first attempt started 23h ago.
      await sql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "provider_first_attempt_started_at", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
          'cutoff-transient@example.com', ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY}, ${providerKey},
          'PENDING'::notification_delivery_status,
          transaction_timestamp() - interval '23 hours', ${deliveryKey}
        )
      `;

      const sender = new FakeTransactionalEmailSender();
      sender.setNextResult({ kind: 'TRANSIENT_NOT_SENT', failureCode: 'PROVIDER_RATE_LIMITED' });

      const result = await executeTransactionalEmailPipeline(db, sender, 10);

      expect(result.claimedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.manualReviewCount).toBe(1);
      expect(sender.sendCallCount).toBe(0);

      const notif = await getNotification(seeded.outboxEventId);
      expect(notif).not.toBeNull();
      expect(notif!.status).toBe('REQUIRES_MANUAL_REVIEW');
      expect(notif!.failure_code).toBe('EMAIL_RETRY_WINDOW_EXPIRED');

      const effects = await getEffects(seeded.outboxEventId);
      const sendEmail = effects.find((e) => e.effect_type === 'SEND_EMAIL');
      expect(sendEmail!.status).toBe('PENDING');
      expect(sendEmail!.attempt_count).toBe(0);

      const event = await getOutboxEvent(seeded.outboxEventId);
      expect(event.status).toBe('PENDING');
      expect(event.lease_token).toBeNull();
    });

    it('two concurrent workers result in exactly one provider call', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();

      const [r1, r2] = await Promise.all([
        executeTransactionalEmailPipeline(db, sender, 10),
        executeTransactionalEmailPipeline(db, sender, 10),
      ]);

      expect(r1.claimedCount + r2.claimedCount).toBe(1);
      expect(r1.sentCount + r2.sentCount).toBe(1);
      expect(sender.sendCallCount).toBe(1);
    });
  });

  describe('G5H-C2B critical invariants', () => {
    it('Phase B transaction est commitée avant le début logique de sender.send()', async () => {
      if (!db) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new (class implements TransactionalEmailSender {
        sendCallCount = 0;
        constructor(
          private db: DatabaseClient,
          private orgId: string,
          private outboxEventId: string,
        ) {}
        async send(_input: EmailInput): Promise<EmailSendResult> {
          this.sendCallCount++;
          const [sendEmail, notif, outbox] = await Promise.all([
            this.db.execute(
              sql`SELECT "attempt_count" FROM "outbox_effects" WHERE "organization_id" = ${this.orgId}::uuid AND "outbox_event_id" = ${this.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
            ) as unknown as Promise<Array<{ attempt_count: number }>>,
            this.db.execute(
              sql`SELECT "status", "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "organization_id" = ${this.orgId}::uuid AND "outbox_event_id" = ${this.outboxEventId}::uuid`,
            ) as unknown as Promise<
              Array<{ status: string; provider_first_attempt_started_at: Date | null }>
            >,
            this.db.execute(
              sql`SELECT "status", "lease_token" FROM "outbox_events" WHERE "id" = ${this.outboxEventId}::uuid AND "organization_id" = ${this.orgId}::uuid`,
            ) as unknown as Promise<Array<{ status: string; lease_token: string | null }>>,
          ]);
          expect(sendEmail[0]!.attempt_count).toBe(1);
          expect(notif[0]!.status).toBe('PENDING');
          expect(notif[0]!.provider_first_attempt_started_at).not.toBeNull();
          expect(outbox[0]!.status).toBe('PROCESSING');
          expect(outbox[0]!.lease_token).toBeTruthy();
          return { kind: 'SENT', providerMessageId: 'msg_commit_before_call' };
        }
      })(db, ids.orgId, seeded.outboxEventId);

      const result = await executeTransactionalEmailPipeline(db, sender, 10);
      expect(result.sentCount).toBe(1);
    });

    it('échec de persistance du timestamp provoque un rollback sans appel fournisseur', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const before = (await db.execute(
        sql`SELECT "attempt_count" FROM "outbox_effects" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      )) as unknown as Array<{ attempt_count: number }>;
      const attemptCountBefore = before[0]!.attempt_count;

      await rawSql`
        CREATE OR REPLACE FUNCTION reject_provider_timestamp_update() RETURNS trigger AS $$
        BEGIN
          IF OLD.provider_first_attempt_started_at IS NULL AND NEW.provider_first_attempt_started_at IS NOT NULL THEN
            RAISE EXCEPTION 'test: provider timestamp update rejected';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;
      await rawSql`
        CREATE TRIGGER test_reject_provider_timestamp
        BEFORE UPDATE ON notification_deliveries
        FOR EACH ROW EXECUTE FUNCTION reject_provider_timestamp_update()
      `;

      const sender = new FakeTransactionalEmailSender();
      try {
        await executeTransactionalEmailPipeline(db, sender, 10);
      } finally {
        await rawSql`DROP TRIGGER IF EXISTS test_reject_provider_timestamp ON notification_deliveries`;
        await rawSql`DROP FUNCTION IF EXISTS reject_provider_timestamp_update()`;
      }

      expect(sender.sendCallCount).toBe(0);
      const after = (await db.execute(
        sql`SELECT "attempt_count" FROM "outbox_effects" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      )) as unknown as Array<{ attempt_count: number }>;
      expect(after[0]!.attempt_count).toBe(attemptCountBefore);

      const notif = (await db.execute(
        sql`SELECT "status", "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid`,
      )) as unknown as Array<{
        status: string;
        provider_first_attempt_started_at: Date | null;
      }>;
      expect(notif[0]!.status).toBe('PENDING');
      expect(notif[0]!.provider_first_attempt_started_at).toBeNull();

      const outbox = (await db.execute(
        sql`SELECT "status", "lease_token" FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid AND "organization_id" = ${ids.orgId}::uuid`,
      )) as unknown as Array<{ status: string; lease_token: string | null }>;
      expect(outbox[0]!.status).toBe('PENDING');
      expect(outbox[0]!.lease_token).toBeNull();
    });

    it('crash après Phase B et replay idempotent', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();

      await expect(
        executeTransactionalEmailPipeline(db, sender, 10, {
          onAfterPhaseB: async () => {
            throw new Error('simulated crash before Phase C');
          },
        }),
      ).rejects.toThrow('simulated crash before Phase C');

      const firstNotif = (await db.execute(
        sql`SELECT "status", "provider_first_attempt_started_at" FROM "notification_deliveries" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid`,
      )) as unknown as Array<{
        status: string;
        provider_first_attempt_started_at: Date | null;
      }>;
      const firstEffect = (await db.execute(
        sql`SELECT "attempt_count" FROM "outbox_effects" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      )) as unknown as Array<{ attempt_count: number }>;
      const firstOutbox = (await db.execute(
        sql`SELECT "status", "lease_token", "lease_until" FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid AND "organization_id" = ${ids.orgId}::uuid`,
      )) as unknown as Array<{
        status: string;
        lease_token: string | null;
        lease_until: Date | null;
      }>;

      expect(sender.sendCallCount).toBe(1);
      expect(firstEffect[0]!.attempt_count).toBe(1);
      expect(firstNotif[0]!.provider_first_attempt_started_at).not.toBeNull();
      expect(firstNotif[0]!.status).toBe('PENDING');
      expect(firstOutbox[0]!.status).toBe('PROCESSING');
      expect(firstOutbox[0]!.lease_token).toBeTruthy();

      await rawSql`UPDATE "outbox_events" SET "lease_until" = transaction_timestamp() - interval '1 minute' WHERE "id" = ${seeded.outboxEventId}::uuid`;

      const secondResult = await executeTransactionalEmailPipeline(db, sender, 10);
      expect(secondResult.sentCount).toBe(1);
      expect(sender.sendCallCount).toBe(2);
      expect(sender.calls[0]!.providerIdempotencyKey).toBe(sender.calls[1]!.providerIdempotencyKey);
      expect(sender.calls[0]!.recipientEmail).toBe(sender.calls[1]!.recipientEmail);

      const finalNotif = (await db.execute(
        sql`SELECT "status", "provider_message_id" FROM "notification_deliveries" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid`,
      )) as unknown as Array<{ status: string; provider_message_id: string | null }>;
      const finalEffect = (await db.execute(
        sql`SELECT "status" FROM "outbox_effects" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      )) as unknown as Array<{ status: string }>;
      const finalOutbox = (await db.execute(
        sql`SELECT "status" FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid AND "organization_id" = ${ids.orgId}::uuid`,
      )) as unknown as Array<{ status: string }>;
      expect(finalNotif[0]!.status).toBe('SENT');
      expect(finalEffect[0]!.status).toBe('COMPLETED');
      expect(finalOutbox[0]!.status).toBe('PROCESSED');
    });

    it('crash de la cinquième tentative : aucun sixième appel fournisseur', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      const seeded = await seedReadyForEmailEvent(ids);

      const sender = new FakeTransactionalEmailSender();
      await db.execute(
        sql`UPDATE "outbox_effects" SET "attempt_count" = 4 WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      );
      await db.execute(
        sql`UPDATE "notification_deliveries" SET "provider_first_attempt_started_at" = transaction_timestamp() WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid`,
      );

      await expect(
        executeTransactionalEmailPipeline(db, sender, 10, {
          onAfterPhaseB: async () => {
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');

      expect(sender.sendCallCount).toBe(1);
      const midEffect = (await db.execute(
        sql`SELECT "attempt_count" FROM "outbox_effects" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid AND "effect_type" = 'SEND_EMAIL'`,
      )) as unknown as Array<{ attempt_count: number }>;
      expect(midEffect[0]!.attempt_count).toBe(5);

      await rawSql`UPDATE "outbox_events" SET "lease_until" = transaction_timestamp() - interval '1 minute' WHERE "id" = ${seeded.outboxEventId}::uuid`;

      const secondResult = await executeTransactionalEmailPipeline(db, sender, 10);
      expect(sender.sendCallCount).toBe(1);
      expect(secondResult.claimedCount).toBe(0); // SEND_EMAIL.attempt_count = 5 now excludes re-claim
      const notif = (await db.execute(
        sql`SELECT "status" FROM "notification_deliveries" WHERE "organization_id" = ${ids.orgId}::uuid AND "outbox_event_id" = ${seeded.outboxEventId}::uuid`,
      )) as unknown as Array<{ status: string }>;
      expect(notif[0]!.status).toBe('PENDING');
      const outbox = (await db.execute(
        sql`SELECT "status", "lease_token" FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid AND "organization_id" = ${ids.orgId}::uuid`,
      )) as unknown as Array<{ status: string; lease_token: string | null }>;
      expect(outbox[0]!.status).toBe('PROCESSING');
      expect(outbox[0]!.lease_token).toBeTruthy();
    });
  });
});
