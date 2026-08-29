import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { createDatabase, runMigrations, assertLocalhost } from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import { createBookingDraftWithHold, initiatePayment } from '@uttily/core';
import type {
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  LegacyCreateBookingDraftInput,
  InitiatePaymentInput,
  InitiatePaymentDependencies,
  FinancialTermsConfig,
  TermsAcceptanceProof,
  PaymentProviderAdapter,
  PaymentIntentResult,
  PaymentIntentStatus,
  StripeEnvironment,
  CreatePaymentIntentParams,
  CancelPaymentIntentParams,
  CreateRefundParams,
  RefundResult,
  RefundStatus,
  VerifyWebhookParams,
  WebhookVerification,
  CreateConnectedAccountParams,
  ConnectedAccountResult,
  CreateOnboardingLinkParams,
  OnboardingLinkResult,
  AccountCapabilities,
} from '@uttily/core';
import { PaymentProviderError } from '@uttily/core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : getDb + getStripeAdapter.
// ---------------------------------------------------------------------------

let testDb: DatabaseClient | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

let testProvider: PaymentProviderAdapter | null = null;

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => {
    if (!testProvider) {
      throw new Error('getStripeAdapter: testProvider non initialisé');
    }
    return testProvider;
  },
}));

const { GET } = await import('./route');

// ---------------------------------------------------------------------------
// Provider fake minimal pour les tests (FakeStripeAdapter n'est pas exporté
// depuis @uttily/core). Implémente PaymentProviderAdapter avec un store
// en mémoire des PaymentIntents et Refunds.
// ---------------------------------------------------------------------------

interface StoredIntent {
  id: string;
  status: PaymentIntentStatus;
  latestChargeId: string | null;
  amountMinor: number;
  currency: string;
  connectedAccountId: string;
  applicationFeeAmountMinor: number | null;
  onBehalfOfAccountId: string | null;
  environment: StripeEnvironment;
}

interface StoredRefund {
  id: string;
  status: RefundStatus;
  amountMinor: number;
  currency: string;
}

class TestStripeProvider implements PaymentProviderAdapter {
  readonly environment: StripeEnvironment;
  private readonly intents = new Map<string, StoredIntent>();
  private readonly refunds = new Map<string, StoredRefund>();
  /** Si non-null, createRefund lève cette erreur. */
  forceCreateRefundError: Error | null = null;

  constructor(environment: StripeEnvironment = 'TEST') {
    this.environment = environment;
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    const id = `pi_test_${createHash('sha256').update(params.idempotencyKey).digest('hex').slice(0, 16)}`;
    const intent: StoredIntent = {
      id,
      status: 'processing',
      latestChargeId: null,
      amountMinor: params.amountMinor,
      currency: params.currency,
      connectedAccountId: params.connectedAccountId,
      applicationFeeAmountMinor: params.applicationFeeAmountMinor,
      onBehalfOfAccountId: params.onBehalfOfAccountId,
      environment: this.environment,
    };
    this.intents.set(id, intent);
    return { ...intent, clientSecret: `${id}_secret` };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentResult> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`PaymentIntent non trouvé : ${id}`);
    return { ...intent, clientSecret: null };
  }

  async cancelPaymentIntent(params: CancelPaymentIntentParams): Promise<PaymentIntentResult> {
    const intent = this.intents.get(params.id);
    if (!intent) throw new Error(`PaymentIntent non trouvé : ${params.id}`);
    intent.status = 'canceled';
    return { ...intent, clientSecret: null };
  }

  async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    if (this.forceCreateRefundError) {
      throw this.forceCreateRefundError;
    }
    const intent = this.intents.get(params.paymentIntentId);
    if (!intent) throw new Error(`PaymentIntent non trouvé : ${params.paymentIntentId}`);
    const id = `re_${createHash('sha256').update(params.idempotencyKey).digest('hex').slice(0, 16)}`;
    const refund: StoredRefund = {
      id,
      status: 'pending',
      amountMinor: params.amountMinor,
      currency: intent.currency,
    };
    this.refunds.set(id, refund);
    return refund;
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    const refund = this.refunds.get(id);
    if (!refund) throw new Error(`Refund non trouvé : ${id}`);
    return refund;
  }

  /** Simule un changement de statut d'un PaymentIntent stocké. */
  simulateStatus(id: string, status: PaymentIntentStatus): void {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`PaymentIntent non trouvé : ${id}`);
    intent.status = status;
    if (status === 'succeeded') {
      intent.latestChargeId = `ch_${id}`;
    }
  }

  async verifyWebhook(_params: VerifyWebhookParams): Promise<WebhookVerification> {
    throw new Error('not implemented');
  }
  async createConnectedAccount(
    _params: CreateConnectedAccountParams,
  ): Promise<ConnectedAccountResult> {
    throw new Error('not implemented');
  }
  async retrieveConnectedAccount(_id: string): Promise<ConnectedAccountResult> {
    throw new Error('not implemented');
  }
  async createOnboardingLink(_params: CreateOnboardingLinkParams): Promise<OnboardingLinkResult> {
    throw new Error('not implemented');
  }
  async createAccountSession(_params: {
    accountId: string;
  }): Promise<{ clientSecret: string; expiresAt: number }> {
    throw new Error('not implemented');
  }
  async projectCapabilities(_accountId: string): Promise<AccountCapabilities> {
    throw new Error('not implemented');
  }
}

