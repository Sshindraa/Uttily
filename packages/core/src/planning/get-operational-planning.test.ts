import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  clipPlanningInterval,
  getDefaultWeekWindow,
  getOperationalPlanning,
} from './get-operational-planning';

describe('Chantier 10 — getOperationalPlanning', () => {
  it('calcule la semaine par défaut dans le fuseau du lieu', () => {
    const window = getDefaultWeekWindow(new Date('2026-08-30T23:30:00Z'), 'America/Los_Angeles');

    expect(window.from).toEqual(new Date('2026-08-24T07:00:00Z'));
    expect(window.to).toEqual(new Date('2026-08-31T07:00:00Z'));
  });

  it('rejette un organizationId invalide', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(getOperationalPlanning(fakeDb, 'invalid-uuid')).rejects.toThrow('organizationId');
  });

  it('rejette une période inversée', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    const orgId = '00000000-0000-0000-0000-000000000001';
    await expect(
      getOperationalPlanning(fakeDb, orgId, {
        from: new Date('2026-08-30T10:00:00Z'),
        to: new Date('2026-08-20T10:00:00Z'),
      }),
    ).rejects.toThrow('date de fin');
  });

  it('clipse les événements à la fenêtre affichée et respecte l’intervalle semi-ouvert', () => {
    const from = new Date('2026-08-03T00:00:00Z');
    const to = new Date('2026-08-04T00:00:00Z');

    expect(
      clipPlanningInterval(
        new Date('2026-08-02T22:00:00Z'),
        new Date('2026-08-04T02:00:00Z'),
        from,
        to,
      ),
    ).toEqual({ startAt: from, endAt: to });
    expect(
      clipPlanningInterval(
        new Date('2026-08-04T00:00:00Z'),
        new Date('2026-08-04T02:00:00Z'),
        from,
        to,
      ),
    ).toBeNull();
  });
});
