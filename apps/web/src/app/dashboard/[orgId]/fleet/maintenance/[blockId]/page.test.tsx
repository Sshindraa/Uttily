import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('MaintenanceCaseDetailPage (Chantier 9B & 9D)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation catalogue et un blockId valide', () => {
    expect(pageSource).toContain('isValidUuid(blockId)');
    expect(pageSource).toContain('requireCatalogViewerOf');
    expect(pageSource).toContain('getMaintenanceCaseDetails');
  });

  it('intègre le modal de remise en service', () => {
    expect(pageSource).toContain('<ResolveMaintenanceModal');
  });
});
