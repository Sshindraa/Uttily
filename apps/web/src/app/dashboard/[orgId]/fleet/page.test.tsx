import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('FleetListPage (Chantier 7A & 7B)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation de catalogue pour afficher la flotte unitaire', () => {
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('listInventorySummaries(db, organizationId)');
  });

  it('utilise un vocabulaire centré sur la Flotte physique', () => {
    expect(pageSource).toContain('Ma Flotte Physique');
    expect(pageSource).toContain('Exemplaires totaux');
    expect(pageSource).toContain('En service · Disponibles');
    expect(pageSource).toContain('En maintenance / Révision');
  });
});
