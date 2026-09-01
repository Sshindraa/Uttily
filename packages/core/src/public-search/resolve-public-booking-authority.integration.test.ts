import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { resolvePublicBookingAuthority } from './resolve-public-booking-authority';
import type { PublicProductPublicationGate } from './types';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_auth_resolver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)('resolvePublicBookingAuthority — intégration PostgreSQL', () => {
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
    orgId: string;
    publicProductId: string;
    productId: string;
    publicLocationId: string;
    locationId: string;
    variant1Id: string;
    variant1PublicId: string;
    variant2Id: string;
    variant2PublicId: string;
  }

  async function seedResolverFixture(
    sql: postgres.Sql,
    opts: {
      tag?: string;
      publicationStatus?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      productDeleted?: boolean;
      orgDeleted?: boolean;
      locationDeleted?: boolean;
      isPubliclyListed?: boolean;
      pickupEnabled?: boolean;
      countryActive?: boolean;
      variant1Active?: boolean;
      variant1Deleted?: boolean;
      seedPhotos?: boolean;
    } = {},
  ): Promise<SeedResult> {
    const tag = (opts.tag ?? Math.random().toString(36).slice(2, 8))
      .toLowerCase()
      .replace(/_/g, '-');
    const targetPubStatus = opts.publicationStatus ?? 'PUBLISHED';
    const countryActive = opts.countryActive ?? true;
    const shouldSeedPhotos = opts.seedPhotos ?? targetPubStatus === 'PUBLISHED';

    // 1. Pays
    const countryCode = 'FR';
    await sql`
      INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
      VALUES (${countryCode}, ${countryActive}, 'EUR', 'fr-FR')
      ON CONFLICT ("country_code") DO UPDATE SET "is_active" = ${countryActive}
    `;

    // 2. Organisation
    const org = await sql`
      INSERT INTO "organizations" (
        "legal_name", "public_display_name", "slug", "deleted_at"
      )
      VALUES (
        ${'Legal Org ' + tag}, ${'Loueur Pro ' + tag}, ${'org-' + tag},
        ${opts.orgDeleted ? sql`now()` : null}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    // 3. Catégorie commerciale active
    const cat = await sql`
      SELECT "id" FROM "categories" WHERE "slug" = 'kayak' LIMIT 1
    `.then((r) => r[0]!);

    // 4. Établissement
    const isPubliclyListed = opts.isPubliclyListed ?? true;
    const pickupEnabled = opts.pickupEnabled ?? true;
    const locationDeleted = opts.locationDeleted ?? false;
    const effectiveIsPubliclyListed = isPubliclyListed && pickupEnabled && !locationDeleted;

    const loc = await sql`
      INSERT INTO "locations" (
        "organization_id", "name", "slug", "time_zone", "operating_currency",
        "address_line1", "city", "postal_code", "country_code",
        "geo_point", "pickup_enabled", "is_publicly_listed", "deleted_at"
      )
      VALUES (
        ${org.id}, ${'Magasin ' + tag}, ${'loc-' + tag}, 'Europe/Paris', 'EUR',
        '10 Rue de la Paix', 'Paris', '75001', ${countryCode},
        ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326),
        ${pickupEnabled},
        ${effectiveIsPubliclyListed},
        ${locationDeleted ? sql`now()` : null}
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    // 5. Produit
    const prod = await sql`
      INSERT INTO "products" (
        "organization_id", "category_id", "name", "slug", "description",
        "publication_status", "deleted_at"
      )
      VALUES (
        ${org.id}, ${cat.id}, ${'Produit ' + tag}, ${'prod-' + tag}, ${'Description ' + tag},
        'DRAFT',
        ${opts.productDeleted ? sql`now()` : null}
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

    if (targetPubStatus !== 'DRAFT') {
      await sql`
        UPDATE "products"
        SET "publication_status" = ${targetPubStatus}
        WHERE "id" = ${prod.id}
      `;
    }

    // 6. Variantes
    const v1 = await sql`
      INSERT INTO "product_variants" (
        "product_id", "name", "is_active", "daily_price_amount_minor", "currency", "deleted_at"
      )
      VALUES (
        ${prod.id}, 'Taille M',
        ${opts.variant1Active ?? true}, 4500, 'EUR',
        ${opts.variant1Deleted ? sql`now()` : null}
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    const v2 = await sql`
      INSERT INTO "product_variants" (
        "product_id", "name", "is_active", "daily_price_amount_minor", "currency"
      )
      VALUES (
        ${prod.id}, 'Taille L', true, 5000, 'EUR'
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    return {
      orgId: org.id as string,
      productId: prod.id as string,
      publicProductId: prod.public_id as string,
      locationId: loc.id as string,
      publicLocationId: loc.public_id as string,
      variant1Id: v1.id as string,
      variant1PublicId: v1.public_id as string,
      variant2Id: v2.id as string,
      variant2PublicId: v2.public_id as string,
    };
  }

  it('1. Résout avec succès les identifiants transactionnels pour une offre valide', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_hp' });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    expect(res.authority.organizationId).toBe(f.orgId);
    expect(res.authority.locationId).toBe(f.locationId);
    expect(res.authority.productId).toBe(f.productId);
    expect(res.authority.variantId).toBe(f.variant1Id);
    expect(res.authority.timeZone).toBe('Europe/Paris');
    expect(res.authority.operatingCurrency).toBe('EUR');
  });

  it('2. Tenant isolation : Rejette NOT_FOUND si produit et établissement appartiennent à des organisations différentes', async () => {
    const f1 = await seedResolverFixture(rawSql, { tag: 'res_org1' });
    const f2 = await seedResolverFixture(rawSql, { tag: 'res_org2' });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f1.publicProductId,
      publicLocationId: f2.publicLocationId,
      publicVariantId: f1.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('3. Rejette NOT_FOUND si publicVariantId appartient à un autre produit', async () => {
    const f1 = await seedResolverFixture(rawSql, { tag: 'res_v1' });
    const f2 = await seedResolverFixture(rawSql, { tag: 'res_v2' });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f1.publicProductId,
      publicLocationId: f1.publicLocationId,
      publicVariantId: f2.variant1PublicId, // variante du produit 2
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('4. Rejette NOT_FOUND si le produit est en statut DRAFT', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_draft', publicationStatus: 'DRAFT' });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('5. Rejette NOT_FOUND si le produit est supprimé', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_pdel', productDeleted: true });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('6. Rejette NOT_FOUND si l’organisation est supprimée', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_orgdel', orgDeleted: true });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('7. Rejette NOT_FOUND si l’établissement est supprimé ou non listé', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_locdel', locationDeleted: true });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('8. Rejette NOT_FOUND si le pays est inactif', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_badctry', countryActive: false });

    const res = await resolvePublicBookingAuthority(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
      publicVariantId: f.variant1PublicId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('9. Rejette NOT_FOUND si la variante est inactive ou supprimée', async () => {
    const fInactive = await seedResolverFixture(rawSql, {
      tag: 'res_inact',
      variant1Active: false,
    });
    const res1 = await resolvePublicBookingAuthority(db, {
      publicProductId: fInactive.publicProductId,
      publicLocationId: fInactive.publicLocationId,
      publicVariantId: fInactive.variant1PublicId,
    });
    expect(res1.kind).toBe('NOT_FOUND');

    const fDeleted = await seedResolverFixture(rawSql, { tag: 'res_vdel', variant1Deleted: true });
    const res2 = await resolvePublicBookingAuthority(db, {
      publicProductId: fDeleted.publicProductId,
      publicLocationId: fDeleted.publicLocationId,
      publicVariantId: fDeleted.variant1PublicId,
    });
    expect(res2.kind).toBe('NOT_FOUND');
  });

  it('10. Gating photos : rejette NOT_FOUND si le gate refuse le produit', async () => {
    const f = await seedResolverFixture(rawSql, { tag: 'res_gate' });

    const rejectingGate: PublicProductPublicationGate = {
      filterEligibleProductIds: async () => new Set<string>(),
    };

    const res = await resolvePublicBookingAuthority(
      db,
      {
        publicProductId: f.publicProductId,
        publicLocationId: f.publicLocationId,
        publicVariantId: f.variant1PublicId,
      },
      { publicationGate: rejectingGate },
    );

    expect(res.kind).toBe('NOT_FOUND');
  });
});
