import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../features/internal/support-cockpit-view.tsx');

describe('InternalCockpitPage (Chantier 16 & 21-U1-D21)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme et les lectures support dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('searchSupport');
    expect(pageSource).toContain('listAuditLogsSupport');
    expect(pageSource).toContain('<SupportCockpitView');
  });

  it('déporte la présentation du cockpit et sa recherche dans la feature interne', () => {
    expect(featureSource).toContain('Cockpit Support & Diagnostic');
    expect(featureSource).toContain('SupportSearchForm');
    expect(featureSource).toContain('Dernières activités auditées');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
