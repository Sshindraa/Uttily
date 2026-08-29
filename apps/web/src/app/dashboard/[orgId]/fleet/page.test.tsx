import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('FleetListPage (Chantier 7A & 7B & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation de catalogue pour afficher la flotte unitaire', () => {
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('listInventorySummaries(db, organizationId)');
  });

  it('utilise un vocabulaire centré sur la Flotte de vélos sans jargon interne', () => {
    expect(pageSource).toContain('title="Flotte"');
    expect(pageSource).toContain('Vélos au total');
    expect(pageSource).toContain('Disponibles');
    expect(pageSource).toContain('En maintenance');
    expect(pageSource).toContain('Référence vélo');
  });
});
