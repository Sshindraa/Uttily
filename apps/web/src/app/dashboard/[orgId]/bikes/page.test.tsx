import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/bikes/bikes-list-view.tsx');

describe('BikesListPage (Mes équipements & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('utilise listUnifiedBikes et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('listUnifiedBikes(db, organizationId)');
  });

  it('affiche les titres, le CTA d’ajout et les liens vers les fiches équipements', () => {
    expect(source).toContain('Mes équipements');
    expect(source).toContain('Ajouter un équipement');
    expect(source).toContain('/bikes/${bike.id}');
  });

  it('gère les statuts fail-closed (ONLINE_AVAILABLE, READY_TO_PUBLISH, etc.)', () => {
    expect(source).toContain('ONLINE_AVAILABLE');
    expect(source).toContain('En ligne · Disponible');
    expect(source).toContain('ONLINE_UNAVAILABLE');
    expect(source).toContain('En ligne · Indisponible');
  });

  it('laisse la présentation de la flotte à la feature bikes', () => {
    expect(pageSource).toContain('<BikesListView');
    expect(pageSource).not.toContain('<PageHeader');
    expect(pageSource).not.toContain('style=');
  });
});
