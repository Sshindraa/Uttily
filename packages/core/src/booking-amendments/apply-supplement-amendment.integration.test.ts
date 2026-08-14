import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { getEffectiveBooking } from './get-effective-booking';
import { initiateSupplementPayment } from './initiate-supplement-payment';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from '../webhook-handler/handle-webhook';
import type { WebhookHandlerDeps, WebhookHandlerInput } from '../webhook-handler/types';
import type { CreatePaymentIntentParams, PaymentIntentResult } from '../payments/types';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = 'uttily_test_g7m_c3';
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';
const PLATFORM_SECRET = 'whsec_c3_platform';
const BASE_START = '2026-05-10T09:00:00.000Z';
const BASE_END = '2026-05-12T17:00:00.000Z';
const BASE_BLOCKED_START = '2026-05-10T08:30:00.000Z';
const BASE_BLOCKED_END = '2026-05-12T17:30:00.000Z';

let db: DatabaseClient | null = null;
let sql: postgres.Sql | null = null;
let testUrl: string | null = null;

type AllocationAction = 'RETAIN' | 'REPLACE' | 'ADD' | 'REMOVE';

interface SegmentSpec {
  start: string;
  end: string;
}

interface AllocationSpec {
  itemIndex: number;
  action: AllocationAction;
  sourceBlockIndex?: number;
  segments?: SegmentSpec[];
}

interface Fixture {
  orgId: string;
  connectedAccountId: string;
  customerId: string;
  otherCustomerId: string;
  bookingId: string;
  bookingLineId: string;
  itemIds: string[];
  sourceBlockIds: string[];
  amendmentId: string;
  amendmentPaymentId: string;
  attemptId: string;
  holdDeadline: Date;
  amountMinor: number;
  initialTotalMinor: number;
  initialCommissionMinor: number;
  effectiveStart: string;
  effectiveEnd: string;
  effectiveBlockedStart: string;
  effectiveBlockedEnd: string;
}

interface ScenarioOptions {
  suffix: string;
  allocations: AllocationSpec[];
  bookedItemCount?: number;
  holdDeadline?: Date;
  effectiveStart?: string;
  effectiveEnd?: string;
  effectiveBlockedStart?: string;
  effectiveBlockedEnd?: string;
  amountMinor?: number;
}

function uuid(value: unknown): string {
  return String(value);
}