// ---------------------------------------------------------------------------
// Setup base de test (réplique minimale de setupIntegrationTestDb).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttily_test_cron_compensation';

function shouldSkipIntegrationTests(): boolean {
  if (isCi) return false;
  if (!process.env.DATABASE_URL) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

let adminUrl: string | null = null;
let testUrl: string | null = null;
let adminSql: ReturnType<typeof postgres> | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

const CRON_SECRET = 'test-cron-secret-for-vitest';

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.STRIPE_ENVIRONMENT = 'TEST';

  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isCi) throw new Error("CI: DATABASE_URL est requise pour les tests d'action.");
    return;
  }

  adminSql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await adminSql`SELECT 1`;
  } catch {
    await adminSql.end();
    adminSql = null;
    if (isCi) throw new Error('CI: base PostgreSQL non joignable.');
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
    adminSql = null;
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);

  testDb = createDatabase(testUrl);
  rawSql = postgres(testUrl, { max: 5 });
});

afterAll(async () => {
  delete process.env.CRON_SECRET;
  delete process.env.STRIPE_ENVIRONMENT;

  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (testDb) {
    await testDb.$client.end();
    testDb = null;
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

beforeEach(async () => {
  if (!testDb) return;
  await testDb.execute(
    sql`TRUNCATE TABLE
      refunds, outbox_events, booking_items, booking_lines, bookings,
      payment_webhook_events, payment_attempts, payments, organization_payment_accounts,
      allocations, booking_draft_lines, booking_drafts, inventory_blocks,
      inventory_movements, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships, organizations,
      users, idempotency_records
      RESTART IDENTITY CASCADE`,
  );
  testProvider = new TestStripeProvider('TEST');
});

// ---------------------------------------------------------------------------
// Helpers de test.
// ---------------------------------------------------------------------------

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
  const s = rawSql;
  const org = await s`
    INSERT INTO "organizations" ("legal_name", "slug", "default_cancellation_policy_code")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, 'FLEXIBLE')
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await s`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 30, 30, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await s`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await s`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await s`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug", "publication_status")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix}, 'DRAFT')
    RETURNING "id"
  `.then((r) => r[0]!);
  // G7F-A2 : 3 photos valides requises pour la publication (trigger différé).
  for (let _pi = 0; _pi < 3; _pi++) {
    await s`
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
  await s`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${product.id}`;
  const variant = await s`
    INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', true, 5000, 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const conditions = ['NEW', 'GOOD', 'FAIR'] as const;
  const itemIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cond = conditions[i]!;
    const item = await s`
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

const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

function makeInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
    pricingMode: 'LEGACY',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'key-' + SUFFIX(),
    ...overrides,
  };
}

function expectSuccess(
  result: CreateBookingDraftResult,
): asserts result is CreateBookingDraftSuccess {
  expect(result.kind).toBe('SUCCESS');
  if (result.kind !== 'SUCCESS') throw new Error('Résultat SUCCESS attendu.');
}

function makeFinancialTermsConfig(connectedAccountId = 'acct_test_123'): FinancialTermsConfig {
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

function makeInitiateInput(
  ids: BaseIds,
  draftId: string,
  keySuffix: string,
  overrides: Partial<InitiatePaymentInput> = {},
): InitiatePaymentInput {
  return {
    draftId,
    idempotencyKey: 'init-' + keySuffix,
    organizationId: ids.orgId,
    customerUserId: ids.userId,
    environment: 'TEST',
    financialTermsConfig: makeFinancialTermsConfig(),
    termsAcceptance: makeTermsAcceptance(ids.userId),
    ...overrides,
  };
}

async function createHeldDraft(ids: BaseIds, keySuffix: string): Promise<string> {
  if (!testDb) throw new Error('testDb not initialized');
  const result = await createBookingDraftWithHold(
    testDb,
    makeInput(ids, {
      idempotencyKey: 'held-' + keySuffix,
    }),
  );
  expectSuccess(result);
  return result.body.draftId;
}

/**
 * Crée un paiement SUCCEEDED + refund PENDING + outbox PAYMENT_COMPENSATION_REQUESTED
 * en utilisant le flux réel (initiatePayment + seed direct).
 */
async function seedCompensationData(
  ids: BaseIds,
  keySuffix: string,
): Promise<{
  paymentId: string;
  attemptId: string;
  refundId: string;
  outboxEventId: string;
  providerPaymentIntentId: string;
}> {
  if (!testDb || !rawSql) throw new Error('not initialized');
  if (!testProvider) throw new Error('testProvider not initialized');

  // Crée le compte de paiement.
  await rawSql`
    INSERT INTO "organization_payment_accounts" (
      "organization_id", "provider", "environment", "provider_account_id",
      "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
      "transfers_capability_status", "settlement_merchant_mode",
      "controller_configuration_snapshot", "requirements_snapshot"
    ) VALUES (
      ${ids.orgId}, 'STRIPE', 'TEST', 'acct_test_123',
      'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true,
      'ACTIVE', 'PLATFORM',
      ${rawSql.json({ preset: 'CUSTOM' })}, ${rawSql.json({})}
    )
  `;

  // Crée le brouillon HELD.
  const draftId = await createHeldDraft(ids, keySuffix);

  // Initie le paiement.
  const initDeps: InitiatePaymentDependencies = {
    db: testDb,
    provider: testProvider,
  };
  const initResult = await initiatePayment(initDeps, makeInitiateInput(ids, draftId, keySuffix));
  expect(initResult.kind).toBe('SUCCESS');
  if (initResult.kind !== 'SUCCESS') throw new Error('initiatePayment failed');
  const providerPaymentIntentId = initResult.providerPaymentIntentId;

  // Récupérer les IDs et le montant réel du paiement (P1-4 : le refund est
  // recoupé contre le total du paiement — le seed doit être cohérent).
  const paymentRow =
    await rawSql`SELECT id, amount_minor FROM payments WHERE draft_id = ${draftId}`;
  const paymentId = paymentRow[0]!.id;
  const paymentAmountMinor = Number(paymentRow[0]!.amount_minor);
  const attemptRow = await rawSql`SELECT id FROM payment_attempts WHERE payment_id = ${paymentId}`;
  const attemptId = attemptRow[0]!.id;

  // Ce scénario couvre le worker de remboursement historique : le paiement
  // legacy n'a pas de snapshot split, politique actuellement bloquée.
  await rawSql`
    UPDATE "payments"
    SET "marketplace_fee_snapshot" = NULL
    WHERE "id" = ${paymentId}
  `;

  // Marquer le paiement et l'attempt comme SUCCEEDED.
  await rawSql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${paymentId}`;
  await rawSql`UPDATE "payment_attempts" SET "status" = 'SUCCEEDED', "provider_status" = 'succeeded' WHERE "id" = ${attemptId}`;

  // Simuler le statut succeeded dans le provider.
  (testProvider as TestStripeProvider).simulateStatus(providerPaymentIntentId, 'succeeded');

  // Créer le refund PENDING.
  const refundIdempotencyKey = `refund_late_${paymentId}`;
  const refund = await rawSql`
    INSERT INTO "refunds" (
      "organization_id", "payment_id", "reason", "status",
      "amount_minor", "currency",
      "provider_idempotency_key",
      "reverse_transfer", "refund_application_fee",
      "requested_at"
    ) VALUES (
      ${ids.orgId}, ${paymentId}, 'LATE_PAYMENT_NO_BOOKING', 'PENDING',
      ${paymentAmountMinor}, 'EUR',
      ${refundIdempotencyKey},
      true, true,
      now()
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  // Créer l'outbox event.
  const outbox = await rawSql`
    INSERT INTO "outbox_events" (
      "organization_id", "aggregate_type", "aggregate_id", "event_type", "event_version",
      "payload", "status", "attempt_count", "available_at", "idempotency_key"
    ) VALUES (
      ${ids.orgId}, 'PAYMENT', ${paymentId}::uuid, 'PAYMENT_COMPENSATION_REQUESTED', 'v1',
      ${rawSql.json({
        paymentId,
        refundIdempotencyKey,
        amountMinor: paymentAmountMinor,
        currency: 'EUR',
        reason: 'LATE_PAYMENT_NO_BOOKING',
      })},
      'PENDING', 0, now(),
      ${'payment_compensation_' + paymentId}
    )
    RETURNING "id"
  `.then((r) => r[0]!);

  return {
    paymentId,
    attemptId,
    refundId: refund.id,
    outboxEventId: outbox.id,
    providerPaymentIntentId,
  };
}

function makeRequest(secret?: string): Request {
  const headers = new Headers();
  if (secret) {
    headers.set('Authorization', `Bearer ${secret}`);
  }
  return new Request('http://localhost/api/cron/process-compensations', { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'GET /api/cron/process-compensations — intégration PostgreSQL',
  () => {
    // 1. Unauthorized — pas de header Authorization
    it('1. retourne 401 sans header Authorization', async () => {
      const response = await GET(makeRequest());
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    // 2. Unauthorized — secret incorrect
    it('2. retourne 401 avec un secret incorrect', async () => {
      const response = await GET(makeRequest('wrong-secret'));
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    // 3. Batch vide — auth valide, aucune compensation due
    it('3. retourne 200 avec tous les compteurs à 0 quand aucune compensation due', async () => {
      if (!testDb) return;
      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe('TEST');
      expect(body.claimedCount).toBe(0);
      expect(body.submittedCount).toBe(0);
      expect(body.failedCount).toBe(0);
      expect(body.rescheduledCount).toBe(0);
      expect(body.anomalyCount).toBe(0);
    });

    // 4. Succès — une compensation est exécutée
    it('4. retourne 200 avec submittedCount=1 quand une compensation est exécutée', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { refundId } = await seedCompensationData(ids, 'success');

      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.claimedCount).toBe(1);
      expect(body.submittedCount).toBe(1);
      expect(body.failedCount).toBe(0);
      expect(body.anomalyCount).toBe(0);

      // Vérifier que le refund est SUBMITTED.
      const refund = await rawSql`SELECT status FROM refunds WHERE id = ${refundId}`;
      expect(refund[0]!.status).toBe('SUBMITTED');

      // Aucune donnée sensible (refundId) ne doit être dans la réponse.
      expect(JSON.stringify(body)).not.toContain(refundId);
    });

    it('5. logue des événements structurés avec event, durationMs et compteurs', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      await seedCompensationData(ids, 'logging');

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Log de succès présent.
        expect(infoSpy).toHaveBeenCalledTimes(1);
        const logCall = JSON.parse(infoSpy.mock.calls[0]![0] as string);
        expect(logCall.operation).toBe('cron_process_compensations');
        expect(logCall.outcome).toBe('success');
        expect(logCall.durationMs).toBeGreaterThanOrEqual(0);
        expect(logCall.counts?.claimed).toBe(1);
        expect(logCall.counts?.submitted).toBe(1);
        expect(logCall.counts?.failed).toBe(0);
        expect(logCall.counts?.anomalies).toBe(0);
      } finally {
        infoSpy.mockRestore();
      }
    });

    // 6. Log d'alerte — outcome degraded quand failedCount > 0
    it('6. logue un warn structuré quand failedCount > 0', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      await seedCompensationData(ids, 'alert');

      // Provoquer un échec : faire que createRefund lève une erreur de refus.
      (testProvider as TestStripeProvider).forceCreateRefundError = new PaymentProviderError(
        'UNKNOWN',
        'Insufficient balance for reversal',
        'invalid_request_error',
      );

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Logs dégradés présents.
        const cronCalls = infoSpy.mock.calls
          .map((c) => JSON.parse(c[0] as string))
          .filter((e) => e.operation === 'cron_process_compensations');
        expect(cronCalls.length).toBeGreaterThanOrEqual(1);
        const logCall = cronCalls[0];
        expect(logCall.operation).toBe('cron_process_compensations');
        expect(logCall.outcome).toBe('degraded');
        expect(logCall.counts?.failed).toBe(1);
        expect(logCall.counts?.submitted).toBe(0);

        const alertCall = cronCalls.find((e) => e.errorCode === 'ANOMALY_DETECTED');
        expect(alertCall).toBeDefined();
        expect(alertCall?.operation).toBe('cron_process_compensations');
        expect(alertCall?.outcome).toBe('degraded');
        expect(alertCall?.errorCode).toBe('ANOMALY_DETECTED');
        expect(alertCall?.counts?.failed).toBe(1);
      } finally {
        infoSpy.mockRestore();
      }
    });

    // 7. Erreur technique — getStripeAdapter lève une erreur → 500
    it("7. retourne 500 en cas d'erreur technique (provider indisponible)", async () => {
      if (!testDb) return;
      const originalProvider = testProvider;
      testProvider = null; // Force getStripeAdapter à lever une erreur.

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal Server Error');

        // Error log présent.
        expect(infoSpy).toHaveBeenCalledTimes(1);
        const errorCall = JSON.parse(infoSpy.mock.calls[0]![0] as string);
        expect(errorCall.operation).toBe('cron_process_compensations');
        expect(errorCall.outcome).toBe('failed');
        expect(errorCall.errorCode).toBe('INTERNAL_ERROR');
        expect(errorCall.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        testProvider = originalProvider;
        infoSpy.mockRestore();
      }
    });

    it('8. retourne 500 quand STRIPE_ENVIRONMENT est invalide', async () => {
      if (!testDb) return;
      const savedEnv = process.env.STRIPE_ENVIRONMENT;
      process.env.STRIPE_ENVIRONMENT = 'INVALID';
      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Configuration Error');
      } finally {
        process.env.STRIPE_ENVIRONMENT = savedEnv;
      }
    });
  },
);
