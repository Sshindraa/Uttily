import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/onboarding/unified-onboarding-view.tsx');

describe('UnifiedOnboardingPage (Chantier 6)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une autorisation fulfillment pour lire l’état d’onboarding de l’organisation', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOrganizationOnboardingReadiness(db, organizationId)');
  });

  it('calcule la progression 4 étapes avec resolveUnifiedOnboardingProgress', () => {
    expect(pageSource).toContain('resolveUnifiedOnboardingProgress(organizationId, readiness)');
    expect(source).toContain('Créer ma boutique Uttily');
    expect(source).toContain('stepperTrack');
  });

  it('gère l’état de célébration quand la boutique est prête', () => {
    expect(source).toContain('progress.isReadyForReservations');
    expect(source).toContain('Votre boutique Uttily est prête !');
    expect(source).toContain('Accéder à mon Tableau de Bord');
  });

  it('laisse la présentation du parcours à la feature onboarding', () => {
    expect(pageSource).toContain('<UnifiedOnboardingView');
    expect(pageSource).not.toContain('className=');
    expect(pageSource).not.toContain('<header');
  });
});
