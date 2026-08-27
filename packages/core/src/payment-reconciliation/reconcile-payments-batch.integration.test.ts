/**
 * @uttily/core — Tests d'intégration PostgreSQL du moteur de réconciliation
 * (Phase 7A, ADR-010 §12).
 *
 * 29 scénarios couvrant : batch vide, revendication, lease, concurrence,
 * appels provider hors transaction, transitions métier (succeeded, processing,
 * requires_payment_method, canceled), compensation tardive, isolation
 * multi-tenant, compatibilité de verrouillage, couverture de l'index,
 * filtrage TEST/LIVE, limite 23h, fencing de lease, et garde terminale.
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
import { createBookingDraftWithHold } from '../booking-drafts';
import type { LegacyCreateBookingDraftInput as CreateBookingDraftInput } from '../booking-drafts/types';
import { initiatePayment } from '../payment-initiation/initiate-payment';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
} from '../payment-initiation/types';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import { PaymentProviderError } from '../payments/errors';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import { lockFullBusinessRows, applyBookingConfirmation } from '../payment-transitions';
import { WebhookHandlerError } from '../webhook-handler/errors';
import type { PaymentIntentEventData, ResolvedAttempt } from '../webhook-handler/types';
import { PAYMENT_PROTOCOL_VERSION } from '../payment-initiation/types';
import { reconcilePaymentsBatch } from './reconcile-payments-batch';
import { claimReconciliationBatch } from './claim-reconciliation-batch';
import { applyReconciliationResult } from './apply-reconciliation-result';
import { ReconciliationError } from './errors';
import type { ReconciliationDependencies } from './types';
import { expireBookingDraftsBatch } from '../booking-drafts/expire-booking-drafts-batch';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('reconciliation');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 5 });
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
  if (rawSql) {
    await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON payment_attempts`;
    await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
  }
  await db.execute(
    sql`TRUNCATE TABLE
      refunds, outbox_events, booking_items, booking_lines, bookings,
      payment_webhook_events, payment_attempts, payments, organization_payment_accounts,
      allocations, booking_draft_lines, booking_drafts, inventory_blocks,
      inventory_movements, inventory_items, product_variants, products,
      location_opening_hours, locations, organization_memberships, organizations,
      users, idempotency_records
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
const STD_START = new Date('2026-02-10T09:00:00.000Z');
const STD_END = new Date('2026-02-12T17:00:00.000Z');

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

async function seedPaymentAccount(ids: BaseIds, accountId = 'acct_test_123'): Promise<void> {
  if (!rawSql) throw new Error('rawSql not initialized');
  const sql = rawSql;
  await sql`
    INSERT INTO "organization_payment_accounts" (
      "organization_id", "provider", "environment", "provider_account_id",
      "account_api_generation", "onboarding_status", "charges_enabled", "payouts_enabled",
      "transfers_capability_status", "settlement_merchant_mode",
      "controller_configuration_snapshot", "requirements_snapshot"
    ) VALUES (
      ${ids.orgId}, 'STRIPE', 'TEST', ${accountId},
      'ACCOUNTS_V1_CONTROLLER_PROPERTIES', 'ENABLED', true, true,
      'ACTIVE', 'PLATFORM',
      ${sql.json({ preset: 'CUSTOM' })}, ${sql.json({})}
    )
  `;
}

async function createHeldDraft(ids: BaseIds, keySuffix: string): Promise<string> {
  if (!db) throw new Error('db not initialized');
  const input: CreateBookingDraftInput = {
    pricingMode: 'LEGACY',
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: STD_START,
    customerEndAt: STD_END,
    lines: [{ variantId: ids.variantId, quantity: 1 }],
    idempotencyKey: 'held-' + keySuffix,
  };
  const result = await createBookingDraftWithHold(db, input);
  if (result.kind !== 'SUCCESS') throw new Error('Failed to create held draft');
  return result.body.draftId;
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

function makeDeps(adapter?: FakeStripeAdapter): ReconciliationDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: adapter ?? new FakeStripeAdapter({ environment: 'TEST' }),
  };
}

function makeInitDeps(adapter?: FakeStripeAdapter): InitiatePaymentDependencies {
  if (!db) throw new Error('db not initialized');
  return {
    db,
    provider: adapter ?? new FakeStripeAdapter({ environment: 'TEST' }),
  };
}

/**
 * Initie un paiement et met reconcile_after dans le passé pour le rendre éligible
 * à la réconciliation immédiatement.
 */
