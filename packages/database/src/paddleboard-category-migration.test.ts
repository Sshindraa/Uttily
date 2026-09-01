import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0054_activate_paddleboard_category.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('migration de la catégorie paddleboard', () => {
  it('ajoute ou réactive uniquement la catégorie canonique paddleboard', () => {
    expect(migration).toContain("VALUES ('paddleboard', 'Paddle', true)");
    expect(migration).toContain('ON CONFLICT ("slug") DO UPDATE');
    expect(migration).toContain('"is_active" = true');
    expect(migration).not.toMatch(/UPDATE\s+"products"/i);
    expect(migration).not.toContain("'equipment'");
    expect(migration).not.toContain("'paddle'");
  });
});
