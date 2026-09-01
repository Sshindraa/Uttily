import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '../../../../../features/fleet/maintenance/maintenance-list-view.tsx',
);

describe('MaintenanceListPage (Chantier 9A & 9C & 21-U2.3)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une autorisation catalogue pour afficher la page atelier', () => {
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('listMaintenanceCases');
  });

  it("affiche les sections d'interventions et l'historique", () => {
    expect(source).toContain('Atelier & Maintenance');
    expect(source).toContain('Interventions à traiter');
  });

  it('laisse le rendu de l’atelier à la feature dédiée', () => {
    expect(pageSource).toContain('<MaintenanceListView');
    expect(pageSource).not.toContain('<Card');
    expect(pageSource).not.toContain('style=');
  });
});
