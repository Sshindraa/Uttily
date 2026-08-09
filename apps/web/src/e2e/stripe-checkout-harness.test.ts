import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  runMigrations,
  assertLocalhost,
  type DatabaseClient,
} from '@uttily/database';
import {
  createBookingDraftWithHold,
  createConnectedAccount,
  initiatePayment,
  handleWebhook,
  FakeStripeAdapter,
  type CreateBookingDraftInput,
  type InitiatePaymentInput,
  type InitiatePaymentDependencies,
  type WebhookHandlerDeps,
  type WebhookHandlerInput,
  type FinancialTermsConfig,
  type TermsAcceptanceProof,
} from '@uttily/core';

/**
 * Harness fake contractuel déterministe pour le flux checkout Stripe.
 *
 * Ce harness valide le contrat entre les composants du flux de paiement
 * SANS appeler l'API Stripe réelle. Il utilise le FakeStripeAdapter et
 * une DB de test PostgreSQL pour simuler le flux complet :
 *
 * 1. Création d'un compte connecté (onboarding)
 * 2. Création d'un brouillon HELD
 * 3. Initiation du paiement (clientSecret obtenu)
 * 4. Simulation de la confirmation webhook (payment_intent.succeeded)
 * 5. Vérification de la réservation créée
 *
 * Ce harness ne remplace pas un test E2E avec Stripe sandbox réelle,
 * mais il valide que tous les composants s'intègrent correctement.
 *
 * Pour un test E2E avec Stripe sandbox réelle, voir
 * docs/implementation/stripe-test-setup.md (test manuel).
 *
 * Exécution :
 *   DATABASE_URL=postgresql://uttily:uttily@localhost:5432/uttuly \
 *   pnpm --filter @uttily/web test src/e2e/stripe-checkout-harness.test.ts
 */

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttuly_test_e2e_harness';

process.env.STRIPE_ENVIRONMENT = 'TEST';

function shouldSkipIntegrationTests(): boolean {
  if (isCi) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;
let adminUrl: string | null = null;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isCi) throw new Error('CI: DATABASE_URL est requise pour le harness E2E.');
    return;
  }

  const adminSql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await adminSql`SELECT 1`;
  } catch {
    await adminSql.end();
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);
  adminUrl = url;

  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  const testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
  db = createDatabase(testUrl);
  rawSql = postgres(testUrl, { max: 5 });
});

