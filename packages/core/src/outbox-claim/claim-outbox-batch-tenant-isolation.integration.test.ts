/**
 * @uttily/core — Tests d'intégration PostgreSQL d'isolation multi-tenant
 * pour claimOutboxBatch (G5F, ADR-013 §7).
 *
 * Audit de sécurité ciblé sur les sous-requêtes d'éligibilité dans
 * claimOutboxBatch : vérifie que les sous-requêtes EXISTS/NOT EXISTS sur
 * outbox_effects et notification_deliveries corrèlent sur organization_id
 * (défense en profondeur), et qu'un événement de l'org A ne devient jamais
 * éligible en se basant sur les effets de l'org B.
 *
 * Scénarios couverts :
 * 1. Non-sélection cross-tenant READY_FOR_TRANSACTIONAL_EMAIL :
 *    l'event de A (0 effets) n'est pas sélectionné même si B a 3 effets COMPLETED.
 * 2. Sélection indépendante : l'event de B (avec ses propres effets) est sélectionné
 *    séparément, l'event de A ne l'est pas.
 * 3. Non-sélection INCOMPLETE_DOCUMENT_GENERATION cross-tenant :
 *    l'event de A (0 effets) reste sélectionnable par INCOMPLETE (car 0 effets ≠ 3 COMPLETED)
 *    mais l'event de B (3 COMPLETED) n'est PAS sélectionné par INCOMPLETE.
 * 4. notification_deliveries cross-tenant : une notification SENT sur l'event de B
 *    n'exclut pas l'event de A de la sélection READY_FOR_TRANSACTIONAL_EMAIL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { claimOutboxBatch, BOOKING_CONFIRMED_SELECTION } from './index';
import { effectIdempotencyKey } from '../transactional-documents/effect-mapping';

const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5fclaim');
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
// Seed helpers (duplication minimale self-contained, adaptés de
// document-generation-pipeline.integration.test.ts et
// transactional-email-pipeline.integration.test.ts)
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

async function seedBaseData(suffix = SUFFIX()): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
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

async function seedBookingConfirmedEvent(ids: BaseIds): Promise<SeedBookingResult> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const amountMinor = 10000;
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
      )
      VALUES (${booking.id}, ${line.id}, ${itemId}, ${bookingBlock.id})
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
 * Seed 3 effets GENERATE_* COMPLETED + 1 effet SEND_EMAIL PENDING pour un event.
 * Crée également le document_render_snapshot et les documents nécessaires (FK).
 * Tous les effets portent l'organization_id de l'org propriétaire de l'event.
 */
