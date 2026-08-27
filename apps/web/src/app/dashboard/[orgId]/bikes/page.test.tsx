import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('BikesListPage (Mes Vélos)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('utilise listUnifiedBikes et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('listUnifiedBikes(db, organizationId)');
  });

  it('affiche les titres, le CTA d’ajout et les liens vers les fiches vélos unifiées', () => {
    expect(pageSource).toContain('Mes Vélos');
    expect(pageSource).toContain('Ajouter un vélo');
    expect(pageSource).toContain('/bikes/${bike.id}');
  });

  it('gère les statuts fail-closed (BOOKABLE, READY_TO_PUBLISH, etc.)', () => {
    expect(pageSource).toContain('BOOKABLE');
    expect(pageSource).toContain('En ligne & réservable');
    expect(pageSource).toContain('PUBLISHED_UNAVAILABLE');
    expect(pageSource).toContain('En ligne (Indisponible)');
  });
});
