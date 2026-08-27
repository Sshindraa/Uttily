import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('MaintenanceListPage (Chantier 9A & 9C)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation catalogue pour afficher la page atelier', () => {
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('listMaintenanceCases');
  });

  it("affiche les sections d'interventions et l'historique", () => {
    expect(pageSource).toContain('Atelier &amp; Maintenance');
    expect(pageSource).toContain('Interventions à traiter');
  });
});
