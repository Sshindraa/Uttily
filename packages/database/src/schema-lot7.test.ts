import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL du schéma Lot 7 — G7C-R3 (fondations de
 * recherche publique, alignement définitif).
 *
 * Vérifie les tables `countries`, `destinations` (avec countryCode, placeType,
 * bbox), `destination_translations`, les colonnes `public_id` (products,
 * locations, destinations), `public_display_name` (organizations),
 * `is_publicly_listed` (locations), les contraintes CHECK, UNIQUE, les
 * triggers d'immutabilité des public_id, le trigger d'activation des
 * destinations et la protection des traductions FR/EN (ADR-017).
 *
 * Reprend la stratégie de setup des cycles précédents : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_lot7';
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
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test de schéma Lot 7.');
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
  productId: string;
}

/**
 * Crée les données de base (organisation, établissement, catégorie, produit)
 * et retourne leurs IDs. Le suffixe garantit l'unicité des slugs entre les tests.
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
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 'EUR')
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
  return {
    orgId: org.id,
    locationId: location.id,
    productId: product.id,
  };
}

/**
 * Crée un pays actif (is_active=true) avec ON CONFLICT pour idempotence.
 */
async function seedActiveCountry(
  sql: postgres.Sql,
  code = 'FR',
  currency = 'EUR',
  locale = 'fr',
): Promise<void> {
  await sql`
    INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
    VALUES (${code}, true, ${currency}, ${locale})
    ON CONFLICT ("country_code") DO UPDATE SET "is_active" = true, "default_currency" = ${currency}, "default_locale" = ${locale}
  `;
}

interface DestinationOpts {
  slug: string;
  countryCode: string;
  placeType: string;
  center: string;
  bbox: [number, number, number, number];
  translations: { locale: string; label: string }[];
  isActive?: boolean;
}

/**
 * Crée une destination avec ses traductions et retourne l'ID de la destination.
 * Si isActive=true, la destination est d'abord insérée inactive, puis les
 * traductions sont ajoutées, puis la destination est activée (le trigger
 * check_destination_activation vérifie les traductions au moment de l'activation).
 */
