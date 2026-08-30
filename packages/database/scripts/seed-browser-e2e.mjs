import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  assertLocalSeedEnvironment,
  resolveLocalDatabaseUrl,
  seedLocalDemo,
} from './seed-local.mjs';

const DEMO_ORGANIZATION_SLUG = 'test-org-dev';
const DEMO_PRODUCT_SLUG = 'kayak-dev';
const E2E_PHOTOS = [
  {
    storageKey: 'product-photos/e2e-kayak-dev-0',
    sortOrder: 0,
    checksumSha256: '0'.repeat(64),
  },
  {
    storageKey: 'product-photos/e2e-kayak-dev-1',
    sortOrder: 1,
    checksumSha256: '1'.repeat(64),
  },
  {
    storageKey: 'product-photos/e2e-kayak-dev-2',
    sortOrder: 2,
    checksumSha256: '2'.repeat(64),
  },
];

export function assertBrowserE2ESeedEnvironment(environment = process.env) {
  assertLocalSeedEnvironment(environment);
  const isCi = environment.CI === '1' || environment.CI === 'true';
  if (!isCi || environment.UTTILY_BROWSER_E2E !== '1') {
    throw new Error('Le seed browser E2E exige CI et le marqueur UTTILY_BROWSER_E2E=1 explicites.');
  }
}

async function seedBrowserE2E() {
  assertBrowserE2ESeedEnvironment();
  await seedLocalDemo();

  const sql = postgres(resolveLocalDatabaseUrl(), { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('uttily-local-demo-seed', 0))`;

      const products = await tx`
        SELECT p."id", p."organization_id"
        FROM "products" p
        JOIN "organizations" o ON o."id" = p."organization_id"
        WHERE o."slug" = ${DEMO_ORGANIZATION_SLUG}
          AND p."slug" = ${DEMO_PRODUCT_SLUG}
          AND o."deleted_at" IS NULL
          AND p."deleted_at" IS NULL
        LIMIT 1
        FOR UPDATE
      `;
      if (products.length !== 1) {
        throw new Error('La fixture produit browser E2E est introuvable.');
      }

      const product = products[0];
      for (const photo of E2E_PHOTOS) {
        await tx`
          INSERT INTO "product_photos" (
            "organization_id", "product_id", "storage_key", "content_type",
            "byte_size", "width_px", "height_px", "checksum_sha256",
            "sort_order", "file_state"
          )
          SELECT
            ${product.organization_id}, ${product.id}, ${photo.storageKey}, 'image/jpeg',
            102400, 800, 600, ${photo.checksumSha256}, ${photo.sortOrder}, 'AVAILABLE'
          WHERE NOT EXISTS (
            SELECT 1
            FROM "product_photos"
            WHERE "product_id" = ${product.id}
              AND "storage_key" = ${photo.storageKey}
          )
        `;
      }

      await tx`
        UPDATE "products"
        SET "publication_status" = 'PUBLISHED', "updated_at" = now()
        WHERE "id" = ${product.id}
      `;
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
  seedBrowserE2E()
    .then(() => {
      console.log('Browser E2E fixture applied: product=kayak-dev (published test fixture)');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Browser E2E seed failed.');
      process.exitCode = 1;
    });
}
