import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { DashboardError } from './errors';
import {
  classifyMaintenanceBlock,
  listMaintenanceDashboardSignals,
  normalizeMaintenanceDashboardLimit,
  orderMaintenanceDashboardSignals,
} from './maintenance-signals';
import type { MaintenanceDashboardSignal } from './types';

const asOf = new Date('2026-08-09T12:00:00.000Z');
const hour = 60 * 60 * 1000;

const fakeDb = {} as DatabaseClient;
const organizationId = '00000000-0000-4000-8000-000000000001';

function common(overrides?: Partial<MaintenanceDashboardSignal>): MaintenanceDashboardSignal {
  return {
    kind: 'BROKEN_ITEM',
    inventoryItemId: '00000000-0000-4000-8000-000000000010',
    internalSku: 'SKU-001',
    productName: 'Kayak',
    variantName: 'Standard',
    locationId: '00000000-0000-4000-8000-000000000020',
    locationName: 'Annecy',
    locationTimeZone: 'Europe/Paris',
    ...overrides,
  } as MaintenanceDashboardSignal;
}

function maintenance(
  kind: 'ACTIVE_MAINTENANCE' | 'UPCOMING_MAINTENANCE',
  overrides?: Partial<MaintenanceDashboardSignal>,
): MaintenanceDashboardSignal {
  return common({
    kind,
    maintenanceBlockId: '00000000-0000-4000-8000-000000000030',
    blockedStartAt: new Date(asOf.getTime() - hour),
    blockedEndAt: new Date(asOf.getTime() + hour),
    ...overrides,
  });
}

describe('listMaintenanceDashboardSignals — validation', () => {
  it('refuse un organizationId qui ne correspond pas à un UUID', async () => {
    await expect(listMaintenanceDashboardSignals(fakeDb, 'not-an-uuid')).rejects.toMatchObject({
      name: 'DashboardError',
      code: 'VALIDATION',
    } satisfies Partial<DashboardError>);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuse une limite invalide: %s',
    async (limit) => {
      await expect(
        listMaintenanceDashboardSignals(fakeDb, organizationId, { limit }),
      ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<DashboardError>);
    },
  );

  it('refuse une Date asOf invalide sans utiliser la date courante en fallback', async () => {
    await expect(
      listMaintenanceDashboardSignals(fakeDb, organizationId, {
        asOf: new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<DashboardError>);
  });

  it('refuse une asOf dont la fenêtre de 24 heures dépasse les dates représentables', async () => {
    await expect(
      listMaintenanceDashboardSignals(fakeDb, organizationId, {
        asOf: new Date(8_640_000_000_000_000),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<DashboardError>);
  });
});

describe('normalizeMaintenanceDashboardLimit', () => {
  it('normalise une limite absente à 50', () => {
    expect(normalizeMaintenanceDashboardLimit()).toBe(50);
  });

  it('conserve toutes les limites de 1 à 100', () => {
    const limits = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(limits.map((limit) => normalizeMaintenanceDashboardLimit(limit))).toEqual(limits);
  });

  it('plafonne les limites sûres supérieures à 100 à 100', () => {
    expect(
      [101, 1000, Number.MAX_SAFE_INTEGER].map((limit) =>
        normalizeMaintenanceDashboardLimit(limit),
      ),
    ).toEqual([100, 100, 100]);
  });
});

describe('classifyMaintenanceBlock', () => {
  it('applique les bornes exactes de l intervalle [start, end)', () => {
    expect(
      classifyMaintenanceBlock(
        {
          blockedStartAt: asOf,
          blockedEndAt: new Date(asOf.getTime() + hour),
        },
        asOf,
      ),
    ).toBe('ACTIVE_MAINTENANCE');

    expect(
      classifyMaintenanceBlock(
        {
          blockedStartAt: new Date(asOf.getTime() - hour),
          blockedEndAt: asOf,
        },
        asOf,
      ),
    ).toBeNull();

    expect(
      classifyMaintenanceBlock(
        {
          blockedStartAt: new Date(asOf.getTime() + 24 * hour),
          blockedEndAt: new Date(asOf.getTime() + 25 * hour),
        },
        asOf,
      ),
    ).toBe('UPCOMING_MAINTENANCE');

    expect(
      classifyMaintenanceBlock(
        {
          blockedStartAt: new Date(asOf.getTime() + 24 * hour + 1),
          blockedEndAt: new Date(asOf.getTime() + 25 * hour),
        },
        asOf,
      ),
    ).toBeNull();
  });
});

describe('orderMaintenanceDashboardSignals', () => {
  it('ordonne active, cassé, puis à venir avec les tie-breakers déterministes', () => {
    const signals: MaintenanceDashboardSignal[] = [
      maintenance('UPCOMING_MAINTENANCE', {
        inventoryItemId: '00000000-0000-4000-8000-000000000099',
        maintenanceBlockId: '00000000-0000-4000-8000-000000000099',
        blockedStartAt: new Date(asOf.getTime() + hour),
        blockedEndAt: new Date(asOf.getTime() + 2 * hour),
      }),
      common({
        internalSku: 'SKU-002',
        inventoryItemId: '00000000-0000-4000-8000-000000000012',
      }),
      maintenance('ACTIVE_MAINTENANCE', {
        inventoryItemId: '00000000-0000-4000-8000-000000000011',
        maintenanceBlockId: '00000000-0000-4000-8000-000000000031',
        blockedStartAt: new Date(asOf.getTime() - hour),
      }),
      common({
        internalSku: 'SKU-001',
        inventoryItemId: '00000000-0000-4000-8000-000000000013',
      }),
      maintenance('ACTIVE_MAINTENANCE', {
        inventoryItemId: '00000000-0000-4000-8000-000000000010',
        maintenanceBlockId: '00000000-0000-4000-8000-000000000030',
        blockedStartAt: new Date(asOf.getTime() - hour),
      }),
    ];

    const ordered = orderMaintenanceDashboardSignals(signals);

    expect(ordered.map((signal) => `${signal.kind}:${signal.inventoryItemId}`)).toEqual([
      'ACTIVE_MAINTENANCE:00000000-0000-4000-8000-000000000010',
      'ACTIVE_MAINTENANCE:00000000-0000-4000-8000-000000000011',
      'BROKEN_ITEM:00000000-0000-4000-8000-000000000013',
      'BROKEN_ITEM:00000000-0000-4000-8000-000000000012',
      'UPCOMING_MAINTENANCE:00000000-0000-4000-8000-000000000099',
    ]);
    expect(signals[0]?.kind).toBe('UPCOMING_MAINTENANCE');
  });

  it('conserve la forme fermée : un signal BROKEN_ITEM ne porte aucun champ de bloc', () => {
    const broken = common();
    expect(Object.keys(broken).sort()).toEqual([
      'internalSku',
      'inventoryItemId',
      'kind',
      'locationId',
      'locationName',
      'locationTimeZone',
      'productName',
      'variantName',
    ]);
  });
});
