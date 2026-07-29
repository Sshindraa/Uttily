import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 4 (ADR-009).
 *
 * Vérifie les contraintes CHECK, UNIQUE et les valeurs par défaut des tables
 * booking_drafts, booking_draft_lines, allocations, idempotency_records ainsi
 * que les colonnes ajoutées sur organizations, locations et product_variants.
 *
 * Reprend la stratégie de setup de migrate.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot4';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 4.');
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

interface BaseIds {
  orgId: string;
  locationId: string;
  userId: string;
  variantId: string;
  itemId: string;
  blockId: string;
}

/**
 * Crée les données de base (organisation, établissement, utilisateur, catégorie,
 * produit, variante, exemplaire, bloc d'inventaire) et retourne leurs IDs.
 * Le suffixe garantit l'unicité des slugs/emails entre les tests.
 */
async function seedBaseData(
  sql: postgres.Sql,
  suffix = Math.random().toString(36).slice(2, 10),
): Promise<BaseIds> {
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris')
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
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name")
    VALUES (${product.id}, 'Standard')
    RETURNING "id"
  `.then((r) => r[0]!);
  const item = await sql`
    INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
    VALUES (${org.id}, ${variant.id}, ${'KAY-' + suffix}, ${location.id})
    RETURNING "id"
  `.then((r) => r[0]!);
  // Dates choisies en janvier 2026 pour le bloc seedé. Les tests qui créent
  // des blocs supplémentaires utilisent des plages en février 2026 pour
  // éviter les conflits avec no_overlapping_blocks sur le même inventory_item_id.
  const block = await sql`
    INSERT INTO "inventory_blocks" (
      "organization_id", "inventory_item_id", "type", "status",
      "customer_start_at", "customer_end_at",
      "blocked_start_at", "blocked_end_at", "expires_at"
    )
    VALUES (
      ${org.id}, ${item.id}, 'HOLD', 'ACTIVE',
      '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
      '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00', '2026-01-09 12:00:00+00'
    )
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    variantId: variant.id,
    itemId: item.id,
    blockId: block.id,
  };
}

interface DraftPayload {
  customer_start_at: string;
  customer_end_at: string;
  blocked_start_at: string;
  blocked_end_at: string;
  timezone: string;
  prep_buffer_minutes: number;
  cleanup_buffer_minutes: number;
  subtotal_amount_minor: number;
  mandatory_fees_amount_minor: number;
  total_amount_minor: number;
  tax_status: string;
  tax_amount_minor: number | null;
  tax_rate_bps: number | null;
  commission_amount_minor: number | null;
  billable_unit: string;
  billable_unit_count: number;
  currency: string;
  cancellation_policy_snapshot: { policy_code: string; policy_version: string; timezone: string };
}

/**
 * Construit un payload valide pour booking_drafts et permet de surcharger
 * certains champs pour tester les contraintes CHECK.
 */
function validDraftPayload(overrides: Partial<DraftPayload> = {}): DraftPayload {
  return {
    customer_start_at: '2026-01-10 09:00:00+00',
    customer_end_at: '2026-01-12 17:00:00+00',
    blocked_start_at: '2026-01-10 08:30:00+00',
    blocked_end_at: '2026-01-12 17:30:00+00',
    timezone: 'Europe/Paris',
    prep_buffer_minutes: 30,
    cleanup_buffer_minutes: 30,
    subtotal_amount_minor: 10000,
    mandatory_fees_amount_minor: 0,
    total_amount_minor: 10000,
    tax_status: 'UNDETERMINED',
    tax_amount_minor: null,
    tax_rate_bps: null,
    commission_amount_minor: null,
    billable_unit: 'DAY',
    billable_unit_count: 2,
    currency: 'EUR',
    cancellation_policy_snapshot: {
      policy_code: 'FLEXIBLE',
      policy_version: '1',
      timezone: 'Europe/Paris',
    },
    ...overrides,
  };
}

/**
 * Insère un brouillon de réservation à partir d'un payload et des IDs de base.
 */
