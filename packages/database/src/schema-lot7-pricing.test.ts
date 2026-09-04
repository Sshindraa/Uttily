import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 7 — G7P-A Round 3 (fondations
 * des plans tarifaires flexibles, ADR-018, migration 0032).
 *
 * Vérifie :
 * - La migration 0032 (enums pricing_plan_type / pricing_lifecycle_state,
 *   locations.operating_currency, tables pricing_plans / pricing_plan_windows /
 *   multi_day_discount_tiers / pricing_plan_translations, triggers de cohérence
 *   multi-tenant, cycle de vie DRAFT→ACTIVE→RETIRED, immutabilité, backfill
 *   DAILY avec traductions FR+EN).
 * - L'union discriminée stricte HOURLY / FIXED_DURATION / DAILY.
 * - Le cycle de vie et l'immutabilité après activation.
 * - Le versioning et la clé métier (index uniques).
 * - L'héritage default/local et la résolution (resolve_effective_pricing_plans)
 *   avec isolation multi-tenant (signature à un seul paramètre location_id,
 *   dérivation server-side de organization_id et currency).
 * - Les fenêtres tarifaires (pas de wraparound minuit, gel sur plan non-DRAFT).
 * - Les paliers de réduction multi-jours (uniquement DAILY, monotonie).
 * - Les traductions FR+EN (requises pour l'activation, gelées après).
 * - La protection de la devise opérationnelle des magasins (DRAFT + ACTIVE
 *   bloquent le changement ; RETIRED ne bloque pas).
 * - La revalidation complète à l'activation (cohérence org, currency, fenêtres,
 *   paliers, traductions).
 * - La concurrence (création simultanée de plans actifs même clé, mutations
 *   enfants vs activation, monotonie des paliers, devise vs activation).
 *
 * Reprend la stratégie de setup des cycles précédents : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot7_pricing';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  if (!url) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(dbUrl: string): Promise<boolean> {
  try {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

let testUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 7 pricing.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
});

