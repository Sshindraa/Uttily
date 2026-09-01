import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  assertLocalhost,
  createDatabase,
  runMigrations,
  type DatabaseClient,
} from '@uttily/database';
import { getPublicOfferDetails } from './get-public-offer-details';
import type { PublicProductPublicationGate } from './types';

const sourceUrl = process.env.DATABASE_URL;
const testDatabase = `uttily_test_pub_offer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shouldSkip = !sourceUrl && process.env.CI !== '1' && process.env.CI !== 'true';

describe.skipIf(shouldSkip)('getPublicOfferDetails — intégration PostgreSQL', () => {
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
    skuSuffixSentinel?: string | undefined;
    attrSentinel?: string | undefined;
  }

  async function seedOfferFixture(
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
      variant2Active?: boolean;
      seedPhotos?: boolean;
      skuSuffixSentinel?: string;
      attrSentinel?: string;
    } = {},
  ): Promise<SeedResult> {
    const tag = opts.tag ?? Math.random().toString(36).slice(2, 8);
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
        "address_line1", "address_line2", "city", "postal_code", "country_code",
        "geo_point", "pickup_enabled", "is_publicly_listed", "deleted_at"
      )
      VALUES (
        ${org.id}, ${'Magasin ' + tag}, ${'loc-' + tag}, 'Europe/Paris', 'EUR',
        '10 Rue de la Paix', 'Bâtiment B', 'Paris', '75001', ${countryCode},
        ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326),
        ${pickupEnabled},
        ${effectiveIsPubliclyListed},
        ${locationDeleted ? sql`now()` : null}
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    // Horaires d'ouverture
    await sql`
      INSERT INTO "location_opening_hours" ("location_id", "weekday", "open_time", "close_time")
      VALUES
        (${loc.id}, 1, '08:00:00', '18:00:00'),
        (${loc.id}, 2, '08:00:00', '18:00:00')
    `;

    // 5. Produit
    const prod = await sql`
      INSERT INTO "products" (
        "organization_id", "category_id", "name", "slug", "description",
        "publication_status", "deleted_at"
      )
      VALUES (
        ${org.id}, ${cat.id}, ${'Produit ' + tag}, ${'prod-' + tag}, ${'Super description ' + tag},
        'DRAFT',
        ${opts.productDeleted ? sql`now()` : null}
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    // Photos si nécessaire pour publication
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
    const skuSuffix1 = opts.skuSuffixSentinel ?? 'M';
    const attr1 = opts.attrSentinel ? { sentinel_key: opts.attrSentinel } : { size: 'M' };
    const v1 = await sql`
      INSERT INTO "product_variants" (
        "product_id", "name", "sku_suffix", "attributes", "is_active", "daily_price_amount_minor", "currency"
      )
      VALUES (
        ${prod.id}, 'Taille M', ${skuSuffix1}, ${sql.json(attr1)},
        ${opts.variant1Active ?? true}, 4500, 'EUR'
      )
      RETURNING "id", "public_id"
    `.then((r) => r[0]!);

    const v2 = await sql`
      INSERT INTO "product_variants" (
        "product_id", "name", "sku_suffix", "attributes", "is_active", "daily_price_amount_minor", "currency"
      )
      VALUES (
        ${prod.id}, 'Taille L', 'L', '{"size": "L"}'::jsonb,
        ${opts.variant2Active ?? true}, 5000, 'EUR'
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
      skuSuffixSentinel: opts.skuSuffixSentinel,
      attrSentinel: opts.attrSentinel,
    };
  }

  it('1. Charge avec succès une offre complète avec publicVariantId sans fuite interne', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'happy' });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    expect(res.offer.publicProductId).toBe(f.publicProductId);
    expect(res.offer.publicLocationId).toBe(f.publicLocationId);
    expect(res.offer.productName).toBe('Produit happy');
    expect(res.offer.productDescription).toBe('Super description happy');
    expect(res.offer.organizationPublicDisplayName).toBe('Loueur Pro happy');
    expect(res.offer.locationName).toBe('Magasin happy');
    expect(res.offer.timeZone).toBe('Europe/Paris');
    expect(res.offer.operatingCurrency).toBe('EUR');
    expect(res.offer.addressLine1).toBe('10 Rue de la Paix');
    expect(res.offer.addressLine2).toBe('Bâtiment B');
    expect(res.offer.city).toBe('Paris');
    expect(res.offer.postalCode).toBe('75001');
    expect(res.offer.countryCode).toBe('FR');

    // Variantes : projection minimale (publicVariantId et name uniquement)
    expect(res.offer.variants).toHaveLength(2);
    expect(res.offer.variants[0]!.publicVariantId).toBe(f.variant1PublicId);
    expect(res.offer.variants[0]!.name).toBe('Taille M');
    expect(res.offer.variants[1]!.publicVariantId).toBe(f.variant2PublicId);
    expect(res.offer.variants[1]!.name).toBe('Taille L');

    // Horaires
    expect(res.offer.openingHours).toHaveLength(2);
    expect(res.offer.openingHours[0]!.weekday).toBe(1);
  });

  it('2. Sans critères, utilise le plan actif réel plutôt que le legacy daily price', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'indicative-flexible' });
    const plan = await rawSql`
      INSERT INTO "pricing_plans" (
        "organization_id", "product_variant_id", "location_id", "plan_type",
        "currency", "price_amount_minor", "min_duration_minutes",
        "max_duration_minutes", "billing_increment_minutes", "version", "lifecycle_state"
      )
      VALUES (
        ${f.orgId}, ${f.variant1Id}, NULL, 'HOURLY', 'EUR', 1200,
        60, 600, 60, 1, 'DRAFT'
      )
      RETURNING "id"
    `.then((r) => r[0]!);
    await rawSql`
      INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
      VALUES (${plan.id}, 'fr', 'Tarif horaire'), (${plan.id}, 'en', 'Hourly rate')
    `;
    await rawSql`
      UPDATE "pricing_plans"
      SET "lifecycle_state" = 'ACTIVE'
      WHERE "id" = ${plan.id}
    `;

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;
    expect(res.offer.price?.planType).toBe('HOURLY');
    expect(res.offer.price?.marketplaceFeeBaseAmountMinor).toBe(1200);
    expect(res.offer.price?.publicLabel).toContain('heure');
  });

  it('3. Sentinelles : prouve qu’aucun ID interne, SKU suffix ou attribut JSON n’apparaît dans le read model', async () => {
    const skuSentinel = 'SENTINEL_SKU_SUFFIX_XYZ_999';
    const attrSentinel = 'SENTINEL_JSON_ATTRIBUTE_VALUE_123';
    const f = await seedOfferFixture(rawSql, {
      tag: 'sentinel',
      skuSuffixSentinel: skuSentinel,
      attrSentinel: attrSentinel,
    });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('SUCCESS');
    if (res.kind !== 'SUCCESS') return;

    const offerJson = JSON.stringify(res.offer);

    // Aucune sentinelle interne
    expect(offerJson).not.toContain(f.orgId);
    expect(offerJson).not.toContain(f.productId);
    expect(offerJson).not.toContain(f.locationId);
    expect(offerJson).not.toContain(f.variant1Id);
    expect(offerJson).not.toContain(f.variant2Id);
    expect(offerJson).not.toContain(skuSentinel);
    expect(offerJson).not.toContain(attrSentinel);

    // Seuls les public IDs apparaissent
    expect(offerJson).toContain(f.publicProductId);
    expect(offerJson).toContain(f.publicLocationId);
    expect(offerJson).toContain(f.variant1PublicId);
    expect(offerJson).toContain(f.variant2PublicId);
  });

  it('4. Tenant isolation : Rejette NOT_FOUND si produit et établissement appartiennent à des organisations différentes', async () => {
    const f1 = await seedOfferFixture(rawSql, { tag: 'org1' });
    const f2 = await seedOfferFixture(rawSql, { tag: 'org2' });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f1.publicProductId,
      publicLocationId: f2.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('5. Rejette NOT_FOUND si le produit est en statut DRAFT', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'draft', publicationStatus: 'DRAFT' });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('6. Rejette NOT_FOUND si le produit est supprimé (deletedAt)', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'pdel', productDeleted: true });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it("7. Rejette NOT_FOUND si l'établissement n'est pas publicly listed", async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'nolist', isPubliclyListed: false });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('8. Rejette NOT_FOUND si le retrait est désactivé (pickupEnabled = false)', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'nopick', pickupEnabled: false });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it("9. Rejette NOT_FOUND si l'établissement est supprimé", async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'locdel', locationDeleted: true });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it("10. Rejette NOT_FOUND si l'organisation est supprimée", async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'orgdel', orgDeleted: true });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('11. Rejette NOT_FOUND si le pays est inactif', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'badctry', countryActive: false });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('12. Filtre les variantes inactives et retourne NOT_FOUND si aucune variante active', async () => {
    const f = await seedOfferFixture(rawSql, {
      tag: 'novar',
      variant1Active: false,
      variant2Active: false,
    });

    const res = await getPublicOfferDetails(db, {
      publicProductId: f.publicProductId,
      publicLocationId: f.publicLocationId,
    });

    expect(res.kind).toBe('NOT_FOUND');
  });

  it('13. Gating photos : rejette NOT_FOUND si le gate refuse le produit, accepte si le gate valide', async () => {
    const f = await seedOfferFixture(rawSql, { tag: 'gate' });

    const rejectingGate: PublicProductPublicationGate = {
      filterEligibleProductIds: async () => new Set<string>(),
    };

    const acceptingGate: PublicProductPublicationGate = {
      filterEligibleProductIds: async (_d, ids) => new Set(ids),
    };

    const resRejected = await getPublicOfferDetails(
      db,
      { publicProductId: f.publicProductId, publicLocationId: f.publicLocationId },
      { publicationGate: rejectingGate },
    );
    expect(resRejected.kind).toBe('NOT_FOUND');

    const resAccepted = await getPublicOfferDetails(
      db,
      { publicProductId: f.publicProductId, publicLocationId: f.publicLocationId },
      { publicationGate: acceptingGate },
    );
    expect(resAccepted.kind).toBe('SUCCESS');
  });

  it('14. Retourne NOT_FOUND pour des identifiants inconnus', async () => {
    const res = await getPublicOfferDetails(db, {
      publicProductId: '00000000-0000-4000-8000-000000000001',
      publicLocationId: '00000000-0000-4000-8000-000000000002',
    });
    expect(res.kind).toBe('NOT_FOUND');
  });
});
