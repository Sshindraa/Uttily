import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import {
  buildOperationalItemCalendarEvents,
  getOperationalItemCalendar,
  type OperationalItemCalendarSourceRow,
} from './get-operational-item-calendar';
import { getDefaultWeekWindow } from './get-operational-planning';
import type { OperationalPlanningFleetItem } from './types';

const orgId = '00000000-0000-0000-0000-000000000001';
const itemId = '00000000-0000-0000-0000-000000000002';
const locationId = '00000000-0000-0000-0000-000000000003';
const from = new Date('2026-10-24T00:00:00.000Z');
const to = new Date('2026-10-26T00:00:00.000Z');

const item: OperationalPlanningFleetItem = {
  id: itemId,
  internalSku: 'SKU-42',
  serialNumber: 'SN-42',
  productName: 'Kayak test',
  variantName: 'Solo',
  categorySlug: 'kayak',
  condition: 'GOOD',
  status: 'ACTIVE',
  locationId,
  locationName: 'Annecy',
};

function sourceRow(
  overrides: Partial<OperationalItemCalendarSourceRow> &
    Pick<OperationalItemCalendarSourceRow, 'inventoryBlockId' | 'blockType'>,
): OperationalItemCalendarSourceRow {
  return {
    blockStatus: 'ACTIVE',
    blockCustomerStartAt: new Date('2026-10-24T10:00:00.000Z'),
    blockCustomerEndAt: new Date('2026-10-24T12:00:00.000Z'),
    blockStartAt: new Date('2026-10-24T09:00:00.000Z'),
    blockEndAt: new Date('2026-10-24T13:00:00.000Z'),
    holdExpiresAt: null,
    bookingId: null,
    bookingStatus: null,
    bookingCustomerStartAt: null,
    bookingCustomerEndAt: null,
    customerDisplayName: null,
    customerEmail: null,
    maintenanceCaseId: null,
    maintenanceStatus: null,
    maintenanceReason: null,
    recurringSeriesId: null,
    ...overrides,
  };
}

describe('buildOperationalItemCalendarEvents', () => {
  it('agrège les quatre types, tronque la fenêtre et relie la série récurrente', () => {
    const rows = [
      sourceRow({ inventoryBlockId: 'hold-1', blockType: 'HOLD', holdExpiresAt: to }),
      sourceRow({
        inventoryBlockId: 'booking-block-1',
        blockType: 'BOOKING',
        bookingId: 'booking-1',
        bookingStatus: 'CONFIRMED',
        customerDisplayName: 'Client test',
        blockStartAt: new Date('2026-10-23T23:00:00.000Z'),
        blockEndAt: new Date('2026-10-24T01:00:00.000Z'),
      }),
      sourceRow({
        inventoryBlockId: 'maintenance-1',
        blockType: 'MAINTENANCE',
        maintenanceCaseId: 'case-1',
        maintenanceStatus: 'IN_PROGRESS',
        maintenanceReason: 'Contrôle',
      }),
      sourceRow({
        inventoryBlockId: 'manual-1',
        blockType: 'MANUAL_BLOCK',
        recurringSeriesId: 'series-1',
      }),
    ];

    const events = buildOperationalItemCalendarEvents(rows, item, 'Europe/Paris', from, to);

    expect(events.map((event) => event.type)).toEqual([
      'HOLD',
      'RENTAL',
      'MAINTENANCE',
      'MANUAL_BLOCK',
    ]);
    expect(events[0]).toMatchObject({
      holdId: 'hold-1',
      holdExpiresAt: to,
      reason: 'Hold temporaire',
      locationTimeZone: 'Europe/Paris',
    });
    expect(events[1]).toMatchObject({
      bookingId: 'booking-1',
      customerName: 'Client test',
      startAt: from,
      endAt: new Date('2026-10-24T01:00:00.000Z'),
    });
    expect(events[2]).toMatchObject({
      maintenanceCaseId: 'case-1',
      reason: 'Contrôle',
      status: 'IN_PROGRESS',
    });
    expect(events[3]).toMatchObject({
      manualBlockId: 'manual-1',
      recurringSeriesId: 'series-1',
      reason: 'Indisponibilité manuelle récurrente',
    });
  });

  it('ignore les blocs inconnus et ceux qui ne chevauchent pas la fenêtre', () => {
    const events = buildOperationalItemCalendarEvents(
      [
        sourceRow({ inventoryBlockId: 'unknown', blockType: 'FUTURE_TYPE' }),
        sourceRow({
          inventoryBlockId: 'outside',
          blockType: 'HOLD',
          blockStartAt: new Date('2026-10-26T00:00:00.000Z'),
          blockEndAt: new Date('2026-10-26T01:00:00.000Z'),
        }),
      ],
      item,
      'America/New_York',
      from,
      to,
    );

    expect(events).toHaveLength(0);
  });

  it('conserve les instants UTC autour d’un changement d’heure et le fuseau IANA', () => {
    const dstFrom = new Date('2026-10-24T22:00:00.000Z');
    const dstTo = new Date('2026-10-25T04:00:00.000Z');
    const events = buildOperationalItemCalendarEvents(
      [
        sourceRow({
          inventoryBlockId: 'dst-block',
          blockType: 'MANUAL_BLOCK',
          blockStartAt: new Date('2026-10-24T23:30:00.000Z'),
          blockEndAt: new Date('2026-10-25T03:30:00.000Z'),
        }),
      ],
      item,
      'Europe/Paris',
      dstFrom,
      dstTo,
    );

    expect(events[0]).toMatchObject({
      locationTimeZone: 'Europe/Paris',
      startAt: new Date('2026-10-24T23:30:00.000Z'),
      endAt: new Date('2026-10-25T03:30:00.000Z'),
    });
    expect(getDefaultWeekWindow(new Date('2026-10-25T12:00:00.000Z'), 'Europe/Paris')).toEqual({
      from: new Date('2026-10-18T22:00:00.000Z'),
      to: new Date('2026-10-25T23:00:00.000Z'),
    });
  });
});

describe('getOperationalItemCalendar validation', () => {
  it('rejette les identifiants hors contrat avant toute lecture', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(getOperationalItemCalendar(fakeDb, 'bad', itemId)).rejects.toThrow(
      'organizationId',
    );
    await expect(getOperationalItemCalendar(fakeDb, orgId, 'bad')).rejects.toThrow(
      'inventoryItemId',
    );
    await expect(
      getOperationalItemCalendar(fakeDb, orgId, itemId, { locationId: 'bad' }),
    ).rejects.toThrow('locationId');
  });

  it('rejette une fenêtre inversée sans interroger la base', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      getOperationalItemCalendar(fakeDb, orgId, itemId, { from: to, to: from }),
    ).rejects.toBeInstanceOf(CatalogError);
  });
});
