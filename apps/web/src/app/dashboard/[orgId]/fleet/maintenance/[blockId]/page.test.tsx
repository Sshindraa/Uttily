import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '../../../../../../features/fleet/maintenance/case-detail-view.tsx',
);

describe('MaintenanceCaseDetailPage (Chantier 9B & 9D)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une autorisation catalogue et un blockId valide', () => {
    expect(pageSource).toContain('isValidUuid(blockId)');
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('getMaintenanceCaseDetails');
  });

  it('intègre le modal de remise en service', () => {
    expect(source).toContain('<ResolveMaintenanceModal');
  });

  it('laisse la présentation du dossier à la feature dédiée', () => {
    expect(pageSource).toContain('<MaintenanceCaseDetailView');
    expect(pageSource).not.toContain('<Card');
    expect(pageSource).not.toContain('style=');
  });
});
