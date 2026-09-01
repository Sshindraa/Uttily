import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../features/internal/audit-support-view.tsx');

describe('AuditSupportPage (Chantier 16 & 21-U1-D23)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme, les filtres et la lecture Core dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('listAuditLogsSupport');
    expect(pageSource).toContain('targetId');
    expect(pageSource).toContain('<AuditSupportView');
  });

  it('déporte le journal append-only dans la feature interne', () => {
    expect(featureSource).toContain('Journal d’Audit Append-Only');
    expect(featureSource).toContain('JSON.stringify(log.metadata, null, 2)');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
