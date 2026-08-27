import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const LOCAL_DATABASE_URL = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEMO_DESTINATION_SLUG = 'lyon-dev';
const DEMO_ORGANIZATION_SLUG = 'test-org-dev';
const DEMO_LOCATION_SLUG = 'lyon-shop-dev';
const DEMO_PRODUCT_SLUG = 'kayak-dev';
const DEMO_VARIANT_SKU_SUFFIX = 'dev-standard';
const DEMO_INVENTORY_SKU = 'KAY-DEV-001';
const DEMO_PLAN_INTERNAL_LABEL = 'local-demo-seed';
const LYON_LONGITUDE = 4.8357;
const LYON_LATITUDE = 45.764;
const DEMO_PHOTOS = [
  {
    storageKey: 'product-photos/dev-kayak-0',
    sortOrder: 0,
    checksumSha256: '0'.repeat(64),
  },
  {
    storageKey: 'product-photos/dev-kayak-1',
    sortOrder: 1,
    checksumSha256: '1'.repeat(64),
  },
  {
    storageKey: 'product-photos/dev-kayak-2',
    sortOrder: 2,
    checksumSha256: '2'.repeat(64),
  },
];

export function isLocalSeedEnvironment(environment = process.env) {
  return environment?.UTTILY_LOCAL_DEV === '1' && environment?.NODE_ENV === 'development';
}

export function assertLocalSeedEnvironment(environment = process.env) {
  if (!isLocalSeedEnvironment(environment)) {
    throw new Error('Le seed local exige un environnement de développement local explicite.');
  }
}

function resolveLocalDatabaseUrl() {
  const configuredUrl = process.env.DATABASE_URL;
  const databaseUrl = configuredUrl === undefined ? LOCAL_DATABASE_URL : configuredUrl;

  if (
    typeof databaseUrl !== 'string' ||
    databaseUrl.length === 0 ||
    databaseUrl.trim() !== databaseUrl
  ) {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    (!LOCAL_DATABASE_HOSTS.has(hostname) && !LOCAL_DATABASE_HOSTS.has(normalizedHostname))
  ) {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  return databaseUrl;
}

async function ensureCountry(tx) {
  await tx`
    INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
    VALUES ('FR', true, 'EUR', 'fr')
    ON CONFLICT ("country_code") DO UPDATE SET
      "is_active" = EXCLUDED."is_active",
      "default_currency" = EXCLUDED."default_currency",
      "default_locale" = EXCLUDED."default_locale",
      "updated_at" = now()
  `;
}

async function ensureDestination(tx) {
  const existingRows = await tx`
    SELECT "id"
    FROM "destinations"
    WHERE "slug" = ${DEMO_DESTINATION_SLUG}
    ORDER BY "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  let destinationId;
  if (existingRows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "destinations" (
        "slug", "country_code", "place_type", "center",
        "bbox_south", "bbox_west", "bbox_north", "bbox_east", "is_active"
      )
      VALUES (
        ${DEMO_DESTINATION_SLUG}, 'FR', 'CITY',
        ST_SetSRID(ST_MakePoint(${LYON_LONGITUDE}, ${LYON_LATITUDE}), 4326),
        45.707, 4.771, 45.809, 4.899, false
      )
      RETURNING "id"
    `;
    destinationId = insertedRows[0].id;
  } else {
    destinationId = existingRows[0].id;
  }

  // La destination reste inactive pendant toute la mise en place de ses traductions.
  await tx`
    UPDATE "destinations"
    SET "is_active" = false, "updated_at" = now()
    WHERE "id" = ${destinationId}
  `;
  await tx`
    UPDATE "destinations"
    SET
      "country_code" = 'FR',
      "place_type" = 'CITY',
      "center" = ST_SetSRID(ST_MakePoint(${LYON_LONGITUDE}, ${LYON_LATITUDE}), 4326),
      "bbox_south" = 45.707,
      "bbox_west" = 4.771,
      "bbox_north" = 45.809,
      "bbox_east" = 4.899,
      "sort_order" = 0,
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${destinationId}
  `;
  await tx`
    INSERT INTO "destination_translations" ("destination_id", "locale", "label")
    VALUES
      (${destinationId}, 'fr', 'Lyon'),
      (${destinationId}, 'en', 'Lyon')
    ON CONFLICT ("destination_id", "locale") DO UPDATE SET
      "label" = EXCLUDED."label",
      "updated_at" = now()
  `;
  await tx`
    UPDATE "destinations"
    SET "is_active" = true, "updated_at" = now()
    WHERE "id" = ${destinationId}
  `;
}