afterAll(async () => {
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (adminUrl) {
    const cleanupSql = postgres(adminUrl, { max: 1 });
    try {
      await cleanupSql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
      );
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    } finally {
      await cleanupSql.end();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers (réplique du pattern des tests d'intégration core).
// ─────────────────────────────────────────────────────────────────────────────

interface BaseIds {
  orgId: string;
  locationId: string;
  customerUserId: string;
  variantId: string;
}

const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

async function seedBaseData(suffix: string): Promise<BaseIds> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Harness Org ' + suffix}, ${'harness-org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const customer = await sql`
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
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i];
    if (cond === undefined) continue;
    await sql`
      INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id", "condition", "status")
      VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix + '-' + i}, ${location.id}, ${cond}, 'ACTIVE')
    `;
  }
  return {
    orgId: org.id,
    locationId: location.id,
    customerUserId: customer.id,
    variantId: variant.id,
  };
}

function makeFinancialTermsConfig(connectedAccountId: string): FinancialTermsConfig {
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
      amountMinor: 500, // 5 EUR sur 100 EUR
    },
    connectedAccount: {
      accountId: connectedAccountId,
      chargesEnabled: true,
      transfersCapabilityStatus: 'ACTIVE',
      settlementMerchantMode: 'PLATFORM',
      onBehalfOfAccountId: null,
    },
    legalTermsVersion: 'v1',
  };
}

function makeTermsAcceptance(userId: string): TermsAcceptanceProof {
  return {
    termsVersion: 'v1',
    userId,
    acceptedAt: new Date().toISOString(),
  };
}

function makeWebhookPayload(
  type: string,
  piId: string,
  amount: number,
  metadata: Record<string, string>,
  connectedAccountId: string,
  eventId: string,
): string {
  return JSON.stringify({
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        status: 'succeeded',
        amount,
        currency: 'eur',
        metadata,
        transfer_data: { destination: connectedAccountId },
        application_fee_amount: 500,
        on_behalf_of: null,
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness — flux checkout complet (fake contractuel).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'Harness E2E fake contractuel — flux checkout Stripe',
  () => {
    it('valide le contrat complet : onboarding → hold → paiement → webhook → réservation', async () => {
      if (!db || !rawSql) return;
      const sql = rawSql;
      const suffix = 'harness1';

      // ── Setup : données de base ──────────────────────────────────────────
      const ids = await seedBaseData(suffix);

      // ── Étape préalable : compte connecté via FakeStripeAdapter ──────────
      // Un seul adapter partagé entre l'initiation et le webhook afin que le
      // PaymentIntent créé soit connu du fake lors de la signature webhook.
      const adapter = new FakeStripeAdapter({
        environment: 'TEST',
        platformWebhookSecret: 'whsec_fake_platform',
        connectWebhookSecret: 'whsec_fake_connect',
      });

      const accountResult = await createConnectedAccount(
        { db, provider: adapter },
        {
          organizationId: ids.orgId,
          environment: 'TEST',
          country: 'FR',
          idempotencyKey: 'harness-ca-1',
        },
      );
      expect(accountResult.providerAccountId).toMatch(/^acct_/);

      // Simule la fin de l'onboarding (webhook account.updated reçu) : le
      // compte passe à ENABLED / chargesEnabled / transfers ACTIVE.
      await sql`
        UPDATE "organization_payment_accounts"
        SET "onboarding_status" = 'ENABLED',
            "charges_enabled" = true,
            "payouts_enabled" = true,
            "transfers_capability_status" = 'ACTIVE',
            "updated_at" = now()
        WHERE "organization_id" = ${ids.orgId}
          AND "provider" = 'STRIPE'
          AND "environment" = 'TEST'
      `;

      // ── Étape 1 : créer un brouillon HELD ────────────────────────────────
      const draftInput: CreateBookingDraftInput = {
        organizationId: ids.orgId,
        locationId: ids.locationId,
        customerUserId: ids.customerUserId,
        customerStartAt: STD_START,
        customerEndAt: STD_END,
        lines: [{ variantId: ids.variantId, quantity: 1 }],
        idempotencyKey: 'harness-held-1',
      };
      const draftResult = await createBookingDraftWithHold(db, draftInput);
      expect(draftResult.kind).toBe('SUCCESS');
      if (draftResult.kind !== 'SUCCESS') return;
      const draftId = draftResult.body.draftId;
      expect(draftResult.body.status).toBe('HELD');

      // ── Étape 2 : initier le paiement ────────────────────────────────────
      const initDeps: InitiatePaymentDependencies = { db, provider: adapter };
      const initInput: InitiatePaymentInput = {
        draftId,
        idempotencyKey: 'harness-init-1',
        organizationId: ids.orgId,
        customerUserId: ids.customerUserId,
        environment: 'TEST',
        financialTermsConfig: makeFinancialTermsConfig(accountResult.providerAccountId),
        termsAcceptance: makeTermsAcceptance(ids.customerUserId),
      };
      const initResult = await initiatePayment(initDeps, initInput);
      expect(initResult.kind).toBe('SUCCESS');
      if (initResult.kind !== 'SUCCESS') return;

      // ── Étape 3 : le clientSecret est obtenu et non persisté ─────────────
      expect(initResult.clientSecret).toMatch(/_secret_/);
      expect(initResult.providerPaymentIntentId).toMatch(/^pi_/);

      // Vérifie qu'aucun client_secret n'est persisté en DB.
      const secretLeak = await sql`
        SELECT "id" FROM "payments" WHERE "draft_id" = ${draftId}
      `.then((r) => r[0]);
      expect(secretLeak).toBeDefined();
      // Le client_secret n'a pas de colonne dédiée — il ne doit apparaître
      // dans aucune colonne textuelle de payments ou payment_attempts.
      const paymentSecretScan = await sql`
        SELECT "id" FROM "payments"
        WHERE "draft_id" = ${draftId}
          AND (CAST("id" AS text) LIKE '%_secret_%')
      `;
      expect(paymentSecretScan.length).toBe(0);

      const piId = initResult.providerPaymentIntentId;
      const paymentId = (
        await sql`SELECT "id" FROM "payments" WHERE "draft_id" = ${draftId}`.then((r) => r[0]!)
      ).id;
      const amount = Number(
        (
          await sql`SELECT "amount_minor" FROM "payments" WHERE "id" = ${paymentId}`.then(
            (r) => r[0]!,
          )
        ).amount_minor,
      );

      // ── Étape 4 : simuler le webhook payment_intent.succeeded ─────────────
      const webhookDeps: WebhookHandlerDeps = { db, provider: adapter };
      const body = makeWebhookPayload(
        'payment_intent.succeeded',
        piId,
        amount,
        {
          payment_id: paymentId,
          payment_attempt_id: initResult.paymentAttemptId,
          draft_id: draftId,
          organization_id: ids.orgId,
          protocol_version: 'v1',
        },
        accountResult.providerAccountId,
        'evt_harness_succeeded_1',
      );
      const signature = adapter.generateValidSignature(body, 'platform');
      const webhookInput: WebhookHandlerInput = {
        rawBody: body,
        signature,
        endpoint: 'platform',
        environment: 'TEST',
      };
      const webhookResult = await handleWebhook(webhookDeps, webhookInput);
      expect(webhookResult.kind).toBe('SUCCESS');
      if (webhookResult.kind !== 'SUCCESS') return;
      expect(webhookResult.statusCode).toBe(200);

      // ── Étape 5 : vérifier la réservation créée, le hold converti, l'outbox ─
      const booking = await sql`
        SELECT "id", "status", "draft_id", "payment_id" FROM "bookings" WHERE "draft_id" = ${draftId}
      `.then((r) => r[0]);
      expect(booking).toBeDefined();
      expect(booking!.status).toBe('CONFIRMED');
      expect(booking!.payment_id).toBe(paymentId);

      // Le brouillon est CONVERTED.
      const draft = await sql`SELECT "status" FROM "booking_drafts" WHERE "id" = ${draftId}`.then(
        (r) => r[0],
      );
      expect(draft!.status).toBe('CONVERTED');

      // Le paiement est SUCCEEDED.
      const payment = await sql`
        SELECT "status", "succeeded_at" FROM "payments" WHERE "id" = ${paymentId}
      `.then((r) => r[0]);
      expect(payment!.status).toBe('SUCCEEDED');
      expect(payment!.succeeded_at).not.toBeNull();

      // Les holds sont CONVERTED.
      const blocks = await sql`
        SELECT "status", "type" FROM "inventory_blocks" WHERE "source_id" = ${draftId} AND "type" = 'HOLD'
      `;
      expect(blocks.length).toBe(1);
      expect(blocks[0]!.status).toBe('CONVERTED');

      // L'outbox contient un événement de confirmation de réservation.
      const outbox = await sql`
        SELECT "id", "event_type", "status" FROM "outbox_events" WHERE "aggregate_id" = ${booking!.id}
      `;
      expect(outbox.length).toBeGreaterThanOrEqual(1);
    });
  },
);
