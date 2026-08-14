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
  VerifyWebhookParams,
  WebhookVerification,
  CreateConnectedAccountParams,
  ConnectedAccountResult,
  CreateOnboardingLinkParams,
  OnboardingLinkResult,
  AccountCapabilities,
} from '@uttily/core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mocks : getDb + getStripeAdapter.
//
// Le route handler dépend des singletons `getDb()` et `getStripeAdapter()`.
// On les mocke pour brancher une base de test PostgreSQL réelle et un
// provider fake déterministe.
// ---------------------------------------------------------------------------

// `getDb` est mocké pour retourner le client de test. On l'injecte via
// une variable mutable afin de pouvoir la réinitialiser entre les tests.
let testDb: DatabaseClient | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => testDb,
}));

// `getStripeAdapter` est mocké pour retourner le provider de test.
let testProvider: PaymentProviderAdapter | null = null;

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => {
    if (!testProvider) {
      throw new Error('getStripeAdapter: testProvider non initialisé');
    }
    return testProvider;
  },
}));

// Importe le route handler APRÈS les mocks pour qu'il utilise la version mockée.
const { GET } = await import('./route');

// ---------------------------------------------------------------------------
// Provider fake minimal pour les tests (FakeStripeAdapter n'est pas exporté
// depuis @uttily/core). Implémente PaymentProviderAdapter avec un store
// en mémoire des PaymentIntents.
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

class TestStripeProvider implements PaymentProviderAdapter {
  readonly environment: StripeEnvironment;
  private readonly intents = new Map<string, StoredIntent>();

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

  /** Simule un changement de statut d'un PaymentIntent stocké. */
  simulateStatus(id: string, status: PaymentIntentStatus): void {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`PaymentIntent non trouvé : ${id}`);
    intent.status = status;
  }

  // Les méthodes suivantes ne sont pas utilisées par la réconciliation.
  async createRefund(_params: CreateRefundParams): Promise<RefundResult> {
    throw new Error('not implemented');
  }
  async retrieveRefund(_id: string): Promise<RefundResult> {
    throw new Error('not implemented');
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
  async projectCapabilities(_accountId: string): Promise<AccountCapabilities> {
    throw new Error('not implemented');
  }
}

// ---------------------------------------------------------------------------
// Setup base de test (réplique minimale de setupIntegrationTestDb).
// ---------------------------------------------------------------------------

