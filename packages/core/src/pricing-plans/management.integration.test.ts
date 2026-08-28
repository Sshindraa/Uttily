import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import {
  saveDailyPricingPlanDraft,
  activateDailyPricingPlan,
  getVariantPricingSummary,
} from './management';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('pricing_management');
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
  await db.execute(
    (await import('drizzle-orm'))
      .sql`TRUNCATE TABLE pricing_plan_translations, multi_day_discount_tiers, pricing_plan_windows, pricing_plans, inventory_items, product_variants, products, categories, organizations, users RESTART IDENTITY CASCADE`,
  );
});

describe.skipIf(shouldSkipIntegrationTests())(
  'Pricing Plans Management (PostgreSQL Integration)',
  () => {
    async function seedTestEnvironment() {
      const orgId = randomUUID();
      const userId = randomUUID();
      const catId = randomUUID();
      const prodId = randomUUID();
      const variantId = randomUUID();

      await rawSql!`
        INSERT INTO organizations (id, legal_name, slug, default_currency)
        VALUES (${orgId}, 'Loueur Vélo Lyon', 'loueur-lyon', 'EUR')
      `;

      await rawSql!`
        INSERT INTO categories (id, name, slug, is_active)
        VALUES (${catId}, 'Vélo urbain', 'velo-urbain', true)
      `;

      await rawSql!`
        INSERT INTO products (id, organization_id, category_id, name, slug, description, publication_status)
        VALUES (${prodId}, ${orgId}, ${catId}, 'Vélo Gazelle VAE', 'gazelle-vae', 'Superbe vélo électrique', 'DRAFT')
      `;

      await rawSql!`
        INSERT INTO product_variants (id, product_id, name, is_active)
        VALUES (${variantId}, ${prodId}, 'Taille M', true)
      `;

      return { orgId, userId, catId, prodId, variantId };
    }

    it('enregistre un brouillon DRAFT, ses traductions et ses tiers multi-jours', async () => {
      if (!db) return;
      const { orgId, variantId } = await seedTestEnvironment();

      const plan = await saveDailyPricingPlanDraft(db, {
        organizationId: orgId,
        variantId,
        priceAmountMinor: 2500, // 25.00 €
        internalLabel: 'Tarif Eté 2026',
        discountTiers: [
          { thresholdDays: 3, discountPercent: 12 },
          { thresholdDays: 7, discountPercent: 25 },
        ],
      });

      expect(plan.id).toBeDefined();
      expect(plan.lifecycleState).toBe('DRAFT');
      expect(plan.version).toBe(1);
      expect(plan.priceAmountMinor).toBe(2500);
      expect(plan.discountTiers).toHaveLength(2);

      const overview = await getVariantPricingSummary(db, orgId, variantId);
      expect(overview.activePlan).toBeNull();
      expect(overview.draftPlan).not.toBeNull();
      expect(overview.draftPlan?.priceAmountMinor).toBe(2500);
      expect(overview.draftPlan?.discountTiers).toHaveLength(2);
    });

    it('active un brouillon DRAFT vers ACTIVE et archive les anciens plans actifs', async () => {
      if (!db) return;
      const { orgId, variantId } = await seedTestEnvironment();

      // 1. Version 1 DRAFT puis ACTIVE
      const draftV1 = await saveDailyPricingPlanDraft(db, {
        organizationId: orgId,
        variantId,
        priceAmountMinor: 2500,
      });

      const activeV1 = await activateDailyPricingPlan(db, orgId, draftV1.id);
      expect(activeV1.lifecycleState).toBe('ACTIVE');
      expect(activeV1.version).toBe(1);

      let overview = await getVariantPricingSummary(db, orgId, variantId);
      expect(overview.activePlan?.id).toBe(draftV1.id);
      expect(overview.draftPlan).toBeNull();

      // 2. Version 2 DRAFT puis ACTIVE
      const draftV2 = await saveDailyPricingPlanDraft(db, {
        organizationId: orgId,
        variantId,
        priceAmountMinor: 3000,
      });
      expect(draftV2.version).toBe(2);

      overview = await getVariantPricingSummary(db, orgId, variantId);
      expect(overview.activePlan?.priceAmountMinor).toBe(2500);
      expect(overview.draftPlan?.priceAmountMinor).toBe(3000);

      const activeV2 = await activateDailyPricingPlan(db, orgId, draftV2.id);
      expect(activeV2.lifecycleState).toBe('ACTIVE');
      expect(activeV2.version).toBe(2);

      overview = await getVariantPricingSummary(db, orgId, variantId);
      expect(overview.activePlan?.id).toBe(draftV2.id);
      expect(overview.activePlan?.priceAmountMinor).toBe(3000);
      expect(overview.draftPlan).toBeNull();
      expect(overview.retiredPlansCount).toBe(1);
    });
  },
);
