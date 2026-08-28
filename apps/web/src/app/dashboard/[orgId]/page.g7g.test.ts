import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('G7G — dashboard maintenance projection', () => {
  const page = readFileSync(PAGE_PATH, 'utf8');

  it('utilise le contexte organisationnel authentifié et capture asOf une seule fois', () => {
    expect(page).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(page).toMatch(/const asOf = new Date\(\);/);
    expect(page).toContain('listMaintenanceDashboardSignals(db, organizationId, { asOf })');
  });

  it('rend la section, la liste, le compte et les labels visibles accessibles', () => {
    expect(page).toContain('aria-labelledby="maintenance-signals-heading"');
    expect(page).toContain('aria-label="Alertes de matériel et de maintenance"');
    expect(page).toContain('<h2 id="maintenance-signals-heading">');
    expect(page).toContain('<strong>{signalLabel}</strong>');
    expect(page).toContain('Aucune alerte de matériel ou de maintenance.');
    expect(page).not.toContain('role="alert"');
    expect(page).toContain('BROKEN_ITEM');
    expect(page).toContain('ACTIVE_MAINTENANCE');
    expect(page).toContain('UPCOMING_MAINTENANCE');
    expect(page).toContain('Matériel cassé');
    expect(page).toContain('Maintenance active');
    expect(page).toContain('Maintenance à venir');
    expect(page).toContain('maintenanceSignals.length');
  });

  it('affiche le fuseau IANA et relie chaque signal à la flotte', () => {
    expect(page).toContain('formatDateTimeInTimeZone');
    expect(page).toContain('signal.locationTimeZone');
    expect(page).toContain('/fleet');
  });
});
