import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('BikesListPage (Mes équipements & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('utilise listUnifiedBikes et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('listUnifiedBikes(db, organizationId)');
  });

  it('affiche les titres, le CTA d’ajout et les liens vers les fiches équipements', () => {
    expect(pageSource).toContain('Mes équipements');
    expect(pageSource).toContain('Ajouter un équipement');
    expect(pageSource).toContain('/bikes/${bike.id}');
  });

  it('gère les statuts fail-closed (ONLINE_AVAILABLE, READY_TO_PUBLISH, etc.)', () => {
    expect(pageSource).toContain('ONLINE_AVAILABLE');
    expect(pageSource).toContain('En ligne · Disponible');
    expect(pageSource).toContain('ONLINE_UNAVAILABLE');
    expect(pageSource).toContain('En ligne · Indisponible');
  });
});
