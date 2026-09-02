import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  convertManualBlockLocalPeriod,
  createManualBlock,
  normalizeManualBlockLocalDateTime,
} from './manual-block';

const orgId = '00000000-0000-0000-0000-000000000001';
const itemId = '00000000-0000-0000-0000-000000000002';
const locationId = '00000000-0000-0000-0000-000000000003';

describe('blocage manuel — validation et conversion locale', () => {
  it('accepte la précision minute de datetime-local et rejette les offsets', () => {
    expect(normalizeManualBlockLocalDateTime('2026-01-15T10:30', 'startAt')).toBe(
      '2026-01-15T10:30:00',
    );
    expect(() => normalizeManualBlockLocalDateTime('2026-01-15T10:30+01:00', 'startAt')).toThrow(
      /sans fuseau/,
    );
  });

  it('convertit les horaires dans le fuseau de l’établissement', () => {
    const period = convertManualBlockLocalPeriod(
      '2026-01-15T10:00',
      '2026-01-15T12:00',
      'Europe/Paris',
    );
    expect(period.startAt.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(period.endAt.toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('refuse une période inversée et les heures DST inexistantes', () => {
    expect(() =>
      convertManualBlockLocalPeriod('2026-01-15T12:00', '2026-01-15T10:00', 'Europe/Paris'),
    ).toThrow(/fin doit être après/);
    expect(() =>
      convertManualBlockLocalPeriod('2026-03-29T02:30', '2026-03-29T04:00', 'Europe/Paris'),
    ).toThrow(/pas valide/);
  });

  it('valide les identifiants et la clé avant tout accès base', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      createManualBlock(fakeDb, {
        organizationId: 'invalid',
        inventoryItemId: itemId,
        locationId,
        startAt: '2026-01-15T10:00',
        endAt: '2026-01-15T12:00',
        idempotencyKey: 'manual-validation',
      }),
    ).rejects.toThrow(/organizationId/);

    await expect(
      createManualBlock(fakeDb, {
        organizationId: orgId,
        inventoryItemId: itemId,
        locationId,
        startAt: '2026-01-15T10:00',
        endAt: '2026-01-15T12:00',
        idempotencyKey: '',
      }),
    ).rejects.toThrow(/clé d'idempotence/);
  });
});
