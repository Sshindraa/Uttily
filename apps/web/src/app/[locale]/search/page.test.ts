import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('PublicSearchPage', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('rends une erreur fermée au lieu de laisser remonter une panne technique', () => {
    expect(pageSource).toContain("getPublicErrorMessage('SEARCH_UNAVAILABLE', locale)");
  });
});