async function seedDestinationWithTranslations(
  sql: postgres.Sql,
  opts: DestinationOpts,
): Promise<string> {
  const [south, west, north, east] = opts.bbox;
  const dest = await sql`
    INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east", "is_active")
    VALUES (${opts.slug}, ${opts.countryCode}, ${opts.placeType}, ST_GeomFromText(${opts.center}, 4326), ${south}, ${west}, ${north}, ${east}, false)
    RETURNING "id"
  `.then((r) => r[0]!);
  for (const tr of opts.translations) {
    await sql`
      INSERT INTO "destination_translations" ("destination_id", "locale", "label")
      VALUES (${dest.id}, ${tr.locale}, ${tr.label})
    `;
  }
  if (opts.isActive) {
    await sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${dest.id}`;
  }
  return dest.id;
}

describe.skipIf(shouldSkipIntegrationTests())(
  'Schéma Lot 7 G7C-R3 — fondations recherche publique',
  () => {
    // -------------------------------------------------------------------------
    // A. Migration
    // -------------------------------------------------------------------------
    it('__drizzle_migrations a 39 entrées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(rows.length).toBe(39);
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
        expect(rows.length).toBe(39);
      } finally {
        await sql.end();
      }
    });

    // -------------------------------------------------------------------------
    // B. Pays (countries)
    // -------------------------------------------------------------------------
    it('country_code ISO alpha-2 valide accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
          VALUES ('FR', false, 'EUR', 'fr')
          RETURNING "country_code", "is_active"
        `.then((r) => r[0]!);
        expect(row.country_code).toBe('FR');
        expect(row.is_active).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it("rejet des minuscules : INSERT ('fr') rejeté", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('fr', 'EUR', 'fr')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("rejet des longueurs invalides : ('F') et ('FRA') rejetés", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('F', 'EUR', 'fr')
          `,
        ).rejects.toThrow();
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FRA', 'EUR', 'fr')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("rejet des formats invalides : ('F1') rejeté", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('F1', 'EUR', 'fr')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('is_active DEFAULT false : INSERT sans is_active → false', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "default_currency", "default_locale")
          VALUES ('DE', 'EUR', 'de')
          RETURNING "is_active"
        `.then((r) => r[0]!);
        expect(row.is_active).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it('default_currency et default_locale conservées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "default_currency", "default_locale")
          VALUES ('IT', 'EUR', 'it')
          RETURNING "default_currency", "default_locale"
        `.then((r) => r[0]!);
        expect(row.default_currency).toBe('EUR');
        expect(row.default_locale).toBe('it');
      } finally {
        await sql.end();
      }
    });

    it('devise absente rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_locale") VALUES ('NL', 'nl')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('devise minuscules rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('NL', 'eur', 'nl')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('devise longueur invalide rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('NL', 'EURO', 'nl')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('locale absente rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency") VALUES ('NL', 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('locale majuscules rejetée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('NL', 'EUR', 'FR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('locale régionale mal normalisée rejetée (fr-fr)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('NL', 'EUR', 'fr-fr')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('pays valide FR/EUR/fr accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
          VALUES ('FR', false, 'EUR', 'fr')
          ON CONFLICT ("country_code") DO UPDATE SET "default_currency" = 'EUR', "default_locale" = 'fr'
          RETURNING "country_code", "default_currency", "default_locale"
        `.then((r) => r[0]!);
        expect(row.default_currency).toBe('EUR');
        expect(row.default_locale).toBe('fr');
      } finally {
        await sql.end();
      }
    });

    it('pays valide GB/GBP/en-GB accepté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale")
          VALUES ('GB', false, 'GBP', 'en-GB')
          RETURNING "country_code", "default_currency", "default_locale"
        `.then((r) => r[0]!);
        expect(row.default_currency).toBe('GBP');
        expect(row.default_locale).toBe('en-GB');
      } finally {
        await sql.end();
      }
    });

    it('locale régionale valide acceptée (en-GB)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const row = await sql`
          INSERT INTO "countries" ("country_code", "default_currency", "default_locale")
          VALUES ('IE', 'EUR', 'en-GB')
          RETURNING "default_locale"
        `.then((r) => r[0]!);
        expect(row.default_locale).toBe('en-GB');
      } finally {
        await sql.end();
      }
    });

    it('absence de pays actif = aucune destination activable', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        // Créer un pays inactif
        await sql`INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale") VALUES ('ES', false, 'EUR', 'es') ON CONFLICT ("country_code") DO NOTHING`;
        // Créer une destination inactive avec traductions FR+EN
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'madrid-inactive-country',
          countryCode: 'ES',
          placeType: 'CITY',
          center: 'POINT(-3.7 40.4)',
          bbox: [40.0, -4.0, 40.6, -3.5],
          translations: [
            { locale: 'fr', label: 'Madrid' },
            { locale: 'en', label: 'Madrid' },
          ],
        });
        // Tenter d'activer → rejeté car pays inactif
        await expect(
          sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // -------------------------------------------------------------------------
    // C. Destinations
    // -------------------------------------------------------------------------
    it('destination inactive par défaut', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const row = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('paris-default', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "is_active"
        `.then((r) => r[0]!);
        expect(row.is_active).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it('FK pays : INSERT avec country_code inexistant → rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('no-country', 'ZZ', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('place_type fermé : type invalide rejeté, types valides acceptés', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('bad-type', 'FR', 'DISTRICT', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          `,
        ).rejects.toThrow();
        // Types valides
        for (const pt of ['COUNTRY', 'REGION', 'CITY', 'LOCALITY', 'POINT_OF_INTEREST']) {
          const slug = 'valid-type-' + pt.toLowerCase().replace(/_/g, '-');
          const row = await sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES (${slug}, 'FR', ${pt}, ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
            RETURNING "id"
          `.then((r) => r[0]!);
          expect(row.id).toBeTruthy();
        }
      } finally {
        await sql.end();
      }
    });

    it('coordonnées centre valides acceptées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const row = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('valid-center', 'FR', 'CITY', ST_GeomFromText('POINT(2.3522 48.8566)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "id"
        `.then((r) => r[0]!);
        expect(row.id).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    it('bounding box valide acceptée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const row = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('valid-bbox', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.7, 2.2, 49.0, 2.5)
          RETURNING "id"
        `.then((r) => r[0]!);
        expect(row.id).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    it('rejet des latitudes hors bornes pour bbox : bbox_south=-100 rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('bad-lat-south', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), -100, 2.3, 48.9, 2.4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('rejet des longitudes hors bornes pour bbox : bbox_west=200 rejeté', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('bad-lon-west', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 200, 48.9, 2.4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('rejet sud >= nord : égalité et inversion rejetées', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        // south = north → rejeté
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('south-eq-north', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 45.0, 2.3, 45.0, 2.4)
          `,
        ).rejects.toThrow();
        // south > north → rejeté
        await expect(
          sql`
            INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES ('south-gt-north', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 46.0, 2.3, 45.0, 2.4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('représentation antiméridien acceptée : bbox_west=170, bbox_east=-170', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const row = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('antimeridian', 'FR', 'CITY', ST_GeomFromText('POINT(180 0)', 4326), -10.0, 170.0, 10.0, -170.0)
          RETURNING "id"
        `.then((r) => r[0]!);
        expect(row.id).toBeTruthy();
      } finally {
        await sql.end();
      }
    });

    it('activation impossible si pays inactif', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale") VALUES ('PT', false, 'EUR', 'pt') ON CONFLICT ("country_code") DO NOTHING`;
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'lisbon-inactive',
          countryCode: 'PT',
          placeType: 'CITY',
          center: 'POINT(-9.1 38.7)',
          bbox: [38.6, -9.2, 38.8, -9.0],
          translations: [
            { locale: 'fr', label: 'Lisbonne' },
            { locale: 'en', label: 'Lisbon' },
          ],
        });
        await expect(
          sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('activation impossible sans traduction FR', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'no-fr-translation',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [{ locale: 'en', label: 'Paris' }],
        });
        await expect(
          sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('activation impossible sans traduction EN', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'no-en-translation',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [{ locale: 'fr', label: 'Paris' }],
        });
        await expect(
          sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('activation possible avec pays actif et traductions FR+EN', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'activable-destination',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
        });
        await sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`;
        const row = await sql`SELECT "is_active" FROM "destinations" WHERE "id" = ${destId}`.then(
          (r) => r[0]!,
        );
        expect(row.is_active).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it("impossibilité de supprimer traduction FR d'une destination active", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'protect-fr-delete',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await expect(
          sql`DELETE FROM "destination_translations" WHERE "destination_id" = ${destId} AND "locale" = 'fr'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("impossibilité de supprimer traduction EN d'une destination active", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'protect-en-delete',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await expect(
          sql`DELETE FROM "destination_translations" WHERE "destination_id" = ${destId} AND "locale" = 'en'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("impossibilité de changer locale FR vers une autre locale d'une destination active", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'protect-fr-locale-change',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await expect(
          sql`UPDATE "destination_translations" SET "locale" = 'de' WHERE "destination_id" = ${destId} AND "locale" = 'fr'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it("impossibilité de changer locale EN vers une autre locale d'une destination active", async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'protect-en-locale-change',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await expect(
          sql`UPDATE "destination_translations" SET "locale" = 'de' WHERE "destination_id" = ${destId} AND "locale" = 'en'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('désactivation fail-closed : destination active → is_active=false autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'deactivate-allowed',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await sql`UPDATE "destinations" SET "is_active" = false WHERE "id" = ${destId}`;
        const row = await sql`SELECT "is_active" FROM "destinations" WHERE "id" = ${destId}`.then(
          (r) => r[0]!,
        );
        expect(row.is_active).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it('suppression traduction autorisée si destination inactive', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'delete-translation-inactive',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
        });
        await sql`DELETE FROM "destination_translations" WHERE "destination_id" = ${destId} AND "locale" = 'fr'`;
        const rows =
          await sql`SELECT "locale" FROM "destination_translations" WHERE "destination_id" = ${destId}`;
        expect(rows.length).toBe(1);
        expect(rows[0]!.locale).toBe('en');
      } finally {
        await sql.end();
      }
    });

    it('déplacement traduction FR vers autre destination refusé (destination active)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const dest1Id = await seedDestinationWithTranslations(sql, {
          slug: 'move-fr-active-src',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        const dest2Id = await seedDestinationWithTranslations(sql, {
          slug: 'move-fr-active-dst',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(4.83 45.76)',
          bbox: [45.7, 4.8, 45.8, 4.9],
          translations: [
            { locale: 'fr', label: 'Lyon' },
            { locale: 'en', label: 'Lyon' },
          ],
        });
        await expect(
          sql`UPDATE "destination_translations" SET "destination_id" = ${dest2Id} WHERE "destination_id" = ${dest1Id} AND "locale" = 'fr'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('déplacement traduction EN vers autre destination refusé (destination active)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const dest1Id = await seedDestinationWithTranslations(sql, {
          slug: 'move-en-active-src',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        const dest2Id = await seedDestinationWithTranslations(sql, {
          slug: 'move-en-active-dst',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(4.83 45.76)',
          bbox: [45.7, 4.8, 45.8, 4.9],
          translations: [
            { locale: 'fr', label: 'Lyon' },
            { locale: 'en', label: 'Lyon' },
          ],
        });
        await expect(
          sql`UPDATE "destination_translations" SET "destination_id" = ${dest2Id} WHERE "destination_id" = ${dest1Id} AND "locale" = 'en'`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('modification du label autorisée pour traduction FR (destination active)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'update-label-active',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        await sql`UPDATE "destination_translations" SET "label" = 'Nouveau libellé' WHERE "destination_id" = ${destId} AND "locale" = 'fr'`;
        const row =
          await sql`SELECT "label" FROM "destination_translations" WHERE "destination_id" = ${destId} AND "locale" = 'fr'`.then(
            (r) => r[0]!,
          );
        expect(row.label).toBe('Nouveau libellé');
      } finally {
        await sql.end();
      }
    });

    it('opérations autorisées après désactivation (déplacement, suppression, changement locale)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await seedActiveCountry(sql, 'FR');
        const dest1Id = await seedDestinationWithTranslations(sql, {
          slug: 'ops-after-deactivate-src',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
          isActive: true,
        });
        const dest2Id = await seedDestinationWithTranslations(sql, {
          slug: 'ops-after-deactivate-dst',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(4.83 45.76)',
          bbox: [45.7, 4.8, 45.8, 4.9],
          translations: [{ locale: 'en', label: 'Lyon' }],
        });
        // Désactiver la destination source
        await sql`UPDATE "destinations" SET "is_active" = false WHERE "id" = ${dest1Id}`;
        // Déplacement autorisé après désactivation
        await sql`UPDATE "destination_translations" SET "destination_id" = ${dest2Id} WHERE "destination_id" = ${dest1Id} AND "locale" = 'fr'`;
        // Suppression autorisée après désactivation
        await sql`DELETE FROM "destination_translations" WHERE "destination_id" = ${dest1Id} AND "locale" = 'en'`;
        const rows =
          await sql`SELECT count(*)::int AS cnt FROM "destination_translations" WHERE "destination_id" = ${dest1Id}`;
        expect(rows[0]!.cnt).toBe(0);
      } finally {
        await sql.end();
      }
    });

    // -------------------------------------------------------------------------
    // D. Localisations
    // -------------------------------------------------------------------------
    it('locations.public_id généré et immuable', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const loc =
          await sql`SELECT "public_id" FROM "locations" WHERE "id" = ${ids.locationId}`.then(
            (r) => r[0]!,
          );
        expect(loc.public_id).toBeTruthy();
        await expect(
          sql`UPDATE "locations" SET "public_id" = gen_random_uuid() WHERE "id" = ${ids.locationId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('is_publicly_listed false par défaut', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const loc = await sql`
          SELECT "is_publicly_listed" FROM "locations" WHERE "id" = ${ids.locationId}
        `.then((r) => r[0]!);
        expect(loc.is_publicly_listed).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it('publication refusée sans pickup_enabled', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'No Pickup', ${'no-pickup-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', false, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'FR', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée sans geo_point', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'No Geo', ${'no-geo-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, '1 rue Test', 'Annecy', 'FR', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée pour ligne supprimée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "deleted_at", "operating_currency")
            VALUES (${ids.orgId}, 'Deleted Listed', ${'deleted-listed-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'FR', true, now(), 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée sans address_line1', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "city", "country_code", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'No Addr', ${'no-addr-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), 'Annecy', 'FR', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée sans city', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "country_code", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'No City', ${'no-city-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'FR', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée sans country_code', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'No Country', ${'no-country-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication refusée avec country_code invalide (minuscules)', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`
            INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
            VALUES (${ids.orgId}, 'Lower Country', ${'lower-country-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'fr', true, 'EUR')
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('publication acceptée lorsque toutes les conditions locales sont satisfaites', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const loc = await sql`
          INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
          VALUES (${ids.orgId}, 'Valid Listed', ${'valid-listed-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'FR', true, 'EUR')
          RETURNING "is_publicly_listed"
        `.then((r) => r[0]!);
        expect(loc.is_publicly_listed).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it('code postal non universellement obligatoire : publication acceptée sans postal_code', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const loc = await sql`
          INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
          VALUES (${ids.orgId}, 'No Postal', ${'no-postal-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'FR', true, 'EUR')
          RETURNING "is_publicly_listed", "postal_code"
        `.then((r) => r[0]!);
        expect(loc.is_publicly_listed).toBe(true);
        expect(loc.postal_code).toBeNull();
      } finally {
        await sql.end();
      }
    });

    // -------------------------------------------------------------------------
    // E. Identifiants publics
    // -------------------------------------------------------------------------
    it('destinations.public_id immuable', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const dest = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('imm-dest', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "id", "public_id"
        `.then((r) => r[0]!);
        await expect(
          sql`UPDATE "destinations" SET "public_id" = gen_random_uuid() WHERE "id" = ${dest.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('products.public_id immuable', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`UPDATE "products" SET "public_id" = gen_random_uuid() WHERE "id" = ${ids.productId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('locations.public_id immuable', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await expect(
          sql`UPDATE "locations" SET "public_id" = gen_random_uuid() WHERE "id" = ${ids.locationId}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('public_id UNIQUE pour destinations', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const fixedUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
        await sql`
          INSERT INTO "destinations" ("public_id", "slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES (${fixedUuid}::uuid, 'dup-pid-1', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
        `;
        await expect(
          sql`
            INSERT INTO "destinations" ("public_id", "slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
            VALUES (${fixedUuid}::uuid, 'dup-pid-2', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    it('UPDATE d autre champ d une destination sans mentionner public_id : autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const dest = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('update-sort-order', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "id"
        `.then((r) => r[0]!);
        await sql`UPDATE "destinations" SET "sort_order" = 5 WHERE "id" = ${dest.id}`;
        const row = await sql`SELECT "sort_order" FROM "destinations" WHERE "id" = ${dest.id}`.then(
          (r) => r[0]!,
        );
        expect(row.sort_order).toBe(5);
      } finally {
        await sql.end();
      }
    });

    it('UPDATE d autre champ d un produit sans mentionner public_id : autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await sql`UPDATE "products" SET "name" = 'New Name' WHERE "id" = ${ids.productId}`;
        const row = await sql`SELECT "name" FROM "products" WHERE "id" = ${ids.productId}`.then(
          (r) => r[0]!,
        );
        expect(row.name).toBe('New Name');
      } finally {
        await sql.end();
      }
    });

    it('UPDATE d autre champ d une location sans mentionner public_id : autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        await sql`UPDATE "locations" SET "name" = 'New Name' WHERE "id" = ${ids.locationId}`;
        const row = await sql`SELECT "name" FROM "locations" WHERE "id" = ${ids.locationId}`.then(
          (r) => r[0]!,
        );
        expect(row.name).toBe('New Name');
      } finally {
        await sql.end();
      }
    });

    it('SET public_id = public_id (no-op) sur destination : autorisé', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const dest = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('noop-public-id', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "id", "public_id"
        `.then((r) => r[0]!);
        await sql`UPDATE "destinations" SET "public_id" = "public_id" WHERE "id" = ${dest.id}`;
        const row = await sql`SELECT "public_id" FROM "destinations" WHERE "id" = ${dest.id}`.then(
          (r) => r[0]!,
        );
        expect(row.public_id).toBe(dest.public_id);
      } finally {
        await sql.end();
      }
    });

    it('mise à NULL de public_id sur destination : refusée', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        const dest = await sql`
          INSERT INTO "destinations" ("slug", "country_code", "place_type", "center", "bbox_south", "bbox_west", "bbox_north", "bbox_east")
          VALUES ('null-public-id', 'FR', 'CITY', ST_GeomFromText('POINT(2.35 48.85)', 4326), 48.8, 2.3, 48.9, 2.4)
          RETURNING "id"
        `.then((r) => r[0]!);
        await expect(
          sql`UPDATE "destinations" SET "public_id" = NULL WHERE "id" = ${dest.id}`,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    });

    // -------------------------------------------------------------------------
    // F. Recherche future fail-closed
    // -------------------------------------------------------------------------
    it('pays inactif → aucune destination active possible', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "is_active", "default_currency", "default_locale") VALUES ('ES', false, 'EUR', 'es') ON CONFLICT ("country_code") DO NOTHING`;
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'spain-inactive-country',
          countryCode: 'ES',
          placeType: 'CITY',
          center: 'POINT(-3.7 40.4)',
          bbox: [40.0, -4.0, 40.6, -3.5],
          translations: [
            { locale: 'fr', label: 'Madrid' },
            { locale: 'en', label: 'Madrid' },
          ],
        });
        await expect(
          sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`,
        ).rejects.toThrow();
        const active =
          await sql`SELECT count(*)::int AS cnt FROM "destinations" WHERE "is_active" = true AND "country_code" = 'ES'`;
        expect(active[0]!.cnt).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('destination inactive → non éligible', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        await sql`INSERT INTO "countries" ("country_code", "default_currency", "default_locale") VALUES ('FR', 'EUR', 'fr') ON CONFLICT ("country_code") DO NOTHING`;
        await seedDestinationWithTranslations(sql, {
          slug: 'inactive-dest-query',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
        });
        const active =
          await sql`SELECT count(*)::int AS cnt FROM "destinations" WHERE "is_active" = true AND "slug" = 'inactive-dest-query'`;
        expect(active[0]!.cnt).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('location non listée → non éligible', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const listed =
          await sql`SELECT count(*)::int AS cnt FROM "locations" WHERE "is_publicly_listed" = true AND "id" = ${ids.locationId}`;
        expect(listed[0]!.cnt).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('organisation sans public_display_name → non éligible', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        const ids = await seedBaseData(sql);
        const eligible =
          await sql`SELECT count(*)::int AS cnt FROM "organizations" WHERE "public_display_name" IS NOT NULL AND "id" = ${ids.orgId}`;
        expect(eligible[0]!.cnt).toBe(0);
      } finally {
        await sql.end();
      }
    });

    it('activation explicite de toutes les conditions rend les données éligibles', async () => {
      if (!testUrl) return;
      const sql = postgres(testUrl, { max: 1 });
      try {
        // Country actif
        await seedActiveCountry(sql, 'FR');
        // Destination active avec FR+EN
        const destId = await seedDestinationWithTranslations(sql, {
          slug: 'fully-eligible-dest',
          countryCode: 'FR',
          placeType: 'CITY',
          center: 'POINT(2.35 48.85)',
          bbox: [48.8, 2.3, 48.9, 2.4],
          translations: [
            { locale: 'fr', label: 'Paris' },
            { locale: 'en', label: 'Paris' },
          ],
        });
        await sql`UPDATE "destinations" SET "is_active" = true WHERE "id" = ${destId}`;

        // Organisation avec public_display_name
        const org = await sql`
          INSERT INTO "organizations" ("legal_name", "slug", "public_display_name")
          VALUES ('Eligible Org', ${'eligible-org-' + Math.random().toString(36).slice(2, 8)}, 'Annecy Kayak Co.')
          RETURNING "id"
        `.then((r) => r[0]!);

        // Location publiable
        await sql`
          INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "pickup_enabled", "geo_point", "address_line1", "city", "country_code", "is_publicly_listed", "operating_currency")
          VALUES (${org.id}, 'Eligible Loc', ${'eligible-loc-' + Math.random().toString(36).slice(2, 8)}, 'Europe/Paris', true, ST_GeomFromText('POINT(6.13 45.9)', 4326), '1 rue Test', 'Annecy', 'FR', true, 'EUR')
        `;

        // Vérifier tous les prédicats
        const activeDests =
          await sql`SELECT count(*)::int AS cnt FROM "destinations" WHERE "is_active" = true AND "deleted_at" IS NULL`;
        expect(activeDests[0]!.cnt).toBeGreaterThanOrEqual(1);

        const listedLocs =
          await sql`SELECT count(*)::int AS cnt FROM "locations" WHERE "is_publicly_listed" = true`;
        expect(listedLocs[0]!.cnt).toBeGreaterThanOrEqual(1);

        const orgsWithPdn =
          await sql`SELECT count(*)::int AS cnt FROM "organizations" WHERE "public_display_name" IS NOT NULL`;
        expect(orgsWithPdn[0]!.cnt).toBeGreaterThanOrEqual(1);

        const activeCountries =
          await sql`SELECT count(*)::int AS cnt FROM "countries" WHERE "is_active" = true`;
        expect(activeCountries[0]!.cnt).toBeGreaterThanOrEqual(1);
      } finally {
        await sql.end();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Upgrade 0030 → 0031 avec données préexistantes
// ---------------------------------------------------------------------------
const UPGRADE_TEST_DB = 'uttuly_test_lot7_upgrade';

async function applyMigrationsUntilBefore0031(dbUrl: string): Promise<void> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of allFiles) {
      const num = parseInt(file.slice(0, 4), 10);
      if (isNaN(num) || num >= 31) continue;
      const sqlContent = readFileSync(join(migrationsDir, file), 'utf-8');
      await sql.unsafe(sqlContent);
    }
  } finally {
    await sql.end();
  }
}

async function applyMigration0031(dbUrl: string): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const sqlContent = readFileSync(
    join(migrationsDir, '0031_lot7_public_search_foundations.sql'),
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

describe.skipIf(shouldSkipIntegrationTests())('Upgrade 0030 → 0031 avec données', () => {
  let upgradeTestUrl: string | null = null;
  let upgradeAdminSql: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    if (!url) {
      if (ci) throw new Error('CI: DATABASE_URL est requise pour le test upgrade Lot 7.');
      return;
    }
    upgradeAdminSql = postgres(url, { max: 1 });
    await upgradeAdminSql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_TEST_DB};`);
    await upgradeAdminSql.unsafe(`CREATE DATABASE ${UPGRADE_TEST_DB};`);
    const upgradeUrlObj = new URL(url);
    upgradeUrlObj.pathname = `/${UPGRADE_TEST_DB}`;
    upgradeTestUrl = upgradeUrlObj.toString();
    await applyMigrationsUntilBefore0031(upgradeTestUrl);
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

  it('préserve les données 0030 et applique 0031 correctement', async () => {
    if (!upgradeTestUrl) return;
    const dbUrl = upgradeTestUrl;

    // Connexion 1 : insertion de données préexistantes sur la base 0030.
    const sql1 = postgres(dbUrl, { max: 1 });
    let orgId: string;
    let locationId: string;
    let productId: string;
    let legalName: string;
    try {
      const org = await sql1`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES ('Upgrade Test Org', 'upgrade-test-org')
        RETURNING "id", "legal_name"
      `.then((r) => r[0]!);
      orgId = org.id;
      legalName = org.legal_name;

      const location = await sql1`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgId}, 'Upgrade Loc', 'upgrade-loc', 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      locationId = location.id;

      const category =
        await sql1`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const product = await sql1`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgId}, ${category.id}, 'Upgrade Kayak', 'upgrade-kayak')
        RETURNING "id"
      `.then((r) => r[0]!);
      productId = product.id;
    } finally {
      await sql1.end();
    }

    // Appliquer la migration 0031 dans une transaction.
    await applyMigration0031(dbUrl);

    // Connexion 2 : vérifications post-migration.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // Données 0030 préservées avec mêmes IDs.
      const org =
        await sql2`SELECT "id", "legal_name" FROM "organizations" WHERE "id" = ${orgId}`.then(
          (r) => r[0]!,
        );
      expect(org.id).toBe(orgId);
      expect(org.legal_name).toBe(legalName);

      const loc = await sql2`SELECT "id" FROM "locations" WHERE "id" = ${locationId}`.then(
        (r) => r[0]!,
      );
      expect(loc.id).toBe(locationId);

      const prod = await sql2`SELECT "id" FROM "products" WHERE "id" = ${productId}`.then(
        (r) => r[0]!,
      );
      expect(prod.id).toBe(productId);

      // Backfill non NULL et unique des public_id.
      const prodPid = await sql2`SELECT "public_id" FROM "products" WHERE "id" = ${productId}`.then(
        (r) => r[0]!,
      );
      expect(prodPid.public_id).toBeTruthy();

      const locPid =
        await sql2`SELECT "public_id" FROM "locations" WHERE "id" = ${locationId}`.then(
          (r) => r[0]!,
        );
      expect(locPid.public_id).toBeTruthy();

      const dupProdPid =
        await sql2`SELECT count(*)::int AS cnt FROM "products" WHERE "public_id" IS NOT NULL GROUP BY "public_id" HAVING count(*) > 1`;
      expect(dupProdPid.length).toBe(0);

      const dupLocPid =
        await sql2`SELECT count(*)::int AS cnt FROM "locations" WHERE "public_id" IS NOT NULL GROUP BY "public_id" HAVING count(*) > 1`;
      expect(dupLocPid.length).toBe(0);

      // locations.is_publicly_listed = false pour les anciennes lignes.
      const locListed =
        await sql2`SELECT "is_publicly_listed" FROM "locations" WHERE "id" = ${locationId}`.then(
          (r) => r[0]!,
        );
      expect(locListed.is_publicly_listed).toBe(false);

      // Tables 0031 existent.
      const countriesExist = await sql2`SELECT to_regclass('countries') AS reg`.then((r) => r[0]!);
      expect(countriesExist.reg).toBe('countries');

      const destinationsExist = await sql2`SELECT to_regclass('destinations') AS reg`.then(
        (r) => r[0]!,
      );
      expect(destinationsExist.reg).toBe('destinations');

      const dtExist = await sql2`SELECT to_regclass('destination_translations') AS reg`.then(
        (r) => r[0]!,
      );
      expect(dtExist.reg).toBe('destination_translations');

      // Fonctions attendues.
      const funcs =
        await sql2`SELECT proname FROM pg_proc WHERE proname IN ('prevent_public_id_mutation', 'check_destination_activation', 'protect_destination_required_translations')`;
      expect(funcs.length).toBe(3);

      // Triggers attendus.
      const triggers =
        await sql2`SELECT tgname FROM pg_trigger WHERE tgname IN ('prevent_destinations_public_id_mutation', 'prevent_products_public_id_mutation', 'prevent_locations_public_id_mutation', 'before_check_destination_activation', 'before_protect_destination_translations')`;
      expect(triggers.length).toBe(5);

      // organizations.public_display_name existe.
      const pdnCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'public_display_name'`;
      expect(pdnCol.length).toBe(1);

      // products.public_id existe.
      const prodPidCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'public_id'`;
      expect(prodPidCol.length).toBe(1);

      // locations.public_id et is_publicly_listed existent.
      const locPidCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'public_id'`;
      expect(locPidCol.length).toBe(1);

      const locListedCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'is_publicly_listed'`;
      expect(locListedCol.length).toBe(1);
    } finally {
      await sql2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback transactionnel 0031
// ---------------------------------------------------------------------------
const ROLLBACK_TEST_DB = 'uttuly_test_lot7_rollback';

describe.skipIf(shouldSkipIntegrationTests())('Rollback transactionnel 0031', () => {
  let rollbackTestUrl: string | null = null;
  let rollbackAdminSql: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    if (!url) {
      if (ci) throw new Error('CI: DATABASE_URL est requise pour le test rollback Lot 7.');
      return;
    }
    rollbackAdminSql = postgres(url, { max: 1 });
    await rollbackAdminSql.unsafe(`DROP DATABASE IF EXISTS ${ROLLBACK_TEST_DB};`);
    await rollbackAdminSql.unsafe(`CREATE DATABASE ${ROLLBACK_TEST_DB};`);
    const rollbackUrlObj = new URL(url);
    rollbackUrlObj.pathname = `/${ROLLBACK_TEST_DB}`;
    rollbackTestUrl = rollbackUrlObj.toString();
    await applyMigrationsUntilBefore0031(rollbackTestUrl);
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

  it('rollback complet : aucune application partielle de 0031', async () => {
    if (!rollbackTestUrl) return;
    const dbUrl = rollbackTestUrl;

    // Connexion 1 : insertion de données préexistantes sur la base 0030.
    const sql1 = postgres(dbUrl, { max: 1 });
    let orgId: string;
    let locationId: string;
    let productId: string;
    let legalName: string;
    try {
      const org = await sql1`
        INSERT INTO "organizations" ("legal_name", "slug")
        VALUES ('Rollback Test Org', 'rollback-test-org')
        RETURNING "id", "legal_name"
      `.then((r) => r[0]!);
      orgId = org.id;
      legalName = org.legal_name;

      const location = await sql1`
        INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone")
        VALUES (${orgId}, 'Rollback Loc', 'rollback-loc', 'Europe/Paris')
        RETURNING "id"
      `.then((r) => r[0]!);
      locationId = location.id;

      const category =
        await sql1`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
          (r) => r[0]!,
        );
      const product = await sql1`
        INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
        VALUES (${orgId}, ${category.id}, 'Rollback Kayak', 'rollback-kayak')
        RETURNING "id"
      `.then((r) => r[0]!);
      productId = product.id;
    } finally {
      await sql1.end();
    }

    // Lire le contenu de 0031 et tenter de l'appliquer dans une transaction
    // qui échoue volontairement.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const sqlContent = readFileSync(
      join(migrationsDir, '0031_lot7_public_search_foundations.sql'),
      'utf-8',
    );

    const sqlTx = postgres(dbUrl, { max: 1 });
    try {
      await expect(
        sqlTx.begin(async (tx) => {
          await tx.unsafe(sqlContent);
          // Vérifier in-tx que les objets existent.
          const countriesExist = await tx`SELECT to_regclass('countries') AS reg`.then(
            (r) => r[0]!,
          );
          expect(countriesExist.reg).toBe('countries');
          // Provoquer une erreur volontaire → rollback.
          await tx.unsafe('SELECT 1/0');
        }),
      ).rejects.toThrow();
    } finally {
      await sqlTx.end();
    }

    // Connexion fraîche : vérifier que rien de 0031 n'a subsisté.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // Données 0030 toujours présentes et inchangées.
      const org =
        await sql2`SELECT "id", "legal_name" FROM "organizations" WHERE "id" = ${orgId}`.then(
          (r) => r[0]!,
        );
      expect(org.id).toBe(orgId);
      expect(org.legal_name).toBe(legalName);

      const loc = await sql2`SELECT "id" FROM "locations" WHERE "id" = ${locationId}`.then(
        (r) => r[0]!,
      );
      expect(loc.id).toBe(locationId);

      const prod = await sql2`SELECT "id" FROM "products" WHERE "id" = ${productId}`.then(
        (r) => r[0]!,
      );
      expect(prod.id).toBe(productId);

      // Table countries n'existe pas.
      const countriesExist = await sql2`SELECT to_regclass('countries') AS reg`.then((r) => r[0]!);
      expect(countriesExist.reg).toBeNull();

      // destinations et destination_translations n'existent pas.
      const destinationsExist = await sql2`SELECT to_regclass('destinations') AS reg`.then(
        (r) => r[0]!,
      );
      expect(destinationsExist.reg).toBeNull();

      const dtExist = await sql2`SELECT to_regclass('destination_translations') AS reg`.then(
        (r) => r[0]!,
      );
      expect(dtExist.reg).toBeNull();

      // organizations.public_display_name n'existe pas.
      const pdnCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'public_display_name'`;
      expect(pdnCol.length).toBe(0);

      // products.public_id n'existe pas.
      const prodPidCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'public_id'`;
      expect(prodPidCol.length).toBe(0);

      // locations.public_id et is_publicly_listed n'existent pas.
      const locPidCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'public_id'`;
      expect(locPidCol.length).toBe(0);

      const locListedCol =
        await sql2`SELECT column_name FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'is_publicly_listed'`;
      expect(locListedCol.length).toBe(0);

      // Aucune fonction de 0031 ne subsiste.
      const funcs =
        await sql2`SELECT proname FROM pg_proc WHERE proname IN ('prevent_public_id_mutation', 'check_destination_activation', 'protect_destination_required_translations')`;
      expect(funcs.length).toBe(0);

      // Aucun trigger de 0031 ne subsiste.
      const triggers =
        await sql2`SELECT tgname FROM pg_trigger WHERE tgname IN ('prevent_destinations_public_id_mutation', 'prevent_products_public_id_mutation', 'prevent_locations_public_id_mutation', 'before_check_destination_activation', 'before_protect_destination_translations')`;
      expect(triggers.length).toBe(0);
    } finally {
      await sql2.end();
    }
  });
});