async function seedScenario(options: ScenarioOptions): Promise<Fixture> {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  const client = sql;
  const bookedItemCount = options.bookedItemCount ?? 1;
  const amountMinor = options.amountMinor ?? 5000;
  const initialTotalMinor = 10000 * bookedItemCount;
  const initialCommissionMinor = 500 * bookedItemCount;
  const suffix = `${options.suffix}-${randomUUID().slice(0, 8)}`;
  const effectiveStart = options.effectiveStart ?? BASE_START;
  const effectiveEnd = options.effectiveEnd ?? BASE_END;
  const effectiveBlockedStart = options.effectiveBlockedStart ?? BASE_BLOCKED_START;
  const effectiveBlockedEnd = options.effectiveBlockedEnd ?? BASE_BLOCKED_END;
  const holdDeadline = options.holdDeadline ?? new Date(Date.now() + 60 * 60 * 1000);
  const createdAt = new Date(holdDeadline.getTime() - 10 * 60 * 1000);
  const connectedAccountId = `acct_c3_${suffix}`;

  const org = await client`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'C3 Org ' + suffix}, ${'c3-org-' + suffix})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await client`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Annecy', ${'c3-location-' + suffix}, 'UTC', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const customer = await client`
    INSERT INTO users (email) VALUES (${'c3-customer-' + suffix + '@example.com'})
    RETURNING id
  `.then((rows) => rows[0]!);
  const otherCustomer = await client`
    INSERT INTO users (email) VALUES (${'c3-other-' + suffix + '@example.com'})
    RETURNING id
  `.then((rows) => rows[0]!);
  const category = await client`
    SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1
  `.then((rows) => rows[0]!);
  const product = await client`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${org.id}, ${category.id}, 'C3 Equipment', ${'c3-product-' + suffix}, 'DRAFT')
    RETURNING id
  `.then((rows) => rows[0]!);
  const variant = await client`
    INSERT INTO product_variants (product_id, name, daily_price_amount_minor, currency)
    VALUES (${product.id}, 'Standard', 5000, 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);

  const itemIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const item = await client`
      INSERT INTO inventory_items (
        organization_id, product_variant_id, internal_sku, current_location_id
      ) VALUES (
        ${org.id}, ${variant.id}, ${'C3-SKU-' + suffix + '-' + index}, ${location.id}
      ) RETURNING id
    `.then((rows) => rows[0]!);
    itemIds.push(uuid(item.id));
  }

  const draft = await client`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, commission_amount_minor, billable_unit,
      billable_unit_count, cancellation_policy_snapshot
    ) VALUES (
      ${org.id}, ${location.id}, ${customer.id}, 'DRAFT',
      ${BASE_START}, ${BASE_END}, ${BASE_BLOCKED_START}, ${BASE_BLOCKED_END},
      'UTC', 30, 30, 'EUR', ${initialTotalMinor}, 0, ${initialTotalMinor},
      'NOT_APPLICABLE', 0, ${initialCommissionMinor}, 'DAY', 2,
      ${client.json({ policy: 'C3' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const initialPayment = await client`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status, amount_minor, currency,
      tax_status, tax_amount_minor, commission_amount_minor, financial_terms_version,
      legal_terms_version, terms_acceptance_snapshot, connected_account_id,
      on_behalf_of_account_id, charge_model, settlement_merchant_mode, environment,
      succeeded_at
    ) VALUES (
      ${org.id}, ${draft.id}, ${customer.id}, 'SUCCEEDED', ${initialTotalMinor}, 'EUR',
      'NOT_APPLICABLE', 0, ${initialCommissionMinor}, 'v1', 'v1',
      ${client.json({ accepted: true })}, ${connectedAccountId}, ${connectedAccountId}, 'DESTINATION',
      'CONNECTED_ACCOUNT', 'TEST', now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await client`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, timezone,
      prep_buffer_minutes, cleanup_buffer_minutes, currency, subtotal_amount_minor,
      mandatory_fees_amount_minor, total_amount_minor, tax_status, tax_amount_minor,
      commission_amount_minor, billable_unit_count, cancellation_policy_snapshot,
      terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${org.id}, ${location.id}, ${customer.id}, ${draft.id}, ${initialPayment.id}, 'CONFIRMED',
      ${BASE_START}, ${BASE_END}, ${BASE_BLOCKED_START}, ${BASE_BLOCKED_END}, 'UTC', 30, 30,
      'EUR', ${initialTotalMinor}, 0, ${initialTotalMinor}, 'NOT_APPLICABLE', 0,
      ${initialCommissionMinor}, 2, ${client.json({ policy: 'C3' })},
      ${client.json({ accepted: true })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const line = await client`
    INSERT INTO booking_lines (
      booking_id, variant_id, quantity, unit_price_amount_minor, billable_unit_count,
      line_total_amount_minor, variant_snapshot
    ) VALUES (
      ${booking.id}, ${variant.id}, ${bookedItemCount}, 5000, 2,
      ${initialTotalMinor}, ${client.json({ name: 'Standard' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);

  const sourceBlockIds: string[] = [];
  for (let index = 0; index < bookedItemCount; index += 1) {
    const block = await client`
      INSERT INTO inventory_blocks (
        organization_id, inventory_item_id, type, status,
        customer_start_at, customer_end_at, blocked_start_at, blocked_end_at, source_id
      ) VALUES (
        ${org.id}, ${itemIds[index]!}, 'BOOKING', 'ACTIVE',
        ${BASE_START}, ${BASE_END}, ${BASE_BLOCKED_START}, ${BASE_BLOCKED_END}, ${booking.id}
      ) RETURNING id
    `.then((rows) => rows[0]!);
    sourceBlockIds.push(uuid(block.id));
    await client`
      INSERT INTO booking_items (
        booking_id, booking_line_id, inventory_item_id, booking_block_id
      ) VALUES (${booking.id}, ${line.id}, ${itemIds[index]!}, ${block.id})
    `;
  }

  await client`
    INSERT INTO organization_payment_accounts (
      organization_id, provider, environment, provider_account_id,
      account_api_generation, onboarding_status, charges_enabled, payouts_enabled,
      transfers_capability_status, settlement_merchant_mode,
      controller_configuration_snapshot, requirements_snapshot
    ) VALUES (
      ${org.id}, 'STRIPE', 'TEST', ${connectedAccountId},
      'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true, 'ACTIVE', 'PLATFORM',
      ${client.json({ preset: 'C3' })}, ${client.json({})}
    )
  `;

  const firstAction = options.allocations[0]?.action ?? 'REPLACE';
  const lineAction =
    firstAction === 'ADD'
      ? 'ADD'
      : firstAction === 'REMOVE'
        ? 'REMOVE'
        : firstAction === 'RETAIN'
          ? 'UNCHANGED'
          : 'MODIFY';
  const isAdd = lineAction === 'ADD';
  const afterQuantity =
    lineAction === 'REMOVE' ? 0 : isAdd ? options.allocations.length : Math.max(bookedItemCount, 1);
  const afterUnitPrice = lineAction === 'REMOVE' ? 0 : 5000;
  const afterLineTotal = afterUnitPrice * afterQuantity * 2;
  const amendment = await client`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at, new_blocked_start_at,
      new_blocked_end_at, hold_deadline, created_by, created_at
    ) VALUES (
      ${org.id}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
      ${client.json({ totalAmountMinor: initialTotalMinor, currency: 'EUR' })},
      ${client.json({ totalAmountMinor: initialTotalMinor + amountMinor, currency: 'EUR' })},
      ${effectiveStart}, ${effectiveEnd}, ${effectiveBlockedStart}, ${effectiveBlockedEnd},
      ${holdDeadline}, ${customer.id}, ${createdAt}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const logicalLineId = isAdd ? randomUUID() : uuid(line.id);
  const amendmentLine = await client`
    INSERT INTO booking_amendment_lines (
      amendment_id, organization_id, logical_line_id, origin_type, source_booking_line_id,
      variant_id, action, before_quantity, before_unit_price_amount_minor,
      before_line_total_amount_minor, after_quantity, after_unit_price_amount_minor,
      after_line_total_amount_minor, pricing_snapshot, variant_snapshot
    ) VALUES (
      ${amendment.id}, ${org.id}, ${logicalLineId}, ${isAdd ? 'AMENDMENT' : 'ORIGINAL'},
      ${isAdd ? null : line.id}, ${variant.id}, ${lineAction},
      ${isAdd ? 0 : bookedItemCount}, ${isAdd ? 0 : 5000}, ${isAdd ? 0 : initialTotalMinor},
      ${afterQuantity}, ${afterUnitPrice}, ${afterLineTotal},
      ${client.json({ source: 'C3 integration' })}, ${client.json({ name: 'Standard' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);

  for (const allocation of options.allocations) {
    const sourceIndex = allocation.sourceBlockIndex ?? allocation.itemIndex;
    const sourceBlockId =
      allocation.sourceBlockIndex === undefined && allocation.action === 'ADD'
        ? null
        : (sourceBlockIds[sourceIndex] ?? null);
    const allocationRow = await client`
      INSERT INTO booking_amendment_allocations (
        amendment_id, amendment_line_id, organization_id, inventory_item_id, action,
        source_booking_block_id, effective_customer_start_at, effective_customer_end_at,
        effective_blocked_start_at, effective_blocked_end_at
      ) VALUES (
        ${amendment.id}, ${amendmentLine.id}, ${org.id}, ${itemIds[allocation.itemIndex]!},
        ${allocation.action}, ${sourceBlockId}, ${effectiveStart}, ${effectiveEnd},
        ${effectiveBlockedStart}, ${effectiveBlockedEnd}
      ) RETURNING id
    `.then((rows) => rows[0]!);
    for (const segment of allocation.segments ?? []) {
      const hold = await client`
        INSERT INTO inventory_blocks (
          organization_id, inventory_item_id, type, status,
          customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
          expires_at, source_id
        ) VALUES (
          ${org.id}, ${itemIds[allocation.itemIndex]!}, 'HOLD', 'ACTIVE',
          ${segment.start}, ${segment.end}, ${segment.start}, ${segment.end},
          ${holdDeadline}, ${amendment.id}
        ) RETURNING id
      `.then((rows) => rows[0]!);
      await client`
        INSERT INTO booking_amendment_segments (
          allocation_id, organization_id, inventory_item_id, hold_block_id,
          delta_start_at, delta_end_at
        ) VALUES (
          ${allocationRow.id}, ${org.id}, ${itemIds[allocation.itemIndex]!}, ${hold.id},
          ${segment.start}, ${segment.end}
        )
      `;
    }
  }

  const amendmentPayment = await client`
    INSERT INTO amendment_payments (
      organization_id, booking_id, amendment_id, customer_user_id, amount_minor,
      currency, environment, connected_account_id, on_behalf_of_account_id,
      charge_model, settlement_merchant_mode, status
    ) VALUES (
      ${org.id}, ${booking.id}, ${amendment.id}, ${customer.id}, ${amountMinor}, 'EUR', 'TEST',
      ${connectedAccountId}, ${connectedAccountId}, 'DESTINATION', 'CONNECTED_ACCOUNT', 'PENDING_PROVIDER'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const attempt = await client`
    INSERT INTO amendment_payment_attempts (
      organization_id, amendment_payment_id, attempt_number, status, provider_idempotency_key
    ) VALUES (
      ${org.id}, ${amendmentPayment.id}, 1, 'PENDING_PROVIDER',
      ${'pi_amendment_' + amendmentPayment.id + '_1'}
    ) RETURNING id
  `.then((rows) => rows[0]!);

  return {
    orgId: uuid(org.id),
    connectedAccountId,
    customerId: uuid(customer.id),
    otherCustomerId: uuid(otherCustomer.id),
    bookingId: uuid(booking.id),
    bookingLineId: uuid(line.id),
    itemIds,
    sourceBlockIds,
    amendmentId: uuid(amendment.id),
    amendmentPaymentId: uuid(amendmentPayment.id),
    attemptId: uuid(attempt.id),
    holdDeadline,
    amountMinor,
    initialTotalMinor,
    initialCommissionMinor,
    effectiveStart,
    effectiveEnd,
    effectiveBlockedStart,
    effectiveBlockedEnd,
  };
}

function makePayload(
  fixture: Fixture,
  suffix: string,
  overrides: {
    eventType?: string;
    status?: string;
    eventId?: string;
    amount?: number;
    currency?: string;
    destination?: string;
    applicationFeeAmount?: number | null;
    onBehalfOf?: string | null;
    name?: string;
    metadata?: Record<string, string>;
  } = {},
): string {
  const piId = `pi_c3_${suffix}`;
  return JSON.stringify({
    id: overrides.eventId ?? `evt_c3_${suffix}`,
    type: overrides.eventType ?? 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        status: overrides.status ?? 'succeeded',
        amount: overrides.amount ?? fixture.amountMinor,
        currency: overrides.currency ?? 'eur',
        metadata: {
          payment_type: 'AMENDMENT',
          amendment_payment_attempt_id: fixture.attemptId,
          amendment_id: fixture.amendmentId,
          organization_id: fixture.orgId,
          environment: 'TEST',
          protocol_version: 'booking-amendment-payment-v1',
          ...overrides.metadata,
        },
        transfer_data: { destination: overrides.destination ?? fixture.connectedAccountId },
        application_fee_amount: overrides.applicationFeeAmount ?? 250,
        on_behalf_of: overrides.onBehalfOf ?? fixture.connectedAccountId,
      },
    },
  });
}

async function sendWebhook(
  fixture: Fixture,
  suffix: string,
  overrides: Parameters<typeof makePayload>[2] = {},
  environment: 'TEST' | 'LIVE' = 'TEST',
  clock?: () => Date,
): Promise<Awaited<ReturnType<typeof handleWebhook>>> {
  if (!db) throw new Error('Database non initialisée');
  const adapter = new FakeStripeAdapter({
    platformWebhookSecret: PLATFORM_SECRET,
    connectWebhookSecret: 'whsec_c3_connect',
    environment: 'TEST',
  });
  const rawBody = makePayload(fixture, suffix, overrides);
  const input: WebhookHandlerInput = {
    rawBody,
    signature: adapter.generateValidSignature(rawBody, 'platform'),
    endpoint: 'platform',
    environment,
  };
  const deps: WebhookHandlerDeps = {
    db,
    provider: adapter,
    ...(clock === undefined ? {} : { clock }),
  };
  return handleWebhook(deps, input);
}

async function readState(fixture: Fixture) {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  const rows = await sql`
    SELECT
      ba.status AS amendment_status,
      ba.applied_at,
      ap.status AS payment_status,
      ap.succeeded_at,
      apa.status AS attempt_status,
      apa.provider_payment_intent_id,
      apa.provider_status
    FROM booking_amendments ba
    JOIN amendment_payments ap ON ap.amendment_id = ba.id
    JOIN amendment_payment_attempts apa ON apa.amendment_payment_id = ap.id
    WHERE ba.id = ${fixture.amendmentId}
  `;
  return rows[0]!;
}

async function readMaterial(fixture: Fixture) {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  const blocks = await sql`
    SELECT id, inventory_item_id, type, status, source_id,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at
    FROM inventory_blocks
    WHERE inventory_item_id = ANY(${fixture.itemIds}::uuid[])
      AND (source_id = ${fixture.bookingId} OR source_id = ${fixture.amendmentId})
    ORDER BY created_at, id
  `;
  const allocations = await sql`
    SELECT id, inventory_item_id, action, status, source_booking_block_id,
      applied_booking_block_id
    FROM booking_amendment_allocations
    WHERE amendment_id = ${fixture.amendmentId}
    ORDER BY created_at, id
  `;
  const segments = await sql`
    SELECT s.id, s.status, s.hold_block_id
    FROM booking_amendment_segments s
    JOIN booking_amendment_allocations a ON a.id = s.allocation_id
    WHERE a.amendment_id = ${fixture.amendmentId}
    ORDER BY s.created_at, s.id
  `;
  return { blocks, allocations, segments };
}

async function readOutbox(fixture: Fixture) {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  return sql`
    SELECT organization_id, aggregate_type, aggregate_id, event_type, event_version,
      payload, idempotency_key
    FROM outbox_events
    WHERE idempotency_key = ${'booking_amended_' + fixture.amendmentId}
  `;
}

async function readWebhookEvents(fixture: Fixture) {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  return sql`
    SELECT provider_event_id, status, failure_code, normalized_payload
    FROM payment_webhook_events
    WHERE organization_id = ${fixture.orgId}
    ORDER BY created_at, id
  `;
}

async function readWebhookEvent(providerEventId: string) {
  if (!sql) throw new Error('PostgreSQL non initialisé');
  return sql`
    SELECT organization_id, status, failure_code
    FROM payment_webhook_events
    WHERE provider_event_id = ${providerEventId}
  `;
}

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
  sql = postgres(testUrl, { max: 30 });
}, 600000);

afterAll(async () => {
  await db?.$client.end();
  await sql?.end();
  if (!sourceUrl || !testUrl) return;
  const admin = postgres(sourceUrl, { max: 1 });
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDatabase}' AND pid <> pg_backend_pid()`,
  );
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
  await admin.end();
});

describe.skipIf(shouldSkip)('G7M-C3 — application supplément PostgreSQL réel', () => {
  it('applique REPLACE nominalement, convertit le delta et publie BOOKING_AMENDED.v1', async () => {
    const fixture = await seedScenario({
      suffix: 'nominal',
      allocations: [
        {
          itemIndex: 0,
          action: 'REPLACE',
          segments: [
            { start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START },
            { start: BASE_BLOCKED_END, end: '2026-05-13T17:30:00.000Z' },
          ],
        },
      ],
      effectiveStart: '2026-05-09T09:00:00.000Z',
      effectiveEnd: '2026-05-13T17:00:00.000Z',
      effectiveBlockedStart: '2026-05-09T08:30:00.000Z',
      effectiveBlockedEnd: '2026-05-13T17:30:00.000Z',
    });
    const result = await sendWebhook(fixture, 'nominal');
    expect(result).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readState(fixture)).toMatchObject({
      amendment_status: 'APPLIED',
      payment_status: 'SUCCEEDED',
      attempt_status: 'SUCCEEDED',
      provider_payment_intent_id: 'pi_c3_nominal',
      provider_status: 'succeeded',
    });
    const state = await readState(fixture);
    expect(state.applied_at).toBeTruthy();
    expect(state.succeeded_at).toBeTruthy();
    const material = await readMaterial(fixture);
    expect(material.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_id: fixture.bookingId, status: 'RELEASED' }),
        expect.objectContaining({
          source_id: fixture.amendmentId,
          type: 'HOLD',
          status: 'CONVERTED',
        }),
        expect.objectContaining({
          source_id: fixture.bookingId,
          type: 'BOOKING',
          status: 'ACTIVE',
        }),
      ]),
    );
    expect(material.allocations).toHaveLength(1);
    expect(material.allocations[0]).toMatchObject({
      action: 'REPLACE',
      status: 'CONVERTED',
    });
    expect(material.allocations[0]!.applied_booking_block_id).toBeTruthy();
    expect(material.segments).toHaveLength(2);
    expect(material.segments.every((row) => row.status === 'CONVERTED')).toBe(true);
    const outbox = await readOutbox(fixture);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      organization_id: fixture.orgId,
      aggregate_type: 'BOOKING',
      aggregate_id: fixture.bookingId,
      event_type: 'BOOKING_AMENDED',
      event_version: 'v1',
      idempotency_key: `booking_amended_${fixture.amendmentId}`,
      payload: {
        organizationId: fixture.orgId,
        bookingId: fixture.bookingId,
        amendmentId: fixture.amendmentId,
      },
    });
    expect(JSON.stringify(outbox)).not.toContain('client_secret');
    const events = await readWebhookEvents(fixture);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'PROCESSED', provider_event_id: 'evt_c3_nominal' });

    const projection = await getEffectiveBooking(db!, fixture.orgId, fixture.bookingId);
    expect(projection.kind).toBe('FOUND');
    if (projection.kind !== 'FOUND') return;
    expect(projection.booking.effectiveTotalAmountMinor).toBe(15000);
    expect(projection.booking.effectiveCustomerStartAt.toISOString()).toBe(fixture.effectiveStart);
    expect(projection.booking.effectiveCustomerEndAt.toISOString()).toBe(fixture.effectiveEnd);
    expect(projection.booking.allocations).toHaveLength(1);
    expect(projection.booking.financials).toMatchObject({
      grossCollectedAmountMinor: 15000,
      contractualTotalAmountMinor: 15000,
      netCollectedAmountMinor: 15000,
      currency: 'EUR',
    });
  });

  it.each([
    ['reduction', 'REPLACE', 'RELEASED', true],
    ['add', 'ADD', 'ACTIVE', true],
    ['remove', 'REMOVE', 'RELEASED', false],
    ['retain', 'RETAIN', 'ACTIVE', false],
  ] as const)(
    '%s : applique les quantités et statuts de blocs attendus',
    async (_name, action, sourceStatus, createsNew) => {
      const fixture = await seedScenario({
        suffix: _name,
        allocations: [
          {
            itemIndex: action === 'ADD' ? 1 : 0,
            action,
            ...(action === 'ADD'
              ? { segments: [{ start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START }] }
              : {}),
          },
        ],
        ...(action === 'REPLACE'
          ? {
              effectiveStart: '2026-05-10T09:00:00.000Z',
              effectiveEnd: '2026-05-11T17:00:00.000Z',
              effectiveBlockedStart: '2026-05-10T08:30:00.000Z',
              effectiveBlockedEnd: '2026-05-11T17:30:00.000Z',
            }
          : {}),
      });
      const result = await sendWebhook(fixture, _name);
      expect(result).toEqual({ kind: 'SUCCESS', statusCode: 200 });
      const material = await readMaterial(fixture);
      const source = material.blocks.find((row) => row.id === fixture.sourceBlockIds[0]);
      expect(source?.status).toBe(sourceStatus);
      expect(material.allocations[0]).toMatchObject({
        action,
        status: action === 'REMOVE' ? 'RELEASED' : 'CONVERTED',
      });
      expect(material.segments.every((row) => row.status === 'CONVERTED')).toBe(true);
      const bookingBlocks = material.blocks.filter(
        (row) => row.type === 'BOOKING' && row.source_id === fixture.bookingId,
      );
      expect(bookingBlocks.length).toBe(createsNew ? 2 : 1);
      if (action === 'RETAIN') {
        expect(material.allocations[0]!.applied_booking_block_id).toBe(fixture.sourceBlockIds[0]);
      }
      if (action === 'REMOVE') {
        expect(material.allocations[0]!.applied_booking_block_id).toBeNull();
      }
    },
  );

  it('traite plusieurs allocations dans un ordre déterministe sans collision EXCLUDE', async () => {
    const fixture = await seedScenario({
      suffix: 'quantities',
      bookedItemCount: 2,
      allocations: [
        { itemIndex: 0, action: 'RETAIN' },
        { itemIndex: 1, action: 'REPLACE' },
      ],
    });
    await expect(sendWebhook(fixture, 'quantities')).resolves.toEqual({
      kind: 'SUCCESS',
      statusCode: 200,
    });
    const material = await readMaterial(fixture);
    expect(material.allocations).toHaveLength(2);
    expect(material.allocations.map((row) => row.inventory_item_id)).toEqual(
      expect.arrayContaining([fixture.itemIds[0], fixture.itemIds[1]]),
    );
    expect(
      material.blocks.filter((row) => row.type === 'BOOKING' && row.status === 'ACTIVE'),
    ).toHaveLength(2);
  });

  it('résout un webhook précoce par attempt ID et une Transaction B C2 tardive ne régresse rien', async () => {
    const fixture = await seedScenario({
      suffix: 'early',
      allocations: [{ itemIndex: 0, action: 'REPLACE' }],
    });
    if (!db || !sql) throw new Error('Database non initialisée');
    const database = db;
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: PLATFORM_SECRET,
      environment: 'TEST',
    });
    let earlyResult: Awaited<ReturnType<typeof handleWebhook>> | null = null;
    class LateTransactionBProvider extends FakeStripeAdapter {
      override async createPaymentIntent(
        params: CreatePaymentIntentParams,
      ): Promise<PaymentIntentResult> {
        const providerResult = await super.createPaymentIntent(params);
        const rawBody = makePayload(fixture, 'early', {
          status: 'succeeded',
          eventId: 'evt_c3_early',
        });
        earlyResult = await handleWebhook(
          { db: database, provider: adapter },
          {
            rawBody,
            signature: adapter.generateValidSignature(rawBody, 'platform'),
            endpoint: 'platform',
            environment: 'TEST',
          },
        );
        return providerResult;
      }
    }
    const provider = new LateTransactionBProvider({ environment: 'TEST' });
    const c2Result = await initiateSupplementPayment(
      db,
      provider,
      {
        organizationId: fixture.orgId,
        amendmentId: fixture.amendmentId,
        customerUserId: fixture.customerId,
        environment: 'TEST',
      },
      { now: new Date(Date.now()) },
    );
    expect(earlyResult).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(c2Result.kind).toBe('INVALID_STATE');
    expect(await readState(fixture)).toMatchObject({
      amendment_status: 'APPLIED',
      payment_status: 'SUCCEEDED',
      attempt_status: 'SUCCEEDED',
    });
  });

  it('déduplique le même event, deux events distincts et deux webhooks concurrents', async () => {
    const fixture = await seedScenario({
      suffix: 'dedupe',
      allocations: [{ itemIndex: 0, action: 'REPLACE' }],
    });
    const first = await sendWebhook(fixture, 'dedupe', { eventId: 'evt_c3_dedupe_1' });
    const replay = await sendWebhook(fixture, 'dedupe', { eventId: 'evt_c3_dedupe_1' });
    const distinct = await sendWebhook(fixture, 'dedupe', { eventId: 'evt_c3_dedupe_2' });
    const [concurrentA, concurrentB] = await Promise.all([
      sendWebhook(fixture, 'dedupe', { eventId: 'evt_c3_dedupe_3' }),
      sendWebhook(fixture, 'dedupe', { eventId: 'evt_c3_dedupe_4' }),
    ]);
    expect(first).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(replay).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(distinct).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(concurrentA).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(concurrentB).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readOutbox(fixture)).toHaveLength(1);
    expect(
      (await readMaterial(fixture)).blocks.filter((row) => row.type === 'BOOKING'),
    ).toHaveLength(2);
    expect(
      (await readWebhookEvents(fixture)).filter((row) => row.status === 'PROCESSED'),
    ).toHaveLength(4);
  });

  it('projette requires_action, processing, payment_failed et canceled sans régression terminale', async () => {
    const fixture = await seedScenario({
      suffix: 'states',
      allocations: [
        {
          itemIndex: 0,
          action: 'REPLACE',
          segments: [{ start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START }],
        },
      ],
    });
    expect(
      await sendWebhook(fixture, 'states', {
        eventId: 'evt_c3_states-action',
        eventType: 'payment_intent.requires_action',
        status: 'requires_action',
      }),
    ).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(
      await sendWebhook(fixture, 'states', {
        eventId: 'evt_c3_states-processing',
        eventType: 'payment_intent.processing',
        status: 'processing',
      }),
    ).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(
      await sendWebhook(fixture, 'states', {
        eventId: 'evt_c3_states-failed',
        eventType: 'payment_intent.payment_failed',
        status: 'requires_payment_method',
      }),
    ).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readState(fixture)).toMatchObject({
      amendment_status: 'HOLD_PENDING',
      payment_status: 'FAILED',
      attempt_status: 'FAILED',
    });
    expect(
      (await readMaterial(fixture)).blocks.some(
        (row) => row.type === 'HOLD' && row.status === 'ACTIVE',
      ),
    ).toBe(true);
    expect(
      await sendWebhook(fixture, 'states-disordered', {
        eventType: 'payment_intent.processing',
        status: 'processing',
      }),
    ).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readState(fixture)).toMatchObject({
      payment_status: 'FAILED',
      attempt_status: 'FAILED',
    });

    const canceled = await seedScenario({
      suffix: 'canceled',
      allocations: [
        {
          itemIndex: 0,
          action: 'REPLACE',
          segments: [{ start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START }],
        },
      ],
    });
    await sql!`
      UPDATE amendment_payments
      SET status = 'PROCESSING', processing_started_at = now(),
          processing_deadline_at = now() + interval '10 minutes'
      WHERE id = ${canceled.amendmentPaymentId}
    `;
    await sql!`
      UPDATE amendment_payment_attempts
      SET status = 'PROCESSING'
      WHERE id = ${canceled.attemptId}
    `;
    expect(
      await sendWebhook(canceled, 'canceled', {
        eventType: 'payment_intent.canceled',
        status: 'canceled',
      }),
    ).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readState(canceled)).toMatchObject({
      amendment_status: 'CANCELLED',
      payment_status: 'CANCELLED',
      attempt_status: 'CANCELLED',
    });
    expect(
      (await readMaterial(canceled)).blocks.some(
        (row) => row.type === 'HOLD' && row.status === 'ACTIVE',
      ),
    ).toBe(false);
  });

  it('projette un late success à holdDeadline exactement, sans application ni fuite d’identifiants', async () => {
    const fixedNow = new Date('2026-08-14T12:00:00.000Z');
    const fixture = await seedScenario({
      suffix: 'late',
      holdDeadline: fixedNow,
      allocations: [
        {
          itemIndex: 0,
          action: 'REPLACE',
          segments: [{ start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START }],
        },
      ],
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await sendWebhook(fixture, 'late', {}, 'TEST', () => fixedNow)).toEqual({
      kind: 'SUCCESS',
      statusCode: 200,
    });
    const warnings = warning.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    warning.mockRestore();
    expect(warnings).toContain('LATE_SUCCESS_REQUIRES_COMPENSATION');
    for (const identifier of [
      fixture.amendmentId,
      fixture.amendmentPaymentId,
      fixture.bookingId,
      fixture.orgId,
      fixture.customerId,
      fixture.attemptId,
      'pi_c3_late',
      'evt_c3_late',
    ]) {
      expect(warnings).not.toContain(identifier);
    }
    const state = await readState(fixture);
    expect(state).toMatchObject({
      amendment_status: 'HOLD_PENDING',
      payment_status: 'SUCCEEDED',
      attempt_status: 'SUCCEEDED',
      provider_payment_intent_id: 'pi_c3_late',
    });
    const material = await readMaterial(fixture);
    expect(
      material.blocks.filter((row) => row.type === 'BOOKING' && row.status === 'ACTIVE'),
    ).toHaveLength(1);
    expect(material.blocks.some((row) => row.type === 'HOLD' && row.status === 'ACTIVE')).toBe(
      true,
    );
    expect(await readOutbox(fixture)).toHaveLength(0);
  });

  it('rejette les mismatches de tenant, metadata, environnement, destination et finance sans mutation', async () => {
    const cases = [
      { name: 'organization', metadata: { organization_id: randomUUID() } },
      { name: 'amendment', metadata: { amendment_id: randomUUID() } },
      { name: 'attempt', metadata: { amendment_payment_attempt_id: randomUUID() } },
      { name: 'environment', metadata: { environment: 'LIVE' } },
      { name: 'amount', amount: 5001 },
      { name: 'currency', currency: 'USD' },
      { name: 'fee', applicationFeeAmount: 251 },
      { name: 'destination', destination: 'acct_other' },
      { name: 'on-behalf-of', onBehalfOf: 'acct_other' },
    ] as const;
    for (const testCase of cases) {
      const fixture = await seedScenario({
        suffix: `security-${testCase.name}`,
        allocations: [{ itemIndex: 0, action: 'REPLACE' }],
      });
      const before = await readMaterial(fixture);
      const { name: _caseName, ...override } = testCase;
      const result = await sendWebhook(fixture, `security-${testCase.name}`, override);
      expect(result).toEqual({ kind: 'SUCCESS', statusCode: 200 });
      expect(await readState(fixture)).toMatchObject({
        amendment_status: 'HOLD_PENDING',
        payment_status: 'PENDING_PROVIDER',
        attempt_status: 'PENDING_PROVIDER',
      });
      expect(await readMaterial(fixture)).toEqual(before);
      expect(await readOutbox(fixture)).toHaveLength(0);
      const eventRows = await readWebhookEvent(`evt_c3_security-${testCase.name}`);
      expect(eventRows).toHaveLength(1);
      if (testCase.name === 'attempt') {
        expect(eventRows[0]).toMatchObject({ organization_id: null, status: 'IGNORED' });
      } else {
        expect(eventRows[0]).toMatchObject({ organization_id: fixture.orgId, status: 'FAILED' });
      }
    }
  });

  it('rollbacke toutes les mutations si une outbox existante a un payload incompatible', async () => {
    const fixture = await seedScenario({
      suffix: 'rollback',
      allocations: [
        {
          itemIndex: 0,
          action: 'REPLACE',
          segments: [{ start: '2026-05-09T08:30:00.000Z', end: BASE_BLOCKED_START }],
        },
      ],
    });
    const before = await readMaterial(fixture);
    await sql!`
      INSERT INTO outbox_events (
        organization_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, status, available_at, idempotency_key
      ) VALUES (
        ${fixture.orgId}, 'BOOKING', ${fixture.bookingId}, 'BOOKING_AMENDED', 'v1',
        ${sql!.json({ incompatible: true })}, 'PENDING', now(),
        ${'booking_amended_' + fixture.amendmentId}
      )
    `;
    const result = await sendWebhook(fixture, 'rollback');
    expect(result).toEqual({ kind: 'SUCCESS', statusCode: 200 });
    expect(await readMaterial(fixture)).toEqual(before);
    expect(await readState(fixture)).toMatchObject({
      amendment_status: 'HOLD_PENDING',
      payment_status: 'PENDING_PROVIDER',
      attempt_status: 'PENDING_PROVIDER',
    });
    expect((await readOutbox(fixture)).map((row) => row.payload)).toEqual([{ incompatible: true }]);
    expect((await readWebhookEvents(fixture))[0]).toMatchObject({
      status: 'FAILED',
      failure_code: 'WEBHOOK_INVARIANT_BROKEN',
    });
  });
});
