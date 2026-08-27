import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('UnifiedOnboardingPage (Chantier 6)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour lire l’état d’onboarding de l’organisation', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOrganizationOnboardingReadiness(db, organizationId)');
  });

  it('calcule la progression 4 étapes avec resolveUnifiedOnboardingProgress', () => {
    expect(pageSource).toContain('resolveUnifiedOnboardingProgress(organizationId, readiness)');
    expect(pageSource).toContain('Créer ma boutique Uttily');
    expect(pageSource).toContain('stepperTrack');
  });

  it('gère l’état de célébration quand la boutique est prête', () => {
    expect(pageSource).toContain('progress.isReadyForReservations');
    expect(pageSource).toContain('Votre boutique Uttily est prête !');
    expect(pageSource).toContain('Accéder à mon Tableau de Bord');
  });
});
