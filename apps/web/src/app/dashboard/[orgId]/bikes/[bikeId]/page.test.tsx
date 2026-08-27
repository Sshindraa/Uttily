import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('UnifiedBikePage (G8B Vertical Slice)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('appelle getUnifiedBike et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('getUnifiedBike(db, organizationId, bikeId)');
    expect(pageSource).toContain('if (bike === null) notFound()');
  });

  it('expose les 4 piliers fondamentaux dans sa structure visuelle', () => {
    expect(pageSource).toContain('1. Identité & Descriptif');
    expect(pageSource).toContain('2. Standard Photo (3 Vues)');
    expect(pageSource).toContain('3. Tarification & Paliers');
    expect(pageSource).toContain('4. Flotte & Numéros de Série');
  });

  it('fournit les liens contextuels directs pour chaque dimension métier', () => {
    expect(pageSource).toContain('/edit');
    expect(pageSource).toContain('/pricing');
    expect(pageSource).toContain('/inventory/new');
  });
});
