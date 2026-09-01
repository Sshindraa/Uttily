import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../../features/bikes/bike-detail-view.tsx');

describe('UnifiedBikePage (Fiche Vélo Unifiée v2 - Centre de commande)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('appelle getUnifiedBike et exige les autorisations catalogue du loueur', () => {
    expect(pageSource).toContain('requireCatalogViewerOf(orgId)');
    expect(pageSource).toContain('getUnifiedBike(db, organizationId, bikeId)');
    expect(pageSource).toContain('if (bike === null) notFound()');
  });

  it('intègre les 4 cartes modulaires d’action sur place', () => {
    expect(source).toContain('BikeIdentityCard');
    expect(source).toContain('BikePhotosCard');
    expect(source).toContain('BikePricingCard');
    expect(source).toContain('BikeInventoryCard');
  });

  it('fournit le fil d’Ariane et les badges de statut fail-closed', () => {
    expect(source).toContain('← Retour à Mes équipements');
    expect(source).toContain('ONLINE_AVAILABLE');
    expect(source).toContain('En ligne · Disponible');
  });

  it('laisse la présentation de la fiche à la feature bikes', () => {
    expect(pageSource).toContain('<BikeDetailView');
    expect(pageSource).not.toContain('<section');
    expect(pageSource).not.toContain('className=');
  });
});