async function ensureOrganization(tx) {
  const existingRows = await tx`
    SELECT "id"
    FROM "organizations"
    WHERE "slug" = ${DEMO_ORGANIZATION_SLUG}
    LIMIT 1
    FOR UPDATE
  `;

  let organizationId;
  if (existingRows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "organizations" (
        "legal_name", "public_display_name", "slug", "status",
        "is_professional", "default_currency", "default_cancellation_policy_code"
      )
      VALUES (
        'Test Org Dev', 'Test Org Dev', ${DEMO_ORGANIZATION_SLUG}, 'ACTIVE',
        true, 'EUR', 'FLEXIBLE'
      )
      RETURNING "id"
    `;
    organizationId = insertedRows[0].id;
  } else {
    organizationId = existingRows[0].id;
  }

  await tx`
    UPDATE "organizations"
    SET
      "legal_name" = 'Test Org Dev',
      "public_display_name" = 'Test Org Dev',
      "status" = 'ACTIVE',
      "is_professional" = true,
      "default_currency" = 'EUR',
      "default_cancellation_policy_code" = 'FLEXIBLE',
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${organizationId}
  `;

  return organizationId;
}

async function ensureLocation(tx, organizationId) {
  const existingRows = await tx`
    SELECT "id"
    FROM "locations"
    WHERE "organization_id" = ${organizationId}
      AND "slug" = ${DEMO_LOCATION_SLUG}
    ORDER BY "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  let locationId;
  if (existingRows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "locations" (
        "organization_id", "name", "slug", "time_zone",
        "address_line1", "address_line2", "city", "postal_code", "country_code",
        "geo_point", "pickup_enabled", "is_publicly_listed",
        "prep_buffer_minutes", "cleanup_buffer_minutes", "operating_currency"
      )
      VALUES (
        ${organizationId}, 'Lyon Shop Dev', ${DEMO_LOCATION_SLUG}, 'Europe/Paris',
        '1 place Bellecour', NULL, 'Lyon', '69002', 'FR',
        ST_SetSRID(ST_MakePoint(${LYON_LONGITUDE}, ${LYON_LATITUDE}), 4326),
        true, true, 30, 30, 'EUR'
      )
      RETURNING "id"
    `;
    locationId = insertedRows[0].id;
  } else {
    locationId = existingRows[0].id;
  }

  await tx`
    UPDATE "locations"
    SET
      "name" = 'Lyon Shop Dev',
      "time_zone" = 'Europe/Paris',
      "address_line1" = '1 place Bellecour',
      "address_line2" = NULL,
      "city" = 'Lyon',
      "postal_code" = '69002',
      "country_code" = 'FR',
      "geo_point" = ST_SetSRID(ST_MakePoint(${LYON_LONGITUDE}, ${LYON_LATITUDE}), 4326),
      "pickup_enabled" = true,
      "is_publicly_listed" = true,
      "prep_buffer_minutes" = 30,
      "cleanup_buffer_minutes" = 30,
      "operating_currency" = 'EUR',
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${locationId}
  `;

  return locationId;
}

async function ensureOpeningHours(tx, locationId) {
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    await tx`
      INSERT INTO "location_opening_hours" (
        "location_id", "weekday", "open_time", "close_time"
      )
      SELECT ${locationId}, ${weekday}, '08:00:00'::time, '20:00:00'::time
      WHERE NOT EXISTS (
        SELECT 1
        FROM "location_opening_hours"
        WHERE "location_id" = ${locationId}
          AND "weekday" = ${weekday}
          AND "open_time" = '08:00:00'::time
          AND "close_time" = '20:00:00'::time
      )
    `;
  }
}

async function ensureCategory(tx) {
  const rows = await tx`
    INSERT INTO "categories" ("slug", "name", "is_active")
    VALUES ('equipment', 'Équipements', true)
    ON CONFLICT ("slug") DO UPDATE SET
      "is_active" = true,
      "updated_at" = now()
    RETURNING "id"
  `;
  return rows[0].id;
}

async function ensureProduct(tx, organizationId, categoryId) {
  const existingRows = await tx`
    SELECT "id"
    FROM "products"
    WHERE "organization_id" = ${organizationId}
      AND "slug" = ${DEMO_PRODUCT_SLUG}
    ORDER BY "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  let productId;
  if (existingRows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "products" (
        "organization_id", "category_id", "name", "slug", "description", "publication_status"
      )
      VALUES (
        ${organizationId}, ${categoryId}, 'Kayak de démonstration', ${DEMO_PRODUCT_SLUG},
        'Kayak de démonstration pour le développement local.', 'DRAFT'
      )
      RETURNING "id"
    `;
    productId = insertedRows[0].id;
  } else {
    productId = existingRows[0].id;
  }

  // Le produit est DRAFT avant toute insertion ou remise en état de photo.
  await tx`
    UPDATE "products"
    SET
      "category_id" = ${categoryId},
      "name" = 'Kayak de démonstration',
      "description" = 'Kayak de démonstration pour le développement local.',
      "publication_status" = 'DRAFT',
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${productId}
  `;

  return productId;
}

function photoMetadataMatches(row, photo) {
  return (
    row.content_type === 'image/jpeg' &&
    Number(row.byte_size) === 102400 &&
    Number(row.width_px) === 800 &&
    Number(row.height_px) === 600 &&
    row.checksum_sha256 === photo.checksumSha256 &&
    row.deleted_at === null &&
    row.rejection_reason === null
  );
}

async function ensureProductPhoto(tx, organizationId, productId, photo) {
  const rows = await tx`
    SELECT
      "id", "organization_id", "product_id", "content_type", "byte_size",
      "width_px", "height_px", "checksum_sha256", "sort_order", "file_state",
      "deleted_at", "rejection_reason"
    FROM "product_photos"
    WHERE "storage_key" = ${photo.storageKey}
    LIMIT 1
    FOR UPDATE
  `;

  if (rows.length === 0) {
    await tx`
      INSERT INTO "product_photos" (
        "organization_id", "product_id", "storage_key", "content_type", "byte_size",
        "width_px", "height_px", "checksum_sha256", "sort_order", "file_state"
      )
      VALUES (
        ${organizationId}, ${productId}, ${photo.storageKey}, 'image/jpeg', 102400,
        800, 600, ${photo.checksumSha256}, ${photo.sortOrder}, 'AVAILABLE'
      )
    `;
    return;
  }

  const row = rows[0];
  if (row.organization_id !== organizationId || row.product_id !== productId) {
    throw new Error('Une clé photo stable est déjà utilisée par une autre fixture.');
  }

  if (row.file_state === 'AVAILABLE') {
    if (!photoMetadataMatches(row, photo)) {
      throw new Error('Les métadonnées d’une photo stable sont incohérentes.');
    }
    if (Number(row.sort_order) !== photo.sortOrder) {
      await tx`
        UPDATE "product_photos"
        SET "sort_order" = ${photo.sortOrder}, "updated_at" = now()
        WHERE "id" = ${row.id}
      `;
    }
    return;
  }

  if (row.file_state !== 'PENDING_UPLOAD') {
    throw new Error('Une photo stable ne peut pas revenir à AVAILABLE.');
  }

  await tx`
    UPDATE "product_photos"
    SET
      "content_type" = 'image/jpeg',
      "byte_size" = 102400,
      "width_px" = 800,
      "height_px" = 600,
      "checksum_sha256" = ${photo.checksumSha256},
      "sort_order" = ${photo.sortOrder},
      "file_state" = 'AVAILABLE',
      "rejection_reason" = NULL,
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${row.id}
  `;
}

async function ensureVariant(tx, productId) {
  let rows = await tx`
    SELECT "id"
    FROM "product_variants"
    WHERE "product_id" = ${productId}
      AND "sku_suffix" = ${DEMO_VARIANT_SKU_SUFFIX}
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  if (rows.length === 0) {
    rows = await tx`
      SELECT "id"
      FROM "product_variants"
      WHERE "product_id" = ${productId}
        AND "name" = 'Standard'
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE
    `;
  }

  let variantId;
  if (rows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "product_variants" (
        "product_id", "name", "sku_suffix", "attributes", "is_active",
        "daily_price_amount_minor", "currency"
      )
      VALUES (${productId}, 'Standard', ${DEMO_VARIANT_SKU_SUFFIX}, '{}'::jsonb, true, 5000, 'EUR')
      RETURNING "id"
    `;
    variantId = insertedRows[0].id;
  } else {
    variantId = rows[0].id;
  }

  await tx`
    UPDATE "product_variants"
    SET
      "name" = 'Standard',
      "sku_suffix" = ${DEMO_VARIANT_SKU_SUFFIX},
      "is_active" = true,
      "daily_price_amount_minor" = 5000,
      "currency" = 'EUR',
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${variantId}
  `;

  return variantId;
}

async function ensureInventoryItem(tx, organizationId, variantId, locationId) {
  const existingRows = await tx`
    SELECT "id"
    FROM "inventory_items"
    WHERE "organization_id" = ${organizationId}
      AND "internal_sku" = ${DEMO_INVENTORY_SKU}
    ORDER BY "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  let inventoryItemId;
  if (existingRows.length === 0) {
    const insertedRows = await tx`
      INSERT INTO "inventory_items" (
        "organization_id", "product_variant_id", "internal_sku", "condition",
        "status", "current_location_id"
      )
      VALUES (${organizationId}, ${variantId}, ${DEMO_INVENTORY_SKU}, 'NEW', 'ACTIVE', ${locationId})
      RETURNING "id"
    `;
    inventoryItemId = insertedRows[0].id;
  } else {
    inventoryItemId = existingRows[0].id;
  }

  await tx`
    UPDATE "inventory_items"
    SET
      "product_variant_id" = ${variantId},
      "condition" = 'NEW',
      "status" = 'ACTIVE',
      "current_location_id" = ${locationId},
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE "id" = ${inventoryItemId}
  `;
}

async function planHasRequiredChildren(tx, planId) {
  const rows = await tx`
    SELECT
      EXISTS (
        SELECT 1
        FROM "pricing_plan_windows"
        WHERE "pricing_plan_id" = ${planId}
          AND "location_id" = (SELECT "location_id" FROM "pricing_plans" WHERE "id" = ${planId})
          AND "weekday_mask" = 127
          AND "start_time" = '08:00:00'::time
          AND "end_time" = '20:00:00'::time
      ) AS "has_window",
      EXISTS (
        SELECT 1 FROM "pricing_plan_translations"
        WHERE "pricing_plan_id" = ${planId} AND "locale" = 'fr'
      ) AS "has_fr",
      EXISTS (
        SELECT 1 FROM "pricing_plan_translations"
        WHERE "pricing_plan_id" = ${planId} AND "locale" = 'en'
      ) AS "has_en"
  `;
  return Boolean(rows[0].has_window && rows[0].has_fr && rows[0].has_en);
}

async function addPricingPlanChildren(tx, planId, locationId) {
  await tx`
    INSERT INTO "pricing_plan_windows" (
      "pricing_plan_id", "location_id", "weekday_mask", "start_time", "end_time"
    )
    SELECT ${planId}, ${locationId}, 127, '08:00:00'::time, '20:00:00'::time
    WHERE NOT EXISTS (
      SELECT 1
      FROM "pricing_plan_windows"
      WHERE "pricing_plan_id" = ${planId}
        AND "location_id" = ${locationId}
        AND "weekday_mask" = 127
        AND "start_time" = '08:00:00'::time
        AND "end_time" = '20:00:00'::time
    )
  `;

  await tx`
    INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
    VALUES
      (${planId}, 'fr', 'Location journalière'),
      (${planId}, 'en', 'Daily rental')
    ON CONFLICT ("pricing_plan_id", "locale") DO UPDATE SET
      "public_label" = EXCLUDED."public_label",
      "updated_at" = now()
  `;
}

async function insertPricingPlan(tx, organizationId, variantId, locationId, version) {
  const rows = await tx`
    INSERT INTO "pricing_plans" (
      "organization_id", "product_variant_id", "location_id", "plan_type", "currency",
      "price_amount_minor", "internal_label", "priority", "lifecycle_state", "version"
    )
    VALUES (
      ${organizationId}, ${variantId}, ${locationId}, 'DAILY', 'EUR', 5000,
      ${DEMO_PLAN_INTERNAL_LABEL}, 0, 'DRAFT', ${version}
    )
    RETURNING "id"
  `;
  return rows[0].id;
}

async function ensurePricingPlan(tx, organizationId, variantId, locationId) {
  const planRows = await tx`
    SELECT
      "id", "price_amount_minor", "lifecycle_state", "version", "internal_label"
    FROM "pricing_plans"
    WHERE "organization_id" = ${organizationId}
      AND "product_variant_id" = ${variantId}
      AND "location_id" = ${locationId}
      AND "plan_type" = 'DAILY'
      AND "currency" = 'EUR'
    ORDER BY
      CASE WHEN "internal_label" = ${DEMO_PLAN_INTERNAL_LABEL} THEN 0 ELSE 1 END,
      CASE WHEN "lifecycle_state" = 'ACTIVE' THEN 0 ELSE 1 END,
      "version" ASC,
      "created_at" ASC,
      "id" ASC
    LIMIT 1
    FOR UPDATE
  `;

  if (planRows.length > 0 && planRows[0].lifecycle_state === 'ACTIVE') {
    if (
      Number(planRows[0].price_amount_minor) !== 5000 ||
      !(await planHasRequiredChildren(tx, planRows[0].id))
    ) {
      throw new Error('Le plan tarifaire stable actif est incohérent.');
    }
    return;
  }

  let planId;
  if (planRows.length > 0 && planRows[0].lifecycle_state === 'DRAFT') {
    planId = planRows[0].id;
    await tx`
      UPDATE "pricing_plans"
      SET
        "price_amount_minor" = 5000,
        "internal_label" = ${DEMO_PLAN_INTERNAL_LABEL},
        "priority" = 0,
        "updated_at" = now()
      WHERE "id" = ${planId}
    `;
  } else {
    let version = 1;
    if (planRows.length > 0) {
      const versionRows = await tx`
        SELECT COALESCE(MAX("version"), 0) + 1 AS "next_version"
        FROM "pricing_plans"
        WHERE "organization_id" = ${organizationId}
          AND "product_variant_id" = ${variantId}
          AND "location_id" = ${locationId}
          AND "plan_type" = 'DAILY'
          AND "currency" = 'EUR'
      `;
      version = Number(versionRows[0].next_version);
    }
    planId = await insertPricingPlan(tx, organizationId, variantId, locationId, version);
  }

  // Le plan reste DRAFT pendant l'insertion de la fenêtre et des traductions.
  await addPricingPlanChildren(tx, planId, locationId);
  await tx`
    UPDATE "pricing_plans"
    SET "lifecycle_state" = 'ACTIVE', "updated_at" = now()
    WHERE "id" = ${planId}
  `;
}

async function applyLocalDemoSeed(tx) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('uttily-local-demo-seed', 0))`;

  await ensureCountry(tx);
  await ensureDestination(tx);
  const organizationId = await ensureOrganization(tx);
  const locationId = await ensureLocation(tx, organizationId);
  await ensureOpeningHours(tx, locationId);
  const categoryId = await ensureCategory(tx);
  const productId = await ensureProduct(tx, organizationId, categoryId);

  for (const photo of DEMO_PHOTOS) {
    await ensureProductPhoto(tx, organizationId, productId, photo);
  }
  await tx`
    UPDATE "products"
    SET "publication_status" = 'PUBLISHED', "updated_at" = now()
    WHERE "id" = ${productId}
  `;

  const variantId = await ensureVariant(tx, productId);
  await ensureInventoryItem(tx, organizationId, variantId, locationId);
  await ensurePricingPlan(tx, organizationId, variantId, locationId);
}

export async function seedLocalDemo() {
  assertLocalSeedEnvironment();
  const databaseUrl = resolveLocalDatabaseUrl();
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // postgres.begin annule automatiquement la transaction si le callback échoue.
    await sql.begin(async (tx) => {
      await applyLocalDemoSeed(tx);
    });
  } finally {
    await sql.end();
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  seedLocalDemo()
    .then(() => {
      console.log('Local demo seed applied: destination=lyon-dev product=kayak-dev');
    })
    .catch(() => {
      console.error('Local demo seed failed.');
      process.exitCode = 1;
    });
}
