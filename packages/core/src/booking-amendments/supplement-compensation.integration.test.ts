/**
 * @uttily/core — Tests d'intégration PostgreSQL réels pour G7M-C4-B.
 *
 * Valide :
 * 1. Éligibilité stricte : refus avant deadline et sur APPLIED.
 * 2. Rejeu strict : tuple complet cohérent (refund + outbox exacts).
 * 3. Validation autoritative du worker (mismatchs tenant/montant/devise/env fail-closed).
 * 4. Zéro appel provider en cas d'incohérence.
 * 5. Rollback complet et HTTP 500 en cas de panne outbox / DB.
 * 6. Provider réellement appelé HORS transaction (lock probe PostgreSQL sur outbox, refund, payment, amendment, attempt).
 * 7. Concurrence réelle : sérialisation sous verrou, exactement 1 refund et 1 outbox.
 * 8. Invariant financier ADR-023 §11.2 & §11.4 via getEffectiveBooking canonique.
 * 9. Flux E2E complet de REFUND_REQUESTED.v1 jusqu'au moteur refund.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import * as schema from '@uttily/database';
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerInput } from '../webhook-handler/types';
import type { RefundResult, CreateRefundParams } from '../payments/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { getEffectiveBooking } from './get-effective-booking';
import { compensateAmendmentPayment } from './compensate-amendment-payment';
import { claimRefundRequestBatch } from '../refund-request-execution/claim-refund-request-batch';
import { executeRefundRequest } from '../refund-request-execution/execute-refund-request';
import { RefundRequestError } from '../refund-request-execution/errors';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://uttily:uttily@localhost:5432/uttily';

class TestRefundProbeAdapter extends FakeStripeAdapter {
  readonly createRefundCalls: Array<CreateRefundParams> = [];
  onBeforeCreateRefund?: (params: CreateRefundParams) => Promise<void>;

  constructor() {
    super({
      platformWebhookSecret: 'whsec_platform_test',
      connectWebhookSecret: 'whsec_connect_test',
      environment: 'TEST',
    });
  }

  override async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    this.createRefundCalls.push(params);
    if (this.onBeforeCreateRefund) {
      await this.onBeforeCreateRefund(params);
    }
    return {
      id: `re_test_${randomUUID().slice(0, 12)}`,
      amountMinor: params.amountMinor,
      currency: 'EUR',
      status: 'pending',
    };
  }
}

describe('G7M-C4-B — compensation des suppléments PostgreSQL réel', () => {
  let sql: postgres.Sql | null = null;
  let db: (PostgresJsDatabase<typeof schema> & { $client: postgres.Sql }) | null = null;
  let probeSql: postgres.Sql | null = null;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 10 });
    db = drizzle(sql, { schema }) as unknown as PostgresJsDatabase<typeof schema> & {
      $client: postgres.Sql;
    };
    probeSql = postgres(DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    if (probeSql) await probeSql.end();
    if (sql) await sql.end();
  });

  beforeEach(async () => {
    if (sql) {
      await sql`DELETE FROM outbox_events WHERE event_type = 'REFUND_REQUESTED'`;
    }
  });

  interface FixtureIds {
    orgId: string;
    locationId: string;
    userId: string;
    variantId: string;
    itemId: string;
    draftId: string;
    initialPaymentId: string;
    bookingId: string;
    bookingLineId: string;
    bookingBlockId: string;
    amendmentId: string;
    amendmentLineId: string;
    holdBlockId: string;
    allocationId: string;
    segmentId: string;
    amendmentPaymentId: string;
    attemptId: string;
    paymentIntentId: string;
    connectedAccountId: string;
  }

  async function seedFixture(opts?: {
    suffix?: string;
    holdDeadlineOffsetMs?: number;
    amendmentStatus?: 'HOLD_PENDING' | 'READY_TO_APPLY' | 'EXPIRED' | 'APPLIED' | 'CANCELLED';
    amendmentPaymentStatus?: 'PENDING_PROVIDER' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
    environment?: 'TEST' | 'LIVE';
  }): Promise<FixtureIds> {
    if (!sql) throw new Error('Database not initialized');
    const s = sql;
    const suffix = ((opts?.suffix ?? 'sfx') + '-' + randomUUID().slice(0, 8))
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    const holdOffset = opts?.holdDeadlineOffsetMs ?? 600_000;
    const amendmentStatus = opts?.amendmentStatus ?? 'HOLD_PENDING';
    const paymentStatus = opts?.amendmentPaymentStatus ?? 'PENDING_PROVIDER';
    const environment = opts?.environment ?? 'TEST';
    const connectedAccountId = `acct_test_${suffix}`;

    const org = await s`
      INSERT INTO "organizations" ("slug", "legal_name", "status")
      VALUES (${'org-' + suffix}, 'Org Test', 'ACTIVE')
      RETURNING "id"
    `.then((r) => r[0]!);
    const orgId = org.id;

    const location = await s`
      INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency", "address_line1", "postal_code", "city", "country_code")
      VALUES (${orgId}, 'Loc Test', ${'loc-' + suffix}, 'Europe/Paris', 'EUR', '1 rue Test', '75001', 'Paris', 'FR')
      RETURNING "id"
    `.then((r) => r[0]!);
    const locationId = location.id;

    const user = await s`
      INSERT INTO "users" ("email", "display_name")
      VALUES (${'u-' + suffix + '@test.com'}, 'User Test')
      RETURNING "id"
    `.then((r) => r[0]!);
    const userId = user.id;

    const category = await s`
      SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1
    `.then((r) => r[0]!);

    const product = await s`
      INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
      VALUES (${orgId}, ${category.id}, 'Prod Test', ${'prod-' + suffix}, 'DRAFT')
      RETURNING "id"
    `.then((r) => r[0]!);

    const variant = await s`
      INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
      VALUES (${product.id}, 'Standard', 5000, 'EUR')
      RETURNING "id"
    `.then((r) => r[0]!);
    const variantId = variant.id;

    const item = await s`
      INSERT INTO "inventory_items" (
        "organization_id", "product_variant_id", "internal_sku", "current_location_id"
      ) VALUES (
        ${orgId}, ${variantId}, ${'SKU-' + suffix}, ${locationId}
      ) RETURNING "id"
    `.then((r) => r[0]!);
    const itemId = item.id;

    await s`
      INSERT INTO "organization_payment_accounts" (
        "organization_id", "provider", "environment", "provider_account_id",
        "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
        "transfers_capability_status", "settlement_merchant_mode",
        "controller_configuration_snapshot", "requirements_snapshot"
      ) VALUES (
        ${orgId}, 'STRIPE', 'TEST', ${connectedAccountId},
        'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true, 'ACTIVE', 'PLATFORM',
        ${JSON.stringify({ preset: 'TEST' })}, ${JSON.stringify({})}
      )
    `;

    const draft = await s`
      INSERT INTO "booking_drafts" (
        "organization_id", "location_id", "customer_user_id", "status",
        "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
        "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes", "currency",
        "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
        "tax_status", "tax_amount_minor", "commission_amount_minor", "billable_unit",
        "billable_unit_count", "cancellation_policy_snapshot"
      ) VALUES (
        ${orgId}, ${locationId}, ${userId}, 'DRAFT',
        '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
        '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z',
        'Europe/Paris', 30, 30, 'EUR', 10000, 0, 10000,
        'NOT_APPLICABLE', 0, 500, 'DAY', 2,
        ${JSON.stringify({ policy: 'FLEXIBLE' })}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const initialPayment = await s`
      INSERT INTO "payments" (
        "organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "currency",
        "tax_status", "tax_amount_minor", "commission_amount_minor", "financial_terms_version",
        "legal_terms_version", "terms_acceptance_snapshot", "charge_model", "settlement_merchant_mode",
        "connected_account_id", "on_behalf_of_account_id", "environment", "succeeded_at"
      ) VALUES (
        ${orgId}, ${draft.id}, ${userId}, 'SUCCEEDED', 10000, 'EUR',
        'NOT_APPLICABLE', 0, 500, 'v1', 'v1',
        ${JSON.stringify({ accepted: true })}, 'DESTINATION', 'CONNECTED_ACCOUNT',
        ${connectedAccountId}, ${connectedAccountId}, ${environment}, now()
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const booking = await s`
      INSERT INTO "bookings" (
        "organization_id", "location_id", "customer_user_id", "draft_id", "payment_id", "status",
        "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "timezone",
        "prep_buffer_minutes", "cleanup_buffer_minutes", "currency", "subtotal_amount_minor",
        "mandatory_fees_amount_minor", "total_amount_minor", "tax_status", "tax_amount_minor",
        "commission_amount_minor", "billable_unit_count", "cancellation_policy_snapshot",
        "terms_acceptance_snapshot", "confirmed_at"
      ) VALUES (
        ${orgId}, ${locationId}, ${userId}, ${draft.id}, ${initialPayment.id}, 'CONFIRMED',
        '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
        '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z', 'Europe/Paris', 30, 30,
        'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 2,
        ${JSON.stringify({ policy: 'FLEXIBLE' })}, ${JSON.stringify({ accepted: true })}, now()
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const bookingLine = await s`
      INSERT INTO "booking_lines" (
        "booking_id", "variant_id", "quantity", "unit_price_amount_minor", "billable_unit_count",
        "line_total_amount_minor", "variant_snapshot"
      ) VALUES (
        ${booking.id}, ${variantId}, 1, 5000, 2, 10000, ${JSON.stringify({ name: 'Standard' })}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const bookingBlock = await s`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "source_id"
      ) VALUES (
        ${orgId}, ${itemId}, 'BOOKING', 'ACTIVE',
        '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
        '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z', ${booking.id}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    await s`
      INSERT INTO "booking_items" ("booking_id", "booking_line_id", "inventory_item_id", "booking_block_id")
      VALUES (${booking.id}, ${bookingLine.id}, ${itemId}, ${bookingBlock.id})
    `;

    const holdDeadline = new Date(Date.now() + holdOffset);
    const createdAt = new Date(holdDeadline.getTime() - 10 * 60 * 1000);
    const amendment = await s`
      INSERT INTO "booking_amendments" (
        "organization_id", "booking_id", "amendment_number", "type", "status",
        "financial_snapshot_before", "financial_snapshot_after",
        "new_customer_start_at", "new_customer_end_at", "new_blocked_start_at", "new_blocked_end_at",
        "hold_deadline", "created_by", "created_at"
      ) VALUES (
        ${orgId}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
        ${JSON.stringify({ totalAmountMinor: 10000, currency: 'EUR' })},
        ${JSON.stringify({ totalAmountMinor: 15000, currency: 'EUR' })},
        '2026-07-10T09:00:00.000Z', '2026-07-13T17:00:00.000Z',
        '2026-07-10T08:30:00.000Z', '2026-07-13T17:30:00.000Z',
        ${holdDeadline.toISOString()}, ${userId}, ${createdAt.toISOString()}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    if (amendmentStatus === 'APPLIED') {
      await s`UPDATE "booking_amendments" SET "status" = 'READY_TO_APPLY' WHERE "id" = ${amendment.id}`;
      await s`UPDATE "booking_amendments" SET "status" = 'APPLIED', "applied_at" = now() WHERE "id" = ${amendment.id}`;
    } else if (amendmentStatus !== 'HOLD_PENDING') {
      await s`
        UPDATE "booking_amendments"
        SET "status" = ${amendmentStatus},
            "expired_at" = ${amendmentStatus === 'EXPIRED' ? new Date().toISOString() : null}
        WHERE "id" = ${amendment.id}
      `;
    }

    const holdBlock = await s`
      INSERT INTO "inventory_blocks" (
        "organization_id", "inventory_item_id", "type", "status",
        "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
        "expires_at", "source_id"
      ) VALUES (
        ${orgId}, ${itemId}, 'HOLD', ${amendmentStatus === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE'},
        '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z',
        '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z',
        ${holdDeadline.toISOString()}, ${amendment.id}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const amendmentLine = await s`
      INSERT INTO "booking_amendment_lines" (
        "amendment_id", "organization_id", "logical_line_id", "origin_type", "source_booking_line_id",
        "variant_id", "action", "before_quantity", "before_unit_price_amount_minor",
        "before_line_total_amount_minor", "after_quantity", "after_unit_price_amount_minor",
        "after_line_total_amount_minor", "pricing_snapshot", "variant_snapshot"
      ) VALUES (
        ${amendment.id}, ${orgId}, ${bookingLine.id}, 'ORIGINAL', ${bookingLine.id},
        ${variantId}, 'MODIFY', 1, 5000, 10000, 1, 5000, 15000,
        ${JSON.stringify({ source: 'C4B' })}, ${JSON.stringify({ name: 'Standard' })}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const allocation = await s`
      INSERT INTO "booking_amendment_allocations" (
        "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id", "action",
        "source_booking_block_id", "effective_customer_start_at", "effective_customer_end_at",
        "effective_blocked_start_at", "effective_blocked_end_at"
      ) VALUES (
        ${amendment.id}, ${amendmentLine.id}, ${orgId}, ${itemId}, 'RETAIN',
        ${bookingBlock.id}, '2026-07-10T09:00:00.000Z', '2026-07-13T17:00:00.000Z',
        '2026-07-10T08:30:00.000Z', '2026-07-13T17:30:00.000Z'
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const segment = await s`
      INSERT INTO "booking_amendment_segments" (
        "allocation_id", "organization_id", "inventory_item_id", "hold_block_id",
        "delta_start_at", "delta_end_at"
      ) VALUES (
        ${allocation.id}, ${orgId}, ${itemId}, ${holdBlock.id},
        '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z'
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const amendmentPayment = await s`
      INSERT INTO "amendment_payments" (
        "organization_id", "booking_id", "amendment_id", "customer_user_id",
        "status", "amount_minor", "currency", "charge_model", "settlement_merchant_mode",
        "connected_account_id", "on_behalf_of_account_id", "environment"
      ) VALUES (
        ${orgId}, ${booking.id}, ${amendment.id}, ${userId},
        'PENDING_PROVIDER', 5000, 'EUR', 'DESTINATION', 'CONNECTED_ACCOUNT',
        ${connectedAccountId}, ${connectedAccountId}, ${environment}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    const paymentIntentId = `pi_supp_${suffix}`;
    const attempt = await s`
      INSERT INTO "amendment_payment_attempts" (
        "organization_id", "amendment_payment_id", "attempt_number",
        "status", "provider_idempotency_key"
      ) VALUES (
        ${orgId}, ${amendmentPayment.id}, 1,
        'PENDING_PROVIDER', ${'pi_amendment_' + suffix}
      ) RETURNING "id"
    `.then((r) => r[0]!);

    if (paymentStatus !== 'PENDING_PROVIDER') {
      await s`
        UPDATE "amendment_payments"
        SET "status" = ${paymentStatus},
            "succeeded_at" = ${paymentStatus === 'SUCCEEDED' ? new Date().toISOString() : null}
        WHERE "id" = ${amendmentPayment.id}
      `;
      await s`
        UPDATE "amendment_payment_attempts"
        SET "status" = ${paymentStatus},
            "provider_payment_intent_id" = ${paymentIntentId},
            "provider_status" = ${paymentStatus === 'SUCCEEDED' ? 'succeeded' : 'processing'}
        WHERE "id" = ${attempt.id}
      `;
    }

    return {
      orgId,
      locationId,
      userId,
      variantId,
      itemId,
      draftId: draft.id,
      initialPaymentId: initialPayment.id,
      bookingId: booking.id,
      bookingLineId: bookingLine.id,
      bookingBlockId: bookingBlock.id,
      amendmentId: amendment.id,
      amendmentLineId: amendmentLine.id,
      holdBlockId: holdBlock.id,
      allocationId: allocation.id,
      segmentId: segment.id,
      amendmentPaymentId: amendmentPayment.id,
      attemptId: attempt.id,
      paymentIntentId,
      connectedAccountId,
    };
  }

  async function sendWebhook(fixture: FixtureIds, eventId: string, clock?: () => Date) {
    if (!db) throw new Error('DB not initialized');
    const provider = new TestRefundProbeAdapter();
    const providerEventId = `evt_${fixture.orgId.slice(0, 8)}_${eventId}_${randomUUID().slice(0, 6)}`;
    const payload = JSON.stringify({
      id: providerEventId,
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      api_version: '2026-06-24.dahlia',
      data: {
        object: {
          id: fixture.paymentIntentId,
          object: 'payment_intent',
          amount: 5000,
          currency: 'eur',
          status: 'succeeded',
          metadata: {
            organization_id: fixture.orgId,
            environment: 'TEST',
            protocol_version: 'booking-amendment-payment-v1',
            payment_type: 'AMENDMENT',
            amendment_id: fixture.amendmentId,
            amendment_payment_attempt_id: fixture.attemptId,
          },
          transfer_data: { destination: fixture.connectedAccountId },
          application_fee_amount: 250,
          on_behalf_of: fixture.connectedAccountId,
        },
      },
    });

    const signature = provider.generateValidSignature(payload, 'platform');
    const input: WebhookHandlerInput = {
      rawBody: payload,
      signature,
      endpoint: 'platform',
      environment: 'TEST',
    };

    const deps = clock !== undefined ? { db, provider, clock } : { db, provider };
    const result = await handleWebhook(deps, input);
    return { result, provider, providerEventId };
  }

  // ── 1. Éligibilité de la compensation ─────────────────────────────────────

  it('1.1 rejet explicite si l’amendement est actif avant sa deadline', async () => {
    if (!db) return;
    const fixture = await seedFixture({
      suffix: 'elig-before',
      holdDeadlineOffsetMs: 600_000,
      amendmentStatus: 'HOLD_PENDING',
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
          now: new Date(Date.now() - 1000), // Avant la deadline
        });
      }),
    ).rejects.toThrow(/actif avant sa deadline/);
  });

  it('1.2 rejet explicite si l’amendement est APPLIED', async () => {
    if (!db) return;
    const fixture = await seedFixture({
      suffix: 'elig-applied',
      holdDeadlineOffsetMs: -60_000,
      amendmentStatus: 'APPLIED',
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ).rejects.toThrow(/APPLIED ne peut pas faire l’objet d’une compensation/);
  });

  it('1.3 succès si l’amendement est EXPIRED ou passé sa deadline', async () => {
    if (!db) return;
    const fixture = await seedFixture({
      suffix: 'elig-ok',
      holdDeadlineOffsetMs: -60_000,
      amendmentStatus: 'HOLD_PENDING',
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const result = await db.transaction(async (tx) => {
      return await compensateAmendmentPayment(tx, {
        organizationId: fixture.orgId,
        bookingId: fixture.bookingId,
        amendmentId: fixture.amendmentId,
        amendmentPaymentId: fixture.amendmentPaymentId,
      });
    });

    expect(result.kind).toBe('COMPENSATION_CREATED');
  });

  // ── 2. Rejeu strict refund + outbox ───────────────────────────────────────

  it('2.1 refund existant sans outbox associé → rejet explicite', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'no-outbox',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 5000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ).rejects.toThrow(/Outbox event manquant/);
  });

  it('2.2 outbox existant avec payload incompatible → rejet explicite', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'bad-payload',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 5000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;
    await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type",
        "event_version", "idempotency_key", "payload", "available_at"
      ) VALUES (
        ${fixture.orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED',
        'v1', ${'refund_requested_' + refundId},
        ${JSON.stringify({ organizationId: fixture.orgId, bookingId: randomUUID(), amendmentId: fixture.amendmentId, refundId })}, ${new Date().toISOString()}
      )
    `;

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ).rejects.toThrow(/Payload outbox incompatible/);
  });

  it('2.3 refund existant avec montant ou flags incompatibles → rejet explicite', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'bad-flags',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 4000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ).rejects.toThrow(/Incohérence détectée sur le refund de compensation existant/);
  });

  it('2.4 rejeu sur outbox contenant un champ supplémentaire → rejet explicite par contrat fermé', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'extra-field',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 5000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;
    await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type",
        "event_version", "idempotency_key", "payload", "available_at"
      ) VALUES (
        ${fixture.orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED',
        'v1', ${'refund_requested_' + refundId},
        ${JSON.stringify({
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          refundId,
          extraUnauthorizedProperty: 'malicious',
        })}, ${new Date().toISOString()}
      )
    `;

    await expect(
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ).rejects.toThrow(/Payload outbox incompatible/);
  });

  it('2.5 rejeu strict parfait → retourne ALREADY_COMPENSATED', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'replay-ok',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const first = await db.transaction(async (tx) => {
      return await compensateAmendmentPayment(tx, {
        organizationId: fixture.orgId,
        bookingId: fixture.bookingId,
        amendmentId: fixture.amendmentId,
        amendmentPaymentId: fixture.amendmentPaymentId,
      });
    });
    expect(first.kind).toBe('COMPENSATION_CREATED');

    const second = await db.transaction(async (tx) => {
      return await compensateAmendmentPayment(tx, {
        organizationId: fixture.orgId,
        bookingId: fixture.bookingId,
        amendmentId: fixture.amendmentId,
        amendmentPaymentId: fixture.amendmentPaymentId,
      });
    });
    expect(second.kind).toBe('ALREADY_COMPENSATED');
    expect(second.refundId).toBe(first.refundId);
  });

  // ── 3. Validation autoritative du worker refund & zéro appel provider ─────

  it('3.1 mismatch organisation entre refund et payload → rejet worker sans appel provider', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'mismatch-org',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const otherOrgId = randomUUID();
    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 5000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;

    const outbox = await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type",
        "event_version", "idempotency_key", "payload", "available_at"
      ) VALUES (
        ${fixture.orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED',
        'v1', ${'refund_requested_' + refundId},
        ${JSON.stringify({ organizationId: otherOrgId, bookingId: fixture.bookingId, amendmentId: fixture.amendmentId, refundId })}, ${new Date(Date.now() - 10_000).toISOString()}
      ) RETURNING id
    `.then((r) => r[0]!);

    const claim = await claimRefundRequestBatch(db, 10, 'TEST');
    const myClaim = claim.find((c) => c.outboxEventId === outbox.id);
    expect(myClaim).toBeDefined();

    const provider = new TestRefundProbeAdapter();
    await expect(executeRefundRequest({ db, provider }, myClaim!, 'TEST')).rejects.toThrow(
      RefundRequestError,
    );

    expect(provider.createRefundCalls.length).toBe(0);

    const refundCheck = await sql`SELECT status FROM refunds WHERE id = ${refundId}`;
    expect(refundCheck[0]!.status).toBe('PENDING');
  });

  it.each([
    {
      name: 'montant refund !== amendmentPayment',
      fixtureOpts: {},
      overrideRefund: { amountMinor: 3000 },
      payloadMod: 'none',
      expectedError: 'AMOUNT_INVALID',
      expectedProviderCalls: 0,
    },
    {
      name: 'refund.currency = USD vs payment.currency = EUR avant provider',
      fixtureOpts: {},
      overrideRefund: { currency: 'USD' },
      payloadMod: 'none',
      expectedError: 'PAYMENT_CURRENCY_MISMATCH',
      expectedProviderCalls: 0,
    },
    {
      name: 'reverseTransfer = false',
      fixtureOpts: {},
      overrideRefund: { reverseTransfer: false },
      payloadMod: 'none',
      expectedError: 'REFUND_FLAGS_INVALID',
      expectedProviderCalls: 0,
    },
    {
      name: 'refundApplicationFee = false',
      fixtureOpts: {},
      overrideRefund: { refundApplicationFee: false },
      payloadMod: 'none',
      expectedError: 'REFUND_FLAGS_INVALID',
      expectedProviderCalls: 0,
    },
    {
      name: 'providerIdempotencyKey incorrecte',
      fixtureOpts: {},
      overrideRefund: { providerIdempotencyKey: 'bad' },
      payloadMod: 'none',
      expectedError: 'IDEMPOTENCY_KEY_MISMATCH',
      expectedProviderCalls: 0,
    },
    {
      name: 'payload avec un autre bookingId',
      fixtureOpts: {},
      overrideRefund: {},
      payloadMod: 'alt-booking',
      expectedError: 'AMENDMENT_MISMATCH',
      expectedProviderCalls: 0,
    },
    {
      name: 'payload avec un autre amendmentId',
      fixtureOpts: {},
      overrideRefund: {},
      payloadMod: 'alt-amendment',
      expectedError: 'AMENDMENT_MISMATCH',
      expectedProviderCalls: 0,
    },
    {
      name: 'environnement LIVE alors que worker est TEST',
      fixtureOpts: { environment: 'LIVE' as const },
      overrideRefund: {},
      payloadMod: 'none',
      expectedError: 'ENVIRONMENT_MISMATCH',
      expectedProviderCalls: 0,
    },
    {
      name: 'résultat provider avec devise non-EUR',
      fixtureOpts: {},
      overrideRefund: {},
      payloadMod: 'none',
      providerCurrency: 'USD',
      expectedError: 'PROVIDER_RESULT_INVALID',
      expectedProviderCalls: 1,
    },
  ])(
    '3.2 table-driven fail-closed : $name → rejet fail-closed sans projection locale indue',
    async (tc) => {
      if (!db || !sql) return;
      const suffix = 'td-' + randomUUID().slice(0, 6);
      const fixture = await seedFixture({
        suffix,
        holdDeadlineOffsetMs: -60_000,
        amendmentPaymentStatus: 'SUCCEEDED',
        ...tc.fixtureOpts,
      });

      const altFixture =
        tc.payloadMod === 'alt-booking' || tc.payloadMod === 'alt-amendment'
          ? await seedFixture({
              suffix: 'alt-' + suffix,
              holdDeadlineOffsetMs: -60_000,
              amendmentPaymentStatus: 'SUCCEEDED',
            })
          : null;

      const targetBookingId =
        tc.payloadMod === 'alt-booking' ? altFixture!.bookingId : fixture.bookingId;
      const targetAmendmentId =
        tc.payloadMod === 'alt-amendment' ? altFixture!.amendmentId : fixture.amendmentId;

      const refundId = randomUUID();
      const amountMinor = tc.overrideRefund?.amountMinor ?? 5000;
      const currency = tc.overrideRefund?.currency ?? 'EUR';
      const reverseTransfer = tc.overrideRefund?.reverseTransfer ?? true;
      const refundApplicationFee = tc.overrideRefund?.refundApplicationFee ?? true;
      const providerIdempotencyKey =
        tc.overrideRefund?.providerIdempotencyKey === 'bad'
          ? `refund_bad_${randomUUID().slice(0, 8)}`
          : `refund_amendment_${refundId}`;

      const isNonEurRefund = currency !== 'EUR';
      if (isNonEurRefund) {
        await sql.unsafe('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_currency_eur');
        await sql.unsafe('ALTER TABLE refunds DISABLE TRIGGER before_check_refund_org');
      }

      try {
        await sql`
        INSERT INTO "refunds" (
          "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
          "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
          "provider_idempotency_key", "requested_at"
        ) VALUES (
          ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
          'PENDING', ${amountMinor}, ${currency}, ${reverseTransfer}, ${refundApplicationFee},
          ${providerIdempotencyKey}, ${new Date(Date.now() - 10_000).toISOString()}
        )
      `;

        const outbox = await sql`
        INSERT INTO "outbox_events" (
          "organization_id", "aggregate_type", "aggregate_id", "event_type",
          "event_version", "idempotency_key", "payload", "available_at"
        ) VALUES (
          ${fixture.orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED',
          'v1', ${'refund_requested_' + refundId},
          ${JSON.stringify({ organizationId: fixture.orgId, bookingId: targetBookingId, amendmentId: targetAmendmentId, refundId })}, ${new Date(Date.now() - 10_000).toISOString()}
        ) RETURNING id
      `.then((r) => r[0]!);

        const claimEnv = (tc.fixtureOpts?.environment ?? 'TEST') as 'TEST' | 'LIVE';
        const claim = await claimRefundRequestBatch(db, 10, claimEnv);
        const myClaim = claim.find((c) => c.outboxEventId === outbox.id);
        expect(myClaim).toBeDefined();

        const provider = new TestRefundProbeAdapter();
        if (tc.providerCurrency) {
          provider.createRefund = async (params) => {
            provider.createRefundCalls.push(params);
            return {
              id: `re_test_${randomUUID().slice(0, 12)}`,
              amountMinor: params.amountMinor,
              currency: tc.providerCurrency!,
              status: 'pending',
            };
          };
        }

        let caughtError: unknown;
        try {
          await executeRefundRequest({ db, provider }, myClaim!, 'TEST');
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(RefundRequestError);
        expect((caughtError as RefundRequestError).code).toBe(tc.expectedError);

        expect(provider.createRefundCalls.length).toBe(tc.expectedProviderCalls);

        // Vérifie qu'aucune projection indue (SUBMITTED/SUCCEEDED) n'a eu lieu
        const refundAfter =
          await sql`SELECT status, provider_refund_id FROM refunds WHERE id = ${refundId}`;
        expect(refundAfter[0]!.status).toBe('PENDING');
        expect(refundAfter[0]!.provider_refund_id).toBeNull();

        const outboxAfter =
          await sql`SELECT status, processed_at FROM outbox_events WHERE id = ${outbox.id}`;
        expect(outboxAfter[0]!.status).not.toBe('PROCESSED');
        expect(outboxAfter[0]!.processed_at).toBeNull();
      } finally {
        if (isNonEurRefund) {
          await sql`DELETE FROM outbox_events WHERE aggregate_id = ${refundId}`;
          await sql`DELETE FROM refunds WHERE currency <> 'EUR' OR id = ${refundId}`;
          await sql.unsafe('ALTER TABLE refunds ENABLE TRIGGER before_check_refund_org');
          await sql.unsafe(
            "ALTER TABLE refunds ADD CONSTRAINT refunds_currency_eur CHECK (currency = 'EUR')",
          );
        }
      }
    },
  );

  it('3.3 amendement APPLIED dans le worker → rejet sans appel provider', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'worker-applied',
      holdDeadlineOffsetMs: -60_000,
      amendmentStatus: 'APPLIED',
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const refundId = randomUUID();
    await sql`
      INSERT INTO "refunds" (
        "id", "organization_id", "payment_id", "amendment_payment_id", "reason",
        "status", "amount_minor", "currency", "reverse_transfer", "refund_application_fee",
        "provider_idempotency_key", "requested_at"
      ) VALUES (
        ${refundId}, ${fixture.orgId}, NULL, ${fixture.amendmentPaymentId}, 'AMENDMENT_COMPENSATION',
        'PENDING', 5000, 'EUR', true, true, ${'refund_amendment_' + refundId}, ${new Date().toISOString()}
      )
    `;

    const outbox = await sql`
      INSERT INTO "outbox_events" (
        "organization_id", "aggregate_type", "aggregate_id", "event_type",
        "event_version", "idempotency_key", "payload", "available_at"
      ) VALUES (
        ${fixture.orgId}, 'REFUND', ${refundId}, 'REFUND_REQUESTED',
        'v1', ${'refund_requested_' + refundId},
        ${JSON.stringify({ organizationId: fixture.orgId, bookingId: fixture.bookingId, amendmentId: fixture.amendmentId, refundId })}, ${new Date(Date.now() - 10_000).toISOString()}
      ) RETURNING id
    `.then((r) => r[0]!);

    const claim = await claimRefundRequestBatch(db, 10, 'TEST');
    const myClaim = claim.find((c) => c.outboxEventId === outbox.id);
    expect(myClaim).toBeDefined();

    const provider = new TestRefundProbeAdapter();
    await expect(executeRefundRequest({ db, provider }, myClaim!, 'TEST')).rejects.toThrow(
      RefundRequestError,
    );

    expect(provider.createRefundCalls.length).toBe(0);

    const refundCheck = await sql`SELECT status FROM refunds WHERE id = ${refundId}`;
    expect(refundCheck[0]!.status).toBe('PENDING');
  });

  // ── 4. Panne outbox : HTTP 500 & rollback complet & logs assainis ─────────

  it('4.1 panne outbox lors du webhook : retourne HTTP 500, rollback complet et logs assainis sans fuite technique', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({ suffix: 'outbox-fail', holdDeadlineOffsetMs: -60_000 });

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION fail_refund_outbox_trigger() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.event_type = 'REFUND_REQUESTED' AND NEW.organization_id = '${fixture.orgId}'::uuid THEN
          RAISE EXCEPTION 'Simulated technical outbox insertion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await sql.unsafe(`
      CREATE OR REPLACE TRIGGER test_fail_refund_outbox
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION fail_refund_outbox_trigger();
    `);

    const capturedErrorLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrorLogs.push(
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      );
    };

    try {
      const { result, providerEventId } = await sendWebhook(fixture, 'outbox_fail');
      expect(result.kind).toBe('FAILURE');
      expect(result.statusCode).toBe(500);

      // Rollback complet : aucun refund créé, paiement resté PENDING_PROVIDER
      const refunds =
        await sql`SELECT count(*) FROM refunds WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
      expect(Number(refunds[0]!.count)).toBe(0);

      const paymentRows =
        await sql`SELECT status FROM amendment_payments WHERE id = ${fixture.amendmentPaymentId}`;
      expect(paymentRows[0]!.status).toBe('PENDING_PROVIDER');

      const attemptRows =
        await sql`SELECT status FROM amendment_payment_attempts WHERE id = ${fixture.attemptId}`;
      expect(attemptRows[0]!.status).toBe('PENDING_PROVIDER');

      // Vérification d'assainissement strict des logs
      expect(capturedErrorLogs.length).toBeGreaterThan(0);
      const combinedLogs = capturedErrorLogs.join(' ');

      // Le message brut PostgreSQL simulé NE DOIT PAS figurer dans le log
      expect(combinedLogs).not.toContain('Simulated technical outbox insertion failure');

      // Le nom d'erreur original (ex. PostgresError) NE DOIT PAS figurer dans le log
      expect(combinedLogs).not.toContain('PostgresError');
      expect(combinedLogs).not.toContain('Error');

      // Le providerEventId ne doit pas figurer dans le log technique 500
      expect(combinedLogs).not.toContain(providerEventId);

      // Les identifiants et payload sensibles ne doivent pas figurer dans le log
      expect(combinedLogs).not.toContain(fixture.orgId);
      expect(combinedLogs).not.toContain(fixture.bookingId);
      expect(combinedLogs).not.toContain(fixture.amendmentId);
      expect(combinedLogs).not.toContain(fixture.amendmentPaymentId);
      expect(combinedLogs).not.toContain(fixture.attemptId);
      expect(combinedLogs).not.toContain(fixture.paymentIntentId);
      expect(combinedLogs).not.toContain('payload');

      // Le log doit contenir un code d'erreur normalisé/assaini
      expect(combinedLogs).toContain('"result":"error"');
      expect(combinedLogs).toContain('"errorCode":"TECHNICAL_FAILURE"');
    } finally {
      console.error = originalConsoleError;
      await sql.unsafe(`DROP TRIGGER IF EXISTS test_fail_refund_outbox ON outbox_events;`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS fail_refund_outbox_trigger;`);
    }
  });

  // ── 5. Prouver l’absence totale de verrou de transaction pendant le provider ──

  it('5.1 prouve par lock probe PostgreSQL l’absence totale de verrous de transaction pendant l’appel provider createRefund', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'lock-probe',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const comp = await db.transaction(async (tx) => {
      return await compensateAmendmentPayment(tx, {
        organizationId: fixture.orgId,
        bookingId: fixture.bookingId,
        amendmentId: fixture.amendmentId,
        amendmentPaymentId: fixture.amendmentPaymentId,
      });
    });
    expect(comp.kind).toBe('COMPENSATION_CREATED');
    if (comp.kind !== 'COMPENSATION_CREATED') throw new Error('Expected COMPENSATION_CREATED');

    const claim = await claimRefundRequestBatch(db, 10, 'TEST');
    const myClaim = claim.find((c) => c.outboxEventId === comp.outboxEventId);
    expect(myClaim).toBeDefined();

    let probeExecuted = false;
    let outboxUnlocked = false;
    let refundUnlocked = false;
    let paymentUnlocked = false;
    let amendmentUnlocked = false;
    let attemptUnlocked = false;

    const provider = new TestRefundProbeAdapter();
    provider.onBeforeCreateRefund = async () => {
      // Exécuter une sonde de verrou concurrente avec NOWAIT sur les 5 tables critiques
      const p = probeSql!;
      await p.begin(async (probeTx) => {
        const outboxProbe = await probeTx`
          SELECT id FROM outbox_events WHERE id = ${comp.outboxEventId} FOR UPDATE NOWAIT
        `;
        outboxUnlocked = outboxProbe.length === 1;

        const refundProbe = await probeTx`
          SELECT id FROM refunds WHERE id = ${comp.refundId} FOR UPDATE NOWAIT
        `;
        refundUnlocked = refundProbe.length === 1;

        const paymentProbe = await probeTx`
          SELECT id FROM amendment_payments WHERE id = ${fixture.amendmentPaymentId} FOR UPDATE NOWAIT
        `;
        paymentUnlocked = paymentProbe.length === 1;

        const amendmentProbe = await probeTx`
          SELECT id FROM booking_amendments WHERE id = ${fixture.amendmentId} FOR UPDATE NOWAIT
        `;
        amendmentUnlocked = amendmentProbe.length === 1;

        const attemptProbe = await probeTx`
          SELECT id FROM amendment_payment_attempts WHERE id = ${fixture.attemptId} FOR UPDATE NOWAIT
        `;
        attemptUnlocked = attemptProbe.length === 1;
      });
      probeExecuted = true;
    };

    const execResult = await executeRefundRequest({ db, provider }, myClaim!, 'TEST');

    expect(execResult.outcome).toBe('submitted');
    expect(probeExecuted).toBe(true);
    expect(outboxUnlocked).toBe(true);
    expect(refundUnlocked).toBe(true);
    expect(paymentUnlocked).toBe(true);
    expect(amendmentUnlocked).toBe(true);
    expect(attemptUnlocked).toBe(true);
  });

  // ── 6. Concurrence réelle ─────────────────────────────────────────────────

  it('6.1 concurrence réelle : deux compensations simultanées produisent exactement 1 refund et 1 outbox', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({
      suffix: 'concurrent',
      holdDeadlineOffsetMs: -60_000,
      amendmentPaymentStatus: 'SUCCEEDED',
    });

    const [res1, res2] = await Promise.all([
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
      db.transaction(async (tx) => {
        return await compensateAmendmentPayment(tx, {
          organizationId: fixture.orgId,
          bookingId: fixture.bookingId,
          amendmentId: fixture.amendmentId,
          amendmentPaymentId: fixture.amendmentPaymentId,
        });
      }),
    ]);

    const kinds = [res1.kind, res2.kind].sort();
    expect(kinds).toEqual(['ALREADY_COMPENSATED', 'COMPENSATION_CREATED']);

    const refunds =
      await sql`SELECT count(*) FROM refunds WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
    expect(Number(refunds[0]!.count)).toBe(1);

    const outboxCount =
      await sql`SELECT count(*) FROM outbox_events WHERE aggregate_id = ${res1.refundId}`;
    expect(Number(outboxCount[0]!.count)).toBe(1);
  });

  // ── 7. Scénarios Webhook & Invariants ADR-023 ──────────────────────────────

  it('7.1 webhook à holdDeadline exactement crée atomiquement la compensation', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({ suffix: 'exact-deadline', holdDeadlineOffsetMs: 0 });

    const { result } = await sendWebhook(fixture, 'exact_deadline');
    expect(result.kind).toBe('SUCCESS');

    const refundRows =
      await sql`SELECT * FROM refunds WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.reason).toBe('AMENDMENT_COMPENSATION');
    expect(refundRows[0]!.status).toBe('PENDING');

    const outboxRows =
      await sql`SELECT * FROM outbox_events WHERE aggregate_id = ${refundRows[0]!.id}`;
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.event_type).toBe('REFUND_REQUESTED');
  });

  it('7.2 webhook replay est strictement idempotent (HTTP 200, zéro doublon)', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({ suffix: 'replay-wh', holdDeadlineOffsetMs: -60_000 });

    const first = await sendWebhook(fixture, 'rep_1');
    expect(first.result.kind).toBe('SUCCESS');

    const second = await sendWebhook(fixture, 'rep_1');
    expect(second.result.kind).toBe('SUCCESS');

    const refunds =
      await sql`SELECT count(*) FROM refunds WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
    expect(Number(refunds[0]!.count)).toBe(1);
  });

  it('7.3 vérifie l’invariant financier ADR-023 §11.2 après compensation tardive via getEffectiveBooking', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({ suffix: 'invariant', holdDeadlineOffsetMs: -60_000 });

    const { result } = await sendWebhook(fixture, 'invariant');
    expect(result.kind).toBe('SUCCESS');

    const effective = await getEffectiveBooking(db, fixture.orgId, fixture.bookingId);
    expect(effective.kind).toBe('FOUND');
    if (effective.kind === 'FOUND') {
      const fin = effective.booking.financials;
      expect(fin.contractualTotalAmountMinor).toBe(10000);
      expect(fin.grossCollectedAmountMinor).toBe(15000);
      expect(fin.refundStillOwedAmountMinor).toBe(5000);
      expect(
        fin.grossCollectedAmountMinor -
          fin.refundStillOwedAmountMinor -
          fin.successfulRefundedAmountMinor,
      ).toBe(fin.contractualTotalAmountMinor);
    }
  });

  it('7.4 passage réel de REFUND_REQUESTED.v1 jusqu’au moteur refund existant', async () => {
    if (!db || !sql) return;
    const fixture = await seedFixture({ suffix: 'e2e-refund', holdDeadlineOffsetMs: -60_000 });

    const { result } = await sendWebhook(fixture, 'e2e_refund');
    expect(result.kind).toBe('SUCCESS');

    const refundRowsBefore =
      await sql`SELECT id FROM refunds WHERE amendment_payment_id = ${fixture.amendmentPaymentId}`;
    expect(refundRowsBefore.length).toBe(1);
    const outboxRowsBefore =
      await sql`SELECT id FROM outbox_events WHERE aggregate_id = ${refundRowsBefore[0]!.id}`;
    expect(outboxRowsBefore.length).toBe(1);

    const claim = await claimRefundRequestBatch(db, 10, 'TEST');
    const myClaim = claim.find((c) => c.outboxEventId === outboxRowsBefore[0]!.id);
    expect(myClaim).toBeDefined();

    const provider = new TestRefundProbeAdapter();
    const exec = await executeRefundRequest({ db, provider }, myClaim!, 'TEST');

    expect(exec.outcome).toBe('submitted');
    expect(provider.createRefundCalls.length).toBe(1);
    expect(provider.createRefundCalls[0]!.amountMinor).toBe(5000);
    expect(provider.createRefundCalls[0]!.reverseTransfer).toBe(true);
    expect(provider.createRefundCalls[0]!.refundApplicationFee).toBe(true);

    const refundRows = await sql`
      SELECT status, provider_refund_id FROM refunds WHERE id = ${refundRowsBefore[0]!.id}
    `;
    expect(refundRows[0]!.status).toBe('SUBMITTED');
    expect(refundRows[0]!.provider_refund_id).toBeTruthy();

    const outboxRows = await sql`
      SELECT status, processed_at FROM outbox_events WHERE id = ${myClaim!.outboxEventId}
    `;
    expect(outboxRows[0]!.status).toBe('PROCESSED');
    expect(outboxRows[0]!.processed_at).toBeTruthy();
  });
});
