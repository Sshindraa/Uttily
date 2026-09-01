import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0051_activate_kayak_category.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('migration de la catégorie kayak', () => {
  it('ajoute ou réactive uniquement la catégorie canonique kayak', () => {
    expect(migration).toContain("VALUES ('kayak', 'Kayaks', true)");
    expect(migration).toContain('ON CONFLICT ("slug") DO UPDATE');
    expect(migration).toContain('"is_active" = true');
    expect(migration).not.toMatch(/UPDATE\s+"products"/i);
    expect(migration).not.toContain("'equipment'");
  });
});
