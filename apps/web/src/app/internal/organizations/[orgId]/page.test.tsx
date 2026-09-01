import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/internal/organization-support-view.tsx');

describe('OrganizationSupportPage (Chantier 16 & 21-U1-D22)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme, la lecture Core et le 404 dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('getOrganizationSupportDetails');
    expect(pageSource).toContain('SupportOrganizationNotFoundError');
    expect(pageSource).toContain('<OrganizationSupportView');
  });

  it('déporte la fiche 360° et les actions interactives dans la feature interne', () => {
    expect(featureSource).toContain('OrganizationSupportDetails');
    expect(featureSource).toContain('Équipe & Invitations');
    expect(featureSource).toContain('ResendInvitationButton');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
