import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0060_activate_snowshoes_and_sled_categories.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('migration des catégories raquettes et luge', () => {
  it('ajoute ou réactive uniquement les deux familles neige demandées', () => {
    expect(migration).toContain("VALUES ('snowshoes', 'Raquettes', true)");
    expect(migration).toContain("VALUES ('sled', 'Luge', true)");
    expect(migration.match(/ON CONFLICT \("slug"\) DO UPDATE/g)).toHaveLength(2);
    expect(migration.match(/"is_active" = true/g)).toHaveLength(2);
    expect(migration).not.toMatch(/UPDATE\s+"products"/i);
    expect(migration).not.toContain("'equipment'");
    expect(migration).not.toContain("'ski'");
    expect(migration).not.toContain("'snowboard'");
  });
});
