import { describe, it, expect } from 'vitest';
import { resolveUnifiedOnboardingProgress } from './unified-onboarding-progress';
import type { OrganizationOnboardingReadiness } from './onboarding-readiness';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

function makeMockReadiness(
  overrides: Partial<OrganizationOnboardingReadiness> = {},
): OrganizationOnboardingReadiness {
  return {
    organizationId: ORG_ID,
    percentage: 0,
    completedCount: 0,
    totalCount: 7,
    isReadyForReservations: false,
    isConfigurationComplete: false,
    milestones: [
      { key: 'ORGANIZATION', completed: false, details: {} },
      { key: 'LOCATION', completed: false, details: {} },
      { key: 'PRIMARY_PRODUCT', completed: false, details: {} },
      { key: 'PHOTOS', completed: false, details: {} },
      { key: 'PRICING', completed: false, details: {} },
      { key: 'INVENTORY', completed: false, details: {} },
      { key: 'PAYMENTS', completed: false, details: {} },
    ],
    ...overrides,
  };
}

describe('resolveUnifiedOnboardingProgress', () => {
  it('calcule 0/4 à l’initialisation avec le CTA vers Activité', () => {
    const readiness = makeMockReadiness();
    const progress = resolveUnifiedOnboardingProgress(ORG_ID, readiness);

    expect(progress.totalCount).toBe(4);
    expect(progress.completedCount).toBe(0);
    expect(progress.percentage).toBe(0);
    expect(progress.currentStepNum).toBe(1);
    expect(progress.currentStep?.key).toBe('ACTIVITY');
    expect(progress.primaryCta.label).toBe('Configurer mon activité →');
    expect(progress.primaryCta.href).toBe(`/dashboard/${ORG_ID}/settings`);
  });

  it('calcule 2/4 quand Activité et Boutique sont complétées, et renvoie vers /bikes/new', () => {
    const readiness = makeMockReadiness({
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        { key: 'PRIMARY_PRODUCT', completed: false, details: {} },
        { key: 'PHOTOS', completed: false, details: {} },
        { key: 'PRICING', completed: false, details: {} },
        { key: 'INVENTORY', completed: false, details: {} },
        { key: 'PAYMENTS', completed: false, details: {} },
      ],
    });
    const progress = resolveUnifiedOnboardingProgress(ORG_ID, readiness);

    expect(progress.completedCount).toBe(2);
    expect(progress.percentage).toBe(50);
    expect(progress.currentStepNum).toBe(3);
    expect(progress.currentStep?.key).toBe('FIRST_BIKE');
    expect(progress.primaryCta.label).toBe('Ajouter mon premier équipement →');
    expect(progress.primaryCta.href).toBe(`/dashboard/${ORG_ID}/bikes/new`);
  });

  it('si le premier vélo a un brouillon créé, le CTA et le lien renvoient vers /bikes/[bikeId]/setup', () => {
    const BIKE_ID = 'bike-123';
    const readiness = makeMockReadiness({
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        {
          key: 'PRIMARY_PRODUCT',
          completed: true,
          details: { productId: BIKE_ID, info: 'Canyon Roadlite' },
        },
        { key: 'PHOTOS', completed: false, details: { count: 1 } },
        { key: 'PRICING', completed: false, details: {} },
        { key: 'INVENTORY', completed: false, details: {} },
        { key: 'PAYMENTS', completed: false, details: {} },
      ],
    });
    const progress = resolveUnifiedOnboardingProgress(ORG_ID, readiness);

    expect(progress.completedCount).toBe(2);
    expect(progress.currentStepNum).toBe(3);
    expect(progress.firstBike.id).toBe(BIKE_ID);
    expect(progress.firstBike.name).toBe('Canyon Roadlite');
    expect(progress.firstBike.photosCount).toBe(1);
    expect(progress.primaryCta.label).toBe('Continuer la configuration de l’équipement →');
    expect(progress.primaryCta.href).toBe(`/dashboard/${ORG_ID}/bikes/${BIKE_ID}/setup`);
  });

  it('calcule 3/4 quand le vélo est complet et met les virements en valeur', () => {
    const BIKE_ID = 'bike-123';
    const readiness = makeMockReadiness({
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        {
          key: 'PRIMARY_PRODUCT',
          completed: true,
          details: { productId: BIKE_ID, info: 'Canyon Roadlite' },
        },
        { key: 'PHOTOS', completed: true, details: { count: 3 } },
        { key: 'PRICING', completed: true, details: {} },
        { key: 'INVENTORY', completed: true, details: { count: 3 } },
        { key: 'PAYMENTS', completed: false, details: {} },
      ],
    });
    const progress = resolveUnifiedOnboardingProgress(ORG_ID, readiness);

    expect(progress.completedCount).toBe(3);
    expect(progress.percentage).toBe(75);
    expect(progress.isConfigurationComplete).toBe(true);
    expect(progress.currentStepNum).toBe(4);
    expect(progress.primaryCta.label).toBe('Activer mes virements bancaires →');
    expect(progress.primaryCta.href).toBe(`/dashboard/${ORG_ID}/finances`);
  });

  it('calcule 4/4 quand tout est complet (isReadyForReservations)', () => {
    const BIKE_ID = 'bike-123';
    const readiness = makeMockReadiness({
      isReadyForReservations: true,
      isConfigurationComplete: true,
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        {
          key: 'PRIMARY_PRODUCT',
          completed: true,
          details: { productId: BIKE_ID, info: 'Canyon Roadlite' },
        },
        { key: 'PHOTOS', completed: true, details: { count: 3 } },
        { key: 'PRICING', completed: true, details: {} },
        { key: 'INVENTORY', completed: true, details: { count: 3 } },
        { key: 'PAYMENTS', completed: true, details: {} },
      ],
    });
    const progress = resolveUnifiedOnboardingProgress(ORG_ID, readiness);

    expect(progress.completedCount).toBe(4);
    expect(progress.percentage).toBe(100);
    expect(progress.currentStepNum).toBe('COMPLETE');
    expect(progress.isReadyForReservations).toBe(true);
    expect(progress.primaryCta.label).toBe('Voir mes équipements en ligne →');
  });
});