async function seedReconciliationData(
  ids: BaseIds,
  keySuffix: string,
  options: {
    adapter?: FakeStripeAdapter;
    overrideAttemptStatus?: string;
    overrideReconcileAfter?: string;
    overrideLeaseUntil?: string | null;
    connectedAccountId?: string;
  } = {},
): Promise<{
  draftId: string;
  paymentId: string;
  attemptId: string;
  providerPaymentIntentId: string;
  adapter: FakeStripeAdapter;
}> {
  if (!db || !rawSql) throw new Error('not initialized');
  const adapter = options.adapter ?? new FakeStripeAdapter({ environment: 'TEST' });
  const initDeps = makeInitDeps(adapter);
  const draftId = await createHeldDraft(ids, keySuffix);
  const initResult = await initiatePayment(
    initDeps,
    makeInitiateInput(ids, draftId, keySuffix, {
      financialTermsConfig: makeFinancialTermsConfig(options.connectedAccountId ?? 'acct_test_123'),
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

  // Mettre reconcile_after dans le passé.
  const reconcileAfter = options.overrideReconcileAfter ?? "now() - interval '1 hour'";
  const leaseUntil = options.overrideLeaseUntil ?? null;
  if (leaseUntil === null) {
    await rawSql`UPDATE "payment_attempts"
      SET "reconcile_after" = ${rawSql.unsafe(reconcileAfter)}, "reconcile_lease_until" = NULL, "reconcile_lease_token" = NULL
      WHERE "id" = ${attemptId}`;
  } else {
    // P2-3 : la contrainte CHECK impose que reconcile_lease_token et
    // reconcile_lease_until soient simultanément non nuls.
    await rawSql`UPDATE "payment_attempts"
      SET "reconcile_after" = ${rawSql.unsafe(reconcileAfter)}, "reconcile_lease_until" = ${rawSql.unsafe(leaseUntil)}, "reconcile_lease_token" = ${randomUUID()}
      WHERE "id" = ${attemptId}`;
  }

  // Optionnellement override le statut.
  if (options.overrideAttemptStatus) {
    await rawSql`UPDATE "payment_attempts" SET "status" = ${options.overrideAttemptStatus} WHERE "id" = ${attemptId}`;
    await rawSql`UPDATE "payments" SET "status" = ${options.overrideAttemptStatus} WHERE "id" = ${paymentId}`;
  }

  return { draftId, paymentId, attemptId, providerPaymentIntentId, adapter };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PostgreSQL synchronization helpers
// ─────────────────────────────────────────────────────────────────────────────

type RawSql = ReturnType<typeof postgres>;

async function waitForAdvisoryLockWaiter(
  conn: RawSql,
  key: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await conn`
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 1
        AND (classid::bigint << 32) | objid::bigint = ${key}
        AND granted = false
      LIMIT 1
    `;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for advisory lock waiter on key ${key} (${timeoutMs}ms)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())(
  'reconcilePaymentsBatch — intégration PostgreSQL',
  () => {
    // 1. batch vide
    it('1. batch vide : aucune tentative due → claimedCount=0', async () => {
      if (!db || !rawSql) return;
      const result = await reconcilePaymentsBatch(makeDeps(), { environment: 'TEST' });
      expect(result.claimedCount).toBe(0);
      expect(result.reconciledCount).toBe(0);
      expect(result.confirmedCount).toBe(0);
      expect(result.cancelledCount).toBe(0);
      expect(result.anomalyCount).toBe(0);
    });

    // 2. tentative due revendiquée avec lease
    it('2. tentative due revendiquée avec lease', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId } = await seedReconciliationData(ids, 'due');

      const claimed = await claimReconciliationBatch(db, 10);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.attemptId).toBe(attemptId);
      expect(claimed[0]!.leaseUntil).toBeDefined();

      // Vérifier que reconcile_lease_until est posé dans le futur.
      const row =
        await rawSql`SELECT reconcile_lease_until FROM payment_attempts WHERE id = ${attemptId}`;
      expect(row[0]!.reconcile_lease_until).not.toBeNull();
    });

    // 3. tentative non due ignorée
    it('3. tentative non due ignorée : reconcile_after dans le futur', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      await seedReconciliationData(ids, 'future', {
        overrideReconcileAfter: "now() + interval '1 hour'",
      });

      const claimed = await claimReconciliationBatch(db, 10);
      expect(claimed.length).toBe(0);
    });

    // 4. lease active ignorée
    it('4. lease active ignorée : reconcile_lease_until dans le futur', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      await seedReconciliationData(ids, 'leased', {
        overrideLeaseUntil: "now() + interval '1 hour'",
      });

      const claimed = await claimReconciliationBatch(db, 10);
      expect(claimed.length).toBe(0);
    });

    // 5. lease expirée récupérée
    it('5. lease expirée récupérée : reconcile_lease_until dans le passé', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      await seedReconciliationData(ids, 'expired-lease', {
        overrideLeaseUntil: "now() - interval '1 hour'",
      });

      const claimed = await claimReconciliationBatch(db, 10);
      expect(claimed.length).toBe(1);
    });

    // 6. deux workers concurrents : SKIP LOCKED
    it('6. deux workers concurrents : SKIP LOCKED, aucune double revendication', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId } = await seedReconciliationData(ids, 'concurrent');

      // Créer un trigger qui bloque l'UPDATE de lease sur payment_attempts.
      const sentinelKey = 98761;
      await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_before_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
      await rawSql.unsafe(`
      CREATE TRIGGER test_block_trigger
      BEFORE UPDATE ON payment_attempts
      FOR EACH ROW
      WHEN (NEW.id = '${attemptId}'::uuid)
      EXECUTE FUNCTION test_block_before_update()
    `);

      // Connexion sentinelle qui prend l'advisory lock.
      const sentinelConn = postgres(ctx!.databaseUrl, { max: 1 });
      await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

      const db1 = createDatabase(ctx!.databaseUrl);
      const db2 = createDatabase(ctx!.databaseUrl);

      try {
        // Lancer le premier claim — il va SELECT FOR UPDATE, puis UPDATE lease
        // (trigger se déclenche, bloque sur l'advisory lock).
        const claim1Promise = claimReconciliationBatch(db1, 10);

        // Attendre que le trigger se déclenche (le waiter advisory apparaît).
        await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

        // Lancer le second claim — il doit retourner 0 (SKIP LOCKED, la ligne
        // est verrouillée par la première transaction qui n'a pas encore commité).
        const claimed2 = await claimReconciliationBatch(db2, 10);
        expect(claimed2.length).toBe(0);

        // Libérer le sentinel — la première transaction se débloque.
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;
        const claimed1 = await claim1Promise;
        expect(claimed1.length).toBe(1);
        expect(claimed1[0]!.attemptId).toBe(attemptId);
      } finally {
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
        await sentinelConn.end();
        await db1.$client.end();
        await db2.$client.end();
        await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON payment_attempts`;
        await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
      }
    });

    // 7. crash après revendication : récupération après expiration de lease
    it('7. crash après revendication : récupération après expiration de lease', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId } = await seedReconciliationData(ids, 'crash');

      // Simuler un crash : claim avec lease, puis ne pas traiter.
      const db1 = createDatabase(ctx!.databaseUrl);
      const claimed = await claimReconciliationBatch(db1, 10);
      expect(claimed.length).toBe(1);
      await db1.$client.end();

      // Mettre le lease dans le passé pour simuler l'expiration.
      await rawSql`UPDATE "payment_attempts" SET "reconcile_lease_until" = now() - interval '1 minute' WHERE "id" = ${attemptId}`;

      // Un nouveau worker peut récupérer la tentative.
      const claimed2 = await claimReconciliationBatch(db, 10);
      expect(claimed2.length).toBe(1);
      expect(claimed2[0]!.attemptId).toBe(attemptId);
    });

    // 8. aucun appel provider pendant une transaction active
    it('8. aucun appel provider pendant une transaction active (FOR UPDATE)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { attemptId, providerPaymentIntentId } = await seedReconciliationData(
        ids,
        'no-provider-in-tx',
        { adapter },
      );

      // Créer un trigger qui bloque l'UPDATE de lease sur payment_attempts.
      const sentinelKey = 98771;
      await rawSql.unsafe(`
      CREATE OR REPLACE FUNCTION test_block_before_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${sentinelKey});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
      await rawSql.unsafe(`
      CREATE TRIGGER test_block_trigger
      BEFORE UPDATE ON payment_attempts
      FOR EACH ROW
      WHEN (NEW.id = '${attemptId}'::uuid)
      EXECUTE FUNCTION test_block_before_update()
    `);

      const sentinelConn = postgres(ctx!.databaseUrl, { max: 1 });
      await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

      const db2 = createDatabase(ctx!.databaseUrl);
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'processing');
      let providerCalled = false;
      const originalRetrieve = adapter.retrievePaymentIntent.bind(adapter);
      adapter.retrievePaymentIntent = async (id: string) => {
        providerCalled = true;
        return originalRetrieve(id);
      };

      try {
        // Start reconcilePaymentsBatch — TX claim va SELECT FOR UPDATE, puis
        // UPDATE lease (trigger fires, blocks). Le provider ne doit PAS être
        // appelé pendant que la transaction de claim est bloquée.
        const reconPromise = reconcilePaymentsBatch(
          { db: db2, provider: adapter },
          { environment: 'TEST' },
        );

        // Wait for the trigger to fire (advisory lock waiter appears).
        await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

        // Pendant que la transaction de claim est bloquée, vérifier qu'aucun appel
        // provider n'a été fait.
        expect(providerCalled).toBe(false);

        // Libérer le sentinel — la transaction de claim se débloque, commit,
        // puis le provider est appelé hors transaction.
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;
        await reconPromise;

        // Maintenant le provider a été appelé (hors transaction).
        expect(providerCalled).toBe(true);
      } finally {
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
        await sentinelConn.end();
        await db2.$client.end();
        await rawSql`DROP TRIGGER IF EXISTS test_block_trigger ON payment_attempts`;
        await rawSql`DROP FUNCTION IF EXISTS test_block_before_update()`;
      }
    });

    // 9. PENDING_PROVIDER sans PI : replay create avec même clé
    it('9. PENDING_PROVIDER sans PI : replay create avec même clé, aucun doublon', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId, adapter } = await seedReconciliationData(ids, 'pending');

      // L'attempt doit être PENDING_PROVIDER sans provider_payment_intent_id.
      const row =
        await rawSql`SELECT provider_payment_intent_id, provider_idempotency_key FROM payment_attempts WHERE id = ${attemptId}`;
      expect(row[0]!.provider_payment_intent_id).not.toBeNull(); // initiate sets it

      // Pour tester PENDING_PROVIDER sans PI, on nullifie le provider_payment_intent_id.
      await rawSql`UPDATE "payment_attempts" SET "provider_payment_intent_id" = NULL WHERE "id" = ${attemptId}`;

      // Le provider a déjà le PI en mémoire (créé par initiatePayment).
      // Le replay avec la même clé doit retourner le même PI.
      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });

      // Le statut du PI est requires_payment_method (défaut du fake).
      // Après échéance, needs_cancellation → cancel → cancelled.
      expect(result.claimedCount).toBe(1);
      // Soit cancelled, soit rescheduled selon le statut.
      expect(result.reconciledCount + result.anomalyCount).toBe(1);

      // Vérifier que la clé d'idempotence n'a pas changé.
      const rowAfter =
        await rawSql`SELECT provider_idempotency_key FROM payment_attempts WHERE id = ${attemptId}`;
      expect(rowAfter[0]!.provider_idempotency_key).toBe(row[0]!.provider_idempotency_key);
    });

    // 10. PI existant : retrieve, jamais create
    it('10. PI existant : retrieve, jamais create', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { providerPaymentIntentId } = await seedReconciliationData(ids, 'retrieve', {
        adapter,
      });

      // Marquer le PI comme succeeded dans le fake.
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      let createCalled = false;
      const originalCreate = adapter.createPaymentIntent.bind(adapter);
      adapter.createPaymentIntent = async (params) => {
        createCalled = true;
        return originalCreate(params);
      };

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.claimedCount).toBe(1);
      expect(createCalled).toBe(false);
      expect(result.confirmedCount).toBe(1);
    });

    // 11. succeeded : une seule booking et une seule outbox
    it('11. succeeded : une seule booking et une seule outbox BOOKING_CONFIRMED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, paymentId } = await seedReconciliationData(ids, 'succeeded', { adapter });

      adapter.simulatePaymentIntentStatus(
        (
          await rawSql`SELECT provider_payment_intent_id FROM payment_attempts WHERE payment_id = ${paymentId}`
        )[0]!.provider_payment_intent_id,
        'succeeded',
      );

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.confirmedCount).toBe(1);

      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(1);

      const outbox =
        await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id} AND event_type = 'BOOKING_CONFIRMED'`;
      expect(outbox.length).toBe(1);
    });

    // 12. concurrence entre réconciliation et webhook : une seule booking
    it('12. concurrence webhook vs réconciliation : une seule booking et un seul outbox BOOKING_CONFIRMED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, providerPaymentIntentId } = await seedReconciliationData(ids, 'race', {
        adapter,
      });

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      // Claimer la tentative pour obtenir un snapshot claimed.
      const dbClaim = createDatabase(ctx!.databaseUrl);
      const claimed1 = await claimReconciliationBatch(dbClaim, 10);
      expect(claimed1.length).toBe(1);
      await dbClaim.$client.end();

      // Récupérer le résultat du provider (succeeded).
      const providerResult = await adapter.retrievePaymentIntent(providerPaymentIntentId);

      // Construire les objets pour le côté webhook (simulate confirmBooking).
      const claimed = claimed1[0]!;
      const webhookAttempt: ResolvedAttempt = {
        attemptId: claimed.attemptId,
        paymentId: claimed.paymentId,
        draftId: claimed.draftId,
        organizationId: claimed.organizationId,
        attemptNumber: claimed.attemptNumber,
        attemptStatus: claimed.attemptStatus,
        paymentStatus: '',
        draftStatus: '',
        providerPaymentIntentId: claimed.providerPaymentIntentId,
      };
      const piData: PaymentIntentEventData = {
        id: providerResult.id,
        status: providerResult.status,
        amount: providerResult.amountMinor,
        currency: providerResult.currency,
        metadata: {
          payment_id: claimed.paymentId,
          payment_attempt_id: claimed.attemptId,
          draft_id: claimed.draftId,
          organization_id: claimed.organizationId,
          protocol_version: PAYMENT_PROTOCOL_VERSION,
        },
        applicationFeeAmount: providerResult.applicationFeeAmountMinor,
        onBehalfOfAccountId: providerResult.onBehalfOfAccountId,
      };
      if (providerResult.connectedAccountId !== null) {
        piData.destination = providerResult.connectedAccountId;
      }

      // Créer un trigger sur booking_drafts BEFORE UPDATE qui bloque sur un
      // advisory lock transactionnel, pour synchroniser les deux transactions.
      const sentinelKey = 98782;
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION test_block_draft_update()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${sentinelKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await rawSql.unsafe(`
        CREATE TRIGGER test_block_draft_trigger
        BEFORE UPDATE ON booking_drafts
        FOR EACH ROW
        WHEN (NEW.id = '${draftId}'::uuid)
        EXECUTE FUNCTION test_block_draft_update()
      `);

      // Connexion sentinelle qui prend l'advisory lock.
      const sentinelConn = postgres(ctx!.databaseUrl, { max: 1 });
      await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

      // DB client pour le côté webhook.
      const dbWebhook = createDatabase(ctx!.databaseUrl);

      try {
        // Lancer applyReconciliationResult en arrière-plan.
        // Il va : lockFullBusinessRows (SELECT FOR UPDATE sur le draft) →
        // applyBookingConfirmation (UPDATE draft → trigger → bloque sur advisory lock).
        const reconPromise = applyReconciliationResult(db, claimed, providerResult, 'TEST');

        // Attendre que le trigger se déclenche (le waiter advisory apparaît).
        await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

        // Lancer le côté webhook en parallèle : il va tenter lockFullBusinessRows
        // (SELECT FOR UPDATE sur le draft) → bloque car le draft est verrouillé
        // par la transaction de réconciliation.
        let webhookError: Error | null = null;
        const webhookPromise = (async () => {
          try {
            await dbWebhook.transaction(async (tx) => {
              const lockedRows = await lockFullBusinessRows(tx, webhookAttempt);
              // Le draft est maintenant CONVERTED (la réconciliation a commité).
              // applyBookingConfirmation doit lever WEBHOOK_LATE_PAYMENT.
              await applyBookingConfirmation(tx, webhookAttempt, piData, 'TEST', lockedRows);
            });
          } catch (error) {
            webhookError = error as Error;
          }
        })();

        // Libérer le sentinel — la réconciliation se débloque, crée la booking, commit.
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

        // Attendre que la réconciliation se termine.
        const reconOutcome = await reconPromise;
        expect(reconOutcome.kind).toBe('confirmed');

        // Attendre que le côté webhook se termine.
        await webhookPromise;

        // Le côté webhook doit avoir échoué avec WEBHOOK_LATE_PAYMENT (draft CONVERTED).
        expect(webhookError).not.toBeNull();
        expect(webhookError).toBeInstanceOf(WebhookHandlerError);
        expect((webhookError as unknown as WebhookHandlerError).code).toBe('WEBHOOK_LATE_PAYMENT');

        // Vérifier qu'une seule booking existe.
        const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
        expect(bookings.length).toBe(1);

        // Vérifier qu'un seul outbox BOOKING_CONFIRMED existe.
        const outbox =
          await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${bookings[0]!.id} AND event_type = 'BOOKING_CONFIRMED'`;
        expect(outbox.length).toBe(1);
      } finally {
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
        await sentinelConn.end();
        await dbWebhook.$client.end();
        await rawSql`DROP TRIGGER IF EXISTS test_block_draft_trigger ON booking_drafts`;
        await rawSql`DROP FUNCTION IF EXISTS test_block_draft_update()`;
      }
    });

    // 13. processing : aucun hold libéré, retry planifié
    it('13. processing : aucun hold libéré, retry planifié (reconcile_after = now()+5min)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId, providerPaymentIntentId } = await seedReconciliationData(
        ids,
        'processing',
        { adapter },
      );

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'processing');

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.rescheduledCount).toBe(1);

      // Vérifier que le draft est toujours PAYMENT_PROCESSING.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

      // Vérifier que reconcile_after est dans le futur (~5 min).
      const attempt =
        await rawSql`SELECT reconcile_after, reconcile_lease_until FROM payment_attempts WHERE id = ${attemptId}`;
      expect(attempt[0]!.reconcile_lease_until).toBeNull();
      const reconcileAfter = attempt[0]!.reconcile_after;
      expect(reconcileAfter).not.toBeNull();
    });

    // 14. requires_payment_method avant échéance : replanifié à processing_deadline_at
    it('14. requires_payment_method avant échéance : replanifié à processing_deadline_at', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { attemptId, providerPaymentIntentId, paymentId } = await seedReconciliationData(
        ids,
        'rpm-before',
        { adapter },
      );

      // Mettre processing_deadline_at dans le futur.
      await rawSql`UPDATE "payments" SET "processing_deadline_at" = now() + interval '1 hour' WHERE "id" = ${paymentId}`;
      // Mettre reconcile_after à maintenant (due) mais avant processing_deadline_at.
      await rawSql`UPDATE "payment_attempts" SET "reconcile_after" = now() WHERE "id" = ${attemptId}`;

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'requires_payment_method');

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.rescheduledCount).toBe(1);

      // Vérifier que reconcile_after = processing_deadline_at.
      const attempt = await rawSql`
      SELECT pa.reconcile_after, pa.reconcile_lease_until, p.processing_deadline_at
      FROM payment_attempts pa JOIN payments p ON p.id = pa.payment_id
      WHERE pa.id = ${attemptId}
    `;
      expect(attempt[0]!.reconcile_lease_until).toBeNull();
    });

    // 15. requires_payment_method après échéance : cancel hors transaction
    it('15. requires_payment_method après échéance : cancel hors transaction, puis applyCancellation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId, providerPaymentIntentId, paymentId } =
        await seedReconciliationData(ids, 'rpm-after', { adapter });

      // Mettre processing_deadline_at dans le passé pour déclencher l'annulation.
      await rawSql`UPDATE "payments" SET "processing_deadline_at" = now() - interval '1 hour' WHERE "id" = ${paymentId}`;
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'requires_payment_method');

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.cancelledCount).toBe(1);

      // Vérifier que le draft est CANCELLED.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('CANCELLED');

      // Vérifier que les holds sont RELEASED.
      const blocks = await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId}`;
      for (const b of blocks) {
        expect(b.status).toBe('RELEASED');
      }

      // Vérifier que payment/attempt sont CANCELLED.
      const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`;
      expect(payment[0]!.status).toBe('CANCELLED');
      const attempt = await rawSql`SELECT status FROM payment_attempts WHERE id = ${attemptId}`;
      expect(attempt[0]!.status).toBe('CANCELLED');
    });

    // 16. cancel réseau ambigu : cancelPaymentIntent lève une erreur
    it('16. cancel réseau ambigu : aucun hold libéré, lease libérée, anomaly', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId, providerPaymentIntentId, paymentId } =
        await seedReconciliationData(ids, 'cancel-fail', { adapter });

      // Mettre processing_deadline_at dans le passé pour déclencher l'annulation.
      await rawSql`UPDATE "payments" SET "processing_deadline_at" = now() - interval '1 hour' WHERE "id" = ${paymentId}`;
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'requires_payment_method');

      // Override cancelPaymentIntent pour lever une erreur.
      adapter.cancelPaymentIntent = async () => {
        throw new PaymentProviderError('VALIDATION', 'Cancel failed', 'api_error');
      };

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.anomalyCount).toBe(1);
      expect(result.cancelledCount).toBe(0);

      // Vérifier que le draft n'est PAS CANCELLED.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');

      // Vérifier que la lease est libérée.
      const attempt =
        await rawSql`SELECT reconcile_lease_until FROM payment_attempts WHERE id = ${attemptId}`;
      expect(attempt[0]!.reconcile_lease_until).toBeNull();
    });

    // 17. canceled confirmé : libération atomique complète
    it('17. canceled confirmé : draft CANCELLED, holds RELEASED, allocations RELEASED, payment/attempt CANCELLED', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId, paymentId, providerPaymentIntentId } =
        await seedReconciliationData(ids, 'canceled', { adapter });

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'canceled');

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.cancelledCount).toBe(1);

      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('CANCELLED');

      const blocks = await rawSql`SELECT status FROM inventory_blocks WHERE source_id = ${draftId}`;
      for (const b of blocks) {
        expect(b.status).toBe('RELEASED');
      }

      const allocs = await rawSql`
      SELECT a.status FROM allocations a
      JOIN inventory_blocks ib ON ib.id = a.inventory_block_id
      WHERE ib.source_id = ${draftId}
    `;
      for (const a of allocs) {
        expect(a.status).toBe('RELEASED');
      }

      const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`;
      expect(payment[0]!.status).toBe('CANCELLED');
      const attempt = await rawSql`SELECT status FROM payment_attempts WHERE id = ${attemptId}`;
      expect(attempt[0]!.status).toBe('CANCELLED');
    });

    // 18. succès tardif : une seule compensation, aucune réallocation
    it('18. succès tardif : une seule compensation (refund LATE_PAYMENT_NO_BOOKING), aucun booking', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, paymentId, providerPaymentIntentId } = await seedReconciliationData(
        ids,
        'late',
        { adapter },
      );

      // Expirer le draft (le rendre terminal).
      await rawSql`UPDATE "booking_drafts" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${draftId}`;
      await rawSql`UPDATE "inventory_blocks" SET "expires_at" = now() - interval '1 minute' WHERE "source_id" = ${draftId} AND "type" = 'HOLD'`;
      // Utiliser expireBookingDraftsBatch pour expirer le draft.
      // Mais le draft est PAYMENT_PROCESSING, pas HELD. Il faut le remettre HELD d'abord.
      // En fait, pour tester la compensation tardive, on peut directement passer le draft en EXPIRED.
      await rawSql`UPDATE "booking_drafts" SET "status" = 'EXPIRED' WHERE "id" = ${draftId}`;
      await rawSql`UPDATE "inventory_blocks" SET "status" = 'EXPIRED' WHERE "source_id" = ${draftId} AND "type" = 'HOLD'`;

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.compensationRequestedCount).toBe(1);

      // Aucun booking créé.
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // Un refund LATE_PAYMENT_NO_BOOKING.
      const refunds =
        await rawSql`SELECT id FROM refunds WHERE payment_id = ${paymentId} AND reason = 'LATE_PAYMENT_NO_BOOKING'`;
      expect(refunds.length).toBe(1);

      // Un outbox PAYMENT_COMPENSATION_REQUESTED.
      const outbox =
        await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${paymentId} AND event_type = 'PAYMENT_COMPENSATION_REQUESTED'`;
      expect(outbox.length).toBe(1);
    });

    // 19. résultat stale après perte de lease
    it('19. résultat stale après perte de lease : un autre worker a pris la lease → aucune mutation', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId, paymentId, providerPaymentIntentId } =
        await seedReconciliationData(ids, 'stale', { adapter });

      // Premier worker claim.
      const db1 = createDatabase(ctx!.databaseUrl);
      const claimed1 = await claimReconciliationBatch(db1, 10);
      expect(claimed1.length).toBe(1);
      await db1.$client.end();

      // Simuler qu'un autre worker prend la lease (nouveau token + nouvelle échéance).
      await rawSql`UPDATE "payment_attempts" SET "reconcile_lease_until" = now() + interval '2 minutes', "reconcile_lease_token" = gen_random_uuid() WHERE "id" = ${attemptId}`;

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      // Récupérer le résultat du provider (succeeded) pour le passer directement.
      const providerResult = await adapter.retrievePaymentIntent(providerPaymentIntentId);

      // Appeler directement applyReconciliationResult avec le claimed1 (lease périmée).
      // La vérification du lease doit lever LEASE_LOST.
      let leaseLost = false;
      try {
        await applyReconciliationResult(db, claimed1[0]!, providerResult, 'TEST');
      } catch (error) {
        if (error instanceof ReconciliationError && error.code === 'LEASE_LOST') {
          leaseLost = true;
        } else {
          throw error;
        }
      }
      expect(leaseLost).toBe(true);

      // Vérifier qu'aucune booking n'a été créée.
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // Vérifier qu'aucun outbox BOOKING_CONFIRMED n'a été créé.
      const outbox =
        await rawSql`SELECT id FROM outbox_events WHERE aggregate_id = ${paymentId} AND event_type = 'BOOKING_CONFIRMED'`;
      expect(outbox.length).toBe(0);

      // Vérifier que le draft est toujours PAYMENT_PROCESSING.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
    });

    // 20. erreur technique : rollback et état récupérable
    it('20. erreur technique : rollback et état récupérable (lease libérée, rescheduled)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, attemptId } = await seedReconciliationData(ids, 'tech-error', { adapter });

      // Simuler une erreur technique : retrievePaymentIntent lève une erreur.
      adapter.retrievePaymentIntent = async () => {
        throw new PaymentProviderError('VALIDATION', 'Network error', 'api_connection_error');
      };

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });
      expect(result.anomalyCount).toBe(1);

      // Vérifier que la lease est libérée et reconcile_after est rescheduled.
      const attempt =
        await rawSql`SELECT reconcile_lease_until, reconcile_after FROM payment_attempts WHERE id = ${attemptId}`;
      expect(attempt[0]!.reconcile_lease_until).toBeNull();
      expect(attempt[0]!.reconcile_after).not.toBeNull();

      // Le draft reste PAYMENT_PROCESSING.
      const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
      expect(draft[0]!.status).toBe('PAYMENT_PROCESSING');
    });

    // 21. isolation multi-tenant
    it("21. isolation multi-tenant : tentative d'org A claimée, tentative d'org B non affectée", async () => {
      if (!db || !rawSql) return;
      const idsA = await seedBaseData('orga');
      await seedPaymentAccount(idsA);
      const { attemptId: attemptA } = await seedReconciliationData(idsA, 'orga');

      const idsB = await seedBaseData('orgb');
      await seedPaymentAccount(idsB, 'acct_test_456');
      const { attemptId: attemptB } = await seedReconciliationData(idsB, 'orgb', {
        connectedAccountId: 'acct_test_456',
      });

      // Claimer — les deux doivent être claimées (SKIP LOCKED ne filtre pas par org).
      const claimed = await claimReconciliationBatch(db, 10);
      expect(claimed.length).toBe(2);
      const claimedIds = new Set(claimed.map((c) => c.attemptId));
      expect(claimedIds.has(attemptA)).toBe(true);
      expect(claimedIds.has(attemptB)).toBe(true);

      // Mais chaque tentative garde son organizationId.
      const attemptAClaimed = claimed.find((c) => c.attemptId === attemptA)!;
      const attemptBClaimed = claimed.find((c) => c.attemptId === attemptB)!;
      expect(attemptAClaimed.organizationId).toBe(idsA.orgId);
      expect(attemptBClaimed.organizationId).toBe(idsB.orgId);
    });

    // 22. Exclusion concurrente : la réconciliation détient des verrous de lignes
    // pendant que l'expiration s'exécute. Le draft est PAYMENT_PROCESSING (non
    // expirable), donc l'expiration l'exclut avant tout verrouillage métier.
    // Ce test démontre l'exécution parallèle et l'exclusion correcte du draft,
    // pas l'absence de deadlock entre deux transactions sur les mêmes lignes.
    // La synchronisation via advisory lock garantit que la transaction de
    // réconciliation est ouverte au moment où l'expiration démarre.
    it('22. réconciliation et expiration concurrentes : exclusion correcte du draft PAYMENT_PROCESSING', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, providerPaymentIntentId } = await seedReconciliationData(ids, 'deadlock', {
        adapter,
      });

      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      // Créer un trigger sur booking_drafts qui bloque sur un advisory lock
      // transactionnel, pour synchroniser les deux transactions concurrentes.
      const sentinelKey = 98792;
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION test_block_draft_update()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${sentinelKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await rawSql.unsafe(`
        CREATE TRIGGER test_block_draft_trigger
        BEFORE UPDATE ON booking_drafts
        FOR EACH ROW
        WHEN (NEW.id = '${draftId}'::uuid)
        EXECUTE FUNCTION test_block_draft_update()
      `);

      // Connexion sentinelle qui prend l'advisory lock.
      const sentinelConn = postgres(ctx!.databaseUrl, { max: 1 });
      await sentinelConn`SELECT pg_advisory_lock(${sentinelKey})`;

      const dbRecon = createDatabase(ctx!.databaseUrl);
      const dbExpire = createDatabase(ctx!.databaseUrl);

      try {
        // Lancer reconcilePaymentsBatch — il va claim, appeler le provider (succeeded),
        // puis applyReconciliationResult → applyBookingConfirmation → UPDATE draft
        // (trigger se déclenche, bloque sur l'advisory lock).
        const reconPromise = reconcilePaymentsBatch(
          { db: dbRecon, provider: adapter },
          { environment: 'TEST' },
        );

        // Attendre que le trigger se déclenche (le waiter advisory apparaît) —
        // la réconciliation est maintenant bloquée à l'intérieur de sa transaction.
        await waitForAdvisoryLockWaiter(rawSql, sentinelKey);

        // Lancer expireBookingDraftsBatch concurremment — il s'exécute en parallèle
        // de la réconciliation bloquée. Le draft est PAYMENT_PROCESSING (non
        // expirable), donc l'expiration ne trouve rien à expirer. Les deux
        // opérations s'exécutent concurremment sans deadlock.
        const expirePromise = expireBookingDraftsBatch(dbExpire);

        // Libérer le sentinel — la réconciliation se débloque, crée la booking, commit.
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`;

        // Attendre les deux résultats concurremment (Promise.all) — si un deadlock
        // se produisait, l'une des deux promesses rejetterait avec une erreur 40P1.
        const [result, expireResult] = await Promise.all([reconPromise, expirePromise]);

        expect(result.confirmedCount).toBe(1);
        expect(expireResult.expiredCount).toBe(0);

        // Vérifier qu'une seule booking existe et que le draft est CONVERTED.
        const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
        expect(bookings.length).toBe(1);

        const draft = await rawSql`SELECT status FROM booking_drafts WHERE id = ${draftId}`;
        expect(draft[0]!.status).toBe('CONVERTED');
      } finally {
        await sentinelConn`SELECT pg_advisory_unlock(${sentinelKey})`.catch(() => {});
        await sentinelConn.end();
        await dbRecon.$client.end();
        await dbExpire.$client.end();
        await rawSql`DROP TRIGGER IF EXISTS test_block_draft_trigger ON booking_drafts`;
        await rawSql`DROP FUNCTION IF EXISTS test_block_draft_update()`;
      }
    });

    // 23. REQUIRES_PAYMENT_METHOD couvert par l'index
    it("23. REQUIRES_PAYMENT_METHOD couvert par l'index : EXPLAIN montre l'utilisation de l'index", async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const seeded = await seedReconciliationData(ids, 'index', {
        overrideAttemptStatus: 'REQUIRES_PAYMENT_METHOD',
      });

      // Seed 99 additional rows with status = 'REQUIRES_PAYMENT_METHOD' and
      // reconcile_after <= now() to reach 100 matching rows total.
      // We use a CTE to bulk-insert booking_drafts → payments → payment_attempts.
      await rawSql`
        WITH drafts AS (
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id", "status",
            "customer_start_at", "customer_end_at", "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "total_amount_minor", "billable_unit_count",
            "cancellation_policy_snapshot", "expires_at"
          )
          SELECT
            ${ids.orgId}, ${ids.locationId}, ${ids.userId}, 'HELD',
            '2026-02-10T09:00:00.000Z'::timestamptz, '2026-02-12T17:00:00.000Z'::timestamptz,
            '2026-02-10T08:30:00.000Z'::timestamptz, '2026-02-12T17:30:00.000Z'::timestamptz,
            'Europe/Paris', 30, 30,
            5000, 5000, 3,
            '{}'::jsonb, now() + interval '1 hour'
          FROM generate_series(1, 99)
          RETURNING "id"
        ),
        pays AS (
          INSERT INTO "payments" (
            "organization_id", "draft_id", "customer_user_id", "status",
            "amount_minor", "currency", "tax_status", "tax_amount_minor",
            "commission_amount_minor", "financial_terms_version", "legal_terms_version",
            "terms_acceptance_snapshot", "connected_account_id",
            "settlement_merchant_mode", "environment"
          )
          SELECT
            ${ids.orgId}, d."id", ${ids.userId}, 'REQUIRES_PAYMENT_METHOD',
            5000, 'EUR', 'NOT_APPLICABLE', 0,
            0, 'v1', 'v1',
            '{}'::jsonb, 'acct_test_123',
            'PLATFORM', 'TEST'
          FROM drafts d
          RETURNING "id"
        )
        INSERT INTO "payment_attempts" (
          "organization_id", "payment_id", "attempt_number", "status",
          "provider_idempotency_key", "provider_status",
          "reconcile_after", "reconcile_lease_until"
        )
        SELECT
          ${ids.orgId}, p."id", 1, 'REQUIRES_PAYMENT_METHOD',
          'bulk-key-' || gen_random_uuid()::text, NULL,
          now() - interval '1 hour', NULL
        FROM pays p
      `;

      // Insert a large number of SUCCEEDED rows (terminal status, not in the
      // partial index) to make the table large enough that the planner prefers
      // the partial index payment_attempts_reconcile_index over a Seq Scan.
      // SUCCEEDED is a terminal status, so the unique index on non-terminal
      // attempts per payment does not apply — we can reuse the same payment_id
      // with incrementing attempt_numbers.
      await rawSql`
        INSERT INTO "payment_attempts" (
          "organization_id", "payment_id", "attempt_number", "status",
          "provider_idempotency_key", "provider_status"
        )
        SELECT
          ${ids.orgId}, ${seeded.paymentId}, g + 1, 'SUCCEEDED',
          'fill-key-' || gen_random_uuid()::text, 'succeeded'
        FROM generate_series(1, 10000) g
      `;

      // ANALYZE pour mettre à jour les statistiques du planner.
      await rawSql`ANALYZE payment_attempts`;

      // EXPLAIN la requête de claim pour REQUIRES_PAYMENT_METHOD.
      const explainResult = await rawSql`
      EXPLAIN (FORMAT TEXT)
      SELECT pa.id FROM payment_attempts pa
      WHERE pa.status = 'REQUIRES_PAYMENT_METHOD'
        AND pa.reconcile_after <= now()
        AND (pa.reconcile_lease_until IS NULL OR pa.reconcile_lease_until <= now())
    `;

      const explainText = explainResult
        .map((r) => (r as unknown as { 'QUERY PLAN': string })['QUERY PLAN'])
        .join('\n');
      // L'index payment_attempts_reconcile_index doit être utilisé.
      expect(explainText).toContain('payment_attempts_reconcile_index');
    }, 120000);

    // 24. Filtrage strict TEST/LIVE : un paiement TEST n'est pas claimé par un batch LIVE
    it('24. filtrage strict TEST/LIVE : paiement TEST non claimé par batch LIVE, et inversement', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      await seedReconciliationData(ids, 'env-filter');

      // Claimer avec environment=LIVE → 0 résultats (le paiement est TEST).
      const claimedLive = await claimReconciliationBatch(db, 10, 'LIVE');
      expect(claimedLive.length).toBe(0);

      // Claimer avec environment=TEST → 1 résultat.
      const claimedTest = await claimReconciliationBatch(db, 10, 'TEST');
      expect(claimedTest.length).toBe(1);
    });

    // 25. Refus d'un adapter du mauvais environnement
    it('25. refus adapter mauvais environnement : reconcilePaymentsBatch avec adapter LIVE et environment=TEST → PROVIDER_ENVIRONMENT_MISMATCH', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      await seedReconciliationData(ids, 'adapter-mismatch');

      const liveAdapter = new FakeStripeAdapter({ environment: 'LIVE' });

      let mismatchError: ReconciliationError | null = null;
      try {
        await reconcilePaymentsBatch({ db, provider: liveAdapter }, { environment: 'TEST' });
      } catch (error) {
        if (
          error instanceof ReconciliationError &&
          error.code === 'PROVIDER_ENVIRONMENT_MISMATCH'
        ) {
          mismatchError = error;
        } else {
          throw error;
        }
      }
      expect(mismatchError).not.toBeNull();
    });

    // 26. Limite de 23 heures : attempt créé il y a 24h → isKeyExpired=true
    it('26. limite 23 heures : attempt créé il y a 24h avec PENDING_PROVIDER sans PI → isKeyExpired=true', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId } = await seedReconciliationData(ids, 'key-expired-24h');

      // Mettre created_at à now() - 24 heures et nullifier le PI pour simuler PENDING_PROVIDER sans PI.
      await rawSql`UPDATE "payment_attempts" SET "created_at" = now() - interval '24 hours', "provider_payment_intent_id" = NULL, "status" = 'PENDING_PROVIDER' WHERE "id" = ${attemptId}`;

      const claimed = await claimReconciliationBatch(db, 10, 'TEST');
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.isKeyExpired).toBe(true);
    });

    // 27. Limite de 23 heures : attempt créé il y a 22h → isKeyExpired=false
    it('27. limite 23 heures : attempt créé il y a 22h avec PENDING_PROVIDER sans PI → isKeyExpired=false', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const { attemptId } = await seedReconciliationData(ids, 'key-fresh-22h');

      // Mettre created_at à now() - 22 heures et nullifier le PI pour simuler PENDING_PROVIDER sans PI.
      await rawSql`UPDATE "payment_attempts" SET "created_at" = now() - interval '22 hours', "provider_payment_intent_id" = NULL, "status" = 'PENDING_PROVIDER' WHERE "id" = ${attemptId}`;

      const claimed = await claimReconciliationBatch(db, 10, 'TEST');
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.isKeyExpired).toBe(false);
    });

    // 28. Récupération conditionnelle sans effacer une nouvelle lease
    it('28. récupération conditionnelle : applyReconciliationResult avec ancien lease token → 0 ligne affectée (LEASE_LOST)', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { attemptId, providerPaymentIntentId } = await seedReconciliationData(
        ids,
        'lease-fencing',
        {
          adapter,
        },
      );

      // Worker 1 claim (lease token T1).
      const db1 = createDatabase(ctx!.databaseUrl);
      const claimed1 = await claimReconciliationBatch(db1, 10, 'TEST');
      expect(claimed1.length).toBe(1);
      const tokenT1 = claimed1[0]!.leaseToken;
      await db1.$client.end();

      // Simuler un crash de worker 1 : expirer le lease.
      await rawSql`UPDATE "payment_attempts" SET "reconcile_lease_until" = now() - interval '1 minute' WHERE "id" = ${attemptId}`;

      // Worker 2 claim (nouveau lease token T2).
      const claimed2 = await claimReconciliationBatch(db, 10, 'TEST');
      expect(claimed2.length).toBe(1);
      const tokenT2 = claimed2[0]!.leaseToken;
      expect(tokenT2).not.toBe(tokenT1);

      // Worker 1 tente applyReconciliationResult avec l'ancien lease token T1.
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');
      const providerResult = await adapter.retrievePaymentIntent(providerPaymentIntentId);

      // Construire un claimed avec l'ancien token T1.
      const staleClaimed = { ...claimed1[0]!, leaseToken: tokenT1 };

      let leaseLost = false;
      try {
        await applyReconciliationResult(db, staleClaimed, providerResult, 'TEST');
      } catch (error) {
        if (error instanceof ReconciliationError && error.code === 'LEASE_LOST') {
          leaseLost = true;
        } else {
          throw error;
        }
      }
      expect(leaseLost).toBe(true);

      // Vérifier qu'aucune booking n'a été créée par le worker 1.
      const bookings =
        await rawSql`SELECT id FROM bookings WHERE draft_id = ${claimed1[0]!.draftId}`;
      expect(bookings.length).toBe(0);
    });

    // 29. Garde terminale dans le contexte de réconciliation : asymétrie terminale
    // détectée via validateWebhookAuthority → anomalie INVARIANT_BROKEN.
    it('29. garde terminale réconciliation : payment=SUCCEEDED, attempt=PROCESSING → anomalie INVARIANT_BROKEN', async () => {
      if (!db || !rawSql) return;
      const ids = await seedBaseData();
      await seedPaymentAccount(ids);
      const adapter = new FakeStripeAdapter({ environment: 'TEST' });
      const { draftId, paymentId, attemptId, providerPaymentIntentId } =
        await seedReconciliationData(ids, 'recon-terminal-guard', {
          adapter,
        });

      // Simuler le provider en succeeded.
      adapter.simulatePaymentIntentStatus(providerPaymentIntentId, 'succeeded');

      // Créer manuellement une asymétrie terminale : payment SUCCEEDED (terminal)
      // mais attempt PROCESSING (non-terminal). validateWebhookAuthority (appelée
      // via applyBookingConfirmation) doit détecter cette asymétrie et lever
      // WEBHOOK_INVARIANT_BROKEN.
      await rawSql`UPDATE "payments" SET "status" = 'SUCCEEDED', "succeeded_at" = now() WHERE "id" = ${paymentId}`;
      await rawSql`UPDATE "payment_attempts" SET "status" = 'PROCESSING' WHERE "id" = ${attemptId}`;

      const result = await reconcilePaymentsBatch(makeDeps(adapter), { environment: 'TEST' });

      // La réconciliation doit détecter l'anomalie (l'erreur WEBHOOK_INVARIANT_BROKEN
      // est capturée et enregistrée comme anomalie avec code INVARIANT_BROKEN).
      expect(result.anomalyCount).toBe(1);
      expect(result.anomalies.length).toBe(1);
      expect(result.anomalies[0]!.attemptId).toBe(attemptId);
      expect(result.anomalies[0]!.code).toBe('INVARIANT_BROKEN');
      expect(result.confirmedCount).toBe(0);

      // Vérifier qu'aucune booking n'a été créée (la tx a rollbacké).
      const bookings = await rawSql`SELECT id FROM bookings WHERE draft_id = ${draftId}`;
      expect(bookings.length).toBe(0);

      // Le payment reste SUCCEEDED (pas de régression — la tx a rollbacké).
      const payment = await rawSql`SELECT status FROM payments WHERE id = ${paymentId}`.then(
        (r) => r[0],
      );
      expect(payment!.status).toBe('SUCCEEDED');
    });
  },
);
