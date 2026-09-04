import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../features/internal/privacy-support-view.tsx');

describe('PrivacySupportPage (Lot 21-P1A)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection fail-closed plateforme et la lecture Core dans la route serveur', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('listPrivacyRequestsSupport');
    expect(pageSource).toContain("export const dynamic = 'force-dynamic'");
    expect(pageSource).toContain('<PrivacySupportView');
  });

  it('déporte l’interface d’instruction et les Server Actions dans la feature cockpit', () => {
    expect(featureSource).toContain('startPrivacyReviewAction');
    expect(featureSource).toContain('flagPrivacyIdentityCheckAction');
    expect(featureSource).toContain('extendPrivacyDeadlineAction');
    expect(featureSource).toContain('resolvePrivacyRequestAction');
    expect(featureSource).toContain('Opérations & Droits RGPD');
    expect(featureSource).toContain('Art. 12.4');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