const isCi = process.env.CI === '1' || process.env.CI === 'true';
const TEST_DB_NAME = 'uttily_test_cron_reconcile';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
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

  // Vérifie la connectivité.
  adminSql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await adminSql`SELECT 1`;
  } catch {
    await adminSql.end();
    adminSql = null;
    if (isCi) throw new Error('CI: base PostgreSQL non joignable.');
    // DATABASE_URL défini mais base injoignable en local : échec explicite,
    // pas de faux vert (skip silencieux).
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  adminUrl = url;

  // Crée la base de test.
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
    adminSql = null;
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
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
  // Garde de sécurité : ne devrait plus être atteint car describe.skipIf
  // (shouldSkipIntegrationTests) skipe toute la suite quand la base est absente
  // ou SKIP_INTEGRATION_TESTS=1, et le setup throw si la base est injoignable.
  // Conservé par défense en profondeur.
  if (!testDb) return;
  // TRUNCATE réinitialise les tables (RESTART IDENTITY). Les catégories
  // seedées ne sont pas tronquées.
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
  // Réinitialise le provider de test pour chaque test.
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

/**
 * Crée les données de base : organisation (FLEXIBLE), lieu (Europe/Paris,
 * buffers 30 min), utilisateur, catégorie, produit PUBLISHED, variante
 * (prix 5000, EUR, active), 3 exemplaires (NEW/GOOD/FAIR, ACTIVE).
 */
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

/** Période standard : 10–12 février 2026 (3 jours civils Europe/Paris). */
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

function makeInput(
  ids: BaseIds,
  overrides: Partial<LegacyCreateBookingDraftInput> = {},
): LegacyCreateBookingDraftInput {
  return {
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
      amountMinor: 500,
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

/**
 * Crée un brouillon HELD réel via `createBookingDraftWithHold`.
 */
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
 * Initie un paiement et met reconcile_after dans le passé pour le rendre éligible
 * à la réconciliation immédiatement.
 *
 * @returns IDs du draft, payment, attempt et du PaymentIntent provider.
 */
async function seedReconciliationData(
  ids: BaseIds,
  keySuffix: string,
  options: {
    connectedAccountId?: string;
  } = {},
): Promise<{
  draftId: string;
  paymentId: string;
  attemptId: string;
  providerPaymentIntentId: string;
}> {
  if (!testDb || !rawSql) throw new Error('not initialized');
  if (!testProvider) throw new Error('testProvider not initialized');

  const connectedAccountId = options.connectedAccountId ?? 'acct_test_123';

  // Crée le compte de paiement pour l'organisation.
  await rawSql`
    INSERT INTO "organization_payment_accounts" (
      "organization_id", "provider", "environment", "provider_account_id",
      "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
      "transfers_capability_status", "settlement_merchant_mode",
      "controller_configuration_snapshot", "requirements_snapshot"
    ) VALUES (
      ${ids.orgId}, 'STRIPE', 'TEST', ${connectedAccountId},
      'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true,
      'ACTIVE', 'PLATFORM',
      ${rawSql.json({ preset: 'CUSTOM' })}, ${rawSql.json({})}
    )
  `;

  // Crée le brouillon HELD.
  const draftId = await createHeldDraft(ids, keySuffix);

  // Initie le paiement avec le provider de test.
  const initDeps: InitiatePaymentDependencies = {
    db: testDb,
    provider: testProvider,
  };
  const initResult = await initiatePayment(
    initDeps,
    makeInitiateInput(ids, draftId, keySuffix, {
      financialTermsConfig: makeFinancialTermsConfig(connectedAccountId),
    }),
  );
  expect(initResult.kind).toBe('SUCCESS');
  if (initResult.kind !== 'SUCCESS') throw new Error('initiatePayment failed');
  const providerPaymentIntentId = initResult.providerPaymentIntentId;

  // Récupérer les IDs.
  const paymentRow = await rawSql`SELECT id FROM payments WHERE draft_id = ${draftId}`;
  const paymentId = paymentRow[0]!.id;
  const attemptRow = await rawSql`SELECT id FROM payment_attempts WHERE payment_id = ${paymentId}`;
  const attemptId = attemptRow[0]!.id;

  // Mettre reconcile_after dans le passé pour rendre la tentative éligible.
  await rawSql`UPDATE "payment_attempts"
    SET "reconcile_after" = now() - interval '1 hour', "reconcile_lease_until" = NULL, "reconcile_lease_token" = NULL
    WHERE "id" = ${attemptId}`;

  return { draftId, paymentId, attemptId, providerPaymentIntentId };
}

/**
 * Crée un objet Request avec le header Authorization optionnel.
 */
function makeRequest(secret?: string): Request {
  const headers = new Headers();
  if (secret) {
    headers.set('Authorization', `Bearer ${secret}`);
  }
  return new Request('http://localhost/api/cron/reconcile-payments', { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'GET /api/cron/reconcile-payments — intégration PostgreSQL',
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

    // 3. Batch vide — auth valide, aucune tentative due
    it('3. retourne 200 avec tous les compteurs à 0 quand aucune tentative due', async () => {
      if (!testDb) return;
      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe('TEST');
      expect(body.claimedCount).toBe(0);
      expect(body.reconciledCount).toBe(0);
      expect(body.confirmedCount).toBe(0);
      expect(body.cancelledCount).toBe(0);
      expect(body.rescheduledCount).toBe(0);
      expect(body.compensationRequestedCount).toBe(0);
      expect(body.anomalyCount).toBe(0);
    });

    // 4. Succès — un paiement PROCESSING est réconcilié en SUCCEEDED
    it('4. retourne 200 avec confirmedCount=1 quand un paiement PROCESSING est réconcilié succeeded', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { draftId, providerPaymentIntentId } = await seedReconciliationData(ids, 'success');

      // Simuler le statut succeeded dans le provider.
      (testProvider as TestStripeProvider).simulateStatus(providerPaymentIntentId, 'succeeded');

      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.claimedCount).toBe(1);
      expect(body.confirmedCount).toBe(1);
      expect(body.anomalyCount).toBe(0);

      // Aucune donnée sensible (draftId) ne doit être dans la réponse.
      expect(JSON.stringify(body)).not.toContain(draftId);
    });

    // 5. Log structuré — vérifie le format JSON et les métriques ADR-010 §12
    it('5. logue des événements structurés avec event, durationMs et compteurs', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      const { providerPaymentIntentId } = await seedReconciliationData(ids, 'logging');
      (testProvider as TestStripeProvider).simulateStatus(providerPaymentIntentId, 'succeeded');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Log de succès présent.
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logCall = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(logCall.event).toBe('cron.reconcile-payments');
        expect(logCall.durationMs).toBeGreaterThanOrEqual(0);
        expect(logCall.environment).toBe('TEST');
        expect(logCall.oldestProcessingAgeSeconds).not.toBeUndefined();
        expect(logCall.claimedCount).toBe(1);
        expect(logCall.confirmedCount).toBe(1);
        expect(logCall.anomalyCount).toBe(0);

        // Pas de warn d'anomalie ni d'erreur.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    // 6. Log d'anomalie — warn quand anomalyCount > 0
    it('6. logue un warn structuré quand anomalyCount > 0', async () => {
      if (!testDb || !rawSql) return;
      const ids = await seedBaseData();
      await seedReconciliationData(ids, 'anomaly');

      // Provoquer une anomalie : faire que retrievePaymentIntent lève une erreur.
      const originalRetrieve = testProvider!.retrievePaymentIntent.bind(testProvider);
      testProvider!.retrievePaymentIntent = async (_id: string) => {
        throw new Error('Simulated provider error');
      };

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(200);

        // Log de succès présent (le batch s'est terminé, mais avec anomalies).
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logCall = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(logCall.event).toBe('cron.reconcile-payments');
        expect(logCall.anomalyCount).toBe(1);
        expect(logCall.confirmedCount).toBe(0);

        // Warn d'anomalie présent. Le moteur de réconciliation logge aussi
        // ses propres warns (event: 'reconciliation.error'), donc on filtre
        // pour trouver l'event spécifique à la route.
        const anomalyWarnCalls = warnSpy.mock.calls.filter((c) => {
          const parsed = JSON.parse(c[0] as string);
          return parsed.event === 'cron.reconcile-payments.anomalies';
        });
        expect(anomalyWarnCalls.length).toBe(1);
        const warnCall = JSON.parse(anomalyWarnCalls[0]![0] as string);
        expect(warnCall.event).toBe('cron.reconcile-payments.anomalies');
        expect(warnCall.anomalyCount).toBe(1);
        expect(Array.isArray(warnCall.codes)).toBe(true);
        expect(warnCall.durationMs).toBeGreaterThanOrEqual(0);

        // Pas d'erreur technique (le batch a géré l'anomalie gracieusement).
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        // Restaurer le provider.
        testProvider!.retrievePaymentIntent = originalRetrieve;
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    // 7. Erreur technique — getStripeAdapter lève une erreur → 500
    it("7. retourne 500 en cas d'erreur technique (provider indisponible)", async () => {
      if (!testDb) return;
      const originalProvider = testProvider;
      testProvider = null; // Force getStripeAdapter à lever une erreur.

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await GET(makeRequest(CRON_SECRET));
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal Server Error');

        // Error log présent.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const errorCall = JSON.parse(errorSpy.mock.calls[0]![0] as string);
        expect(errorCall.event).toBe('cron.reconcile-payments.error');
        expect(errorCall.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof errorCall.error).toBe('string');

        // Pas de log de succès ni de warn.
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        testProvider = originalProvider;
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    // 9. G7M-C4-B — réconcilie les tentatives de paiement de suppléments en plus des paiements initiaux
    it('9. retourne 200 et réconcilie les tentatives de supplément échues', async () => {
      if (!testDb || !rawSql || !testProvider) return;
      const ids = await seedBaseData();
      const s = rawSql;
      const connectedAccountId = 'acct_test_' + SUFFIX();

      await s`
        INSERT INTO "organization_payment_accounts" (
          "organization_id", "provider", "environment", "provider_account_id",
          "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
          "transfers_capability_status", "settlement_merchant_mode",
          "controller_configuration_snapshot", "requirements_snapshot"
        ) VALUES (
          ${ids.orgId}, 'STRIPE', 'TEST', ${connectedAccountId},
          'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true, 'ACTIVE', 'PLATFORM',
          ${s.json({ preset: 'TEST' })}, ${s.json({})}
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
          ${ids.orgId}, ${ids.locationId}, ${ids.userId}, 'DRAFT',
          '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
          '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z',
          'Europe/Paris', 30, 30, 'EUR', 10000, 0, 10000,
          'NOT_APPLICABLE', 0, 500, 'DAY', 2,
          ${s.json({ policy: 'FLEXIBLE' })}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const payment = await s`
        INSERT INTO "payments" (
          "organization_id", "draft_id", "customer_user_id", "status", "amount_minor", "currency",
          "tax_status", "tax_amount_minor", "commission_amount_minor", "financial_terms_version",
          "legal_terms_version", "terms_acceptance_snapshot", "charge_model", "settlement_merchant_mode",
          "connected_account_id", "on_behalf_of_account_id", "environment", "succeeded_at"
        ) VALUES (
          ${ids.orgId}, ${draft.id}, ${ids.userId}, 'SUCCEEDED', 10000, 'EUR',
          'NOT_APPLICABLE', 0, 500, 'v1', 'v1',
          ${s.json({ accepted: true })}, 'DESTINATION', 'CONNECTED_ACCOUNT',
          ${connectedAccountId}, ${connectedAccountId}, 'TEST', now()
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
          ${ids.orgId}, ${ids.locationId}, ${ids.userId}, ${draft.id}, ${payment.id}, 'CONFIRMED',
          '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
          '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z', 'Europe/Paris', 30, 30,
          'EUR', 10000, 0, 10000, 'NOT_APPLICABLE', 0, 500, 2,
          ${s.json({ policy: 'FLEXIBLE' })}, ${s.json({ accepted: true })}, now()
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const bookingLine = await s`
        INSERT INTO "booking_lines" (
          "booking_id", "variant_id", "quantity", "unit_price_amount_minor", "billable_unit_count",
          "line_total_amount_minor", "variant_snapshot"
        ) VALUES (
          ${booking.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${s.json({ name: 'Standard' })}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const bookingBlock = await s`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at", "source_id"
        ) VALUES (
          ${ids.orgId}, ${ids.itemIds[0]!}, 'BOOKING', 'ACTIVE',
          '2026-07-10T09:00:00.000Z', '2026-07-12T17:00:00.000Z',
          '2026-07-10T08:30:00.000Z', '2026-07-12T17:30:00.000Z', ${booking.id}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await s`
        INSERT INTO "booking_items" ("booking_id", "booking_line_id", "inventory_item_id", "booking_block_id")
        VALUES (${booking.id}, ${bookingLine.id}, ${ids.itemIds[0]!}, ${bookingBlock.id})
      `;

      const amendment = await s`
        INSERT INTO "booking_amendments" (
          "organization_id", "booking_id", "amendment_number", "type", "status",
          "financial_snapshot_before", "financial_snapshot_after",
          "new_customer_start_at", "new_customer_end_at", "new_blocked_start_at", "new_blocked_end_at",
          "hold_deadline", "created_by", "created_at"
        ) VALUES (
          ${ids.orgId}, ${booking.id}, 1, 'SUPPLEMENT', 'HOLD_PENDING',
          ${s.json({ totalAmountMinor: 10000, currency: 'EUR' })},
          ${s.json({ totalAmountMinor: 15000, currency: 'EUR' })},
          '2026-07-10T09:00:00.000Z', '2026-07-13T17:00:00.000Z',
          '2026-07-10T08:30:00.000Z', '2026-07-13T17:30:00.000Z',
          now() + interval '10 minutes', ${ids.userId}, now()
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const holdBlock = await s`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
          "expires_at", "source_id"
        ) VALUES (
          ${ids.orgId}, ${ids.itemIds[0]!}, 'HOLD', 'ACTIVE',
          '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z',
          '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z',
          now() + interval '10 minutes', ${amendment.id}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const amendmentLine = await s`
        INSERT INTO "booking_amendment_lines" (
          "amendment_id", "organization_id", "logical_line_id", "origin_type", "source_booking_line_id",
          "variant_id", "action", "before_quantity", "before_unit_price_amount_minor",
          "before_line_total_amount_minor", "after_quantity", "after_unit_price_amount_minor",
          "after_line_total_amount_minor", "pricing_snapshot", "variant_snapshot"
        ) VALUES (
          ${amendment.id}, ${ids.orgId}, ${bookingLine.id}, 'ORIGINAL', ${bookingLine.id},
          ${ids.variantId}, 'MODIFY', 1, 5000, 10000, 1, 5000, 15000,
          ${s.json({ source: 'C4B' })}, ${s.json({ name: 'Standard' })}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const allocation = await s`
        INSERT INTO "booking_amendment_allocations" (
          "amendment_id", "amendment_line_id", "organization_id", "inventory_item_id", "action",
          "source_booking_block_id", "effective_customer_start_at", "effective_customer_end_at",
          "effective_blocked_start_at", "effective_blocked_end_at"
        ) VALUES (
          ${amendment.id}, ${amendmentLine.id}, ${ids.orgId}, ${ids.itemIds[0]!}, 'RETAIN',
          ${bookingBlock.id}, '2026-07-10T09:00:00.000Z', '2026-07-13T17:00:00.000Z',
          '2026-07-10T08:30:00.000Z', '2026-07-13T17:30:00.000Z'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await s`
        INSERT INTO "booking_amendment_segments" (
          "allocation_id", "organization_id", "inventory_item_id", "hold_block_id",
          "delta_start_at", "delta_end_at"
        ) VALUES (
          ${allocation.id}, ${ids.orgId}, ${ids.itemIds[0]!}, ${holdBlock.id},
          '2026-07-12T17:30:00.000Z', '2026-07-13T17:30:00.000Z'
        )
      `;

      const amendmentPayment = await s`
        INSERT INTO "amendment_payments" (
          "organization_id", "booking_id", "amendment_id", "customer_user_id",
          "status", "amount_minor", "currency", "charge_model", "settlement_merchant_mode",
          "connected_account_id", "on_behalf_of_account_id", "environment"
        ) VALUES (
          ${ids.orgId}, ${booking.id}, ${amendment.id}, ${ids.userId},
          'PENDING_PROVIDER', 5000, 'EUR', 'DESTINATION', 'CONNECTED_ACCOUNT',
          ${connectedAccountId}, ${connectedAccountId}, 'TEST'
        ) RETURNING "id"
      `.then((r) => r[0]!);

      const pi = await testProvider.createPaymentIntent({
        idempotencyKey: 'rec_pi_' + SUFFIX(),
        amountMinor: 5000,
        currency: 'EUR',
        connectedAccountId,
        applicationFeeAmountMinor: 250,
        onBehalfOfAccountId: connectedAccountId,
        metadata: {
          payment_type: 'AMENDMENT',
          amendment_payment_attempt_id: 'att_test',
          amendment_id: amendment.id,
          organization_id: ids.orgId,
          environment: 'TEST',
          protocol_version: 'booking-amendment-payment-v1',
        },
      });
      (testProvider as TestStripeProvider).simulateStatus(pi.id, 'succeeded');

      const attempt = await s`
        INSERT INTO "amendment_payment_attempts" (
          "organization_id", "amendment_payment_id", "attempt_number",
          "status", "provider_idempotency_key"
        ) VALUES (
          ${ids.orgId}, ${amendmentPayment.id}, 1,
          'PENDING_PROVIDER', 'idem_supp_' || ${SUFFIX()}
        ) RETURNING "id"
      `.then((r) => r[0]!);

      await s`
        UPDATE "amendment_payment_attempts"
        SET "status" = 'PROCESSING', "provider_status" = 'processing',
            "provider_payment_intent_id" = ${pi.id},
            "reconcile_after" = now() - interval '1 second'
        WHERE "id" = ${attempt.id}
      `;

      const response = await GET(makeRequest(CRON_SECRET));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.supplementPayments.claimedCount).toBe(1);
      expect(body.supplementPayments.reconciledCount).toBe(1);
      expect(body.supplementPayments.projectedCount).toBe(1);

      const attemptRows =
        await s`SELECT "provider_status", "status" FROM "amendment_payment_attempts" WHERE "id" = ${attempt.id}`;
      expect(attemptRows[0]!.provider_status).toBe('succeeded');
    });

    // 8. STRIPE_ENVIRONMENT invalide → 500 Configuration Error
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
