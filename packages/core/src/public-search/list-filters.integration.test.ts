import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { PublicSearchError } from './errors';
import { listPublicSearchFilterOptions } from './list-filters';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('public_search_filters');
  if (!ctx) return;
  db = createDatabase(ctx.databaseUrl);
  rawSql = postgres(ctx.databaseUrl, { max: 2 });
});

afterAll(async () => {
  if (db) await db.$client.end();
  if (rawSql) await rawSql.end();
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!rawSql) return;
  await rawSql`TRUNCATE destination_translations, destinations, countries RESTART IDENTITY CASCADE`;
});

async function seedDestination(input: {
  slug: string;
  countryCode: string;
  countryActive: boolean;
  sortOrder: number;
  frLabel: string;
  enLabel: string;
}): Promise<string> {
  if (!rawSql) throw new Error('rawSql absent');
  await rawSql`
    INSERT INTO countries (country_code, is_active, default_currency, default_locale)
    VALUES (${input.countryCode}, true, 'EUR', 'fr')
  `;
  const destination = await rawSql`
    INSERT INTO destinations (
      slug, country_code, place_type, center,
      bbox_south, bbox_west, bbox_north, bbox_east, sort_order
    ) VALUES (
      ${input.slug}, ${input.countryCode}, 'CITY',
      ST_SetSRID(ST_MakePoint(2.35, 48.86), 4326),
      48.8, 2.2, 48.9, 2.5, ${input.sortOrder}
    ) RETURNING id, public_id
  `.then((rows) => rows[0]!);
  await rawSql`
    INSERT INTO destination_translations (destination_id, locale, label)
    VALUES
      (${destination.id}, 'fr', ${input.frLabel}),
      (${destination.id}, 'en', ${input.enLabel})
  `;
  await rawSql`UPDATE destinations SET is_active = true WHERE id = ${destination.id}`;
  if (!input.countryActive) {
    await rawSql`UPDATE countries SET is_active = false WHERE country_code = ${input.countryCode}`;
  }
  return String(destination.public_id);
}

describe.skipIf(shouldSkipIntegrationTests())('listPublicSearchFilterOptions', () => {
  it('expose seulement les destinations dont le pays est actif, dans un ordre stable', async () => {
    if (!db) throw new Error('db absent');
    const second = await seedDestination({
      slug: 'lyon',
      countryCode: 'FR',
      countryActive: true,
      sortOrder: 20,
      frLabel: 'Lyon',
      enLabel: 'Lyon',
    });
    const first = await seedDestination({
      slug: 'bruxelles',
      countryCode: 'BE',
      countryActive: true,
      sortOrder: 10,
      frLabel: 'Bruxelles',
      enLabel: 'Brussels',
    });
    await seedDestination({
      slug: 'geneve',
      countryCode: 'CH',
      countryActive: false,
      sortOrder: 1,
      frLabel: 'Genève',
      enLabel: 'Geneva',
    });

    const result = await listPublicSearchFilterOptions(db, 'fr-FR');
    expect(result.destinations.map((item) => item.publicId)).toEqual([first, second]);
    expect(result.destinations.map((item) => item.label)).toEqual(['Bruxelles', 'Lyon']);
    expect(result.categories.length).toBeGreaterThan(0);
    expect(result.categories.every((category) => category.id && category.name)).toBe(true);
    expect(result.categories.every((category) => 'parentId' in category)).toBe(true);
  });

  it('expose les liens parent-enfant réels sans catégorie inactive', async () => {
    if (!db || !rawSql) throw new Error('db absent');
    const [parent] = await rawSql`
      INSERT INTO categories (slug, name) VALUES ('search-test-parent', 'Famille test') RETURNING id
    `;
    const [child] = await rawSql`
      INSERT INTO categories (slug, name, parent_id)
      VALUES ('search-test-child', 'Sous-famille test', ${parent!.id}) RETURNING id
    `;
    const [inactive] = await rawSql`
      INSERT INTO categories (slug, name, parent_id, is_active)
      VALUES ('search-test-inactive', 'Inactive', ${parent!.id}, false) RETURNING id
    `;
    const result = await listPublicSearchFilterOptions(db, 'fr');
    expect(result.categories.find((item) => item.id === parent!.id)?.parentId).toBeNull();
    expect(result.categories.find((item) => item.id === child!.id)?.parentId).toBe(parent!.id);
    expect(result.categories.some((item) => item.id === inactive!.id)).toBe(false);
  });

  it('sélectionne explicitement la traduction EN sans fallback implicite', async () => {
    if (!db) throw new Error('db absent');
    await seedDestination({
      slug: 'paris',
      countryCode: 'FR',
      countryActive: true,
      sortOrder: 0,
      frLabel: 'Paris',
      enLabel: 'Paris area',
    });
    const result = await listPublicSearchFilterOptions(db, 'en-GB');
    expect(result.destinations[0]?.label).toBe('Paris area');
  });

  it('refuse fail-closed une locale publique non supportée avant toute lecture', async () => {
    if (!db) throw new Error('db absent');
    await expect(listPublicSearchFilterOptions(db, 'de')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    } satisfies Partial<PublicSearchError>);
  });
});
