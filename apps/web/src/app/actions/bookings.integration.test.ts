import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { createBookingDraftAction } from './bookings';
import * as auth from '@/lib/auth';
import * as dbModule from '@/lib/db';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_web_bookings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

describe.skipIf(shouldSkip)(
  'createBookingDraftAction — intégration PostgreSQL & concurrence',
  () => {
    let db: DatabaseClient;
    let rawSql: Sql;
    let testUrl: string | null = null;

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
      rawSql = postgres(testUrl, { max: 10 });
      vi.mocked(dbModule.getDb).mockReturnValue(db);
    }, 600000);

    afterAll(async () => {
      if (db) {
        await db.$client.end();
      }
      if (rawSql) {
        await rawSql.end();
      }
      if (!sourceUrl || !testUrl) return;
      const admin = postgres(sourceUrl, { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
      await admin.end();
    });

    interface SeedResult {
      customerId: string;
      orgId: string;
      publicProductId: string;
      productId: string;
      publicLocationId: string;
      locationId: string;
      variantId: string;
      publicVariantId: string;
      inventoryItemId: string;
    }

    async function seedFixture(
      sql: postgres.Sql,
      opts: {
        tag?: string;
        inventoryCount?: number;
        orgDeleted?: boolean;
        countryActive?: boolean;
        seedPhotos?: boolean;
      } = {},
    ): Promise<SeedResult> {
      const tag = (opts.tag ?? Math.random().toString(36).slice(2, 8))
        .toLowerCase()
        .replace(/_/g, '-');
      const inventoryCount = opts.inventoryCount ?? 1;
      const countryActive = opts.countryActive ?? true;
      const shouldSeedPhotos = opts.seedPhotos ?? true;

      // Customer User
      const user = await sql`
      INSERT INTO "users" ("email", "oidc_subject", "oidc_provider", "display_name")
      VALUES (${`cust-${tag}@example.com`}, ${`sub-${tag}`}, 'clerk', ${`Cust ${tag}`})
      RETURNING "id"
    `.then((r) => r[0]!);

      // Country
      await sql`
      INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
      VALUES ('FR', ${countryActive}, 'EUR', 'fr-FR')
      ON CONFLICT ("country_code") DO UPDATE SET "is_active" = ${countryActive}
    `;

      // Org
      const org = await sql`
      INSERT INTO "organizations" ("legal_name", "public_display_name", "slug", "deleted_at")
      VALUES (${'Org ' + tag}, ${'Loueur ' + tag}, ${'org-' + tag}, ${opts.orgDeleted ? sql`now()` : null})
      RETURNING "id"
    `.then((r) => r[0]!);

      // Category
      const cat = await sql`
      INSERT INTO "categories" ("name", "slug", "is_active")
      VALUES (${'Cat ' + tag}, ${'cat-' + tag}, true)
      ON CONFLICT ("slug") DO UPDATE SET "is_active" = true
      RETURNING "id"
    `.then((r) => r[0]!);

      // Location
      const loc = await sql`
      INSERT INTO "locations" (
        "organization_id", "name", "slug", "time_zone", "operating_currency",
        "address_line1", "city", "postal_code", "country_code",
        "geo_point", "pickup_enabled", "is_publicly_listed"
      )
      VALUES (
        ${org.id}, ${'Magasin ' + tag}, ${'loc-' + tag}, 'Europe/Paris', 'EUR',
        '10 Rue de la Paix', 'Paris', '75001', 'FR',
        ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326),
        true, true
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

      // Horaires d'ouverture
      for (let w = 0; w <= 6; w++) {
        await sql`
        INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
        VALUES (${loc.id}, ${w}, '07:00:00', '21:00:00')
      `;
      }

      // Produit
      const prod = await sql`
      INSERT INTO "products" (
        "organization_id", "category_id", "name", "slug", "description",
        "publication_status"
      )
      VALUES (
        ${org.id}, ${cat.id}, ${'Produit ' + tag}, ${'prod-' + tag}, 'Description',
        'DRAFT'
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

      // Photos
      if (shouldSeedPhotos) {
        for (let i = 0; i < 3; i++) {
          await sql`
          INSERT INTO product_photos (
            organization_id, product_id, storage_key,
            content_type, byte_size, width_px, height_px, checksum_sha256,
            sort_order, file_state
          )
          VALUES (
            ${org.id}, ${prod.id}, ${'product-photos/' + tag + '-' + i},
            'image/jpeg', 102400, 800, 600, ${('000' + i).repeat(16).slice(0, 64)},
            ${i}, 'AVAILABLE'
          )
        `;
        }
      }

      await sql`UPDATE "products" SET "publication_status" = 'PUBLISHED' WHERE "id" = ${prod.id}`;

      // Variante
      const variant = await sql`
      INSERT INTO "product_variants" ("product_id", "name", "is_active", "daily_price_amount_minor", "currency")
      VALUES (${prod.id}, 'Standard', true, 5000, 'EUR')
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

      // Plan tarifaire
      const plan = await sql`
      INSERT INTO "pricing_plans" (
        "organization_id", "product_variant_id", "location_id", "plan_type",
        "currency", "price_amount_minor", "lifecycle_state", "version"
      )
      VALUES (
        ${org.id}, ${variant.id}, ${loc.id}, 'DAILY',
        'EUR', 5000, 'DRAFT', 1
      )
      RETURNING "id"
    `.then((r) => r[0]!);

      await sql`
      INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
      VALUES (${plan.id}, 'fr', 'Tarif standard'), (${plan.id}, 'en', 'Standard rate')
    `;

      await sql`
      INSERT INTO "pricing_plan_windows" ("pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time")
      VALUES (${plan.id}, ${loc.id}, 127, '08:00:00', '20:00:00')
    `;
      await sql`UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE' WHERE "id" = ${plan.id}`;

      // Exemplaires inventaire physique
      let firstItemId = '';
      for (let i = 0; i < inventoryCount; i++) {
        const item = await sql`
        INSERT INTO "inventory_items" (
          "organization_id", "product_variant_id", "internal_sku", "condition", "status", "current_location_id"
        )
        VALUES (
          ${org.id}, ${variant.id}, ${`SKU-${tag}-${i}`}, 'NEW', 'ACTIVE', ${loc.id}
        )
        RETURNING "id"
      `.then((r) => r[0]!);
        if (i === 0) firstItemId = item.id;
      }

      return {
        customerId: user.id as string,
        orgId: org.id as string,
        productId: prod.id as string,
        publicProductId: prod.public_id as string,
        locationId: loc.id as string,
        publicLocationId: loc.public_id as string,
        variantId: variant.id as string,
        publicVariantId: variant.public_id as string,
        inventoryItemId: firstItemId,
      };
    }

    it('1. Happy path : Crée un booking draft avec hold atomique et retourne redirectUrl', async () => {
      const f = await seedFixture(rawSql, { tag: 'hp' });

      vi.mocked(auth.getAuthenticatedUser).mockResolvedValue({
        id: f.customerId,
        email: 'cust-hp@example.com',
        oidcSubject: 'sub-hp',
        emailVerified: true,
        isPlatformAdmin: false,
      });

      const res = await createBookingDraftAction({
        publicProductId: f.publicProductId,
        publicLocationId: f.publicLocationId,
        publicVariantId: f.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-01', endDateExclusive: '2026-09-03' },
        idempotencyKey: crypto.randomUUID(),
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data.draftId).toBeDefined();
      expect(res.data.redirectUrl).toBe(`/checkout/${res.data.draftId}`);

      // Vérifier la persistance dans PostgreSQL
      const draftRows = await rawSql`
      SELECT "id", "status", "customer_user_id", "total_amount_minor"
      FROM "booking_drafts"
      WHERE "id" = ${res.data.draftId}::uuid
    `;
      expect(draftRows).toHaveLength(1);
      expect(draftRows[0]!.status).toBe('HELD');
      expect(draftRows[0]!.customer_user_id).toBe(f.customerId);
      expect(Number(draftRows[0]!.total_amount_minor)).toBe(10000);
    });

    it('2. Concurrence réelle déterministe : 2 utilisateurs distincts tentent le dernier exemplaire simultanément', async () => {
      const f = await seedFixture(rawSql, { tag: 'race', inventoryCount: 1 });

      const user1 = {
        id: f.customerId,
        email: 'cust-race1@example.com',
        oidcSubject: 'sub-race1',
        emailVerified: true,
        isPlatformAdmin: false,
      };

      const user2Row = await rawSql`
      INSERT INTO "users" ("email", "oidc_subject", "oidc_provider", "display_name")
      VALUES ('cust-race2@example.com', 'sub-race2', 'clerk', 'Cust Race 2')
      RETURNING "id"
    `.then((r) => r[0]!);

      const user2 = {
        id: user2Row.id as string,
        email: 'cust-race2@example.com',
        oidcSubject: 'sub-race2',
        emailVerified: true,
        isPlatformAdmin: false,
      };

      // Configuration déterministe de l'authentification par appel
      vi.mocked(auth.getAuthenticatedUser)
        .mockResolvedValueOnce(user1)
        .mockResolvedValueOnce(user2);

      const [res1, res2] = await Promise.all([
        createBookingDraftAction({
          publicProductId: f.publicProductId,
          publicLocationId: f.publicLocationId,
          publicVariantId: f.publicVariantId,
          quantity: 1,
          intent: { kind: 'DAY_RANGE', startDate: '2026-09-10', endDateExclusive: '2026-09-12' },
          idempotencyKey: crypto.randomUUID(),
        }),
        createBookingDraftAction({
          publicProductId: f.publicProductId,
          publicLocationId: f.publicLocationId,
          publicVariantId: f.publicVariantId,
          quantity: 1,
          intent: { kind: 'DAY_RANGE', startDate: '2026-09-10', endDateExclusive: '2026-09-12' },
          idempotencyKey: crypto.randomUUID(),
        }),
      ]);

      const successes = [res1, res2].filter((r) => r.ok);
      const failures = [res1, res2].filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect((failures[0] as { code: string }).code).toBe('CONFLICT_BLOCK');

      // Vérifier qu'un seul draft HELD existe pour ce produit
      const activeDrafts = await rawSql`
      SELECT count(*)::int AS count
      FROM booking_drafts d
      JOIN booking_draft_lines dl ON dl.draft_id = d.id
      WHERE dl.variant_id = ${f.variantId}::uuid
        AND d.status = 'HELD'
    `.then((r) => r[0]!.count);
      expect(activeDrafts).toBe(1);
    });

    it('3. Idempotence : un second appel avec la même idempotencyKey rejoue le résultat sans hold supplémentaire', async () => {
      const f = await seedFixture(rawSql, { tag: 'idem' });

      vi.mocked(auth.getAuthenticatedUser).mockResolvedValue({
        id: f.customerId,
        email: 'cust-idem@example.com',
        oidcSubject: 'sub-idem',
        emailVerified: true,
        isPlatformAdmin: false,
      });

      const key = crypto.randomUUID();

      const res1 = await createBookingDraftAction({
        publicProductId: f.publicProductId,
        publicLocationId: f.publicLocationId,
        publicVariantId: f.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-20', endDateExclusive: '2026-09-22' },
        idempotencyKey: key,
      });

      expect(res1.ok).toBe(true);

      const res2 = await createBookingDraftAction({
        publicProductId: f.publicProductId,
        publicLocationId: f.publicLocationId,
        publicVariantId: f.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-20', endDateExclusive: '2026-09-22' },
        idempotencyKey: key,
      });

      expect(res2.ok).toBe(true);
      if (res1.ok && res2.ok) {
        expect(res2.data.draftId).toBe(res1.data.draftId);
        expect(res2.data.redirectUrl).toBe(res1.data.redirectUrl);
      }

      const count = await rawSql`
      SELECT count(*)::int AS count FROM "idempotency_records" WHERE "key" = ${key}
    `.then((r) => r[0]!.count);
      expect(count).toBe(1);
    });

    it('4. Gardes d’éligibilité cohérentes : refuse l’accès direct à une offre invalide', async () => {
      // A. Organisation supprimée
      const fOrgDel = await seedFixture(rawSql, { tag: 'orgdel', orgDeleted: true });
      vi.mocked(auth.getAuthenticatedUser).mockResolvedValue({
        id: fOrgDel.customerId,
        email: 'cust-guard@example.com',
        oidcSubject: 'sub-guard',
        emailVerified: true,
        isPlatformAdmin: false,
      });

      const resOrgDel = await createBookingDraftAction({
        publicProductId: fOrgDel.publicProductId,
        publicLocationId: fOrgDel.publicLocationId,
        publicVariantId: fOrgDel.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-25', endDateExclusive: '2026-09-27' },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(resOrgDel.ok).toBe(false);
      if (!resOrgDel.ok) expect(resOrgDel.code).toBe('NOT_FOUND');

      // B. Pays inactif
      const fBadCtry = await seedFixture(rawSql, { tag: 'badctry', countryActive: false });
      const resBadCtry = await createBookingDraftAction({
        publicProductId: fBadCtry.publicProductId,
        publicLocationId: fBadCtry.publicLocationId,
        publicVariantId: fBadCtry.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-25', endDateExclusive: '2026-09-27' },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(resBadCtry.ok).toBe(false);
      if (!resBadCtry.ok) expect(resBadCtry.code).toBe('NOT_FOUND');

      // C. Mismatch tenant entre produit et établissement
      const f1 = await seedFixture(rawSql, { tag: 'mismatch1' });
      const f2 = await seedFixture(rawSql, { tag: 'mismatch2' });
      const resMismatch = await createBookingDraftAction({
        publicProductId: f1.publicProductId,
        publicLocationId: f2.publicLocationId,
        publicVariantId: f1.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-25', endDateExclusive: '2026-09-27' },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(resMismatch.ok).toBe(false);
      if (!resMismatch.ok) expect(resMismatch.code).toBe('NOT_FOUND');

      // D. Variante d'un autre produit
      const resWrongVariant = await createBookingDraftAction({
        publicProductId: f1.publicProductId,
        publicLocationId: f1.publicLocationId,
        publicVariantId: f2.publicVariantId,
        quantity: 1,
        intent: { kind: 'DAY_RANGE', startDate: '2026-09-25', endDateExclusive: '2026-09-27' },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(resWrongVariant.ok).toBe(false);
      if (!resWrongVariant.ok) expect(resWrongVariant.code).toBe('NOT_FOUND');
    });
  },
);
