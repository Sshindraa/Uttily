import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OperationalPlanning, OperationalPlanningEvent } from '@uttily/core';
import { getPlanningFleetDayStatus, PlanningView } from './planning-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const from = new Date('2026-08-03T00:00:00.000Z');
const to = new Date('2026-08-10T00:00:00.000Z');

function event(
  overrides: Partial<OperationalPlanningEvent> &
    Pick<OperationalPlanningEvent, 'id' | 'type' | 'inventoryItemId' | 'categorySlug'>,
): OperationalPlanningEvent {
  return {
    internalSku: `SKU-${overrides.inventoryItemId}`,
    productName: 'Équipement de test',
    variantName: 'Standard',
    locationId: 'location-1',
    locationName: 'Paris',
    locationTimeZone: 'Europe/Paris',
    startAt: new Date('2026-08-03T10:00:00.000Z'),
    endAt: new Date('2026-08-04T10:00:00.000Z'),
    status: 'ACTIVE',
    ...overrides,
  };
}

function planning(): OperationalPlanning {
  return {
    from,
    to,
    locationId: 'location-1',
    locationName: 'Paris',
    locationTimeZone: 'Europe/Paris',
    events: [
      event({
        id: 'rental-1',
        type: 'RENTAL',
        inventoryItemId: 'rented-item',
        categorySlug: 'surf',
        bookingId: 'booking-1',
      }),
      event({
        id: 'pickup-1',
        type: 'PICKUP',
        inventoryItemId: 'rented-item',
        categorySlug: 'surf',
        bookingId: 'booking-1',
      }),
      event({
        id: 'return-1',
        type: 'RETURN',
        inventoryItemId: 'rented-item',
        categorySlug: 'surf',
        bookingId: 'booking-1',
        startAt: new Date('2026-08-04T10:00:00.000Z'),
        endAt: new Date('2026-08-04T10:00:00.000Z'),
      }),
      event({
        id: 'maintenance-1',
        type: 'MAINTENANCE',
        inventoryItemId: 'maintenance-item',
        categorySlug: 'canoe',
        maintenanceCaseId: 'case-1',
        startAt: new Date('2026-08-05T08:00:00.000Z'),
        endAt: new Date('2026-08-06T16:00:00.000Z'),
        reason: 'Contrôle',
      }),
      event({
        id: 'manual-block-1',
        type: 'MANUAL_BLOCK',
        inventoryItemId: 'blocked-item',
        categorySlug: 'kayak',
        manualBlockId: 'block-1',
        startAt: new Date('2026-08-06T08:00:00.000Z'),
        endAt: new Date('2026-08-07T16:00:00.000Z'),
        reason: 'Indisponibilité manuelle',
      }),
    ],
    stats: {
      totalRentals: 1,
      totalPickups: 1,
      totalReturns: 1,
      totalMaintenances: 1,
      totalManualBlocks: 1,
    },
    fleetItems: [
      {
        id: 'rented-item',
        internalSku: 'SKU-SURF',
        serialNumber: null,
        productName: 'Planche',
        variantName: 'Standard',
        categorySlug: 'surf',
        condition: 'GOOD',
        status: 'ACTIVE',
        locationId: 'location-1',
        locationName: 'Paris',
      },
      {
        id: 'maintenance-item',
        internalSku: 'SKU-CANOE',
        serialNumber: null,
        productName: 'Canoë',
        variantName: 'Standard',
        categorySlug: 'canoe',
        condition: 'BROKEN',
        status: 'ACTIVE',
        locationId: 'location-1',
        locationName: 'Paris',
      },
      {
        id: 'blocked-item',
        internalSku: 'SKU-KAYAK',
        serialNumber: null,
        productName: 'Kayak',
        variantName: 'Standard',
        categorySlug: 'kayak',
        condition: 'GOOD',
        status: 'ACTIVE',
        locationId: 'location-1',
        locationName: 'Paris',
      },
    ],
  };
}

describe('PlanningView — blocages manuels', () => {
  it('distingue indisponibilité, location et maintenance et affiche le statut Bloqué', () => {
    const html = renderToStaticMarkup(
      <PlanningView
        orgId="org-1"
        planning={planning()}
        locations={[{ id: 'location-1', name: 'Paris' }]}
        selectedLocationId="location-1"
      />,
    );

    expect(html).toContain('⛔ Indisponible');
    expect(html).toContain('🔧 Maintenance');
    expect(html).toContain('↓ Départ');
    expect(html).toContain('↑ Retour');
    expect(html).toContain('Blocages manuels');
    expect(html).toContain('🏄 planche de surf');
    expect(html).toContain('🛶 canoë');
    expect(html).toContain('🛶 kayak');
    expect(html).not.toContain('Photo Coach');

    expect(
      getPlanningFleetDayStatus(planning().events, 'org-1', 'blocked-item', '2026-08-06'),
    ).toMatchObject({ status: 'BLOCKED', label: '⛔ Bloqué' });
  });
});
