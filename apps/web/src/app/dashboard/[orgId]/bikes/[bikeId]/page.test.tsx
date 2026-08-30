import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('UnifiedBikePage (Fiche Vélo Unifiée v2 - Centre de commande)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('appelle getUnifiedBike et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('getUnifiedBike(db, organizationId, bikeId)');
    expect(pageSource).toContain('if (bike === null) notFound()');
  });

  it('intègre les 4 cartes modulaires d’action sur place', () => {
    expect(pageSource).toContain('BikeIdentityCard');
    expect(pageSource).toContain('BikePhotosCard');
    expect(pageSource).toContain('BikePricingCard');
    expect(pageSource).toContain('BikeInventoryCard');
  });

  it('fournit le fil d’Ariane et les badges de statut fail-closed', () => {
    expect(pageSource).toContain('← Retour à Mes équipements');
    expect(pageSource).toContain('ONLINE_AVAILABLE');
    expect(pageSource).toContain('En ligne · Disponible');
  });
});