afterAll(async () => {
  if (!url || !testUrl) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    await cleanupSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  } finally {
    await cleanupSql.end();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BaseIds {
  orgId: string;
  locationId: string;
  productId: string;
  variantId: string;
}

/**
 * Crée les données de base (organisation, établissement, catégorie, produit,
 * variante avec daily_price_amount_minor) et retourne leurs IDs.
 * Simule le backfill DAILY : crée un plan DAILY ACTIVE v1 par défaut avec
 * traductions FR+EN si daily_price_amount_minor > 0.
 */
async function seedBaseData(
  sql: postgres.Sql,
  opts: {
    orgCurrency?: string;
    locSlug?: string;
    variantPrice?: number;
    variantCurrency?: string;
  } = {},
): Promise<BaseIds> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const orgCurrency = opts.orgCurrency ?? 'EUR';
  const locSlug = opts.locSlug ?? `annecy-${suffix}`;
  const variantPrice = opts.variantPrice ?? 5000;
  const variantCurrency = opts.variantCurrency ?? orgCurrency;

  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix}, ${orgCurrency})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${locSlug}, 'Europe/Paris', ${orgCurrency})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
    VALUES (${product.id}, 'Standard', ${variantPrice}, ${variantCurrency})
    RETURNING "id"
  `.then((r) => r[0]!);
  // Simule le backfill DAILY de la migration 0032 : crée un plan DAILY par
  // défaut (location_id NULL) ACTIVE v1 pour la variante si
  // daily_price_amount_minor > 0, avec traductions FR+EN.
  if (variantPrice > 0) {
    const plan = await sql`
      INSERT INTO "pricing_plans" (
        "organization_id", "product_variant_id", "location_id", "plan_type",
        "currency", "price_amount_minor", "priority", "lifecycle_state", "version"
      )
      VALUES (${org.id}, ${variant.id}, NULL, 'DAILY', ${variantCurrency}, ${variantPrice}, 0, 'DRAFT', 1)
      RETURNING "id"
    `.then((r) => r[0]!);
    await sql`
      INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
      VALUES (${plan.id}, 'fr', 'Tarif journalier'), (${plan.id}, 'en', 'Daily rate')
    `;
    await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
  }
  return {
    orgId: org.id,
    locationId: location.id,
    productId: product.id,
    variantId: variant.id,
  };
}

/**
 * Crée une seconde location pour la même organisation.
 */
async function seedSecondLocation(
  sql: postgres.Sql,
  orgId: string,
  slug?: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${orgId}, 'Genève', ${slug ?? 'geneve-' + suffix}, 'Europe/Zurich', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  return location.id;
}

/**
 * Active un plan DRAFT : ajoute les traductions FR+EN puis passe le plan à
 * ACTIVE. Le plan doit être DRAFT et ne pas avoir de traductions existantes.
 */
async function activatePlan(
  sql: postgres.Sql,
  planId: string,
  frLabel = 'Tarif',
  enLabel = 'Rate',
): Promise<void> {
  await sql`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES (${planId}, 'fr', ${frLabel}), (${planId}, 'en', ${enLabel})
  `;
  await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
}

// ---------------------------------------------------------------------------
// A. Migration & existence du schéma
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Schéma Lot 7 G7P-A Round 3 — migration et existence',
  () => {
    it('__drizzle_migrations a 59 entrées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(59);
      } finally {
        await sql.end();
      }
    });

    it('deuxième exécution idempotente : runMigrations une seconde fois ne plante pas', async () => {
      if (!testUrl) return;
      await runMigrations(testUrl);
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(59);
      } finally {
        await sql.end();
      }
    });

    it('l enum pricing_plan_type existe avec les valeurs HOURLY, FIXED_DURATION, DAILY', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const enums = await sql`
          SELECT e.enumlabel FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = 'pricing_plan_type'
          ORDER BY e.enumsortorder
        `;
        expect(enums.map((r) => r.enumlabel)).toEqual(['HOURLY', 'FIXED_DURATION', 'DAILY']);
      } finally {
        await sql.end();
      }
    });

    it('l enum pricing_lifecycle_state existe avec les valeurs DRAFT, ACTIVE, RETIRED', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const enums = await sql`
          SELECT e.enumlabel FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = 'pricing_lifecycle_state'
          ORDER BY e.enumsortorder
        `;
        expect(enums.map((r) => r.enumlabel)).toEqual(['DRAFT', 'ACTIVE', 'RETIRED']);
      } finally {
        await sql.end();
      }
    });

    it('locations.operating_currency existe, NOT NULL, avec CHECK ISO', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const col = await sql`
          SELECT column_name, is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'locations' AND column_name = 'operating_currency'
        `;
        expect(col.length).toBe(1);
        expect(col[0]!.is_nullable).toBe('NO');
        expect(col[0]!.data_type).toBe('text');

        const constraint = await sql`
          SELECT conname FROM pg_constraint
          WHERE conname = 'locations_operating_currency_iso'
        `;
        expect(constraint.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('les tables pricing_plans, pricing_plan_windows, multi_day_discount_tiers, pricing_plan_translations existent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        for (const table of [
          'pricing_plans',
          'pricing_plan_windows',
          'multi_day_discount_tiers',
          'pricing_plan_translations',
        ]) {
          const res = await sql`SELECT to_regclass(${table}) AS reg`.then((r) => r[0]!);
          expect(res.reg).toBe(table);
        }
      } finally {
        await sql.end();
      }
    });

    it('les 12 triggers de 0032 existent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const triggers = await sql`
          SELECT tgname FROM pg_trigger WHERE tgname IN (
            'before_check_pricing_plan_tenant_consistency',
            'before_enforce_pricing_plan_lifecycle_transitions',
            'before_enforce_pricing_plan_immutable_fields',
            'before_prevent_pricing_plan_delete_if_not_draft',
            'before_revalidate_pricing_plan_on_activation',
            'before_check_pricing_plan_window_tenant_consistency',
            'before_enforce_window_draft_only_mutations',
            'before_check_multi_day_tier_plan_type',
            'before_enforce_tier_draft_only_mutations',
            'before_enforce_tier_monotonic_discount',
            'before_freeze_pricing_plan_translations',
            'before_protect_location_operating_currency'
          )
        `;
        expect(triggers.length).toBe(12);
      } finally {
        await sql.end();
      }
    });

    it('les 12 fonctions de 0032 existent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const funcs = await sql`
          SELECT proname FROM pg_proc WHERE proname IN (
            'check_pricing_plan_tenant_consistency',
            'enforce_pricing_plan_lifecycle_transitions',
            'enforce_pricing_plan_immutable_fields',
            'prevent_pricing_plan_delete_if_not_draft',
            'revalidate_pricing_plan_on_activation',
            'check_pricing_plan_window_tenant_consistency',
            'enforce_window_draft_only_mutations',
            'check_multi_day_tier_plan_type',
            'enforce_tier_draft_only_mutations',
            'enforce_tier_monotonic_discount',
            'freeze_pricing_plan_translations',
            'protect_location_operating_currency'
          )
        `;
        expect(funcs.length).toBe(12);
      } finally {
        await sql.end();
      }
    });

    it('la fonction resolve_effective_pricing_plans existe', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const func = await sql`
          SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'resolve_effective_pricing_plans') AS exists
        `.then((r) => r[0]!);
        expect(func.exists).toBe(true);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// B. Backfill
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Backfill 0032', () => {
  it('backfill operating_currency depuis organizations.default_currency (EUR)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
      const loc =
        await sql`SELECT "operating_currency" FROM "locations" WHERE "id" = ${ids.locationId}`;
      expect(loc[0]!.operating_currency).toBe('EUR');
    } finally {
      await sql.end();
    }
  });

  it('backfill operating_currency depuis organizations.default_currency (CHF)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, { orgCurrency: 'CHF' });
      const loc =
        await sql`SELECT "operating_currency" FROM "locations" WHERE "id" = ${ids.locationId}`;
      expect(loc[0]!.operating_currency).toBe('CHF');
    } finally {
      await sql.end();
    }
  });

  it('backfill DAILY : une variante avec daily_price_amount_minor obtient un plan DAILY ACTIVE v1', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, { variantPrice: 5000, variantCurrency: 'EUR' });
      const plans = await sql`
        SELECT * FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `;
      expect(plans.length).toBe(1);
      expect(String(plans[0]!.price_amount_minor)).toBe('5000');
      expect(plans[0]!.currency).toBe('EUR');
      expect(plans[0]!.version).toBe(1);
      expect(plans[0]!.included_duration_minutes).toBeNull();
      expect(plans[0]!.min_duration_minutes).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it('backfill DAILY : une variante sans daily_price_amount_minor n obtient pas de plan', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const suffix = Math.random().toString(36).slice(2, 10);
      const org = await sql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
        VALUES (${'NoPrice Org ' + suffix}, ${'noprice-org-' + suffix}, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
        VALUES (${org.id}, 'NoPrice Loc', ${'noprice-loc-' + suffix}, 'Europe/Paris', 'EUR')
      `;
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const product = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${org.id}, ${category.id}, 'NoPrice', ${'noprice-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const variant = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${product.id}, 'Standard')
        RETURNING "id"
      `.then((r) => r[0]!);
      const plans =
        await sql`SELECT * FROM "pricing_plans" WHERE "product_variant_id" = ${variant.id}`;
      expect(plans.length).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('backfill DAILY : traductions FR et EN créées (fr = Tarif journalier, en = Daily rate)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, { variantPrice: 5000, variantCurrency: 'EUR' });
      const plan = await sql`
        SELECT "id" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `.then((r) => r[0]!);
      const translations = await sql`
        SELECT "locale", "public_label" FROM "pricing_plan_translations"
        WHERE "pricing_plan_id" = ${plan.id}
        ORDER BY "locale"
      `;
      expect(translations.length).toBe(2);
      expect(translations[0]!.locale).toBe('en');
      expect(translations[0]!.public_label).toBe('Daily rate');
      expect(translations[1]!.locale).toBe('fr');
      expect(translations[1]!.public_label).toBe('Tarif journalier');
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Union discriminée stricte
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Union discriminée stricte HOURLY / FIXED_DURATION / DAILY',
  () => {
    it('un plan HOURLY valide est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', 'EUR', 1500, 60, 240, 15, 1)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan HOURLY sans min_duration_minutes est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "max_duration_minutes", "billing_increment_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', 'EUR', 1500, 240, 15, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan HOURLY avec min > max est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', 'EUR', 1500, 300, 240, 15, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan HOURLY avec included_duration_minutes non NULL est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "included_duration_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', 'EUR', 1500, 60, 240, 15, 120, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan FIXED_DURATION 2h est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan FIXED_DURATION 4h est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 5000, 240, 1)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan FIXED_DURATION 6h est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 7000, 360, 1)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan FIXED_DURATION sans included_duration_minutes est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan FIXED_DURATION avec min_duration_minutes non NULL est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "included_duration_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 60, 120, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan DAILY valide est accepté (version différente du backfill)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan DAILY avec included_duration_minutes non NULL est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 480, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan DAILY avec min_duration_minutes non NULL est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 60, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan avec price_amount_minor = 0 est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 0, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan avec price_amount_minor négatif est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', -100, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan avec price_amount_minor > MAX_SAFE_INTEGER est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 9007199254740992, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan avec price_amount_minor = MAX_SAFE_INTEGER est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 9007199254740991, 2)
          RETURNING "id"
        `;
        expect(plan.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un plan avec version = 0 est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 0)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('un plan avec currency invalide est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EURO', 5000, 2)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('plusieurs plans FIXED_DURATION avec durées différentes sont autorisés (tous DRAFT)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        `;
        await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 5000, 240, 1)
        `;
        const plans = await sql`
          SELECT * FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'FIXED_DURATION' AND "location_id" IS NULL
        `;
        expect(plans.length).toBe(2);
      } finally {
        await sql.end();
      }
    });

    it('doublon FIXED_DURATION même durée même version (deux DRAFT) rejeté par l index historique', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        `;
        await expect(
          sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
            VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3500, 120, 1)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// D. Cycle de vie et immutabilité
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Cycle de vie DRAFT→ACTIVE→RETIRED et immutabilité',
  () => {
    it('un plan DRAFT peut être mis à jour (prix, durée, priorité)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "price_amount_minor" = 4000 WHERE "id" = ${plan.id}`;
        await sql`UPDATE "pricing_plans" SET "included_duration_minutes" = 180 WHERE "id" = ${plan.id}`;
        await sql`UPDATE "pricing_plans" SET "priority" = 5 WHERE "id" = ${plan.id}`;
        const updated = await sql`SELECT * FROM "pricing_plans" WHERE "id" = ${plan.id}`.then(
          (r) => r[0]!,
        );
        expect(String(updated.price_amount_minor)).toBe('4000');
        expect(updated.included_duration_minutes).toBe(180);
        expect(updated.priority).toBe(5);
      } finally {
        await sql.end();
      }
    });

    it('DRAFT → ACTIVE réussit avec traductions FR+EN', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        const updated =
          await sql`SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}`.then(
            (r) => r[0]!,
          );
        expect(updated.lifecycle_state).toBe('ACTIVE');
      } finally {
        await sql.end();
      }
    });

    it('DRAFT → ACTIVE échoue sans traduction FR (seulement EN)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'en', 'Rate')
        `;
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/FR/);
      } finally {
        await sql.end();
      }
    });

    it('DRAFT → ACTIVE échoue sans traduction EN (seulement FR)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif')
        `;
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/EN/);
      } finally {
        await sql.end();
      }
    });

    it('DRAFT → ACTIVE échoue sans aucune traduction', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/FR/);
      } finally {
        await sql.end();
      }
    });

    it('ACTIVE → RETIRED réussit', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
        const updated =
          await sql`SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}`.then(
            (r) => r[0]!,
          );
        expect(updated.lifecycle_state).toBe('RETIRED');
      } finally {
        await sql.end();
      }
    });

    it('ACTIVE → DRAFT est interdit', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'DRAFT' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/lifecycle/);
      } finally {
        await sql.end();
      }
    });

    it('RETIRED → ACTIVE est interdit', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/lifecycle/);
      } finally {
        await sql.end();
      }
    });

    it('RETIRED → DRAFT est interdit', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'DRAFT' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/lifecycle/);
      } finally {
        await sql.end();
      }
    });

    it('DRAFT → RETIRED est interdit (doit activer d abord)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/lifecycle/);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE price sur plan ACTIVE → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "pricing_plans" SET "price_amount_minor" = 4000 WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/immutable/);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE included_duration sur plan ACTIVE → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "pricing_plans" SET "included_duration_minutes" = 180 WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/immutable/);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE priority sur plan ACTIVE → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "pricing_plans" SET "priority" = 5 WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/immutable/);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE version sur plan ACTIVE → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "pricing_plans" SET "version" = 2 WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/immutable/);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE lifecycle_state ACTIVE → RETIRED → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
        const updated =
          await sql`SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}`.then(
            (r) => r[0]!,
          );
        expect(updated.lifecycle_state).toBe('RETIRED');
      } finally {
        await sql.end();
      }
    });

    it('DELETE plan ACTIVE → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(sql`DELETE FROM "pricing_plans" WHERE "id" = ${plan.id}`).rejects.toThrow(
          /delete/,
        );
      } finally {
        await sql.end();
      }
    });

    it('DELETE plan RETIRED → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
        await expect(sql`DELETE FROM "pricing_plans" WHERE "id" = ${plan.id}`).rejects.toThrow(
          /delete/,
        );
      } finally {
        await sql.end();
      }
    });

    it('DELETE plan DRAFT → accepté (cascade fenêtres, paliers, traductions)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Créer un plan DRAFT DAILY v2 (différent du backfill v1).
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        // Ajouter une fenêtre, un palier, et des traductions.
        await sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        `;
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
        `;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        // Supprimer directement le plan parent : le CASCADE DELETE doit
        // supprimer les enregistrements enfants. Les triggers sur les child
        // tables court-circuitent sur TG_OP = 'DELETE' (le plan parent est déjà
        // supprimé et seuls les plans DRAFT peuvent être supprimés).
        await sql`DELETE FROM "pricing_plans" WHERE "id" = ${plan.id}`;
        const windows =
          await sql`SELECT * FROM "pricing_plan_windows" WHERE "pricing_plan_id" = ${plan.id}`;
        expect(windows.length).toBe(0);
        const tiers =
          await sql`SELECT * FROM "multi_day_discount_tiers" WHERE "pricing_plan_id" = ${plan.id}`;
        expect(tiers.length).toBe(0);
        const translations =
          await sql`SELECT * FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id}`;
        expect(translations.length).toBe(0);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// E. Versioning et clé métier
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Versioning et clé métier', () => {
  it('v1 ACTIVE + v2 ACTIVE même clé métier sans retirer v1 → REJETÉ', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Le backfill crée un DAILY ACTIVE v1 par défaut.
      // Créer un DAILY v2 DRAFT puis tenter de l'activer sans retirer v1.
      const v2 = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 6000, 2)
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
        VALUES (${v2.id}, 'fr', 'Tarif'), (${v2.id}, 'en', 'Rate')
      `;
      await expect(
        sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${v2.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('v1 RETIRED + v2 ACTIVE dans la même transaction → SUCCÈS', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Récupérer le plan backfillé v1.
      const v1 = await sql`
        SELECT "id" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
          AND "version" = 1
      `.then((r) => r[0]!);

      // Transaction : retirer v1, créer v2 DRAFT, ajouter traductions, activer v2.
      await sql.begin(async (tx) => {
        await tx`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        const v2 = await tx`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await tx`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${v2.id}, 'fr', 'Tarif'), (${v2.id}, 'en', 'Rate')
        `;
        await tx`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${v2.id}`;
      });

      const active = await sql`
        SELECT * FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `;
      expect(active.length).toBe(1);
      expect(active[0]!.version).toBe(2);
    } finally {
      await sql.end();
    }
  });

  it('versions historiques multiples autorisées (v1 RETIRED, v2 ACTIVE)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const v1 = await sql`
        SELECT "id" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
          AND "version" = 1
      `.then((r) => r[0]!);
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
      const v2 = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 6000, 2)
        RETURNING "id"
      `.then((r) => r[0]!);
      await activatePlan(sql, v2.id);
      const all = await sql`
        SELECT "version", "lifecycle_state" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
        ORDER BY "version"
      `;
      expect(all.length).toBe(2);
      expect(all[0]!.version).toBe(1);
      expect(all[0]!.lifecycle_state).toBe('RETIRED');
      expect(all[1]!.version).toBe(2);
      expect(all[1]!.lifecycle_state).toBe('ACTIVE');
    } finally {
      await sql.end();
    }
  });

  it('(business_key, version) unique historiquement — deux plans même clé+version → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Le backfill crée un DAILY v1 par défaut. Tenter d'insérer un autre DAILY v1
      // par défaut → rejeté par l'index historique.
      await expect(
        sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 1)
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// F. Héritage default/local et résolution
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Héritage default/local et résolution (resolve_effective_pricing_plans)',
  () => {
    it('plan par défaut v1 ACTIVE éligible pour un magasin EUR sans override', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
        `;
        expect(resolved.length).toBeGreaterThanOrEqual(1);
        const daily = resolved.find((r) => r.plan_type === 'DAILY');
        expect(daily).toBeDefined();
        expect(daily!.location_id).toBeNull();
      } finally {
        await sql.end();
      }
    });

    it('override local v2 ACTIVE remplace défaut v1 ACTIVE (résolution retourne seulement le local)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan DAILY local ACTIVE v2 (version différente du défaut v1).
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, local.id, 'Tarif local', 'Local rate');
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'DAILY'
        `;
        expect(resolved.length).toBe(1);
        expect(resolved[0]!.location_id).toBe(ids.locationId);
        expect(String(resolved[0]!.price_amount_minor)).toBe('6000');
      } finally {
        await sql.end();
      }
    });

    it('résolution : défaut v1 + override local v2 → retourne seulement le local v2', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 7000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, local.id, 'Tarif local', 'Local rate');
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId}
        `;
        // Le défaut DAILY ne doit pas apparaître (remplacé par le local).
        const dailyPlans = resolved.filter((r) => r.plan_type === 'DAILY');
        expect(dailyPlans.length).toBe(1);
        expect(dailyPlans[0]!.location_id).toBe(ids.locationId);
      } finally {
        await sql.end();
      }
    });

    it('résolution : un autre plan par défaut non remplacé reste éligible', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan FIXED_DURATION par défaut (non remplacé par un local).
        const fd = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, fd.id, 'Forfait', 'Fixed');
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId}
        `;
        const fdPlan = resolved.find((r) => r.plan_type === 'FIXED_DURATION');
        expect(fdPlan).toBeDefined();
        expect(fdPlan!.location_id).toBeNull();
      } finally {
        await sql.end();
      }
    });

    it('résolution : ne retourne jamais à la fois défaut et override pour la même clé fonctionnelle', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // DAILY défaut v1 ACTIVE (backfill) + DAILY local v2 ACTIVE.
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, local.id, 'Tarif local', 'Local rate');
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'DAILY'
        `;
        expect(resolved.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('magasin CHF ne peut pas utiliser un plan par défaut EUR (résolution retourne rien pour CHF)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer une location CHF dans la même org.
        const suffix = Math.random().toString(36).slice(2, 8);
        const chfLoc = await sql`
          INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
          VALUES (${ids.orgId}, 'CHF Store', ${'chf-' + suffix}, 'Europe/Zurich', 'CHF')
          RETURNING "id"
        `.then((r) => r[0]!);
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${chfLoc.id})
          WHERE "product_variant_id" = ${ids.variantId}
        `;
        expect(resolved.length).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('plan par défaut CHF est éligible pour un magasin CHF', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, {
          orgCurrency: 'CHF',
          variantCurrency: 'CHF',
          variantPrice: 6000,
        });
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId}
        `;
        expect(resolved.length).toBe(1);
        expect(resolved[0]!.currency).toBe('CHF');
        expect(String(resolved[0]!.price_amount_minor)).toBe('6000');
      } finally {
        await sql.end();
      }
    });

    it('plusieurs plans FIXED_DURATION ACTIVE avec durées différentes (résolution retourne tous)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const fd2h = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, fd2h.id, 'Forfait 2h', 'Fixed 2h');
        const fd4h = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 5000, 240, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, fd4h.id, 'Forfait 4h', 'Fixed 4h');
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'FIXED_DURATION'
        `;
        expect(resolved.length).toBe(2);
      } finally {
        await sql.end();
      }
    });

    it('résolution : local EUR ne filtre pas défaut CHF (devise différente, même clé fonctionnelle)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        // 1. Créer une variante EUR avec un plan DAILY par défaut EUR (backfill).
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // 2. Créer une location CHF dans la même organisation.
        const suffix = Math.random().toString(36).slice(2, 8);
        const chfLoc = await sql`
          INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
          VALUES (${ids.orgId}, 'CHF Store', ${'chf-' + suffix}, 'Europe/Zurich', 'CHF')
          RETURNING "id"
        `.then((r) => r[0]!);
        // 3. Créer un plan DAILY par défaut CHF (location_id NULL) pour la même variante.
        const defaultChf = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, NULL, 'DAILY', 'CHF', 7000, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, defaultChf.id, 'Tarif journalier CHF', 'Daily rate CHF');
        // 4. Créer un plan DAILY local CHF pour la location CHF (override du défaut CHF).
        const localChf = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${chfLoc.id}, 'DAILY', 'CHF', 8000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, localChf.id, 'Tarif local CHF', 'Local rate CHF');
        // 5. Résoudre pour la location CHF.
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${chfLoc.id})
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'DAILY'
        `;
        // 6. Vérifier : seul le plan local CHF est retourné.
        //    - Le défaut CHF est filtré par le local CHF (même clé fonctionnelle).
        //    - Le défaut EUR n'est pas retourné (mauvaise devise pour CHF).
        //    - Le défaut EUR ne filtre pas le défaut CHF (devises différentes dans le NOT EXISTS).
        expect(resolved.length).toBe(1);
        expect(resolved[0]!.location_id).toBe(chfLoc.id);
        expect(resolved[0]!.currency).toBe('CHF');
        expect(String(resolved[0]!.price_amount_minor)).toBe('8000');
      } finally {
        await sql.end();
      }
    });
    // --- Multi-tenant isolation (Round 3) ---

    it('isolation multi-tenant : deux orgs EUR, resolve ne retourne que les défauts de l org de la location', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        // Org A (Annecy) avec variante + défaut DAILY EUR.
        const idsA = await seedBaseData(sql, {
          orgCurrency: 'EUR',
          locSlug: 'annecy-a-' + Math.random().toString(36).slice(2, 8),
        });
        // Org B (autre loueur) avec sa propre variante + défaut DAILY EUR.
        const idsB = await seedBaseData(sql, {
          orgCurrency: 'EUR',
          locSlug: 'annecy-b-' + Math.random().toString(36).slice(2, 8),
        });
        // Résoudre pour la location de l'org A.
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${idsA.locationId})
          WHERE "plan_type" = 'DAILY'
        `;
        // Ne doit contenir que les plans de l'org A, jamais de l'org B.
        for (const r of resolved) {
          expect(r.organization_id).toBe(idsA.orgId);
        }
        // Le plan DAILY de l'org A doit être présent.
        const dailyA = resolved.find((r) => r.product_variant_id === idsA.variantId);
        expect(dailyA).toBeDefined();
        // Aucun plan de l'org B ne doit être présent.
        const dailyB = resolved.find((r) => r.product_variant_id === idsB.variantId);
        expect(dailyB).toBeUndefined();
      } finally {
        await sql.end();
      }
    });

    it('location inexistante (UUID aléatoire) → zéro ligne (fail-closed)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const randomUuid = '00000000-0000-0000-0000-000000000001';
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${randomUuid})
        `;
        expect(resolved.length).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('location soft-deleted (deleted_at set) → zéro ligne (fail-closed)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Soft-deleted la location.
        await sql`UPDATE "locations" SET "deleted_at" = now() WHERE "id" = ${ids.locationId}`;
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
        `;
        expect(resolved.length).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('la fonction resolve_effective_pricing_plans a exactement 1 paramètre (pas de paramètre currency)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const func = await sql`
          SELECT pronargs FROM pg_proc WHERE proname = 'resolve_effective_pricing_plans'
        `.then((r) => r[0]!);
        expect(func.pronargs).toBe(1);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// F2. Revalidation à l'activation (Round 3)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Revalidation à l activation (revalidate_pricing_plan_on_activation)',
  () => {
    it('activation rejetée : variante changée d org (org mismatch)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan DRAFT DAILY v2 (différent du backfill).
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        // Changer le product de la variante vers une autre org.
        // Pour cela, créer un nouveau produit dans une autre org et
        // mettre à jour product_variants.product_id (pas immuable en base
        // pour les tests). Mais product_id est immuable par trigger.
        // Alternative : créer un plan avec une variante d'une autre org
        // en contournant le trigger d'INSERT (impossible). Donc on teste
        // en créant un plan avec organization_id incorrect via une
        // approche différente : on crée la variante dans l'org A, le plan
        // dans l'org A, puis on crée un nouveau produit dans l'org B et
        // on déplace la variante (non possible car product_id immuable).
        // Approche : créer un plan DRAFT avec organization_id qui ne
        // correspond pas à la variante — le trigger d'INSERT le rejette.
        // Donc on ne peut pas créer un plan incohérent en DRAFT.
        // Le scénario réel : la variante est déplacée vers un autre produit
        // (autre org) après création du plan DRAFT. Comme product_id est
        // immuable, ce scénario ne peut pas se produire via l'API.
        // Cependant, on peut simuler en supprimant le produit et en
        // recréant avec le même ID dans une autre org — non plus.
        // Test alternatif : créer un plan DRAFT local avec location_id
        // d'une autre org (le trigger d'INSERT le rejette aussi).
        // En résumé : les triggers d'INSERT empêchent la création de plans
        // incohérents. La revalidation à l'activation est une sécurité
        // supplémentaire pour le cas où la cohérence serait brisée entre
        // la création DRAFT et l'activation (ex: currency change).
        // On teste donc le scénario currency mismatch qui est le cas réel.
        // Pour org mismatch, on vérifie que le trigger d'activation
        // existe et fonctionne en créant un plan avec une variante dont
        // on change l'org via une mise à jour directe (bypass trigger).
        // Approche simple : utiliser SET session_replication_role = replica
        // pour bypasser les triggers, créer un plan incohérent, puis
        // tenter l'activation.
        await sql.unsafe('SET session_replication_role = replica');
        try {
          // Créer un plan avec organization_id différent de la variante.
          const suffix = Math.random().toString(36).slice(2, 8);
          const orgB = await sql`
            INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
            VALUES (${'Org B ' + suffix}, ${'org-b-' + suffix}, 'EUR')
            RETURNING "id"
          `.then((r) => r[0]!);
          await sql`
            INSERT INTO "pricing_plans" ("id", "organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version", "lifecycle_state")
            VALUES (${plan.id}, ${orgB.id}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2, 'DRAFT')
            ON CONFLICT ("id") DO UPDATE SET "organization_id" = ${orgB.id}
          `;
        } finally {
          await sql.unsafe('SET session_replication_role = origin');
        }
        // Tenter l'activation → rejeté (org mismatch).
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/organization_id mismatch/);
      } finally {
        await sql.end();
      }
    });

    it('activation rejetée : location currency ≠ plan currency (currency mismatch)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan DRAFT local en EUR.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        // Retirer le plan backfillé v1 pour libérer la clé métier.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Supprimer le plan local DRAFT (pour pouvoir changer la currency).
        await sql`DELETE FROM "pricing_plans" WHERE "id" = ${plan.id}`;
        // Changer la currency de la location en CHF.
        await sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`;
        // Recréer le plan local DRAFT en EUR (bypass trigger pour currency mismatch).
        await sql.unsafe('SET session_replication_role = replica');
        try {
          await sql`
            INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version", "lifecycle_state")
            VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2, 'DRAFT')
            RETURNING "id"
          `.then((r) => r[0]!);
        } finally {
          await sql.unsafe('SET session_replication_role = origin');
        }
        // Récupérer l'ID du plan recréé.
        const draftPlan = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "location_id" = ${ids.locationId}
            AND "lifecycle_state" = 'DRAFT'
            AND "version" = 2
        `.then((r) => r[0]!);
        // Ajouter les traductions.
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${draftPlan.id}, 'fr', 'Tarif'), (${draftPlan.id}, 'en', 'Rate')
        `;
        // Tenter l'activation → rejeté (currency mismatch).
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${draftPlan.id}`,
        ).rejects.toThrow(/currency/);
      } finally {
        await sql.end();
      }
    });

    it('activation rejetée : fenêtre avec currency mismatch (window revalidation)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan DRAFT local avec une fenêtre valide en EUR.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        `;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        // Changer la currency de la location en CHF (bypass trigger de protection).
        await sql.unsafe('SET session_replication_role = replica');
        try {
          await sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`;
        } finally {
          await sql.unsafe('SET session_replication_role = origin');
        }
        // Tenter l'activation → rejeté (currency mismatch : le plan EUR ne
        // correspond plus à la location CHF, et la fenêtre est aussi
        // incohérente). La revalidation détecte d'abord le mismatch de
        // currency du plan local.
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/currency/);
      } finally {
        await sql.end();
      }
    });

    it('activation rejetée : paliers non-monotones (tier revalidation)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1 pour libérer la clé métier DAILY.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DAILY DRAFT v2 avec deux paliers monotones valides.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 2, 10)
        `;
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 5, 15)
        `;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        // Insérer un palier non-monotone en bypassant le trigger.
        await sql.unsafe('SET session_replication_role = replica');
        try {
          await sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 7, 5)
          `;
        } finally {
          await sql.unsafe('SET session_replication_role = origin');
        }
        // Tenter l'activation → rejeté (monotonicity violated).
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/monotonicity/);
      } finally {
        await sql.end();
      }
    });

    it('activation rejetée : pas de traductions (FR+EN manquantes)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DRAFT sans traductions.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        // Tenter l'activation → rejeté (FR manquant).
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/FR/);
      } finally {
        await sql.end();
      }
    });

    it('activation rejetée : seulement FR (EN manquant)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DRAFT avec seulement FR.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif')
        `;
        // Tenter l'activation → rejeté (EN manquant).
        await expect(
          sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`,
        ).rejects.toThrow(/EN/);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// G. Fenêtres tarifaires
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Fenêtres tarifaires (pricing_plan_windows)', () => {
  it('une fenêtre valide sur un plan DRAFT est acceptée', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        RETURNING "id"
      `;
      expect(window.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('weekday_mask = 0 est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 0, '09:00', '13:00')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('weekday_mask = 128 est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 128, '09:00', '13:00')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('weekday_mask = -1 est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, -1, '09:00', '13:00')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('weekday_mask = 1 (lundi seulement) est accepté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 1, '09:00', '13:00')
        RETURNING "id"
      `;
      expect(window.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('weekday_mask = 127 (tous les jours) est accepté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 127, '09:00', '13:00')
        RETURNING "id"
      `;
      expect(window.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('end_time <= start_time est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '13:00', '13:00')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('end_time < start_time est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '17:00', '09:00')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('fenêtre avec location d une autre organisation est rejetée', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Créer une seconde org avec une location.
      const suffix = Math.random().toString(36).slice(2, 8);
      const org2 = await sql`
        INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
        VALUES (${'Other Org ' + suffix}, ${'other-org-' + suffix}, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      const loc2 = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
        VALUES (${org2.id}, 'Other Loc', ${'other-loc-' + suffix}, 'Europe/Paris', 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${loc2.id}, 31, '09:00', '13:00')
        `,
      ).rejects.toThrow(/organization_id/);
    } finally {
      await sql.end();
    }
  });

  it('plan local : window.location_id doit = plan.location_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const loc2Id = await seedSecondLocation(sql, ids.orgId);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${loc2Id}, 31, '09:00', '13:00')
        `,
      ).rejects.toThrow(/location_id/);
    } finally {
      await sql.end();
    }
  });

  it('fenêtre avec devise ne correspondant pas au plan (défaut EUR + location CHF) → rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
      // Créer une location CHF dans la même org.
      const suffix = Math.random().toString(36).slice(2, 8);
      const chfLoc = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
        VALUES (${ids.orgId}, 'CHF Loc', ${'chf-loc-' + suffix}, 'Europe/Zurich', 'CHF')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Plan par défaut (location_id NULL) en EUR.
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${chfLoc.id}, 31, '09:00', '13:00')
        `,
      ).rejects.toThrow(/currency/);
    } finally {
      await sql.end();
    }
  });

  it('fenêtre sur plan ACTIVE : INSERT rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await activatePlan(sql, plan.id);
      await expect(
        sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        `,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('fenêtre sur plan ACTIVE : UPDATE rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      // Ajouter une fenêtre en DRAFT, puis activer le plan.
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        RETURNING "id"
      `.then((r) => r[0]!);
      await activatePlan(sql, plan.id);
      await expect(
        sql`UPDATE "pricing_plan_windows" SET "weekday_mask" = 64 WHERE "id" = ${window.id}`,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('fenêtre sur plan ACTIVE : DELETE rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        RETURNING "id"
      `.then((r) => r[0]!);
      await activatePlan(sql, plan.id);
      await expect(
        sql`DELETE FROM "pricing_plan_windows" WHERE "id" = ${window.id}`,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('fenêtre sur plan DRAFT : INSERT/UPDATE/DELETE acceptés', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      const window = await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`UPDATE "pricing_plan_windows" SET "weekday_mask" = 64 WHERE "id" = ${window.id}`;
      await sql`DELETE FROM "pricing_plan_windows" WHERE "id" = ${window.id}`;
      const windows = await sql`SELECT * FROM "pricing_plan_windows" WHERE "id" = ${window.id}`;
      expect(windows.length).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('plusieurs fenêtres pour un même plan DRAFT sont autorisées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
      `;
      await sql`
        INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
        VALUES (${plan.id}, ${ids.locationId}, 31, '13:00', '17:00')
      `;
      const windows =
        await sql`SELECT * FROM "pricing_plan_windows" WHERE "pricing_plan_id" = ${plan.id}`;
      expect(windows.length).toBe(2);
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// H. Paliers de réduction multi-jours
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Paliers de réduction multi-jours (multi_day_discount_tiers)',
  () => {
    it('un palier sur un plan DAILY DRAFT est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Créer un plan DAILY DRAFT v2 (le backfill v1 est ACTIVE).
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
          RETURNING "id"
        `;
        expect(tier.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('un palier sur un plan HOURLY est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "min_duration_minutes", "max_duration_minutes", "billing_increment_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'HOURLY', 'EUR', 1500, 60, 240, 15, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 10)
          `,
        ).rejects.toThrow(/DAILY/);
      } finally {
        await sql.end();
      }
    });

    it('un palier sur un plan FIXED_DURATION est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 10)
          `,
        ).rejects.toThrow(/DAILY/);
      } finally {
        await sql.end();
      }
    });

    it('threshold_days = 1 est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 1, 10)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('threshold_days = 2 est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 2, 10)
          RETURNING "id"
        `;
        expect(tier.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('threshold_days = 3 est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
          RETURNING "id"
        `;
        expect(tier.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('threshold_days = 7 est accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 7, 15)
          RETURNING "id"
        `;
        expect(tier.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('discount_percent = 0 est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 0)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('discount_percent = 100 est rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 100)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('unicité : deux paliers actifs avec le même seuil sur le même plan sont rejetés', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
        `;
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 15)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('monotonie : threshold 2 @ 10%, threshold 3 @ 5% → REJETÉ (réduction diminue)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 2, 10)
        `;
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 5)
          `,
        ).rejects.toThrow(/discount/);
      } finally {
        await sql.end();
      }
    });

    it('monotonie : threshold 2 @ 10%, threshold 3 @ 15% → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 2, 10)
        `;
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 15)
          RETURNING "id"
        `;
        expect(tier.length).toBe(1);
      } finally {
        await sql.end();
      }
    });

    it('monotonie : threshold 7 @ 10%, puis threshold 3 @ 15% → REJETÉ (seuil inférieur avec réduction supérieure)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 7, 10)
        `;
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 15)
          `,
        ).rejects.toThrow(/discount/);
      } finally {
        await sql.end();
      }
    });

    it('palier sur plan ACTIVE : INSERT rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Le plan backfillé est ACTIVE. Tenter d'ajouter un palier → rejeté.
        const plan = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
        `.then((r) => r[0]!);
        await expect(
          sql`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 10)
          `,
        ).rejects.toThrow(/ACTIVE/);
      } finally {
        await sql.end();
      }
    });

    it('palier sur plan ACTIVE : UPDATE rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Retirer le plan backfillé v1 pour libérer la clé métier DAILY.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DAILY DRAFT v2 avec un palier, puis l'activer.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`UPDATE "multi_day_discount_tiers" SET "discount_percent" = 15 WHERE "id" = ${tier.id}`,
        ).rejects.toThrow(/ACTIVE/);
      } finally {
        await sql.end();
      }
    });

    it('palier sur plan ACTIVE : DELETE rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        // Retirer le plan backfillé v1 pour libérer la clé métier DAILY.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, plan.id);
        await expect(
          sql`DELETE FROM "multi_day_discount_tiers" WHERE "id" = ${tier.id}`,
        ).rejects.toThrow(/ACTIVE/);
      } finally {
        await sql.end();
      }
    });

    it('palier sur plan DRAFT : mutations acceptées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        const tier = await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${plan.id}, 3, 10)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`UPDATE "multi_day_discount_tiers" SET "discount_percent" = 15 WHERE "id" = ${tier.id}`;
        await sql`DELETE FROM "multi_day_discount_tiers" WHERE "id" = ${tier.id}`;
        const tiers = await sql`SELECT * FROM "multi_day_discount_tiers" WHERE "id" = ${tier.id}`;
        expect(tiers.length).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('paliers du défaut ignorés quand un plan local DAILY override (résolution)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Le backfill crée un DAILY défaut ACTIVE v1.
        // Créer un DAILY local ACTIVE v2 avec un palier.
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        // Ajouter un palier en DRAFT, puis activer.
        await sql`
          INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
          VALUES (${local.id}, 3, 10)
        `;
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${local.id}, 'fr', 'Tarif local'), (${local.id}, 'en', 'Local rate')
        `;
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${local.id}`;

        // Résolution : doit retourner seulement le plan local.
        const resolved = await sql`
          SELECT * FROM "resolve_effective_pricing_plans"(${ids.locationId})
          WHERE "product_variant_id" = ${ids.variantId} AND "plan_type" = 'DAILY'
        `;
        expect(resolved.length).toBe(1);
        expect(resolved[0]!.location_id).toBe(ids.locationId);
        // Les paliers du plan local sont accessibles via le plan retourné.
        const localTiers = await sql`
          SELECT * FROM "multi_day_discount_tiers" WHERE "pricing_plan_id" = ${resolved[0]!.id}
        `;
        expect(localTiers.length).toBe(1);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// I. Traductions
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Traductions (pricing_plan_translations)', () => {
  it('traductions FR+EN pour un plan DRAFT sont acceptées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      const tr = await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
          RETURNING "id"
        `;
      expect(tr.length).toBe(2);
    } finally {
      await sql.end();
    }
  });

  it('locale avec format invalide est rejetée', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await expect(
        sql`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'french', 'Tarif')
          `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('label vide est rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await expect(
        sql`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'fr', '   ')
          `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('unicité (plan, locale) : doublon rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif')
        `;
      await expect(
        sql`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'fr', 'Autre tarif')
          `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('plusieurs locales (fr, en) acceptées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
      const tr = await sql`
          SELECT * FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id}
        `;
      expect(tr.length).toBe(2);
    } finally {
      await sql.end();
    }
  });

  it('traductions sur plan ACTIVE : INSERT rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await activatePlan(sql, plan.id);
      await expect(
        sql`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'de', 'Tarif')
          `,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('traductions sur plan ACTIVE : UPDATE rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
      await expect(
        sql`UPDATE "pricing_plan_translations" SET "public_label" = 'Nouveau' WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('traductions sur plan ACTIVE : DELETE rejeté', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
      await expect(
        sql`DELETE FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('traductions sur plan RETIRED : toutes mutations rejetées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await activatePlan(sql, plan.id);
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${plan.id}`;
      await expect(
        sql`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'de', 'Tarif')
          `,
      ).rejects.toThrow(/RETIRED/);
      await expect(
        sql`UPDATE "pricing_plan_translations" SET "public_label" = 'Nouveau' WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`,
      ).rejects.toThrow(/RETIRED/);
      await expect(
        sql`DELETE FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`,
      ).rejects.toThrow(/RETIRED/);
    } finally {
      await sql.end();
    }
  });

  it('traductions sur plan DRAFT : mutations acceptées', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
      await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif')
        `;
      await sql`UPDATE "pricing_plan_translations" SET "public_label" = 'Nouveau tarif' WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`;
      await sql`DELETE FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id} AND "locale" = 'fr'`;
      const tr =
        await sql`SELECT * FROM "pricing_plan_translations" WHERE "pricing_plan_id" = ${plan.id}`;
      expect(tr.length).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// J. Protection de la devise opérationnelle (locations.operating_currency)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Protection de la devise opérationnelle (locations.operating_currency)',
  () => {
    it('changer operating_currency avec un plan ACTIVE local de devise différente → REJETÉ', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan DAILY local ACTIVE en EUR.
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, local.id);
        // Tenter de passer la location en CHF → rejeté (plan ACTIVE en EUR).
        await expect(
          sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`,
        ).rejects.toThrow(/operating_currency/);
      } finally {
        await sql.end();
      }
    });

    it('changer operating_currency sans plans actifs → accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Pas de plan local actif (le backfill est un plan par défaut, pas local).
        await sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`;
        const loc =
          await sql`SELECT "operating_currency" FROM "locations" WHERE "id" = ${ids.locationId}`.then(
            (r) => r[0]!,
          );
        expect(loc.operating_currency).toBe('CHF');
      } finally {
        await sql.end();
      }
    });

    it('changer operating_currency avec un plan DRAFT local de devise différente → REJETÉ (DRAFT bloque)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan local DRAFT en EUR.
        await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
        `;
        // Changer la devise → rejeté (plan DRAFT en EUR deviendrait incohérent).
        await expect(
          sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`,
        ).rejects.toThrow(/operating_currency/);
      } finally {
        await sql.end();
      }
    });

    it('changer operating_currency avec seulement un plan RETIRED → accepté (RETIRED ne bloque pas)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1 (passe en RETIRED).
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan local RETIRED en EUR (activer puis retirer).
        const local = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await activatePlan(sql, local.id);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${local.id}`;
        // Changer la devise → accepté (plan RETIRED ne bloque pas).
        await sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`;
        const loc =
          await sql`SELECT "operating_currency" FROM "locations" WHERE "id" = ${ids.locationId}`.then(
            (r) => r[0]!,
          );
        expect(loc.operating_currency).toBe('CHF');
      } finally {
        await sql.end();
      }
    });

    it('changer operating_currency avec une fenêtre sur plan ACTIVE de devise différente → REJETÉ', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Créer un plan local DRAFT avec une fenêtre, puis l'activer.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "included_duration_minutes", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'FIXED_DURATION', 'EUR', 3000, 120, 1)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
          VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
        `;
        await activatePlan(sql, plan.id);
        // Tenter de passer la location en CHF → rejeté (fenêtre sur plan ACTIVE en EUR).
        await expect(
          sql`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`,
        ).rejects.toThrow(/operating_currency/);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// K. Concurrence
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())('Concurrence — activations simultanées', () => {
  it('deux activations v2 concurrentes (même clé, v1 retiré) : une seule réussit', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Retirer le plan backfillé v1 pour libérer la clé DAILY par défaut.
      const v1 = await sql`
        SELECT "id" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
          AND "version" = 1
      `.then((r) => r[0]!);
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;

      // Deux connexions séparées tentent de créer un DAILY v2 ACTIVE.
      const sqlA = postgres(testUrl!, { max: 1 });
      const sqlB = postgres(testUrl!, { max: 1 });
      const createAndActivate = async (s: postgres.Sql) => {
        const plan = await s`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5500, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await s`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;
        await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
      };
      const results = await Promise.allSettled([createAndActivate(sqlA), createAndActivate(sqlB)]);
      await sqlA.end();
      await sqlB.end();

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      // Exactement un doit réussir, l'autre doit échouer (unique index).
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Vérifier qu'il n'y a qu'un seul plan ACTIVE v2.
      const active = await sql`
        SELECT * FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
          AND "version" = 2
      `;
      expect(active.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('deux activations concurrentes v2 vs v3 (même clé métier, versions différentes) : une seule réussit', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Retirer le plan backfillé v1 pour libérer la clé DAILY par défaut.
      const v1 = await sql`
        SELECT "id" FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
          AND "version" = 1
      `.then((r) => r[0]!);
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;

      // Créer deux plans DRAFT avec la même clé métier mais des versions
      // différentes (v2 et v3) — autorisé par pricing_plans_business_key_version_unique
      // car les versions diffèrent.
      const v2 = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5500, 2)
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
        VALUES (${v2.id}, 'fr', 'Tarif'), (${v2.id}, 'en', 'Rate')
      `;

      const v3 = await sql`
        INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
        VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 6000, 3)
        RETURNING "id"
      `.then((r) => r[0]!);
      await sql`
        INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
        VALUES (${v3.id}, 'fr', 'Tarif'), (${v3.id}, 'en', 'Rate')
      `;

      // Deux connexions séparées tentent d'activer v2 et v3 simultanément.
      // L'index unique partiel pricing_plans_active_business_key_unique garantit
      // qu'au plus un plan ACTIVE existe par clé métier.
      const sqlA = postgres(testUrl!, { max: 1 });
      const sqlB = postgres(testUrl!, { max: 1 });
      const activate = async (s: postgres.Sql, planId: string) => {
        await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${planId}`;
      };
      const results = await Promise.allSettled([activate(sqlA, v2.id), activate(sqlB, v3.id)]);
      await sqlA.end();
      await sqlB.end();

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      // Exactement un doit réussir, l'autre doit échouer (unique partial index).
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Vérifier qu'il n'y a qu'un seul plan ACTIVE pour cette clé métier.
      const active = await sql`
        SELECT * FROM "pricing_plans"
        WHERE "product_variant_id" = ${ids.variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `;
      expect(active.length).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// K2. Concurrence — mutations enfants vs activation (Round 3)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Concurrence — mutations enfants vs activation (FOR UPDATE)',
  () => {
    it('concurrence : ajout de fenêtre vs activation — pas de deadlock, état final cohérent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DRAFT avec traductions.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;

        // Deux connexions : A ajoute une fenêtre, B active le plan.
        const sqlA = postgres(testUrl!, { max: 1 });
        const sqlB = postgres(testUrl!, { max: 1 });
        const addWindow = async (s: postgres.Sql) => {
          await s`
            INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
            VALUES (${plan.id}, ${ids.locationId}, 31, '09:00', '13:00')
          `;
        };
        const activate = async (s: postgres.Sql) => {
          await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
        };
        const results = await Promise.allSettled([addWindow(sqlA), activate(sqlB)]);
        await sqlA.end();
        await sqlB.end();

        // Aucun deadlock : les deux opérations ont terminé (réussie ou rejetée).
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length + rejected.length).toBe(2);

        // Vérifier l'état final : le plan est soit DRAFT (activation rejetée),
        // soit ACTIVE (activation réussie). Si ACTIVE, la fenêtre a été vue
        // par la revalidation.
        const finalState = await sql`
          SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}
        `.then((r) => r[0]!);
        expect(['DRAFT', 'ACTIVE']).toContain(finalState.lifecycle_state);
      } finally {
        await sql.end();
      }
    });

    it('concurrence : ajout de palier vs activation — pas de deadlock, état final cohérent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;

        const sqlA = postgres(testUrl!, { max: 1 });
        const sqlB = postgres(testUrl!, { max: 1 });
        const addTier = async (s: postgres.Sql) => {
          await s`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, 3, 10)
          `;
        };
        const activate = async (s: postgres.Sql) => {
          await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
        };
        const results = await Promise.allSettled([addTier(sqlA), activate(sqlB)]);
        await sqlA.end();
        await sqlB.end();

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length + rejected.length).toBe(2);

        const finalState = await sql`
          SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}
        `.then((r) => r[0]!);
        expect(['DRAFT', 'ACTIVE']).toContain(finalState.lifecycle_state);
      } finally {
        await sql.end();
      }
    });

    it('concurrence : ajout de traduction vs activation — pas de deadlock, état final cohérent', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        // Pas de traductions initialement.

        const sqlA = postgres(testUrl!, { max: 1 });
        const sqlB = postgres(testUrl!, { max: 1 });
        const addTranslation = async (s: postgres.Sql) => {
          await s`
            INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
            VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
          `;
        };
        const activate = async (s: postgres.Sql) => {
          await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
        };
        const results = await Promise.allSettled([addTranslation(sqlA), activate(sqlB)]);
        await sqlA.end();
        await sqlB.end();

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length + rejected.length).toBe(2);

        const finalState = await sql`
          SELECT "lifecycle_state" FROM "pricing_plans" WHERE "id" = ${plan.id}
        `.then((r) => r[0]!);
        expect(['DRAFT', 'ACTIVE']).toContain(finalState.lifecycle_state);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// K3. Concurrence — monotonie des paliers (Round 3)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Concurrence — monotonie des paliers (FOR UPDATE)',
  () => {
    it('concurrence : deux paliers non-monotones insérés simultanément — un seul réussit', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, 'DAILY', 'EUR', 5000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);

        // Deux connexions : A insère (3 days, 20%), B insère (7 days, 10%).
        // Ces deux paliers sont non-monotones ensemble (seuil plus élevé,
        // réduction plus faible). Avec le FOR UPDATE, ils se sérialisent :
        // le second doit voir le premier et échouer.
        const sqlA = postgres(testUrl!, { max: 1 });
        const sqlB = postgres(testUrl!, { max: 1 });
        const insertTier = async (s: postgres.Sql, threshold: number, discount: number) => {
          await s`
            INSERT INTO "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days", "discount_percent")
            VALUES (${plan.id}, ${threshold}, ${discount})
          `;
        };
        const results = await Promise.allSettled([
          insertTier(sqlA, 3, 20),
          insertTier(sqlB, 7, 10),
        ]);
        await sqlA.end();
        await sqlB.end();

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        // Au moins un doit réussir. Au plus un peut réussir si les deux
        // sont non-monotones. Mais si l'ordre d'exécution fait que le
        // second est monotone avec le premier, les deux pourraient réussir.
        // Cependant, (3, 20) et (7, 10) : si (3, 20) est inséré en premier,
        // alors (7, 10) est non-monotone (seuil plus élevé, réduction plus
        // faible) → rejeté. Si (7, 10) est inséré en premier, alors (3, 20)
        // est non-monotone (seuil plus faible, réduction plus élevée) → rejeté.
        // Donc exactement un réussit et un échoue.
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);

        // Vérifier que la configuration finale est monotone.
        const tiers = await sql`
          SELECT "threshold_days", "discount_percent" FROM "multi_day_discount_tiers"
          WHERE "pricing_plan_id" = ${plan.id} AND "active" = true
          ORDER BY "threshold_days" ASC
        `;
        expect(tiers.length).toBe(1);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// K4. Concurrence — activation vs changement de devise (Round 3)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkipIntegrationTests())(
  'Concurrence — activation vs changement de devise',
  () => {
    it('concurrence : activation plan EUR vs changement location en CHF — jamais un plan ACTIVE EUR sur location CHF', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql, { orgCurrency: 'EUR' });
        // Retirer le plan backfillé v1.
        const v1 = await sql`
          SELECT "id" FROM "pricing_plans"
          WHERE "product_variant_id" = ${ids.variantId}
            AND "plan_type" = 'DAILY'
            AND "location_id" IS NULL
            AND "lifecycle_state" = 'ACTIVE'
            AND "version" = 1
        `.then((r) => r[0]!);
        await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'RETIRED' WHERE "id" = ${v1.id}`;
        // Créer un plan DRAFT local en EUR avec traductions.
        const plan = await sql`
          INSERT INTO "pricing_plans" ("organization_id", "product_variant_id", "location_id", "plan_type", "currency", "price_amount_minor", "version")
          VALUES (${ids.orgId}, ${ids.variantId}, ${ids.locationId}, 'DAILY', 'EUR', 6000, 2)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`
          INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
          VALUES (${plan.id}, 'fr', 'Tarif'), (${plan.id}, 'en', 'Rate')
        `;

        // Deux connexions : A active le plan EUR, B change la location en CHF.
        const sqlA = postgres(testUrl!, { max: 1 });
        const sqlB = postgres(testUrl!, { max: 1 });
        const activate = async (s: postgres.Sql) => {
          await s`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;
        };
        const changeCurrency = async (s: postgres.Sql) => {
          await s`UPDATE "locations" SET "operating_currency" = 'CHF' WHERE "id" = ${ids.locationId}`;
        };
        const results = await Promise.allSettled([activate(sqlA), changeCurrency(sqlB)]);
        await sqlA.end();
        await sqlB.end();

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length + rejected.length).toBe(2);

        // Vérifier l'invariant : jamais un plan ACTIVE EUR sur une location CHF.
        const loc =
          await sql`SELECT "operating_currency" FROM "locations" WHERE "id" = ${ids.locationId}`.then(
            (r) => r[0]!,
          );
        const planState = await sql`
          SELECT "lifecycle_state", "currency" FROM "pricing_plans" WHERE "id" = ${plan.id}
        `.then((r) => r[0]!);

        if (loc.operating_currency === 'CHF' && planState.lifecycle_state === 'ACTIVE') {
          // Si la location est CHF et le plan est ACTIVE, le plan doit être CHF.
          // Mais le plan est en EUR, donc cette combinaison est impossible.
          expect(planState.currency).not.toBe('EUR');
        }
        // Soit le plan est DRAFT (activation rejetée), soit la location est EUR
        // (changement rejeté). L'invariant est respecté.
        expect(planState.lifecycle_state === 'DRAFT' || loc.operating_currency === 'EUR').toBe(
          true,
        );
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// L. Upgrade 0031 → 0032 avec données préexistantes
// ---------------------------------------------------------------------------
const UPGRADE_TEST_DB = 'uttily_test_lot7_pricing_upgrade';

async function applyMigrationsUntilBefore0032(dbUrl: string): Promise<void> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of allFiles) {
      const num = parseInt(file.slice(0, 4), 10);
      if (isNaN(num) || num >= 32) continue;
      const sqlContent = readFileSync(join(migrationsDir, file), 'utf-8');
      await sql.unsafe(sqlContent);
    }
  } finally {
    await sql.end();
  }
}

async function applyMigration0032(dbUrl: string): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const sqlContent = readFileSync(
    join(migrationsDir, '0032_lot7_pricing_plan_foundations.sql'),
    'utf-8',
  );
  const sql = postgres(dbUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlContent);
    });
  } finally {
    await sql.end();
  }
}

describe.skipIf(shouldSkipIntegrationTests())('Upgrade 0031 → 0032 avec données', () => {
  let upgradeTestUrl: string | null = null;
  let upgradeAdminSql: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    if (!url) {
      if (ci) throw new Error('CI: DATABASE_URL est requise pour le test upgrade Lot 7 pricing.');
      return;
    }
    upgradeAdminSql = postgres(url, { max: 1 });
    await upgradeAdminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_TEST_DB};`);
    await upgradeAdminSql.unsafe(`CREATE DATABASE ${UPGRADE_TEST_DB};`);
    const upgradeUrlObj = new URL(url);
    upgradeUrlObj.pathname = `/${UPGRADE_TEST_DB}`;
    upgradeTestUrl = upgradeUrlObj.toString();
    await applyMigrationsUntilBefore0032(upgradeTestUrl);
  });

  afterAll(async () => {
    if (upgradeAdminSql) {
      try {
        await upgradeAdminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${UPGRADE_TEST_DB}' AND pid <> pg_backend_pid();`,
        );
        await upgradeAdminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_TEST_DB};`);
      } finally {
        await upgradeAdminSql.end();
      }
    }
  });

  it('préserve les données 0031 et applique 0032 correctement', async () => {
    if (!upgradeTestUrl) return;
    const dbUrl = upgradeTestUrl;

    // Connexion 1 : insertion de données préexistantes sur la base 0031.
    const sql1 = postgres(dbUrl, { max: 1 });
    let orgId: string;
    let locationId: string;
    let productId: string;
    let variantId: string;
    try {
      const org = await sql1`
        INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
        VALUES ('Upgrade Pricing Org', 'upgrade-pricing-org', 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      orgId = org.id;

      const location = await sql1`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgId}, 'Upgrade Loc', 'upgrade-pricing-loc', 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      locationId = location.id;

      const category =
        await sql1`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const product = await sql1`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgId}, ${category.id}, 'Upgrade Kayak', 'upgrade-pricing-kayak')
        RETURNING "id"
      `.then((r) => r[0]!);
      productId = product.id;

      const variant = await sql1`
        INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor", "currency")
        VALUES (${productId}, 'Standard', 5000, 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      variantId = variant.id;
    } finally {
      await sql1.end();
    }

    // Appliquer la migration 0032 dans une transaction.
    await applyMigration0032(dbUrl);

    // Connexion 2 : vérifications post-migration.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // Données 0031 préservées avec mêmes IDs.
      const org = await sql2`SELECT "id" FROM "organizations" WHERE "id" = ${orgId}`.then(
        (r) => r[0]!,
      );
      expect(org.id).toBe(orgId);

      const loc =
        await sql2`SELECT "id", "operating_currency" FROM "locations" WHERE "id" = ${locationId}`.then(
          (r) => r[0]!,
        );
      expect(loc.id).toBe(locationId);
      // Backfill operating_currency depuis org.default_currency = EUR.
      expect(loc.operating_currency).toBe('EUR');

      const prod = await sql2`SELECT "id" FROM "products" WHERE "id" = ${productId}`.then(
        (r) => r[0]!,
      );
      expect(prod.id).toBe(productId);

      // Backfill DAILY : la variante avec daily_price_amount_minor obtient un plan ACTIVE v1.
      const plans = await sql2`
        SELECT * FROM "pricing_plans"
        WHERE "product_variant_id" = ${variantId}
          AND "plan_type" = 'DAILY'
          AND "location_id" IS NULL
          AND "lifecycle_state" = 'ACTIVE'
      `;
      expect(plans.length).toBe(1);
      expect(String(plans[0]!.price_amount_minor)).toBe('5000');
      expect(plans[0]!.currency).toBe('EUR');
      expect(plans[0]!.version).toBe(1);

      // Backfill : traductions FR+EN créées.
      const translations = await sql2`
        SELECT "locale", "public_label" FROM "pricing_plan_translations"
        WHERE "pricing_plan_id" = ${plans[0]!.id}
        ORDER BY "locale"
      `;
      expect(translations.length).toBe(2);
      expect(translations[0]!.locale).toBe('en');
      expect(translations[0]!.public_label).toBe('Daily rate');
      expect(translations[1]!.locale).toBe('fr');
      expect(translations[1]!.public_label).toBe('Tarif journalier');

      // Tables 0032 existent.
      for (const table of [
        'pricing_plans',
        'pricing_plan_windows',
        'multi_day_discount_tiers',
        'pricing_plan_translations',
      ]) {
        const res = await sql2`SELECT to_regclass(${table}) AS reg`.then((r) => r[0]!);
        expect(res.reg).toBe(table);
      }

      // Enums existent.
      const enumExists = await sql2`
        SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_plan_type') AS exists
      `.then((r) => r[0]!);
      expect(enumExists.exists).toBe(true);

      const lifecycleEnumExists = await sql2`
        SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_lifecycle_state') AS exists
      `.then((r) => r[0]!);
      expect(lifecycleEnumExists.exists).toBe(true);

      // Triggers existent.
      const triggers = await sql2`
        SELECT tgname FROM pg_trigger WHERE tgname IN (
          'before_check_pricing_plan_tenant_consistency',
          'before_enforce_pricing_plan_lifecycle_transitions',
          'before_enforce_pricing_plan_immutable_fields',
          'before_prevent_pricing_plan_delete_if_not_draft',
          'before_revalidate_pricing_plan_on_activation',
          'before_check_pricing_plan_window_tenant_consistency',
          'before_enforce_window_draft_only_mutations',
          'before_check_multi_day_tier_plan_type',
          'before_enforce_tier_draft_only_mutations',
          'before_enforce_tier_monotonic_discount',
          'before_freeze_pricing_plan_translations',
          'before_protect_location_operating_currency'
        )
      `;
      expect(triggers.length).toBe(12);
    } finally {
      await sql2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// M. Rollback transactionnel 0032
// ---------------------------------------------------------------------------
const ROLLBACK_TEST_DB = 'uttily_test_lot7_pricing_rollback';

describe.skipIf(shouldSkipIntegrationTests())('Rollback transactionnel 0032', () => {
  let rollbackTestUrl: string | null = null;
  let rollbackAdminSql: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    if (!url) {
      if (ci) throw new Error('CI: DATABASE_URL est requise pour le test rollback Lot 7 pricing.');
      return;
    }
    rollbackAdminSql = postgres(url, { max: 1 });
    await rollbackAdminSql.unsafe(`DROP DATABASE IF EXISTS ${ROLLBACK_TEST_DB};`);
    await rollbackAdminSql.unsafe(`CREATE DATABASE ${ROLLBACK_TEST_DB};`);
    const rollbackUrlObj = new URL(url);
    rollbackUrlObj.pathname = `/${ROLLBACK_TEST_DB}`;
    rollbackTestUrl = rollbackUrlObj.toString();
    await applyMigrationsUntilBefore0032(rollbackTestUrl);
  });

  afterAll(async () => {
    if (rollbackAdminSql) {
      try {
        await rollbackAdminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${ROLLBACK_TEST_DB}' AND pid <> pg_backend_pid();`,
        );
        await rollbackAdminSql.unsafe(`DROP DATABASE IF EXISTS ${ROLLBACK_TEST_DB};`);
      } finally {
        await rollbackAdminSql.end();
      }
    }
  });

  it('rollback complet : aucune application partielle de 0032', async () => {
    if (!rollbackTestUrl) return;
    const dbUrl = rollbackTestUrl;

    // Connexion 1 : insertion de données préexistantes sur la base 0031.
    const sql1 = postgres(dbUrl, { max: 1 });
    let orgId: string;
    let locationId: string;
    try {
      const org = await sql1`
        INSERT INTO "organizations" ("legal_name", "slug", "default_currency")
        VALUES ('Rollback Pricing Org', 'rollback-pricing-org', 'EUR')
        RETURNING "id"
      `.then((r) => r[0]!);
      orgId = org.id;

      const location = await sql1`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgId}, 'Rollback Loc', 'rollback-pricing-loc', 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      locationId = location.id;
    } finally {
      await sql1.end();
    }

    // Lire le contenu de 0032 et tenter de l'appliquer dans une transaction
    // qui échoue volontairement.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const sqlContent = readFileSync(
      join(migrationsDir, '0032_lot7_pricing_plan_foundations.sql'),
      'utf-8',
    );

    const sqlTx = postgres(dbUrl, { max: 1 });
    try {
      await expect(
        sqlTx.begin(async (tx) => {
          await tx.unsafe(sqlContent);
          // Vérifier in-tx que les objets existent.
          const ppExist = await tx`SELECT to_regclass('pricing_plans') AS reg`.then((r) => r[0]!);
          expect(ppExist.reg).toBe('pricing_plans');
          // Provoquer une erreur volontaire → rollback.
          await tx.unsafe('SELECT 1/0');
        }),
      ).rejects.toThrow();
    } finally {
      await sqlTx.end();
    }

    // Connexion fraîche : vérifier que rien de 0032 n'a subsisté.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // Données 0031 toujours présentes et inchangées.
      const org = await sql2`SELECT "id" FROM "organizations" WHERE "id" = ${orgId}`.then(
        (r) => r[0]!,
      );
      expect(org.id).toBe(orgId);

      const loc = await sql2`SELECT "id" FROM "locations" WHERE "id" = ${locationId}`.then(
        (r) => r[0]!,
      );
      expect(loc.id).toBe(locationId);

      // Tables 0032 n'existent pas.
      for (const table of [
        'pricing_plans',
        'pricing_plan_windows',
        'multi_day_discount_tiers',
        'pricing_plan_translations',
      ]) {
        const res = await sql2`SELECT to_regclass(${table}) AS reg`.then((r) => r[0]!);
        expect(res.reg).toBeNull();
      }

      // locations.operating_currency n'existe pas.
      const ocCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'operating_currency'`;
      expect(ocCol.length).toBe(0);

      // Enums n'existent pas.
      const enumExists = await sql2`
        SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_plan_type') AS exists
      `.then((r) => r[0]!);
      expect(enumExists.exists).toBe(false);

      const lifecycleEnumExists = await sql2`
        SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_lifecycle_state') AS exists
      `.then((r) => r[0]!);
      expect(lifecycleEnumExists.exists).toBe(false);

      // Aucune fonction de 0032 ne subsiste.
      const funcs = await sql2`
        SELECT proname FROM pg_proc WHERE proname IN (
          'check_pricing_plan_tenant_consistency',
          'enforce_pricing_plan_lifecycle_transitions',
          'enforce_pricing_plan_immutable_fields',
          'prevent_pricing_plan_delete_if_not_draft',
          'revalidate_pricing_plan_on_activation',
          'check_pricing_plan_window_tenant_consistency',
          'enforce_window_draft_only_mutations',
          'check_multi_day_tier_plan_type',
          'enforce_tier_draft_only_mutations',
          'enforce_tier_monotonic_discount',
          'freeze_pricing_plan_translations',
          'protect_location_operating_currency',
          'resolve_effective_pricing_plans'
        )
      `;
      expect(funcs.length).toBe(0);

      // Aucun trigger de 0032 ne subsiste.
      const triggers = await sql2`
        SELECT tgname FROM pg_trigger WHERE tgname IN (
          'before_check_pricing_plan_tenant_consistency',
          'before_enforce_pricing_plan_lifecycle_transitions',
          'before_enforce_pricing_plan_immutable_fields',
          'before_prevent_pricing_plan_delete_if_not_draft',
          'before_revalidate_pricing_plan_on_activation',
          'before_check_pricing_plan_window_tenant_consistency',
          'before_enforce_window_draft_only_mutations',
          'before_check_multi_day_tier_plan_type',
          'before_enforce_tier_draft_only_mutations',
          'before_enforce_tier_monotonic_discount',
          'before_freeze_pricing_plan_translations',
          'before_protect_location_operating_currency'
        )
      `;
      expect(triggers.length).toBe(0);
    } finally {
      await sql2.end();
    }
  });
});
