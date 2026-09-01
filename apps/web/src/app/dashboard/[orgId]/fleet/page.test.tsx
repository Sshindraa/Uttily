import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/fleet/fleet-list-view.tsx');

describe('FleetListPage (Chantier 7A & 7B & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une autorisation de catalogue pour afficher la flotte unitaire', () => {
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('listInventorySummaries(db, organizationId)');
  });

  it('utilise un vocabulaire centré sur la flotte d’équipements sans jargon interne', () => {
    expect(source).toContain('title="Flotte"');
    expect(source).toContain('Équipements au total');
    expect(source).toContain('Disponibles');
    expect(source).toContain('En maintenance');
    expect(source).toContain('Référence exemplaire');
  });

  it('laisse le rendu de la flotte à la feature dédiée', () => {
    expect(pageSource).toContain('<FleetListView');
    expect(pageSource).not.toContain('<table');
    expect(pageSource).not.toContain('className=');
  });
});
