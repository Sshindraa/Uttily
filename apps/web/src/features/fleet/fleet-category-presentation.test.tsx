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
  it('affiche la présentation kayak dans la flotte sans changer les états', () => {
    const html = renderToStaticMarkup(
      <FleetListView organizationId="org-1" items={[inventoryItem('kayak')]} canManage={false} />,
    );

    expect(html).toContain('🛶 kayak');
    expect(html).toContain('Disponible');
    expect(html).not.toContain('🚲 vélo');
  });

  it('adapte les libellés de maintenance pour le vélo et le kayak', () => {
    const html = renderToStaticMarkup(
      <MaintenanceListView
        organizationId="org-1"
        cases={[maintenanceCase('bike'), maintenanceCase('kayak')]}
      />,
    );

    expect(html).toContain('🚲 vélo');
    expect(html).toContain('🛶 kayak');
    expect(html).toContain('À traiter');
    expect(html).toContain('Interventions à traiter (2)');
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
