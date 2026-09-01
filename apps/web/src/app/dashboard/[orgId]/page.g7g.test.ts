import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'features',
  'dashboard',
  'dashboard-cockpit.tsx',
);

describe('G7G — dashboard maintenance projection', () => {
  const page = readFileSync(PAGE_PATH, 'utf8');
  const cockpit = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${page}\n${cockpit}`;

  it('utilise le contexte organisationnel authentifié et capture asOf une seule fois', () => {
    expect(page).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(page).toMatch(/const asOf = new Date\(\);/);
    expect(page).toContain('listMaintenanceDashboardSignals(db, organizationId, { asOf })');
  });

  it('reste une couche d orchestration et délègue la présentation à la feature', () => {
    expect(page).toContain('<DashboardCockpit');
    expect(page).not.toContain('className=');
    expect(page).not.toContain('.module.css');
  });

  it('rend la section, la liste, le compte et les labels visibles accessibles', () => {
    expect(source).toContain('aria-labelledby="maintenance-signals-heading"');
    expect(source).toContain('aria-label="Alertes de matériel et de maintenance"');
    expect(source).toContain('<h2 id="maintenance-signals-heading">');
    expect(source).toContain('<strong>{signalLabel}</strong>');
    expect(source).toContain('Aucune alerte de matériel ou de maintenance.');
    expect(source).not.toContain('role="alert"');
    expect(source).toContain('BROKEN_ITEM');
    expect(source).toContain('ACTIVE_MAINTENANCE');
    expect(source).toContain('UPCOMING_MAINTENANCE');
    expect(source).toContain('Matériel cassé');
    expect(source).toContain('Maintenance active');
    expect(source).toContain('Maintenance à venir');
    expect(source).toContain('maintenanceSignals.length');
  });

  it('affiche le fuseau IANA et relie chaque signal à la flotte', () => {
    expect(source).toContain('formatDateTimeInTimeZone');
    expect(source).toContain('signal.locationTimeZone');
    expect(source).toContain('/fleet');
  });
});
