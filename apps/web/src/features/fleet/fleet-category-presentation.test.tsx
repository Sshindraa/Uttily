import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InventorySummary, MaintenanceCaseSummary } from '@uttily/core';
import { FleetListView } from './fleet-list-view';
import { MaintenanceListView } from './maintenance/maintenance-list-view';
import { MaintenanceCaseDetailView } from './maintenance/case-detail-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/app/actions/maintenance', () => ({
  openMaintenanceCaseAction: vi.fn(),
  startMaintenanceCaseAction: vi.fn(),
  resolveMaintenanceCaseAction: vi.fn(),
}));

vi.mock('@/app/actions/inventory', () => ({
  transferInventoryItemsBatchAction: vi.fn(),
}));

const inventoryItem = (categorySlug: string): InventorySummary => ({
  id: 'item-1',
  internalSku: 'SKU-1',
  serialNumber: 'SN-1',
  condition: 'GOOD',
  status: 'ACTIVE',
  productVariantId: 'variant-1',
  variantName: 'Standard',
  productId: 'product-1',
  productName: 'Équipement de test',
  categorySlug,
  currentLocationId: 'location-1',
  locationName: 'Paris',
});

const maintenanceCase = (
  categorySlug: string,
  status: MaintenanceCaseSummary['status'] = 'OPEN',
): MaintenanceCaseSummary => ({
  id: `${categorySlug}-case`,
  maintenanceBlockId: `${categorySlug}-block`,
  inventoryItemId: `${categorySlug}-item`,
  internalSku: 'SKU-1',
  serialNumber: 'SN-1',
  productName: 'Équipement de test',
  variantName: 'Standard',
  categorySlug,
  locationId: 'location-1',
  locationName: 'Paris',
  locationTimeZone: 'Europe/Paris',
  status,
  condition: status === 'RESOLVED' ? 'GOOD' : 'BROKEN',
  reason: 'Contrôle nécessaire',
  openedNotes: null,
  resolutionNotes: status === 'RESOLVED' ? 'Contrôle terminé' : null,
  sourceDamageReportId: null,
  openedBy: 'user-1',
  openedAt: new Date('2026-01-01T10:00:00Z'),
  startedBy: status === 'IN_PROGRESS' ? 'user-1' : null,
  startedAt: status === 'IN_PROGRESS' ? new Date('2026-01-01T11:00:00Z') : null,
  resolvedBy: status === 'RESOLVED' ? 'user-1' : null,
  resolvedAt: status === 'RESOLVED' ? new Date('2026-01-01T12:00:00Z') : null,
});

describe('présentation catégorie — flotte et maintenance', () => {
  it('expose une sélection et une action de transfert génériques aux gestionnaires', () => {
    const html = renderToStaticMarkup(
      <FleetListView
        organizationId="org-1"
        items={[inventoryItem('kayak')]}
        locations={[
          { id: 'location-1', name: 'Paris' },
          { id: 'location-2', name: 'Annecy' },
        ]}
        canManage
      />,
    );

    expect(html).toContain('Sélectionner tous les exemplaires');
    expect(html).toContain('Sélectionner SKU-1');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('Transférer vers un établissement');
  });

  it('affiche la présentation kayak dans la flotte sans changer les états', () => {
    const html = renderToStaticMarkup(
      <FleetListView organizationId="org-1" items={[inventoryItem('kayak')]} canManage={false} />,
    );

    expect(html).toContain('🛶 kayak');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('🚲 vélo');
  });

  it('affiche la présentation surf dans la flotte', () => {
    const html = renderToStaticMarkup(
      <FleetListView organizationId="org-1" items={[inventoryItem('surf')]} canManage={false} />,
    );

    expect(html).toContain('🏄 planche de surf');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('🚲 vélo');
  });

  it('affiche le canoë avec la présentation nautique neutre', () => {
    const html = renderToStaticMarkup(
      <FleetListView organizationId="org-1" items={[inventoryItem('canoe')]} canManage={false} />,
    );

    expect(html).toContain('🛶 canoë');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('kayak');
    expect(html).not.toContain('🚲 vélo');
  });

  it('affiche le ski dans la flotte sans activer une présentation snowboard', () => {
    const html = renderToStaticMarkup(
      <FleetListView organizationId="org-1" items={[inventoryItem('ski')]} canManage={false} />,
    );

    expect(html).toContain('🎿 ski');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('Snowboard');
    expect(html).not.toContain('🚲 vélo');
  });

  it('affiche le snowboard dans la flotte avec la présentation neutre', () => {
    const html = renderToStaticMarkup(
      <FleetListView
        organizationId="org-1"
        items={[inventoryItem('snowboard')]}
        canManage={false}
      />,
    );

    expect(html).toContain('🏂 snowboard');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('🎿 ski');
    expect(html).not.toContain('🚲 vélo');
  });

  it('adapte les libellés de maintenance pour les familles actives', () => {
    const html = renderToStaticMarkup(
      <MaintenanceListView
        organizationId="org-1"
        cases={[
          maintenanceCase('bike'),
          maintenanceCase('kayak'),
          maintenanceCase('surf'),
          maintenanceCase('ski'),
          maintenanceCase('snowboard'),
          maintenanceCase('canoe'),
        ]}
      />,
    );

    expect(html).toContain('🚲 vélo');
    expect(html).toContain('🛶 kayak');
    expect(html).toContain('🏄 planche de surf');
    expect(html).toContain('🎿 ski');
    expect(html).toContain('🏂 snowboard');
    expect(html).toContain('🛶 canoë');
    expect(html).toContain('À traiter');
    expect(html).toContain('Interventions à traiter (6)');
  });

  it('conserve la disponibilité et la transition de remise en service', () => {
    const activeHtml = renderToStaticMarkup(
      <MaintenanceCaseDetailView
        organizationId="org-1"
        caseDetails={maintenanceCase('equipment', 'IN_PROGRESS')}
      />,
    );
    const resolvedHtml = renderToStaticMarkup(
      <MaintenanceCaseDetailView
        organizationId="org-1"
        caseDetails={maintenanceCase('equipment', 'RESOLVED')}
      />,
    );

    expect(activeHtml).toContain('🧰 équipement concerné');
    expect(activeHtml).toContain('Bloqué / Indisponible');
    expect(activeHtml).toContain('Intervention en cours');
    expect(activeHtml).toContain('Terminer la réparation · équipement');
    expect(resolvedHtml).toContain('Disponible à la location');
    expect(resolvedHtml).toContain('Réparation terminée');
    expect(activeHtml).not.toContain('🚲 vélo');
    expect(resolvedHtml).not.toContain('🚲 vélo');
  });
});
