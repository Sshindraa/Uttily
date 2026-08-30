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
import { createBookingDraftWithHold } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput as CreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { handleWebhook } from './handle-webhook';
import type { FinancialTermsConfig } from '../financial-terms/types';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

let orgId: string;
let locationId: string;
let userId: string;
let categoryId: string;
let productId: string;
let variantId: string;
let connectedAccountId: string;
let adapter: FakeStripeAdapter;
let seedCount = 0;

const STD_START = new Date('2026-10-01T09:00:00.000Z');
const STD_END = new Date('2026-10-03T17:00:00.000Z');

beforeAll(async () => {
  if (shouldSkipIntegrationTests()) return;
  context = await setupIntegrationTestDb('financial_integrity');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
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
  adapter = new FakeStripeAdapter({
    platformWebhookSecret: 'whsec_fake_platform',
    connectWebhookSecret: 'whsec_fake_connect',
    environment: 'TEST',
  });

  await db.execute(
    sql`TRUNCATE TABLE
      refunds,
      outbox_effects,
      outbox_events,
      booking_fulfillment_events,
      booking_items,
      booking_lines,
      bookings,
      payment_webhook_events,
      payment_attempts,
      payments,
      organization_payment_accounts,
      allocations,
      booking_draft_lines,
      booking_drafts,
      inventory_blocks,
      inventory_movements,
      inventory_items,
      product_variants,
      product_photos,
      products,
      categories,
      location_schedule_exceptions,
      location_opening_hours,
      locations,
      organization_invitations,
      organization_memberships,
      organizations,
      users,
      idempotency_records
      RESTART IDENTITY CASCADE`,
  );

  const orgRow = await rawSql`
    INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
    VALUES ('Financial Org', ${`org-fin-${suffix}`}, true, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  orgId = orgRow.id;

  const userRow = await rawSql`
    INSERT INTO users (email)
    VALUES (${`customer-fin-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  userId = userRow.id;

  const locRow = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgId}, 'Location Fin', ${`loc-fin-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  locationId = locRow.id;

  const catRow = await rawSql`
    INSERT INTO categories (name, slug)
    VALUES ('Vélos', ${`cat-fin-${suffix}`})
    RETURNING id
  `.then((r) => r[0]!);
  categoryId = catRow.id;

  const prodRow = await rawSql`
    INSERT INTO products (organization_id, category_id, name, slug, publication_status)
    VALUES (${orgId}, ${categoryId}, 'Vélo Cargo Pro', ${`cargo-${suffix}`}, 'DRAFT')
    RETURNING id
  `.then((r) => r[0]!);
  productId = prodRow.id;

  for (let pi = 0; pi < 3; pi++) {
    await rawSql`
      INSERT INTO product_photos (
        organization_id, product_id, storage_key,
        content_type, byte_size, width_px, height_px, checksum_sha256,
        sort_order, file_state
      )
      VALUES (
        ${orgId}, ${productId}, ${`product-photos/${suffix}-${pi}`},
        'image/jpeg', 102400, 800, 600, ${('000' + pi).repeat(16).slice(0, 64)},
        ${pi}, 'AVAILABLE'
      )
    `;
  }
  await rawSql`UPDATE products SET publication_status = 'PUBLISHED' WHERE id = ${productId}`;

  const varRow = await rawSql`
    INSERT INTO product_variants (product_id, name, is_active, daily_price_amount_minor, currency)
    VALUES (${productId}, 'Cargo Standard', true, 5000, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  variantId = varRow.id;

  await rawSql`
    INSERT INTO inventory_items (organization_id, product_variant_id, current_location_id, internal_sku, status)
    VALUES (${orgId}, ${variantId}, ${locationId}, ${`SKU-FIN-${suffix}`}, 'ACTIVE')
  `;

  connectedAccountId = `acct_test_${suffix}`;
  await rawSql`
    INSERT INTO organization_payment_accounts (
      organization_id, provider, environment, provider_account_id,
      account_api_generation, onboarding_status, charges_enabled, payouts_enabled,
      transfers_capability_status, settlement_merchant_mode,
      controller_configuration_snapshot, requirements_snapshot
    ) VALUES (
      ${orgId}, 'STRIPE', 'TEST', ${connectedAccountId},
      'ACCOUNTS_V2', 'ENABLED', true, true,
      'ACTIVE', 'PLATFORM',
      ${rawSql.json({ preset: 'CUSTOM' })}, ${rawSql.json({})}
    )
  `;
});

function makeFinancialTermsConfig(accId: string): FinancialTermsConfig {
  return {
    tax: {
      version: 'v1',
      status: 'NOT_APPLICABLE',
      amountMinor: null,
      rateBps: null,
      invoiceIssuer: 'Uttily',
    },
    commission: {
      version: 'v1',
      basis: 'percentage',
      amountMinor: 260,
    },
    connectedAccount: {
      accountId: accId,
      chargesEnabled: true,
      transfersCapabilityStatus: 'ACTIVE',
      settlementMerchantMode: 'PLATFORM',
      onBehalfOfAccountId: null,
    },
    legalTermsVersion: 'v1',
  };
}

async function createHeldDraft(keySuffix: string): Promise<string> {
  const input: CreateBookingDraftInput = {
    pricingMode: 'LEGACY',
    organizationId: orgId,
    locationId: locationId,
    customerUserId: userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId, quantity: 1 }],
    idempotencyKey: 'held-' + keySuffix,
  };
  const result = await createBookingDraftWithHold(db!, input);
  if (result.kind !== 'SUCCESS') throw new Error('Failed to create held draft');
  return result.body.draftId;
}

async function getPaymentAmount(draftId: string): Promise<number> {
  const row = await rawSql!`SELECT amount_minor FROM payments WHERE draft_id = ${draftId}`.then(
    (r) => r[0],
  );
  return Number(row!.amount_minor);
}

describe.skipIf(shouldSkipIntegrationTests())(
  '19-B — Payment & Financial Integrity Integration',
  () => {
    describe('Idempotence et Concurrence des Webhooks Stripe', () => {
      it('traite deux webhooks payment_intent.succeeded concurrents avec exact-once business transition', async () => {
        // 1. Créer draft
        const draftId = await createHeldDraft(`race-${randomUUID()}`);

        // 2. Initier paiement
        const initRes = await initiatePayment(
          { db: db!, provider: adapter },
          {
            draftId,
            idempotencyKey: randomUUID(),
            organizationId: orgId,
            customerUserId: userId,
            environment: 'TEST',
            financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
            termsAcceptance: {
              termsVersion: 'v1',
              userId,
              acceptedAt: new Date().toISOString(),
            },
          },
        );
        expect(initRes.kind).toBe('SUCCESS');
        if (initRes.kind !== 'SUCCESS') throw new Error('Init failed');

        const attemptId = initRes.paymentAttemptId;
        const providerPaymentIntentId = initRes.providerPaymentIntentId;
        const amount = await getPaymentAmount(draftId);
        const feeRow = await rawSql!`
          SELECT marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor' AS application_fee_amount
          FROM payments
          WHERE id = ${initRes.paymentId}
        `;
        const applicationFeeAmount = Number(feeRow[0]!.application_fee_amount);

        // Simuler l'événement Stripe payment_intent.succeeded avec métadonnées conformes
        const eventId = `evt_test_race_${randomUUID()}`;
        const payload = {
          id: eventId,
          type: 'payment_intent.succeeded',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: providerPaymentIntentId,
              object: 'payment_intent',
              status: 'succeeded',
              amount,
              currency: 'eur',
              metadata: {
                payment_id: initRes.paymentId,
                payment_attempt_id: attemptId,
                draft_id: draftId,
                organization_id: orgId,
                protocol_version: 'v1',
              },
              transfer_data: { destination: connectedAccountId },
              application_fee_amount: applicationFeeAmount,
              on_behalf_of: null,
            },
          },
        };

        const rawBody = JSON.stringify(payload);
        const signature = adapter.generateValidSignature(rawBody, 'platform');

        // 3. Exécuter 2 webhooks STRICTEMENT concurrents
        const [res1, res2] = await Promise.all([
          handleWebhook(
            { db: db!, provider: adapter },
            { rawBody, signature, endpoint: 'platform', environment: 'TEST' },
          ),
          handleWebhook(
            { db: db!, provider: adapter },
            { rawBody, signature, endpoint: 'platform', environment: 'TEST' },
          ),
        ]);

        expect(res1.kind).toBe('SUCCESS');
        expect(res2.kind).toBe('SUCCESS');

        // 4. Vérifier en base : EXACTEMENT 1 réservation, 1 paiement SUCCEEDED, 1 outbox
        const bookingRows = await rawSql!`SELECT * FROM bookings WHERE draft_id = ${draftId}`;
        expect(bookingRows.length).toBe(1);
        expect(bookingRows[0]!.status).toBe('CONFIRMED');

        const paymentRows = await rawSql!`SELECT * FROM payments WHERE draft_id = ${draftId}`;
        expect(paymentRows.length).toBe(1);
        expect(paymentRows[0]!.status).toBe('SUCCEEDED');

        const outboxRows =
          await rawSql!`SELECT * FROM outbox_events WHERE aggregate_id = ${bookingRows[0]!.id}`;
        expect(outboxRows.length).toBe(1);
      });

      it('rejette fail-closed un croisement silencieux d’environnement (TEST webhook sur LIVE payment)', async () => {
        // 1. Créer draft
        const draftId = await createHeldDraft(`env-cross-${randomUUID()}`);

        // 2. Initier paiement en TEST
        const initRes = await initiatePayment(
          { db: db!, provider: adapter },
          {
            draftId,
            idempotencyKey: randomUUID(),
            organizationId: orgId,
            customerUserId: userId,
            environment: 'TEST',
            financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
            termsAcceptance: {
              termsVersion: 'v1',
              userId,
              acceptedAt: new Date().toISOString(),
            },
          },
        );
        expect(initRes.kind).toBe('SUCCESS');
        if (initRes.kind !== 'SUCCESS') throw new Error('Init failed');

        const amount = await getPaymentAmount(draftId);
        const feeRow = await rawSql!`
          SELECT marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor' AS application_fee_amount
          FROM payments
          WHERE id = ${initRes.paymentId}
        `;
        const applicationFeeAmount = Number(feeRow[0]!.application_fee_amount);

        // 3. Envoyer un webhook reçu sur endpoint LIVE avec environnement LIVE
        const eventId = `evt_live_cross_${randomUUID()}`;
        const payload = {
          id: eventId,
          type: 'payment_intent.succeeded',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: initRes.providerPaymentIntentId,
              object: 'payment_intent',
              status: 'succeeded',
              amount,
              currency: 'eur',
              metadata: {
                payment_id: initRes.paymentId,
                payment_attempt_id: initRes.paymentAttemptId,
                draft_id: draftId,
                organization_id: orgId,
                protocol_version: 'v1',
              },
              transfer_data: { destination: connectedAccountId },
              application_fee_amount: applicationFeeAmount,
              on_behalf_of: null,
            },
          },
        };

        const rawBody = JSON.stringify(payload);
        const signature = adapter.generateValidSignature(rawBody, 'platform');

        // Adapter configuré en TEST rejette fail-closed une exécution avec input environment LIVE
        await expect(
          handleWebhook(
            { db: db!, provider: adapter },
            { rawBody, signature, endpoint: 'platform', environment: 'LIVE' },
          ),
        ).rejects.toThrow();

        // Le paiement ne doit PAS avoir basculé en SUCCEEDED
        const paymentRows = await rawSql!`SELECT status FROM payments WHERE draft_id = ${draftId}`;
        expect(paymentRows[0]!.status).not.toBe('SUCCEEDED');
      });
    });

    describe('Concurrence d’Initiation de Paiement & Idempotence', () => {
      it('renvoie le même payment_attempt pour des initiations concurrentes avec même clé', async () => {
        const draftId = await createHeldDraft(`init-race-${randomUUID()}`);

        const key = randomUUID();
        const [res1, res2] = await Promise.all([
          initiatePayment(
            { db: db!, provider: adapter },
            {
              draftId,
              idempotencyKey: key,
              organizationId: orgId,
              customerUserId: userId,
              environment: 'TEST',
              financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
              termsAcceptance: {
                termsVersion: 'v1',
                userId,
                acceptedAt: new Date().toISOString(),
              },
            },
          ),
          initiatePayment(
            { db: db!, provider: adapter },
            {
              draftId,
              idempotencyKey: key,
              organizationId: orgId,
              customerUserId: userId,
              environment: 'TEST',
              financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
              termsAcceptance: {
                termsVersion: 'v1',
                userId,
                acceptedAt: new Date().toISOString(),
              },
            },
          ),
        ]);

        expect(['SUCCESS', 'REPLAY']).toContain(res1.kind);
        expect(['SUCCESS', 'REPLAY']).toContain(res2.kind);
        if (res1.kind === 'FAILURE' || res2.kind === 'FAILURE') {
          throw new Error('Concurrent initiation failed');
        }

        expect(res1.paymentId).toBe(res2.paymentId);
        expect(res1.paymentAttemptId).toBe(res2.paymentAttemptId);

        const count =
          await rawSql!`SELECT count(*) FROM payment_attempts WHERE payment_id = ${res1.paymentId}`;
        expect(Number(count[0]!.count)).toBe(1);
      });
    });

    describe('Sécurité & Non-Divulgation des Secrets', () => {
      it('ne divulgue aucun secret Stripe ni payload brut dans les réponses', async () => {
        const draftId = await createHeldDraft(`sec-${randomUUID()}`);

        const initRes = await initiatePayment(
          { db: db!, provider: adapter },
          {
            draftId,
            idempotencyKey: randomUUID(),
            organizationId: orgId,
            customerUserId: userId,
            environment: 'TEST',
            financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
            termsAcceptance: {
              termsVersion: 'v1',
              userId,
              acceptedAt: new Date().toISOString(),
            },
          },
        );

        const serialized = JSON.stringify(initRes);
        expect(serialized).not.toContain('sk_test');
        expect(serialized).not.toContain('whsec_');
        expect(serialized).not.toContain('postgresql://');
      });
    });
  },
);
