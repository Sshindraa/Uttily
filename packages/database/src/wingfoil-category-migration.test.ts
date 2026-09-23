import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0062_activate_wingfoil_category.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('migration de la catégorie wingfoil', () => {
  it('ajoute ou réactive uniquement la catégorie canonique wingfoil', () => {
    expect(migration).toContain("VALUES ('wingfoil', 'Wingfoil', true)");
    expect(migration).toContain('ON CONFLICT ("slug") DO UPDATE');
    expect(migration).toContain('"is_active" = true');
    expect(migration).not.toMatch(/UPDATE\s+"products"/i);
    expect(migration).not.toContain("'equipment'");
    expect(migration).not.toContain("'surf'");
  });
});