function insertDraft(sql: postgres.Sql, ids: BaseIds, p: DraftPayload) {
  return sql`
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
      ${p.customer_start_at}, ${p.customer_end_at},
      ${p.blocked_start_at}, ${p.blocked_end_at},
      ${p.timezone}, ${p.prep_buffer_minutes}, ${p.cleanup_buffer_minutes},
      ${p.subtotal_amount_minor}, ${p.mandatory_fees_amount_minor}, ${p.total_amount_minor},
      ${p.tax_status}, ${p.tax_amount_minor}, ${p.tax_rate_bps}, ${p.commission_amount_minor},
      ${p.billable_unit}, ${p.billable_unit_count},
      ${p.currency}, ${sql.json(p.cancellation_policy_snapshot)}
    )
    RETURNING "id", "status"
  `;
}

describe.skipIf(shouldSkipIntegrationTests())('Schéma Lot 4 — contraintes PostgreSQL', () => {
  it('crée un brouillon de réservation valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      expect(draft).toBeDefined();
      expect(draft.status).toBe('DRAFT');
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec customer_end_at <= customer_start_at (customer_period_valid)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({
        customer_start_at: '2026-01-12 17:00:00+00',
        customer_end_at: '2026-01-10 09:00:00+00',
      });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon où blocked_start_at > customer_start_at (blocked_includes_customer)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({
        blocked_start_at: '2026-01-10 10:00:00+00',
        customer_start_at: '2026-01-10 09:00:00+00',
      });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec total_amount_minor < 0 (total_nonneg)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ total_amount_minor: -1 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un brouillon avec tax_status='UNDETERMINED' et tax_amount_minor non NULL (tax_undetermined_null)", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ tax_status: 'UNDETERMINED', tax_amount_minor: 500 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un brouillon avec tax_status='NOT_APPLICABLE' et tax_amount_minor != 0 (tax_not_applicable_zero)", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ tax_status: 'NOT_APPLICABLE', tax_amount_minor: 500 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un brouillon avec tax_status='APPLIED' et tax_amount_minor IS NULL (tax_applied_not_null)", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ tax_status: 'APPLIED', tax_amount_minor: null });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un doublon idempotency_records (organization_id, operation, key)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée un PENDING valide (avec pending_timeout_at, sans réponse).
      await sql`
        INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at")
        VALUES (${ids.orgId}, 'create_draft', 'key-001', ${'a'.repeat(64)}, 'PENDING', now() + interval '5 minutes')
      `;
      // Tente d'insérer avec la même (org, operation, key) → doit échouer.
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at")
          VALUES (${ids.orgId}, 'create_draft', 'key-001', ${'b'.repeat(64)}, 'PENDING', now() + interval '5 minutes')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette deux allocations avec le même inventory_block_id (unique)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un bloc HOLD lié au brouillon (source_id = draft.id).
      const holdBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      // La première allocation réussit.
      await sql`
        INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
        VALUES (${line.id}, ${holdBlock.id})
      `;
      // La seconde allocation réutilise le même inventory_block_id → doit échouer
      // (contrainte unique allocations_inventory_block_unique).
      // Note : il faut une seconde ligne pour éviter la contrainte (draft_line_id, inventory_block_id).
      const line2 = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line2.id}, ${holdBlock.id})
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('product_variants daily_price_positive : rejette prix = 0, accepte NULL et prix > 0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'surf' LIMIT 1`.then(
        (r) => r[0]!,
      );
      const product = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${ids.orgId}, ${category.id}, 'Planche', 'planche')
        RETURNING "id"
      `.then((r) => r[0]!);

      // Prix = 0 → doit échouer.
      await expect(
        sql`
          INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor")
          VALUES (${product.id}, 'Zero', 0)
        `,
      ).rejects.toThrow();

      // Prix NULL → doit réussir.
      const vNull = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${product.id}, 'NullPrice')
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(vNull).toBeDefined();

      // Prix > 0 → doit réussir.
      const vPos = await sql`
        INSERT INTO "product_variants" ("product_id", "name", "daily_price_amount_minor")
        VALUES (${product.id}, 'Positive', 5000)
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(vPos).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it("organizations : default_cancellation_policy_code = 'FLEXIBLE' par défaut", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const org = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES ('Policy Test Org', 'policy-test-org')
        RETURNING "default_cancellation_policy_code"
      `.then((r) => r[0]!);
      expect(org.default_cancellation_policy_code).toBe('FLEXIBLE');
    } finally {
      await sql.end();
    }
  });

  it('locations : prep_buffer_minutes = 30 et cleanup_buffer_minutes = 30 par défaut', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const org = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES ('Buffer Test Org', 'buffer-test-org')
        RETURNING "id"
      `.then((r) => r[0]!);
      const location = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${org.id}, 'Chamonix', 'chamonix', 'Europe/Paris')
        RETURNING "prep_buffer_minutes", "cleanup_buffer_minutes"
      `.then((r) => r[0]!);
      expect(location.prep_buffer_minutes).toBe(30);
      expect(location.cleanup_buffer_minutes).toBe(30);
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon dont location_id appartient à une autre organisation (trigger multi-tenant)', async () => {
    // Crée deux organisations, un location dans la première, tente de créer un brouillon
    // dans la seconde organisation avec le location de la première → doit échouer.
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgA = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org A ' + suffix}, ${'org-a-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Location rattachée à orgA.
      const locationA = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgA.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Utilisateur client.
      const user = await sql`
        INSERT INTO "users" ("email")
        VALUES (${'customer-mt-' + suffix + '@example.com'})
        RETURNING "id"
      `.then((r) => r[0]!);

      // Tente de créer un brouillon dans orgB avec le location de orgA → trigger doit rejeter.
      const payload = validDraftPayload();
      await expect(
        sql`
          INSERT INTO "booking_drafts" (
            "organization_id", "location_id", "customer_user_id",
            "customer_start_at", "customer_end_at",
            "blocked_start_at", "blocked_end_at",
            "timezone", "prep_buffer_minutes", "cleanup_buffer_minutes",
            "subtotal_amount_minor", "mandatory_fees_amount_minor", "total_amount_minor",
            "tax_status", "tax_amount_minor",
            "billable_unit", "billable_unit_count",
            "currency", "cancellation_policy_snapshot"
          )
          VALUES (
            ${orgB.id}, ${locationA.id}, ${user.id},
            ${payload.customer_start_at}, ${payload.customer_end_at},
            ${payload.blocked_start_at}, ${payload.blocked_end_at},
            ${payload.timezone}, ${payload.prep_buffer_minutes}, ${payload.cleanup_buffer_minutes},
            ${payload.subtotal_amount_minor}, ${payload.mandatory_fees_amount_minor}, ${payload.total_amount_minor},
            ${payload.tax_status}, ${payload.tax_amount_minor},
            ${payload.billable_unit}, ${payload.billable_unit_count},
            ${payload.currency}, ${sql.json(payload.cancellation_policy_snapshot)}
          )
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une ligne de brouillon dont la variante appartient à une autre organisation (trigger multi-tenant)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée une seconde organisation avec son propre produit/variante.
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const productB = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgB.id}, ${category.id}, 'Kayak B', ${'kayak-b-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const variantB = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${productB.id}, 'Standard B')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un brouillon dans org A (ids.orgId).
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      // Tente d'insérer une ligne avec la variante de org B → doit échouer.
      await expect(
        sql`
          INSERT INTO "booking_draft_lines" (
            "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
            "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
          )
          VALUES (${draft.id}, ${variantB.id}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard B' })})
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation dont le bloc appartient à une autre organisation (trigger cohérence)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée une seconde organisation avec son propre exemplaire et bloc.
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgB = await sql`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES (${'Org B ' + suffix}, ${'org-b-alloc-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const locB = await sql`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgB.id}, 'Loc B', ${'loc-b-' + suffix}, 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      const category =
        await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const productB = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgB.id}, ${category.id}, 'Kayak B', ${'kayak-b-alloc-' + suffix})
        RETURNING "id"
      `.then((r) => r[0]!);
      const variantB = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${productB.id}, 'Standard B')
        RETURNING "id"
      `.then((r) => r[0]!);
      const itemB = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${orgB.id}, ${variantB.id}, ${'KAY-B-' + suffix}, ${locB.id})
        RETURNING "id"
      `.then((r) => r[0]!);
      const blockB = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${orgB.id}, ${itemB.id}, 'HOLD', 'ACTIVE',
          '2026-01-10 09:00:00+00', '2026-01-12 17:00:00+00',
          '2026-01-10 08:30:00+00', '2026-01-12 17:30:00+00', '2026-01-09 12:00:00+00', gen_random_uuid()
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un brouillon dans org A avec une ligne valide.
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Tente d'allouer le bloc de org B à la ligne de org A → doit échouer.
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${blockB.id})
        `,
      ).rejects.toThrow(/n'appartient pas à la même organisation/);
    } finally {
      await sql.end();
    }
  });

  it("rejette une allocation dont le bloc n'est pas lié au brouillon (source_id mismatch)", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Le bloc seedé a un source_id NULL (pas lié à un brouillon).
      // Crée un brouillon et une ligne, puis tente d'allouer le bloc seedé.
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Le bloc seedé n'a pas source_id = draft.id → doit échouer.
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${ids.blockId})
        `,
      ).rejects.toThrow(/source_id/);
    } finally {
      await sql.end();
    }
  });

  it("rejette une allocation dont le bloc n'est pas de type HOLD", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée un brouillon et une ligne.
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un bloc BOOKING lié au brouillon (source_id = draft.id).
      const bookingBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'BOOKING', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      // Tente d'allouer le bloc BOOKING → doit échouer (pas HOLD).
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${bookingBlock.id})
        `,
      ).rejects.toThrow(/HOLD/);
    } finally {
      await sql.end();
    }
  });

  it('rejette un idempotency_record avec status invalide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at")
          VALUES (${ids.orgId}, 'create_draft', 'key-bad-status', ${'a'.repeat(64)}, 'INVALID', now() + interval '5 minutes')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un idempotency_record avec empreinte non hex64', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at")
          VALUES (${ids.orgId}, 'create_draft', 'key-bad-fp', 'not-a-hash', 'PENDING', now() + interval '5 minutes')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un idempotency_record PENDING sans pending_timeout_at', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status")
          VALUES (${ids.orgId}, 'create_draft', 'key-no-timeout', ${'a'.repeat(64)}, 'PENDING')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un idempotency_record COMPLETED sans resource_id', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "response_status_code", "response_body", "completed_at")
          VALUES (${ids.orgId}, 'create_draft', 'key-completed-no-res', ${'a'.repeat(64)}, 'COMPLETED', 201, ${sql.json({ ok: true })}, now())
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon où total != subtotal + mandatory_fees', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({
        subtotal_amount_minor: 10000,
        mandatory_fees_amount_minor: 500,
        total_amount_minor: 10000,
      });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un brouillon avec billable_unit != 'DAY'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ billable_unit: 'HOUR' });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette un brouillon avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ currency: 'USD' });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec billable_unit_count = 0', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ billable_unit_count: 0 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un idempotency_record FAILED sans response_body', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      await expect(
        sql`
          INSERT INTO "idempotency_records" ("organization_id", "operation", "key", "request_fingerprint", "status", "response_status_code", "completed_at")
          VALUES (${ids.orgId}, 'create_draft', 'key-failed-no-body', ${'a'.repeat(64)}, 'FAILED', 422, now())
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec total_amount_minor > Number.MAX_SAFE_INTEGER', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // 9007199254740992 = MAX_SAFE_INTEGER + 1
      const payload = validDraftPayload({
        subtotal_amount_minor: 9007199254740992,
        mandatory_fees_amount_minor: 0,
        total_amount_minor: 9007199254740992,
      });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte une allocation valide (brouillon HELD, bloc HOLD/ACTIVE lié, variante correspondante)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un bloc HOLD/ACTIVE lié au brouillon, sur le même exemplaire (même variante).
      const holdBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      const allocation = await sql`
        INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
        VALUES (${line.id}, ${holdBlock.id})
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(allocation).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it("rejette une allocation où l'exemplaire du bloc ne correspond pas à la variante de la ligne", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Crée une seconde variante du même produit.
      const variant2 = await sql`
        INSERT INTO "product_variants" ("product_id", "name")
        VALUES (${(await sql`SELECT "product_id" FROM "product_variants" WHERE "id" = ${ids.variantId}`.then((r) => r[0]!)).product_id}, 'Premium')
        RETURNING "id"
      `.then((r) => r[0]!);
      // Crée un second exemplaire de la seconde variante.
      const item2 = await sql`
        INSERT INTO "inventory_items" ("organization_id", "product_variant_id", "internal_sku", "current_location_id")
        VALUES (${ids.orgId}, ${variant2.id}, ${'KAY-PREMIUM-' + Math.random().toString(36).slice(2, 8)}, ${ids.locationId})
        RETURNING "id"
      `.then((r) => r[0]!);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      // Ligne avec la variante originale.
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Bloc sur le second exemplaire (variante Premium), lié au brouillon.
      const holdBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${item2.id}, 'HOLD', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      // Allocation : ligne=variante Standard, bloc=exemplaire Premium → doit échouer.
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${holdBlock.id})
        `,
      ).rejects.toThrow(/ne correspond pas à la variante/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation avec un bloc non ACTIVE (RELEASED)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      await sql`UPDATE "booking_drafts" SET "status" = 'HELD', "expires_at" = now() + interval '10 minutes' WHERE "id" = ${draft.id}`;
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      // Bloc HOLD mais RELEASED, lié au brouillon.
      const releasedBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'HOLD', 'RELEASED',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${releasedBlock.id})
        `,
      ).rejects.toThrow(/ACTIVE/);
    } finally {
      await sql.end();
    }
  });

  it('rejette une allocation avec un brouillon non HELD (DRAFT)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      // Brouillon reste en statut DRAFT (pas de UPDATE vers HELD).
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      const line = await sql`
        INSERT INTO "booking_draft_lines" (
          "draft_id", "variant_id", "quantity", "unit_price_amount_minor",
          "billable_unit_count", "line_total_amount_minor", "variant_snapshot"
        )
        VALUES (${draft.id}, ${ids.variantId}, 1, 5000, 2, 10000, ${sql.json({ name: 'Standard' })})
        RETURNING "id"
      `.then((r) => r[0]!);
      const holdBlock = await sql`
        INSERT INTO "inventory_blocks" (
          "organization_id", "inventory_item_id", "type", "status",
          "customer_start_at", "customer_end_at",
          "blocked_start_at", "blocked_end_at", "expires_at", "source_id"
        )
        VALUES (
          ${ids.orgId}, ${ids.itemId}, 'HOLD', 'ACTIVE',
          '2026-02-10 09:00:00+00', '2026-02-12 17:00:00+00',
          '2026-02-10 08:30:00+00', '2026-02-12 17:30:00+00', '2026-02-09 12:00:00+00', ${draft.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "allocations" ("draft_line_id", "inventory_block_id")
          VALUES (${line.id}, ${holdBlock.id})
        `,
      ).rejects.toThrow(/HELD/);
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon HELD avec expires_at NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      // Tente de passer en HELD sans expires_at → doit échouer.
      await expect(
        sql`UPDATE "booking_drafts" SET "status" = 'HELD' WHERE "id" = ${draft.id}`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec tax_amount_minor négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ tax_status: 'APPLIED', tax_amount_minor: -1 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon avec commission_amount_minor négatif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ commission_amount_minor: -1 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('rejette un brouillon UNDETERMINED avec tax_rate_bps non NULL', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const payload = validDraftPayload({ tax_rate_bps: 2000 });
      await expect(insertDraft(sql, ids, payload)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejette une variante avec currency != 'EUR'", async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'surf' LIMIT 1`.then(
        (r) => r[0]!,
      );
      const product = await sql`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${ids.orgId}, ${category.id}, 'Planche USD', 'planche-usd')
        RETURNING "id"
      `.then((r) => r[0]!);
      await expect(
        sql`
          INSERT INTO "product_variants" ("product_id", "name", "currency")
          VALUES (${product.id}, 'USD Variant', 'USD')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it('accepte un idempotency_record COMPLETED valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const draft = await insertDraft(sql, ids, validDraftPayload()).then((r) => r[0]!);
      const record = await sql`
        INSERT INTO "idempotency_records" (
          "organization_id", "operation", "key", "request_fingerprint", "status",
          "resource_id", "response_status_code", "response_body", "completed_at"
        )
        VALUES (
          ${ids.orgId}, 'create_draft', 'key-completed-ok', ${'a'.repeat(64)}, 'COMPLETED',
          ${draft.id}, 201, ${sql.json({ ok: true })}, now()
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(record).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it('accepte un idempotency_record FAILED valide', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const ids = await seedBaseData(sql);
      const record = await sql`
        INSERT INTO "idempotency_records" (
          "organization_id", "operation", "key", "request_fingerprint", "status",
          "response_status_code", "response_body", "completed_at"
        )
        VALUES (
          ${ids.orgId}, 'create_draft', 'key-failed-ok', ${'a'.repeat(64)}, 'FAILED',
          422, ${sql.json({ error: 'insufficient_inventory' })}, now()
        )
        RETURNING "id"
      `.then((r) => r[0]!);
      expect(record).toBeDefined();
    } finally {
      await sql.end();
    }
  });
});
