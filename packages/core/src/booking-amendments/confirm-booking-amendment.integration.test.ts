import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { confirmBookingAmendment } from './confirm-booking-amendment';
import { getEffectiveBooking } from './get-effective-booking';
import { computeAmendmentFingerprint } from './execute-booking-amendment-internal';
import type { AuthenticatedUser } from '../identity/types';
import type { ConfirmBookingAmendmentCommand } from './types-amendment';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_c5b_conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)(
  'confirmBookingAmendment — intégration PostgreSQL (G7M-C5-B Hardened)',
  () => {
    let db: DatabaseClient;
    let rawSql: Sql;
    let testUrl: string | null = null;

    beforeAll(async () => {
      if (!sourceUrl) return;
      assertLocalhost(sourceUrl);
      const admin = postgres(sourceUrl, { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
      await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
      await admin.end();

      const parsed = new URL(sourceUrl);
      parsed.pathname = `/${testDatabase}`;
      testUrl = parsed.toString();

      await runMigrations(testUrl);
      db = createDatabase(testUrl);
      rawSql = postgres(testUrl, { max: 10 });
    }, 600000);

    afterAll(async () => {
      if (db) {
        await db.$client.end();
      }
      if (rawSql) {
        await rawSql.end();
      }
      if (!sourceUrl || !testUrl) return;
      const admin = postgres(sourceUrl, { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
      await admin.end();
    });

    interface BaseIds {
      orgId: string;
      locationId: string;
      userId: string;
      variantId: string;
      itemId: string;
    }

    async function seedActiveDailyPricingPlan(
      sql: postgres.Sql,
      orgId: string,
      variantId: string,
      locationId: string,
      priceAmountMinor = 5000,
      label = 'Tarif journalier',
    ): Promise<string> {
      const plan = await sql`
      INSERT INTO "pricing_plans" (
        "organization_id", "product_variant_id", "location_id", "plan_type", "currency",
        "price_amount_minor", "lifecycle_state", "version"
      )
      VALUES (
        ${orgId}, ${variantId}, ${locationId}, 'DAILY', 'EUR',
        ${priceAmountMinor}, 'DRAFT', 1
      )
      RETURNING "id"
    `.then((r) => r[0]!);

      await sql`
      INSERT INTO "pricing_plan_windows" (
        "pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time"
      )
      VALUES (
        ${plan.id}, ${locationId}, 127, '00:00:00', '23:59:59'
      )
    `;

      await sql`
      INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
      VALUES
        (${plan.id}, 'fr', ${label}),
        (${plan.id}, 'en', ${label})
    `;

      await sql`
      UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}
    `;

      return plan.id;
    }

    async function seedPublishedProduct(
      sql: postgres.Sql,
      orgId: string,
      categoryId: string,
      name: string,
      slugPrefix: string,
    ): Promise<string> {
      const suffix = Math.random().toString(36).slice(2, 8);
      const product = await sql`
      INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
      VALUES (${orgId}, ${categoryId}, ${name}, ${slugPrefix + '-' + suffix}, 'DRAFT')
      RETURNING "id"
    `.then((r) => r[0]!);

      for (let pi = 0; pi < 3; pi++) {
        await sql`
        INSERT INTO product_photos (
          organization_id, product_id, storage_key,
          content_type, byte_size, width_px, height_px, checksum_sha256,
          sort_order, file_state
        )
        VALUES (
          ${orgId}, ${product.id}, ${'product-photos/' + suffix + '-' + pi},
          'image/jpeg', 102400, 800, 600, ${('000' + pi).repeat(16).slice(0, 64)},
          ${pi}, 'AVAILABLE'
        )
      `;
      }

      await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
      return product.id;
    }

    async function seedBaseData(sql: postgres.Sql, suffix?: string): Promise<BaseIds> {
      const baseSuffix = suffix ?? '';
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const fullSuffix = baseSuffix + randomSuffix;
      const org = await sql`
      INSERT INTO "organizations" ("legal_name", "slug")
      VALUES (${'Test Org ' + fullSuffix}, ${'org-' + fullSuffix})
      RETURNING "id"
    `.then((r) => r[0]!);
      const location = await sql`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
      VALUES (${org.id}, 'Annecy', ${'annecy-' + fullSuffix}, 'Europe/Paris', 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
      const user = await sql`
      INSERT INTO "users" ("email")
      VALUES (${'customer-' + fullSuffix + '@example.com'})
      RETURNING "id"
    `.then((r) => r[0]!);
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const productId = await seedPublishedProduct(
        sql,
        org.id,
        category.id,
        'Kayak',
        'kayak-' + fullSuffix,
      );
      const variant = await sql`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${productId}, 'Standard', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
      const item = await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + fullSuffix}, ${location.id})
      RETURNING "id"
    `.then((r) => r[0]!);

      await seedActiveDailyPricingPlan(sql, org.id, variant.id, location.id, 5000);

      return {
        orgId: org.id,
        locationId: location.id,
        userId: user.id,
        variantId: variant.id,
        itemId: item.id,
      };
    }

    interface BookingWithItemIds {
      bookingId: string;
      bookingItemId: string;
      lineId: string;
      blockId: string;
      bookingItemIds: string[];
      blockIds: string[];
      inventoryItemIds: string[];
    }

    async function seedBookingWithItem(
      sql: postgres.Sql,
      ids: BaseIds,
      monthOffset = 3,
      qty = 1,
      unitPrice = 5000,
      billedDays = 2,
    ): Promise<BookingWithItemIds> {
      const lineTotal = qty * unitPrice * billedDays;
      const month = String(monthOffset).padStart(2, '0');
      const endDay = String(10 + billedDays).padStart(2, '0');

      const inventoryItemIds: string[] = [ids.itemId];
      for (let i = 1; i < qty; i++) {
        const itemExtra = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${ids.variantId}, ${'SKU-CONFIRM-QTY-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
        inventoryItemIds.push(itemExtra.id);
      }

      const draftPayload = {
        customer_start_at: `2026-${month}-10 09:00:00+00`,
        customer_end_at: `2026-${month}-${endDay} 17:00:00+00`,
        blocked_start_at: `2026-${month}-10 08:30:00+00`,
        blocked_end_at: `2026-${month}-${endDay} 17:30:00+00`,
        timezone: 'Europe/Paris',
        prep_buffer_minutes: 30,
        cleanup_buffer_minutes: 30,
        subtotal_amount_minor: lineTotal,
        mandatory_fees_amount_minor: 0,
        total_amount_minor: lineTotal,
        tax_status: 'NOT_APPLICABLE',
        tax_amount_minor: 0,
        tax_rate_bps: null,
        commission_amount_minor: 500,
        billable_unit: 'DAY',
        billable_unit_count: billedDays,
        currency: 'EUR',
        cancellation_policy_snapshot: {
          policy_code: 'FLEXIBLE',
          policy_version: '1',
          timezone: 'Europe/Paris',
        },
      };
      const draft = await sql`
      INSERT INTO "booking_drafts" (
        "organization_id", "location_id", "customer_user_id",
        "customer_start_at", "customer_end_at",
        "blocked_start_at", "blocked_end_at",
        "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
        "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
        "billable_unit", "billable_unit_count",
        "currency", "cancellation_policy_snapshot"
      )
      VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId},
        ${draftPayload.customer_start_at}, ${draftPayload.customer_end_at},
        ${draftPayload.blocked_start_at}, ${draftPayload.blocked_end_at},
        ${draftPayload.timezone}, ${draftPayload.prep_buffer_minutes}, ${draftPayload.cleanup_buffer_minutes},
        ${draftPayload.subtotal_amount_minor}, ${draftPayload.mandatory_fees_amount_minor}, ${draftPayload.total_amount_minor},
        ${draftPayload.tax_status}, ${draftPayload.tax_amount_minor}, ${draftPayload.tax_rate_bps}, ${draftPayload.commission_amount_minor},
        ${draftPayload.billable_unit}, ${draftPayload.billable_unit_count},
        ${draftPayload.currency}, ${sql.json(draftPayload.cancellation_policy_snapshot)}
      )
      RETURNING "id"
    `.then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const draftLine = await sql`
      INSERT INTO "booking_draft_lines" (
        "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
        "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
      )
      VALUES (${draft.id}, ${ids.variantId}, ${qty}, ${unitPrice}, ${billedDays}, ${lineTotal}, ${sql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);

      const holdBlockIds: string[] = [];
      for (let i = 0; i < qty; i++) {
        const currentItemId = inventoryItemIds[i]!;
        const holdBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${currentItemId}, 'HOLD', 'ACTIVE',
          ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-${endDay} 17:00:00+00`},
          ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-${endDay} 17:30:00+00`}, ${`2026-${month}-09 12:00:00+00`}, ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
        holdBlockIds.push(holdBlock.id);

        await sql`
        INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
        VALUES (${draftLine.id}, ${holdBlock.id})
      `;
      }

      const paymentPayload = {
        status: 'SUCCEEDED',
        amount_minor: lineTotal,
        currency: 'EUR',
        tax_status: 'NOT_APPLICABLE',
        tax_amount_minor: 0,
        tax_rate_bps: null,
        commission_amount_minor: 500,
        financial_terms_version: '1',
        legal_terms_version: '1',
        terms_acceptance_snapshot: {
          version: '1',
          user_id: ids.userId,
          accepted_at: '2026-01-01T00:00:00Z',
        },
        connected_account_id: 'acct_test123',
        charge_model: 'DESTINATION',
        settlement_merchant_mode: 'CONNECTED_ACCOUNT',
        environment: 'TEST' as const,
        succeeded_at: '2026-01-01 12:00:00+00',
      };
      const payment = await sql`
      INSERT INTO "payments" (
        "organization_id", "draft_id", "customer_user_id",
        "status", "amount_minor", "currency",
        "tax_status", "tax_amount_minor", "tax_rate_bps",
        "commission_amount_minor",
        "financial_terms_version", "legal_terms_version",
        "terms_acceptance_snapshot",
        "connected_account_id",
        "charge_model", "settlement_merchant_mode", "environment", "succeeded_at"
      )
      VALUES (
        ${ids.orgId}, ${draft.id}, ${ids.userId},
        ${paymentPayload.status}, ${paymentPayload.amount_minor}, ${paymentPayload.currency},
        ${paymentPayload.tax_status}, ${paymentPayload.tax_amount_minor}, ${paymentPayload.tax_rate_bps},
        ${paymentPayload.commission_amount_minor},
        ${paymentPayload.financial_terms_version}, ${paymentPayload.legal_terms_version},
        ${sql.json(paymentPayload.terms_acceptance_snapshot)},
        ${paymentPayload.connected_account_id},
        ${paymentPayload.charge_model}, ${paymentPayload.settlement_merchant_mode}, ${paymentPayload.environment}, ${paymentPayload.succeeded_at}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

      const termsAcceptanceSnapshot = {
        version: '1',
        user_id: ids.userId,
        accepted_at: '2026-01-01T00:00:00Z',
      };
      const booking = await sql`
      INSERT INTO "bookings" (
        "organization_id", "location_id", "customer_user_id", "draft_id", "payment_id",
        "status", "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
        "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "currency",
        "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
        "tax_status", "tax_amount_minor", "tax_rate_bps", "commission_amount_minor",
        "billable_unit", "billable_unit_count", "cancellation_policy_snapshot", "terms_acceptance_snapshot", "confirmed_at"
      )
      VALUES (
        ${ids.orgId}, ${ids.locationId}, ${ids.userId}, ${draft.id}, ${payment.id},
        'CONFIRMED', ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-${endDay} 17:00:00+00`},
        ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-${endDay} 17:30:00+00`},
        'Europe/Paris', 30, 30, 'EUR',
        ${lineTotal}, 0, ${lineTotal},
        'NOT_APPLICABLE', 0, null, 500,
        'DAY', ${billedDays}, ${sql.json(draftPayload.cancellation_policy_snapshot)}, ${sql.json(termsAcceptanceSnapshot)}, now()
      )
      RETURNING "id"
    `.then((r) => r[0]!);
      const bookingLine = await sql`
      INSERT INTO "booking_lines" (
        "booking_id", "variant_id", "quantity", "unit_price_amount_minor",
        "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
      )
      VALUES (${booking.id}, ${ids.variantId}, ${qty}, ${unitPrice}, ${billedDays}, ${lineTotal}, ${sql.json({ name: 'Standard' })})
      RETURNING "id"
    `.then((r) => r[0]!);

      const bookingBlockIds: string[] = [];
      const bookingItemIds: string[] = [];

      for (let i = 0; i < qty; i++) {
        const currentItemId = inventoryItemIds[i]!;
        const holdBlockId = holdBlockIds[i]!;
        await sql`UPDATE "inventory_blocks" SET "status" = 'RELEASED' WHERE "id" = ${holdBlockId}`;

        const bookingBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${currentItemId}, 'BOOKING', 'ACTIVE',
          ${`2026-${month}-10 09:00:00+00`}, ${`2026-${month}-${endDay} 17:00:00+00`},
          ${`2026-${month}-10 08:30:00+00`}, ${`2026-${month}-${endDay} 17:30:00+00`}, ${booking.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
        bookingBlockIds.push(bookingBlock.id);

        const bookingItem = await sql`
        INSERT INTO "booking_items" (
          "booking_id", "booking_line_id", "inventory_item_id", "booking_block_id"
        )
        VALUES (${booking.id}, ${bookingLine.id}, ${currentItemId}, ${bookingBlock.id})
        RETURNING "id"
      `.then((r) => r[0]!);
        bookingItemIds.push(bookingItem.id);
      }

      return {
        bookingId: booking.id,
        bookingItemId: bookingItemIds[0]!,
        lineId: bookingLine.id,
        blockId: bookingBlockIds[0]!,
        bookingItemIds,
        blockIds: bookingBlockIds,
        inventoryItemIds,
      };
    }

    async function addActor(
      sql: postgres.Sql,
      orgId: string,
      role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF' = 'MANAGER',
    ): Promise<AuthenticatedUser> {
      const suffix = Math.random().toString(36).slice(2, 8);
      const user = await sql`
      INSERT INTO "users" ("email")
      VALUES (${'staff-' + suffix + '@example.com'})
      RETURNING "id", "email"
    `.then((r) => r[0]!);

      await sql`
      INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
      VALUES (${orgId}, ${user.id}, ${role}, 'ACTIVE')
    `;

      return {
        id: user.id,
        email: user.email,
        oidcSubject: 'sub_' + suffix,
        emailVerified: true,
        isPlatformAdmin: false,
      };
    }

    it('1. NEUTRAL confirmation : applique immédiatement la modification', async () => {
      const baseIds = await seedBaseData(rawSql, 'neu-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 5, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-05-11',
          endDateExclusive: '2026-05-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);

      expect(res.kind).toBe('APPLIED_NEUTRAL');
      if (res.kind === 'APPLIED_NEUTRAL') {
        expect(res.amendmentNumber).toBe(1);
        expect(res.bookingId).toBe(bookingIds.bookingId);
        expect(res.isReplay).toBe(false);

        const effective = await getEffectiveBooking(db, baseIds.orgId, bookingIds.bookingId);
        expect(effective.kind).toBe('FOUND');
        if (effective.kind === 'FOUND') {
          expect(effective.booking.lastAppliedAmendmentNumber).toBe(1);
          expect(effective.booking.booking.status).toBe('CONFIRMED');
        }
      }
    });

    it('2. REFUND confirmation : applique immédiatement et crée la dette de remboursement PENDING', async () => {
      const baseIds = await seedBaseData(rawSql, 'ref-');
      // 4 days booked (200.00 €)
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 6, 1, 5000, 4);
      const actor = await addActor(rawSql, baseIds.orgId, 'ADMIN');
      const key = crypto.randomUUID();

      // Reduce to 2 days (100.00 €) -> refund delta 100.00 € (10000)
      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-06-10',
          endDateExclusive: '2026-06-12',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'REFUND',
        expectedDeltaAmountMinor: -10000,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);

      expect(res.kind).toBe('APPLIED_REFUND');
      if (res.kind === 'APPLIED_REFUND') {
        expect(res.amendmentNumber).toBe(1);
        expect(res.refundAmountMinor).toBe(10000);
        expect(res.currency).toBe('EUR');
        expect(res.isReplay).toBe(false);

        // Verify refund record in DB
        const refunds = await rawSql`
        SELECT id, status, amount_minor FROM refunds WHERE organization_id = ${baseIds.orgId}
      `;
        expect(refunds.length).toBe(1);
        expect(refunds[0]!.status).toBe('PENDING');
        expect(Number(refunds[0]!.amount_minor)).toBe(10000);

        // Verify outbox event
        const outbox = await rawSql`
        SELECT event_type FROM outbox_events WHERE organization_id = ${baseIds.orgId}
      `;
        expect(outbox.some((o) => o.event_type === 'REFUND_REQUESTED')).toBe(true);
      }
    });

    it('3. SUPPLEMENT confirmation : hold local en attente de paiement (HOLD_PENDING)', async () => {
      const baseIds = await seedBaseData(rawSql, 'sup-');
      // 2 days booked (100.00 €)
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 7, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'OWNER');
      const key = crypto.randomUUID();

      // Increase to 4 days (200.00 €) -> supplement 100.00 € (10000)
      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-07-10',
          endDateExclusive: '2026-07-14',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'SUPPLEMENT',
        expectedDeltaAmountMinor: 10000,
        expectedNextTotalAmountMinor: 20000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);

      expect(res.kind).toBe('PAYMENT_REQUIRED');
      if (res.kind === 'PAYMENT_REQUIRED') {
        expect(res.amendmentNumber).toBe(1);
        expect(res.supplementAmountMinor).toBe(10000);
        expect(res.currency).toBe('EUR');
        expect(res.holdDeadline).toBeDefined();
        expect(res.isReplay).toBe(false);

        // Verify amendment is HOLD_PENDING
        const amends = await rawSql`
        SELECT status FROM booking_amendments WHERE id = ${res.amendmentId}
      `;
        expect(amends[0]!.status).toBe('HOLD_PENDING');

        // Verify payment attempt is PENDING_PROVIDER
        const payments = await rawSql`
        SELECT status, amount_minor FROM amendment_payments WHERE amendment_id = ${res.amendmentId}
      `;
        expect(payments[0]!.status).toBe('PENDING_PROVIDER');
        expect(Number(payments[0]!.amount_minor)).toBe(10000);
      }
    });

    it('4. Replay idempotent : retourne isReplay: true sans doublons de lignes ou paiements', async () => {
      const baseIds = await seedBaseData(rawSql, 'rpl-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 8, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-08-11',
          endDateExclusive: '2026-08-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const first = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(first.kind).toBe('APPLIED_NEUTRAL');
      if (first.kind === 'APPLIED_NEUTRAL') {
        expect(first.isReplay).toBe(false);
      }

      const second = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(second.kind).toBe('APPLIED_NEUTRAL');
      if (second.kind === 'APPLIED_NEUTRAL') {
        expect(second.isReplay).toBe(true);
        if (first.kind === 'APPLIED_NEUTRAL') {
          expect(second.amendmentId).toBe(first.amendmentId);
        }
      }
    });

    it('5. Même clé idempotente avec payload différent retourne IDEMPOTENCY_CONFLICT', async () => {
      const baseIds = await seedBaseData(rawSql, 'icf-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 9, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      const command1: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-09-11',
          endDateExclusive: '2026-09-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const command2: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-09-12',
          endDateExclusive: '2026-09-14',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const first = await confirmBookingAmendment(db, actor, baseIds.orgId, command1);
      expect(first.kind).toBe('APPLIED_NEUTRAL');

      const second = await confirmBookingAmendment(db, actor, baseIds.orgId, command2);
      expect(second.kind).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('6. Stale version retourne STALE_EFFECTIVE_BOOKING', async () => {
      const baseIds = await seedBaseData(rawSql, 'stl-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 10, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 999, // Stale!
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-10-11',
          endDateExclusive: '2026-10-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: crypto.randomUUID(),
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(res.kind).toBe('STALE_EFFECTIVE_BOOKING');
    });

    it('7. PREVIEW_CHANGED si la classification attendue ne correspond pas au recalcul', async () => {
      const baseIds = await seedBaseData(rawSql, 'pvc-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 11, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');

      // Extension -> SUPPLEMENT in reality, but client claims NEUTRAL
      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-11-10',
          endDateExclusive: '2026-11-14',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: crypto.randomUUID(),
        expectedClassification: 'NEUTRAL', // Mismatch!
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(res.kind).toBe('PREVIEW_CHANGED');
    });

    it('8. Tenant isolation : Organisation B ne peut pas modifier la réservation de Org A', async () => {
      const baseIdsA = await seedBaseData(rawSql, 'tna-');
      const baseIdsB = await seedBaseData(rawSql, 'tnb-');
      const bookingIdsA = await seedBookingWithItem(rawSql, baseIdsA, 12, 1, 5000, 2);
      const actorB = await addActor(rawSql, baseIdsB.orgId, 'MANAGER');

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIdsA.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-12-11',
          endDateExclusive: '2026-12-13',
        },
        desiredLines: [
          { logicalLineId: bookingIdsA.lineId, variantId: baseIdsA.variantId, quantity: 1 },
        ],
        idempotencyKey: crypto.randomUUID(),
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actorB, baseIdsB.orgId, command);
      expect(res.kind).toBe('NOT_FOUND');
    });

    it('9. Rôle STAFF refusé avec FORBIDDEN', async () => {
      const baseIds = await seedBaseData(rawSql, 'stf-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 1, 1, 5000, 2);
      const actorStaff = await addActor(rawSql, baseIds.orgId, 'STAFF');

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-01-11',
          endDateExclusive: '2026-01-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: crypto.randomUUID(),
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actorStaff, baseIds.orgId, command);
      expect(res.kind).toBe('FORBIDDEN');
    });

    it('10. Concurrence double-submit : deux requêtes parallèles avec la même clé idempotente', async () => {
      const baseIds = await seedBaseData(rawSql, 'cnc-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 2, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-02-11',
          endDateExclusive: '2026-02-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const [res1, res2] = await Promise.all([
        confirmBookingAmendment(db, actor, baseIds.orgId, command),
        confirmBookingAmendment(db, actor, baseIds.orgId, command),
      ]);

      // Either one succeeds and one replays, or both return consistent successful states
      const kinds = [res1.kind, res2.kind];
      expect(kinds).toContain('APPLIED_NEUTRAL');
      if (res1.kind === 'APPLIED_NEUTRAL' && res2.kind === 'APPLIED_NEUTRAL') {
        expect(res1.amendmentId).toBe(res2.amendmentId);
      }
    });

    it('11. Zéro appel externe provider : tout est traité de manière locale et durable', async () => {
      const baseIds = await seedBaseData(rawSql, 'zpr-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 4, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      // Confirmation d'un SUPPLEMENT -> crée le hold et paiement local mais AUCUN appel externe Stripe (réservé à C5-C)
      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-04-10',
          endDateExclusive: '2026-04-14',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'SUPPLEMENT',
        expectedDeltaAmountMinor: 10000,
        expectedNextTotalAmountMinor: 20000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(res.kind).toBe('PAYMENT_REQUIRED');

      // Vérifier qu'aucune tentative provider externe n'existe
      const attempts = await rawSql`
      SELECT id, status, provider_payment_intent_id FROM amendment_payment_attempts WHERE amendment_payment_id IN (
        SELECT id FROM amendment_payments WHERE amendment_id = ${res.kind === 'PAYMENT_REQUIRED' ? res.amendmentId : ''}
      )
    `;
      expect(attempts.length).toBe(1);
      expect(attempts[0]!.status).toBe('PENDING_PROVIDER');
      expect(attempts[0]!.provider_payment_intent_id).toBeNull();
    });

    it('12. Ignore une clé d opération étrangère existant avec la même valeur', async () => {
      const baseIds = await seedBaseData(rawSql, 'frg-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 1, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const sharedKey = crypto.randomUUID();

      // Insérer un enregistrement étranger (ex: draft) utilisant la même clé
      await rawSql`
      INSERT INTO "idempotency_records" (
        "organization_id", "operation", "key", "request_fingerprint", "status", "response_body",
        "resource_id", "response_status_code", "completed_at"
      )
      VALUES (
        ${baseIds.orgId}, 'booking-draft:create', ${sharedKey}, ${'a'.repeat(64)}, 'COMPLETED', ${rawSql.json({ draftId: 'd1' })},
        ${crypto.randomUUID()}, 200, now()
      )
    `;

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-01-11',
          endDateExclusive: '2026-01-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: sharedKey,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(res.kind).toBe('APPLIED_NEUTRAL');
    });

    it('13. Replay avec responseBody corrompu retourne INVALID_STATE sans muter la base', async () => {
      const baseIds = await seedBaseData(rawSql, 'cor-');
      const bookingIds = await seedBookingWithItem(rawSql, baseIds, 3, 1, 5000, 2);
      const actor = await addActor(rawSql, baseIds.orgId, 'MANAGER');
      const key = crypto.randomUUID();

      const command: ConfirmBookingAmendmentCommand = {
        bookingId: bookingIds.bookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-03-11',
          endDateExclusive: '2026-03-13',
        },
        desiredLines: [
          { logicalLineId: bookingIds.lineId, variantId: baseIds.variantId, quantity: 1 },
        ],
        idempotencyKey: key,
        expectedClassification: 'NEUTRAL',
        expectedDeltaAmountMinor: 0,
        expectedNextTotalAmountMinor: 10000,
      };

      const fp = computeAmendmentFingerprint(command, 'amendment-neutral-v2');

      // Insérer un enregistrement COMPLETED avec responseBody malformé (amendmentId non-UUID)
      await rawSql`
      INSERT INTO "idempotency_records" (
        "organization_id", "operation", "key", "request_fingerprint", "status", "response_body",
        "resource_id", "response_status_code", "completed_at"
      )
      VALUES (
        ${baseIds.orgId}, 'booking-amendment-neutral', ${key}, ${fp}, 'COMPLETED', ${rawSql.json({ amendmentId: 'not-a-uuid', amendmentNumber: 1 })},
        ${crypto.randomUUID()}, 200, now()
      )
    `;

      const res = await confirmBookingAmendment(db, actor, baseIds.orgId, command);
      expect(res.kind).toBe('INVALID_STATE');

      // Vérifier qu'aucun amendement réel n'a été créé
      const amends = await rawSql`
      SELECT count(*) FROM booking_amendments WHERE booking_id = ${bookingIds.bookingId}
    `;
      expect(Number(amends[0]!.count)).toBe(0);
    });
  },
);
