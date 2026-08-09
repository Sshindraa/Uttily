/**
 * @uttily/core — Tests d'intégration PostgreSQL du use case idempotent de
 * création de snapshot de rendu (G5C, ADR-013).
 *
 * 38 scénarios couvrant : nominal, payload mal formé, champ supplémentaire,
 * mauvais aggregate_type, mauvaise version, aggregate_id != bookingId,
 * organization payload différente, événement cross-org, incohérences
 * booking/payment/draft, payment non SUCCEEDED, succeeded_at null,
 * location autre organisation, données JSON invalides, montant unsafe refusé
 * (booking_lines), montant unsafe refusé (payments, défense DB + application),
 * fuseau IANA invalide, tri des lignes et exemplaires, snapshot sans email
 * ni secret, replay identique, mutation live sans effet, concurrence (une
 * seule ligne), rollback forcé, aucun outbox_effect créé, outbox_events non
 * modifié, cross-tenant sans fuite de données, statuts CANCELLED/REFUNDED
 * acceptés, absence de champs internes, et snapshots existants corrompus
 * (champ racine supplémentaire, email injecté, montant unsafe, date non
 * canonique, mauvais sourceOutboxEventId/organizationId, lignes non triées,
 * item référençant une ligne absente, sous-objet manquant), buffers = 0
 * acceptés, sous-total incohérent, et createdAt ISO canonique au replay.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { getOrCreateDocumentRenderSnapshot } from './get-or-create-document-render-snapshot';
import { canonicalJsonString } from './canonical-json';
import { DocumentRenderError } from './errors';

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const skip = shouldSkipIntegrationTests();

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('g5c');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 10 });
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
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
  crossOrgLocation?: boolean;
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

  // Draft
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

  // Payment
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

  // Location override for cross-org test
  let bookingLocationId = ids.locationId;
  if (opts.crossOrgLocation) {
    // Create a location in a different org
    const otherOrg = await sql`
      INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
      VALUES (${'Other Org ' + SUFFIX()}, ${'other-org-' + SUFFIX()}, 'FLEXIBLE')
      RETURNING "id"
    `.then((r) => r[0]!);
    const otherLocation = await sql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
      VALUES (${otherOrg.id}, 'Other', ${'other-' + SUFFIX()}, 'Europe/Paris', 30, 30, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    bookingLocationId = otherLocation.id;
  }

  // Booking
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
      ${ids.orgId}, ${bookingLocationId}, ${ids.userId},
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

  // Booking line
  const line = await sql`
    INSERT INTO "booking_lines" (
      "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
      "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
    )
    VALUES (${booking.id}, ${ids.variantId}, 2, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
    RETURNING "id"
  `.then((r) => r[0]!);

  // Booking items (with inventory blocks)
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

  // Outbox event
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
      ${'booking_confirmed_' + booking.id}
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('getOrCreateDocumentRenderSnapshot — integration PostgreSQL', () => {
  // 1. nominal — snapshot créé
  it('1. nominal — snapshot créé avec toutes les données', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(result.snapshotId).toBeTruthy();
    expect(result.snapshot.snapshotVersion).toBe('v1');
    expect(result.snapshot.bookingId).toBe(seeded.bookingId);
    expect(result.snapshot.paymentId).toBe(seeded.paymentId);
    expect(result.snapshot.draftId).toBe(seeded.draftId);
    expect(result.snapshot.organizationId).toBe(ids.orgId);
    expect(result.snapshot.sourceOutboxEventId).toBe(seeded.outboxEventId);
    expect(result.snapshot.organization.legalName).toContain('Test Org');
    expect(result.snapshot.location.name).toBe('Annecy');
    expect(result.snapshot.location.timeZone).toBe('Europe/Paris');
    expect(result.snapshot.booking.status).toBe('CONFIRMED');
    expect(result.snapshot.payment.status).toBe('SUCCEEDED');
    expect(result.snapshot.lines).toHaveLength(1);
    expect(result.snapshot.items).toHaveLength(2);
  });

  // 2. payload malformed
  it('2. payload malformed — VALIDATION', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overridePayload: { bookingId: 'not-a-uuid' },
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 3. champ payload supplémentaire
  it('3. champ payload supplementaire — VALIDATION', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overridePayload: {
        bookingId: ids.orgId,
        paymentId: ids.orgId,
        draftId: ids.orgId,
        organizationId: ids.orgId,
        extra: 'bad',
      },
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 4. mauvais aggregate_type
  it('4. mauvais aggregate_type — EVENT_CONTRACT_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overrideAggregateType: 'PAYMENT',
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 5. mauvaise version
  it('5. mauvaise version — EVENT_CONTRACT_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overrideEventVersion: 'v2',
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 6. aggregate_id différent de bookingId
  it('6. aggregate_id different de bookingId — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const otherUuid = randomUUID();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overrideAggregateId: otherUuid,
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 7. organization payload différente
  it('7. organization payload differente — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const otherOrgId = randomUUID();
    const seeded = await seedBookingConfirmedEvent(ids, {
      overridePayload: {
        bookingId: ids.orgId,
        paymentId: ids.orgId,
        draftId: ids.orgId,
        organizationId: otherOrgId,
      },
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 8. événement cross-org
  it('8. evenement cross-org — EVENT_NOT_FOUND', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const wrongOrgId = randomUUID();

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: wrongOrgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 9. booking/payment/draft incohérents
  it('9. booking/payment/draft incoherents — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    // Create a second booking with a different payment/draft and different dates
    const seeded1 = await seedBookingConfirmedEvent(ids);
    const seeded2 = await seedBookingConfirmedEvent(ids, { dateOffset: 1 });
    // Use seeded1's outbox event but with seeded2's payment/draft in payload
    if (!rawSql) return;
    await rawSql`
      UPDATE "outbox_events" SET "payload" = ${rawSql.json({
        bookingId: seeded1.bookingId,
        paymentId: seeded2.paymentId,
        draftId: seeded2.draftId,
        organizationId: ids.orgId,
      })}
      WHERE "id" = ${seeded1.outboxEventId}::uuid
    `;

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded1.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 10. payment non SUCCEEDED
  it('10. payment non SUCCEEDED — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      paymentStatus: 'FAILED',
      paymentSucceededAt: null,
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 11. succeeded_at null
  it('11. succeeded_at null — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    // Payment with PROCESSING status and null succeeded_at (SUCCEEDED requires succeeded_at NOT NULL)
    const seeded = await seedBookingConfirmedEvent(ids, {
      paymentStatus: 'PROCESSING',
      paymentSucceededAt: null,
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 12. location autre organisation
  it('12. location autre organisation — AUTHORITY_MISMATCH', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      crossOrgLocation: true,
    });

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 13. données JSON invalides (variantSnapshot non-objet)
  it('13. donnees JSON invalides — VALIDATION', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    if (!rawSql) return;
    // Corrompre le variant_snapshot dans booking_lines
    // Le trigger d'immutabilité (0033) rejette UPDATE de booking_lines.
    // On désactive temporairement le trigger pour simuler une corruption.
    await rawSql`ALTER TABLE "booking_lines" DISABLE TRIGGER "before_check_booking_line_immutability"`;
    try {
      await rawSql`
        UPDATE "booking_lines" SET "variant_snapshot" = '"not-an-object"'::jsonb
        WHERE "booking_id" = ${seeded.bookingId}::uuid
      `;
    } finally {
      await rawSql`ALTER TABLE "booking_lines" ENABLE TRIGGER "before_check_booking_line_immutability"`;
    }

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 14. données JSON invalides (cancellationPolicySnapshot non-objet)
  it('14. donnees JSON invalides (cancellation_policy_snapshot) — VALIDATION', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    if (!rawSql) return;
    // Corrompre le cancellation_policy_snapshot dans bookings
    // Le trigger d'immutabilité (0033) rejette UPDATE de cancellation_policy_snapshot.
    // On désactive temporairement le trigger pour simuler une corruption.
    await rawSql`ALTER TABLE "bookings" DISABLE TRIGGER "before_check_booking_financial_immutability"`;
    try {
      await rawSql`
        UPDATE "bookings" SET "cancellation_policy_snapshot" = '"not-an-object"'::jsonb
        WHERE "id" = ${seeded.bookingId}::uuid
      `;
    } finally {
      await rawSql`ALTER TABLE "bookings" ENABLE TRIGGER "before_check_booking_financial_immutability"`;
    }

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 15. fuseau IANA invalide refusé
  it('15. fuseau IANA invalide — VALIDATION', async () => {
    if (!db) return;
    const ids = await seedBaseData(SUFFIX());
    const seeded = await seedBookingConfirmedEvent(ids);
    if (!rawSql) return;
    // Corruption artificielle : on simule une donnée historique corrompue en injectant
    // un fuseau invalide après création, sans affaiblir la règle de production.
    await rawSql`UPDATE "locations" SET "time_zone" = 'InvalidTimeZone' WHERE "id" = ${ids.locationId}::uuid`;

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 16. lignes et exemplaires triés
  it('16. lignes et exemplaires tries par ID', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    // Lines sorted by lineId
    const lineIds = result.snapshot.lines.map((l) => l.lineId);
    const sortedLineIds = [...lineIds].sort();
    expect(lineIds).toEqual(sortedLineIds);

    // Items sorted by bookingItemId
    const itemIds = result.snapshot.items.map((i) => i.bookingItemId);
    const sortedItemIds = [...itemIds].sort();
    expect(itemIds).toEqual(sortedItemIds);
  });

  // 17. snapshot sans email ni secret
  it('17. snapshot sans email ni secret', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    const snapshotJson = JSON.stringify(result.snapshot);
    expect(snapshotJson).not.toContain('recipientEmail');
    expect(snapshotJson).not.toContain('client_secret');
    expect(snapshotJson).not.toContain('email');
    expect(snapshotJson).not.toContain('card');
    // The snapshot should not contain user email
    expect(result.snapshot.customer).not.toHaveProperty('email');
  });

  // 18. replay identique (même snapshot retourné)
  it('18. replay identique — meme snapshot retourne', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const r1 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });
    const r2 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(r1.snapshotId).toBe(r2.snapshotId);
    // Utilisation du JSON canonique (clés triées) car JSONB PostgreSQL
    // réordonne les clés par ordre lexicographique.
    expect(canonicalJsonString(r1.snapshot)).toBe(canonicalJsonString(r2.snapshot));
  });

  // 19. mutation live après snapshot sans effet
  it('19. mutation live apres snapshot sans effet', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const r1 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    if (!rawSql) return;
    // Mutate live data
    await rawSql`
      UPDATE "organizations" SET "legal_name" = 'CHANGED NAME'
      WHERE "id" = ${ids.orgId}::uuid
    `;
    await rawSql`
      UPDATE "locations" SET "name" = 'CHANGED LOCATION'
      WHERE "id" = ${ids.locationId}::uuid
    `;
    await rawSql`
      UPDATE "users" SET "display_name" = 'CHANGED USER'
      WHERE "id" = ${ids.userId}::uuid
    `;
    await rawSql`
      UPDATE "inventory_items" SET "condition" = 'BROKEN'
      WHERE "id" = ${ids.itemIds[0]!}::uuid
    `;

    const r2 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    // r2 should return the same snapshot as r1 (no re-read of live data)
    expect(r2.snapshotId).toBe(r1.snapshotId);
    // Utilisation du JSON canonique (clés triées) car JSONB PostgreSQL
    // réordonne les clés par ordre lexicographique.
    expect(canonicalJsonString(r2.snapshot)).toBe(canonicalJsonString(r1.snapshot));
    // Verify the snapshot still has the original values
    expect(r2.snapshot.organization.legalName).toContain('Test Org');
    expect(r2.snapshot.location.name).toBe('Annecy');
    expect(r2.snapshot.customer.displayName).toBeNull();
  });

  // 20. concurrence : une seule ligne (deux appels simultanés)
  it('20. concurrence — une seule ligne pour deux appels simultanes', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const [r1, r2] = await Promise.all([
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ]);

    // Both should return the same snapshot
    expect(r1.snapshotId).toBe(r2.snapshotId);

    // Verify only one row exists
    const rows = await rawSql`
      SELECT COUNT(*)::int AS count FROM "document_render_snapshots"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
    `;
    expect(rows[0]!.count).toBe(1);
  });

  // 21. rollback forcé : aucun snapshot partiel
  it('21. rollback force — aucun snapshot partiel', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData(SUFFIX());
    const seeded = await seedBookingConfirmedEvent(ids);
    // Corruption artificielle : on simule une donnée historique corrompue en injectant
    // un fuseau invalide après création, sans affaiblir la règle de production.
    await rawSql`UPDATE "locations" SET "time_zone" = 'InvalidTimeZone' WHERE "id" = ${ids.locationId}::uuid`;

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);

    // Verify no snapshot was created
    const rows = await rawSql`
      SELECT COUNT(*)::int AS count FROM "document_render_snapshots"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
    `;
    expect(rows[0]!.count).toBe(0);
  });

  // 22. aucun outbox_effect créé
  it('22. aucun outbox_effect cree', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    const rows = await rawSql`
      SELECT COUNT(*)::int AS count FROM "outbox_effects"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
    `;
    expect(rows[0]!.count).toBe(0);
  });

  // 23. outbox_events non modifié
  it('23. outbox_events non modifie (status, attempt_count, available_at, lease)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // Capture outbox state before
    const before = await rawSql`
      SELECT status, attempt_count, available_at, lease_token, lease_until
      FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    const beforeRow = before[0]!;

    await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    // Capture outbox state after
    const after = await rawSql`
      SELECT status, attempt_count, available_at, lease_token, lease_until
      FROM "outbox_events" WHERE "id" = ${seeded.outboxEventId}::uuid
    `;
    const afterRow = after[0]!;

    expect(afterRow.status).toBe(beforeRow.status);
    expect(afterRow.attempt_count).toBe(beforeRow.attempt_count);
    expect(String(afterRow.available_at)).toBe(String(beforeRow.available_at));
    expect(afterRow.lease_token).toBe(beforeRow.lease_token);
    expect(afterRow.lease_until).toBe(beforeRow.lease_until);
  });

  // 24. cross-tenant sans fuite de données
  it('24. cross-tenant sans fuite de donnees', async () => {
    if (!db || !rawSql) return;
    const ids1 = await seedBaseData('org1');
    const ids2 = await seedBaseData('org2');
    const seeded1 = await seedBookingConfirmedEvent(ids1);

    // Try to access org1's event with org2's organizationId
    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded1.outboxEventId,
        organizationId: ids2.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);

    // Verify no snapshot was created for org2
    const rows = await rawSql`
      SELECT COUNT(*)::int AS count FROM "document_render_snapshots"
      WHERE "outbox_event_id" = ${seeded1.outboxEventId}::uuid
        AND "organization_id" = ${ids2.orgId}::uuid
    `;
    expect(rows[0]!.count).toBe(0);
  });

  // 25. montant unsafe refusé (dépassement Number.MAX_SAFE_INTEGER)
  it('25. montant unsafe refuse (depassement Number.MAX_SAFE_INTEGER)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    // La contrainte DB "booking_lines_line_total_max_safe" (<= 9007199254740991)
    // empêche normalement ce montant en production. On la désactive temporairement
    // pour vérifier la défense en profondeur côté JS (Number.isSafeInteger dans
    // load-document-render-data.ts).
    await rawSql`
      ALTER TABLE "booking_lines" DROP CONSTRAINT "booking_lines_line_total_max_safe"
    `;
    // Le trigger d'immutabilité (0033) rejette UPDATE de booking_lines.
    // On désactive temporairement le trigger pour simuler une corruption.
    await rawSql`ALTER TABLE "booking_lines" DISABLE TRIGGER "before_check_booking_line_immutability"`;
    try {
      // 9007199254740992 = Number.MAX_SAFE_INTEGER + 1 = 2^53
      await rawSql`
        UPDATE "booking_lines" SET "line_total_amount_minor" = 9007199254740992
        WHERE "booking_id" = ${seeded.bookingId}::uuid
      `;
      await expect(
        getOrCreateDocumentRenderSnapshot(db, {
          outboxEventId: seeded.outboxEventId,
          organizationId: ids.orgId,
        }),
      ).rejects.toThrow(DocumentRenderError);
    } finally {
      // Remettre une valeur sûre avant de restaurer la contrainte, sinon
      // ADD CONSTRAINT échoue car la ligne existante viole le CHECK.
      await rawSql`
        UPDATE "booking_lines" SET "line_total_amount_minor" = 10000
        WHERE "booking_id" = ${seeded.bookingId}::uuid
      `;
      await rawSql`ALTER TABLE "booking_lines" ENABLE TRIGGER "before_check_booking_line_immutability"`;
      await rawSql`
        ALTER TABLE "booking_lines"
          ADD CONSTRAINT "booking_lines_line_total_max_safe"
          CHECK ("line_total_amount_minor" <= 9007199254740991)
      `;
    }
  });

  // 26. montant unsafe refusé sur payments (défense DB + application)
  it('26. montant unsafe refuse sur payments (defense DB + application)', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    // 1. Défense DB : la contrainte "payments_amount_max_safe"
    //    (CHECK amount_minor <= 9007199254740991) doit rejeter l'insertion
    //    d'un montant dépassant Number.MAX_SAFE_INTEGER.
    // 9007199254740992 = Number.MAX_SAFE_INTEGER + 1 = 2^53
    await expect(
      rawSql`
        UPDATE "payments" SET "amount_minor" = 9007199254740992
        WHERE "id" = ${seeded.paymentId}::uuid
      `,
    ).rejects.toThrow();

    // 2. Défense application : on désactive temporairement la contrainte DB
    //    pour vérifier que Number.isSafeInteger dans load-document-render-data.ts
    //    rejette aussi côté JS (défense en profondeur).
    await rawSql`
      ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_max_safe"
    `;
    try {
      await rawSql`
        UPDATE "payments" SET "amount_minor" = 9007199254740992
        WHERE "id" = ${seeded.paymentId}::uuid
      `;
      await expect(
        getOrCreateDocumentRenderSnapshot(db, {
          outboxEventId: seeded.outboxEventId,
          organizationId: ids.orgId,
        }),
      ).rejects.toThrow(DocumentRenderError);
    } finally {
      // Remettre une valeur sûre avant de restaurer la contrainte, sinon
      // ADD CONSTRAINT échoue car la ligne existante viole le CHECK.
      await rawSql`
        UPDATE "payments" SET "amount_minor" = 10000
        WHERE "id" = ${seeded.paymentId}::uuid
      `;
      await rawSql`
        ALTER TABLE "payments"
          ADD CONSTRAINT "payments_amount_max_safe"
          CHECK ("amount_minor" <= 9007199254740991)
      `;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // G5C correctif ciblé : statuts post-confirmation, parser central, champs internes
  // ─────────────────────────────────────────────────────────────────────────────

  // 27. CANCELLED accepté
  it('27. CANCELLED accepte — snapshot cree', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, { bookingStatus: 'CANCELLED' });

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(result.snapshot.booking.status).toBe('CANCELLED');
    expect(result.snapshotId).toBeTruthy();
  });

  // 28. REFUNDED accepté
  it('28. REFUNDED accepte — snapshot cree', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, { bookingStatus: 'REFUNDED' });

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(result.snapshot.booking.status).toBe('REFUNDED');
    expect(result.snapshotId).toBeTruthy();
  });

  // 29. absence des données internes dans le snapshot créé
  it('29. absence des donnees internes (commissionAmountMinor, connectedAccountId, environment)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    const snapshotJson = JSON.stringify(result.snapshot);
    expect(snapshotJson).not.toContain('commissionAmountMinor');
    expect(snapshotJson).not.toContain('connectedAccountId');
    expect(snapshotJson).not.toContain('environment');
    expect(snapshotJson).not.toContain('commissionRuleSnapshot');
    expect(snapshotJson).not.toContain('taxRuleSnapshot');
    expect(snapshotJson).not.toContain('onBehalfOfAccountId');
  });

  // Helper pour insérer un snapshot corrompu directement via SQL (append-only).
  async function insertCorruptedSnapshot(
    ids: BaseIds,
    seeded: SeedBookingResult,
    snapshotObj: Record<string, unknown>,
  ): Promise<void> {
    if (!rawSql) throw new Error('rawSql not initialized');
    await rawSql`
      INSERT INTO "document_render_snapshots" (
        "organization_id", "outbox_event_id", "booking_id",
        "snapshot", "template_version"
      ) VALUES (
        ${ids.orgId}::uuid,
        ${seeded.outboxEventId}::uuid,
        ${seeded.bookingId}::uuid,
        ${rawSql.json(snapshotObj as unknown as Record<string, string>)}::jsonb,
        'v1'
      )
    `;
  }

  function makeValidSnapshotJson(ids: BaseIds, seeded: SeedBookingResult): Record<string, unknown> {
    return {
      snapshotVersion: 'v1',
      sourceOutboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
      bookingId: seeded.bookingId,
      paymentId: seeded.paymentId,
      draftId: seeded.draftId,
      capturedAt: '2026-01-15T10:00:00.000Z',
      organization: { id: ids.orgId, legalName: 'Test Org' },
      location: {
        id: ids.locationId,
        name: 'Annecy',
        addressLine1: null,
        addressLine2: null,
        city: null,
        postalCode: null,
        countryCode: null,
        timeZone: 'Europe/Paris',
      },
      customer: { userId: ids.userId, displayName: null, locale: 'fr' },
      booking: {
        id: seeded.bookingId,
        status: 'CONFIRMED',
        customerStartAt: '2026-02-10T09:00:00.000Z',
        customerEndAt: '2026-02-12T17:00:00.000Z',
        confirmedAt: '2026-01-15T10:00:00.000Z',
        prepBufferMinutes: 30,
        cleanupBufferMinutes: 30,
        currency: 'EUR',
        subtotalAmountMinor: 10000,
        mandatoryFeesAmountMinor: 0,
        totalAmountMinor: 10000,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        taxRateBps: null,
        cancellationPolicySnapshot: { policy_code: 'FLEXIBLE' },
        termsAcceptanceSnapshot: { version: 'v1' },
      },
      payment: {
        id: seeded.paymentId,
        status: 'SUCCEEDED',
        succeededAt: '2026-01-15T09:58:00.000Z',
        amountMinor: 10000,
        currency: 'EUR',
        financialTermsVersion: 'v1',
        legalTermsVersion: 'v1',
      },
      lines: [
        {
          lineId: seeded.lineId,
          variantId: ids.variantId,
          quantity: 2,
          unitPriceAmountMinor: 5000,
          billableUnitCount: 2,
          lineTotalAmountMinor: 10000,
          currency: 'EUR',
          variantSnapshot: { name: 'Standard' },
        },
      ],
      items: seeded.bookingItemIds.map((itemId, i) => ({
        bookingItemId: itemId,
        bookingLineId: seeded.lineId,
        inventoryItemId: ids.itemIds[i]!,
        internalSku: `KAY-${i}`,
        serialNumber: null,
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      })),
    };
  }

  // 30. snapshot existant corrompu : champ racine supplémentaire
  it('30. snapshot existant corrompu (champ racine supplementaire) — SNAPSHOT_INVARIANT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    snap['extraField'] = 'bad';
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
    try {
      await getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      });
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('SNAPSHOT_INVARIANT');
    }
  });

  // 31. snapshot existant avec email injecté dans customer
  it('31. snapshot existant avec email dans customer — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    (snap['customer'] as Record<string, unknown>)['email'] = 'a@b.com';
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 32. snapshot existant avec montant unsafe
  it('32. snapshot existant avec montant unsafe — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    (snap['payment'] as Record<string, unknown>)['amountMinor'] = Number.MAX_SAFE_INTEGER + 1;
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 33. snapshot existant avec date non canonique
  it('33. snapshot existant avec date non canonique — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    snap['capturedAt'] = '2026-01-15T10:00:00+02:00';
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 34. snapshot existant avec mauvais sourceOutboxEventId
  it('34. snapshot existant avec mauvais sourceOutboxEventId — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    snap['sourceOutboxEventId'] = randomUUID();
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
    try {
      await getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      });
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('SNAPSHOT_INVARIANT');
    }
  });

  // 35. snapshot existant avec mauvais organizationId
  it('35. snapshot existant avec mauvais organizationId — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    snap['organizationId'] = randomUUID();
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 36. snapshot existant avec lignes non triées
  it('36. snapshot existant avec lignes non triees — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    // Construire un snapshot avec deux lignes non triées par lineId.
    // La première ligne a un lineId lexicalement supérieur à la seconde.
    const bigger = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const smaller = '00000000-0000-0000-0000-000000000001';
    const baseLine = (snap['lines'] as Array<Record<string, unknown>>)[0]!;
    snap['lines'] = [
      { ...baseLine, lineId: bigger },
      { ...baseLine, lineId: smaller },
    ];
    // Ajuster items pour référencer les deux lignes (évite l'erreur item→line avant le tri)
    snap['items'] = (snap['items'] as Array<Record<string, unknown>>).map((item, i) => ({
      ...item,
      bookingLineId: i === 0 ? bigger : smaller,
    }));
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 37. snapshot existant avec item référençant une ligne absente
  it('37. snapshot existant avec item referencant une ligne absente — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    const items = snap['items'] as Array<Record<string, unknown>>;
    items[0]!['bookingLineId'] = randomUUID();
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 38. snapshot existant avec sous-objet manquant
  it('38. snapshot existant avec sous-objet manquant — SNAPSHOT_INVARIANT', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    delete snap['location'];
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
  });

  // 39. buffers = 0 acceptés — snapshot créé
  it('39. buffers = 0 acceptes — snapshot cree', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids, {
      prepBufferMinutes: 0,
      cleanupBufferMinutes: 0,
    });

    const result = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(result.snapshotId).toBeTruthy();
    expect(result.snapshot.booking.prepBufferMinutes).toBe(0);
    expect(result.snapshot.booking.cleanupBufferMinutes).toBe(0);
  });

  // 40. snapshot existant corrompu avec sous-total incohérent
  it('40. snapshot existant corrompu avec sous-total incoherent — SNAPSHOT_INVARIANT', async () => {
    if (!db || !rawSql) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);
    const snap = makeValidSnapshotJson(ids, seeded);
    // Corrompre une lineTotalAmountMinor pour que la somme != subtotalAmountMinor
    const lines = snap['lines'] as Array<Record<string, unknown>>;
    lines[0]!['lineTotalAmountMinor'] = 9999;
    await insertCorruptedSnapshot(ids, seeded, snap);

    await expect(
      getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      }),
    ).rejects.toThrow(DocumentRenderError);
    try {
      await getOrCreateDocumentRenderSnapshot(db, {
        outboxEventId: seeded.outboxEventId,
        organizationId: ids.orgId,
      });
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('SNAPSHOT_INVARIANT');
    }
    // Vérifier qu'aucune nouvelle ligne de snapshot n'a été créée
    const count = await rawSql`
      SELECT COUNT(*)::int AS cnt FROM "document_render_snapshots"
      WHERE "outbox_event_id" = ${seeded.outboxEventId}::uuid
    `.then((r) => r[0]!['cnt'] as number);
    expect(count).toBe(1);
  });

  // 41. createdAt est une chaîne ISO canonique (premier appel + replay identiques)
  it('41. createdAt est une chaine ISO canonique (premier appel + replay identiques)', async () => {
    if (!db) return;
    const ids = await seedBaseData();
    const seeded = await seedBookingConfirmedEvent(ids);

    const result1 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    // Contrat : createdAt est une string et un timestamp ISO canonique
    expect(typeof result1.createdAt).toBe('string');
    expect(new Date(result1.createdAt).toISOString()).toBe(result1.createdAt);

    // Replay : deuxième appel avec le même outboxEventId doit retourner le même createdAt
    const result2 = await getOrCreateDocumentRenderSnapshot(db, {
      outboxEventId: seeded.outboxEventId,
      organizationId: ids.orgId,
    });

    expect(typeof result2.createdAt).toBe('string');
    expect(new Date(result2.createdAt).toISOString()).toBe(result2.createdAt);
    expect(result2.createdAt).toBe(result1.createdAt);
  });
});