async function seedCompletedEffectsAndSendEmail(
  ids: BaseIds,
  seeded: SeedBookingResult,
): Promise<{ sendEmailEffectId: string }> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;

  // Crée un document_render_snapshot (FK requise pour documents).
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

  const generateTypes = ['GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT'] as const;
  const docTypes = ['CONFIRMATION', 'CONTRACT', 'RECEIPT'] as const;

  for (let i = 0; i < 3; i++) {
    const effectType = generateTypes[i]!;
    const docType = docTypes[i]!;
    const storageKey = crypto.randomUUID();
    const effectIdempKey = effectIdempotencyKey(seeded.outboxEventId, effectType);
    const docIdempKey = `doc_${seeded.outboxEventId}_${docType}_v1`;

    // Insère le document (FK pour effect.document_id).
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

    // Insère l'effet COMPLETED avec storage_key et document_id.
    await sql`
      INSERT INTO "outbox_effects" (
        "organization_id", "outbox_event_id", "effect_type",
        "status", "document_id", "storage_key", "idempotency_key", "completed_at"
      ) VALUES (
        ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${effectType}::outbox_effect_type,
        'COMPLETED'::outbox_effect_status, ${doc.id}::uuid, ${storageKey}, ${effectIdempKey}, now()
      )
    `;
  }

  // Insère l'effet SEND_EMAIL PENDING.
  const sendEmailIdempKey = effectIdempotencyKey(seeded.outboxEventId, 'SEND_EMAIL');
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

  // S'assure que l'outbox event est PENDING avec available_at = now().
  await sql`
    UPDATE "outbox_events"
    SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
        "available_at" = now(), "attempt_count" = 0
    WHERE "id" = ${seeded.outboxEventId}::uuid
  `;

  return { sendEmailEffectId: sendEmailEffect.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('claimOutboxBatch — isolation multi-tenant (G5F)', () => {
  // 1. Non-sélection cross-tenant READY_FOR_TRANSACTIONAL_EMAIL :
  //    L'event de A (0 effets) ne doit PAS être sélectionné par
  //    READY_FOR_TRANSACTIONAL_EMAIL, même si B a 3 effets COMPLETED
  //    (sur son propre event). La corrélation organization_id garantit
  //    que les effets de B ne rendent pas A éligible.
  it('1. READY_FOR_TRANSACTIONAL_EMAIL — event de A (0 effets) non sélectionné même si B a 3 effets COMPLETED', async () => {
    if (!db) return;
    const idsA = await seedBaseData('a');
    const idsB = await seedBaseData('b');
    const seededA = await seedBookingConfirmedEvent(idsA);
    const seededB = await seedBookingConfirmedEvent(idsB);

    // B a ses 3 effets GENERATE_* COMPLETED + SEND_EMAIL PENDING.
    // A n'a aucun effet.
    await seedCompletedEffectsAndSendEmail(idsB, seededB);

    // Claim avec READY_FOR_TRANSACTIONAL_EMAIL : seul B doit être sélectionné.
    const claimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'READY_FOR_TRANSACTIONAL_EMAIL',
      );
    });

    // B est sélectionné (ses propres effets le rendent éligible).
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.outboxEventId).toBe(seededB.outboxEventId);
    expect(claimed[0]!.organizationId).toBe(idsB.orgId);

    // A n'est PAS sélectionné — il n'a aucun effet, et les effets de B
    // (qui référencent l'event de B, pas celui de A) ne le rendent pas éligible.
    const claimedA = claimed.find((c) => c.outboxEventId === seededA.outboxEventId);
    expect(claimedA).toBeUndefined();
  });

  // 2. Sélection indépendante : deux events distincts (un par org),
  //    chacun avec ses propres effets. Le claim sélectionne les deux
  //    indépendamment — aucun cross-tenant.
  it('2. READY_FOR_TRANSACTIONAL_EMAIL — deux events avec leurs propres effets, sélection indépendante', async () => {
    if (!db) return;
    const idsA = await seedBaseData('a');
    const idsB = await seedBaseData('b');
    const seededA = await seedBookingConfirmedEvent(idsA);
    const seededB = await seedBookingConfirmedEvent(idsB);

    // Chaque org a ses propres effets sur son propre event.
    await seedCompletedEffectsAndSendEmail(idsA, seededA);
    await seedCompletedEffectsAndSendEmail(idsB, seededB);

    const claimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'READY_FOR_TRANSACTIONAL_EMAIL',
      );
    });

    // Les deux events sont sélectionnés, chacun avec son organization_id.
    expect(claimed).toHaveLength(2);
    const claimedIds = claimed.map((c) => c.outboxEventId).sort();
    expect(claimedIds).toEqual([seededA.outboxEventId, seededB.outboxEventId].sort());

    // Vérifie que chaque event claimé porte le bon organization_id.
    const claimA = claimed.find((c) => c.outboxEventId === seededA.outboxEventId)!;
    const claimB = claimed.find((c) => c.outboxEventId === seededB.outboxEventId)!;
    expect(claimA.organizationId).toBe(idsA.orgId);
    expect(claimB.organizationId).toBe(idsB.orgId);
  });

  // 3. Non-sélection INCOMPLETE_DOCUMENT_GENERATION cross-tenant :
  //    L'event de B (3 COMPLETED) n'est PAS sélectionné par INCOMPLETE
  //    (car ses 3 effets sont COMPLETED). L'event de A (0 effets) EST
  //    sélectionné par INCOMPLETE (car 0 effets ≠ 3 COMPLETED).
  //    La corrélation organization_id garantit que les effets de B
  //    n'excluent pas A de la sélection INCOMPLETE.
  it('3. INCOMPLETE_DOCUMENT_GENERATION — event de A (0 effets) sélectionné, event de B (3 COMPLETED) non sélectionné', async () => {
    if (!db) return;
    const idsA = await seedBaseData('a');
    const idsB = await seedBaseData('b');
    const seededA = await seedBookingConfirmedEvent(idsA);
    const seededB = await seedBookingConfirmedEvent(idsB);

    // B a 3 effets COMPLETED. A n'a aucun effet.
    await seedCompletedEffectsAndSendEmail(idsB, seededB);

    const claimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'INCOMPLETE_DOCUMENT_GENERATION',
      );
    });

    // A est sélectionné (0 effets → INCOMPLETE).
    // B n'est PAS sélectionné (3 COMPLETED → pas incomplet).
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.outboxEventId).toBe(seededA.outboxEventId);
    expect(claimed[0]!.organizationId).toBe(idsA.orgId);

    const claimedB = claimed.find((c) => c.outboxEventId === seededB.outboxEventId);
    expect(claimedB).toBeUndefined();
  });

  // 4. notification_deliveries cross-tenant : une notification SENT
  //    sur l'event de B n'exclut pas l'event de A de la sélection
  //    READY_FOR_TRANSACTIONAL_EMAIL. La corrélation organization_id
  //    sur notification_deliveries garantit l'isolation.
  it("4. READY_FOR_TRANSACTIONAL_EMAIL — notification SENT sur B n'exclut pas A", async () => {
    if (!db || !rawSql) return;
    const idsA = await seedBaseData('a');
    const idsB = await seedBaseData('b');
    const seededA = await seedBookingConfirmedEvent(idsA);
    const seededB = await seedBookingConfirmedEvent(idsB);

    // A et B ont chacun leurs effets complets.
    await seedCompletedEffectsAndSendEmail(idsA, seededA);
    const resultB = await seedCompletedEffectsAndSendEmail(idsB, seededB);

    // Insère une notification_deliveries SENT sur l'event de B.
    const providerKey = `email_provider_${seededB.outboxEventId}_SEND_EMAIL_v1`;
    const deliveryKey = `email_delivery_${seededB.outboxEventId}_v1`;
    await rawSql`
      INSERT INTO "notification_deliveries" (
        "organization_id", "outbox_event_id", "outbox_effect_id",
        "recipient_email", "template_key", "provider_idempotency_key",
        "status", "provider_message_id", "sent_at", "idempotency_key"
      ) VALUES (
        ${idsB.orgId}, ${seededB.outboxEventId}::uuid, ${resultB.sendEmailEffectId}::uuid,
        'customer-b@example.com', 'booking_confirmed_customer', ${providerKey},
        'SENT'::notification_delivery_status, 'msg-b-123', now(), ${deliveryKey}
      )
    `;

    // Réinitialise le lease sur A (seedCompletedEffectsAndSendEmail a pu le claimer).
    await rawSql`
      UPDATE "outbox_events"
      SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
          "available_at" = now(), "attempt_count" = 0
      WHERE "id" = ${seededA.outboxEventId}::uuid
    `;

    // Claim READY_FOR_TRANSACTIONAL_EMAIL :
    // A doit être sélectionné (ses effets sont complets, pas de notification).
    // B ne doit PAS être sélectionné (notification SENT l'exclut).
    const claimed = await db.transaction(async (tx) => {
      return await claimOutboxBatch(
        tx,
        BOOKING_CONFIRMED_SELECTION,
        10,
        'always',
        'READY_FOR_TRANSACTIONAL_EMAIL',
      );
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.outboxEventId).toBe(seededA.outboxEventId);
    expect(claimed[0]!.organizationId).toBe(idsA.orgId);

    // B est exclu par sa propre notification SENT (pas par celle de A).
    const claimedB = claimed.find((c) => c.outboxEventId === seededB.outboxEventId);
    expect(claimedB).toBeUndefined();
  });

  describe('claimOutboxBatch — email budget (G5H-C2B)', () => {
    it('1. outbox attempt_count = 5 but SEND_EMAIL.attempt_count = 0 still claimable', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('budget1');
      const seeded = await seedBookingConfirmedEvent(ids);
      await seedCompletedEffectsAndSendEmail(ids, seeded);

      // Set outbox attempt_count to 5; SEND_EMAIL effect stays at 0.
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
            "available_at" = now(), "attempt_count" = 5
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;

      const claimed = await db.transaction(async (tx) => {
        return await claimOutboxBatch(
          tx,
          BOOKING_CONFIRMED_SELECTION,
          10,
          'always',
          'READY_FOR_TRANSACTIONAL_EMAIL',
        );
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.outboxEventId).toBe(seeded.outboxEventId);
    });

    it('2. SEND_EMAIL.attempt_count = 5 not claimable', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('budget2');
      const seeded = await seedBookingConfirmedEvent(ids);
      await seedCompletedEffectsAndSendEmail(ids, seeded);

      // Send effect attempt_count = 5.
      await rawSql`
        UPDATE "outbox_effects"
        SET "attempt_count" = 5
        WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
          AND "effect_type" = 'SEND_EMAIL'
      `;
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
            "available_at" = now(), "attempt_count" = 0
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;

      const claimed = await db.transaction(async (tx) => {
        return await claimOutboxBatch(
          tx,
          BOOKING_CONFIRMED_SELECTION,
          10,
          'always',
          'READY_FOR_TRANSACTIONAL_EMAIL',
        );
      });

      expect(claimed).toHaveLength(0);
    });

    it('3. REQUIRES_MANUAL_REVIEW delivery not claimable', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('budget3');
      const seeded = await seedBookingConfirmedEvent(ids);
      const { sendEmailEffectId } = await seedCompletedEffectsAndSendEmail(ids, seeded);

      const providerKey = `email_provider_${seeded.outboxEventId}_SEND_EMAIL_v1`;
      const deliveryKey = `email_delivery_${seeded.outboxEventId}_v1`;
      await rawSql`
        INSERT INTO "notification_deliveries" (
          "organization_id", "outbox_event_id", "outbox_effect_id",
          "recipient_email", "template_key", "provider_idempotency_key",
          "status", "failure_code", "idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${seeded.outboxEventId}::uuid, ${sendEmailEffectId}::uuid,
          'customer-budget3@example.com', 'booking_confirmed_customer', ${providerKey},
          'REQUIRES_MANUAL_REVIEW'::notification_delivery_status,
          'EMAIL_RETRY_WINDOW_EXPIRED'::document_processing_failure_code, ${deliveryKey}
        )
      `;

      const claimed = await db.transaction(async (tx) => {
        return await claimOutboxBatch(
          tx,
          BOOKING_CONFIRMED_SELECTION,
          10,
          'always',
          'READY_FOR_TRANSACTIONAL_EMAIL',
        );
      });

      expect(claimed).toHaveLength(0);
    });

    it('4. cross-tenant: other org effect/notification cannot make an event eligible', async () => {
      if (!db || !rawSql) return;
      const idsA = await seedBaseData('xa');
      const idsB = await seedBaseData('xb');
      const seededA = await seedBookingConfirmedEvent(idsA);
      const seededB = await seedBookingConfirmedEvent(idsB);

      await seedCompletedEffectsAndSendEmail(idsA, seededA);
      await seedCompletedEffectsAndSendEmail(idsB, seededB);

      // Set B's SEND_EMAIL attempt_count to 5; A stays at 0.
      await rawSql`
        UPDATE "outbox_effects"
        SET "attempt_count" = 5
        WHERE "outbox_event_id" = ${seededB.outboxEventId}::uuid
          AND "organization_id" = ${idsB.orgId}::uuid
          AND "effect_type" = 'SEND_EMAIL'
      `;

      const claimed = await db.transaction(async (tx) => {
        return await claimOutboxBatch(
          tx,
          BOOKING_CONFIRMED_SELECTION,
          10,
          'always',
          'READY_FOR_TRANSACTIONAL_EMAIL',
        );
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.outboxEventId).toBe(seededA.outboxEventId);
      const claimedB = claimed.find((c) => c.outboxEventId === seededB.outboxEventId);
      expect(claimedB).toBeUndefined();
    });

    it('5. document claim still uses global outbox attempt_count (regression)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData('docbudget');
      const seeded = await seedBookingConfirmedEvent(ids);
      // No effects => INCOMPLETE. Outbox attempt_count = 5 should block.
      await rawSql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING', "lease_token" = NULL, "lease_until" = NULL,
            "available_at" = now(), "attempt_count" = 5
        WHERE "id" = ${seeded.outboxEventId}::uuid
      `;

      const claimed = await db.transaction(async (tx) => {
        return await claimOutboxBatch(
          tx,
          BOOKING_CONFIRMED_SELECTION,
          10,
          'always',
          'INCOMPLETE_DOCUMENT_GENERATION',
        );
      });

      expect(claimed).toHaveLength(0);
    });
  });
});
