import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnboardingReadinessCard } from './onboarding-readiness-card';
import type { OrganizationOnboardingReadiness } from '@uttily/core';

describe('OnboardingReadinessCard Component (G8B-3B3)', () => {
  const sampleReadiness: OrganizationOnboardingReadiness = {
    organizationId: '1c13f5b8-cbc1-4c5c-a474-47f0a9d00172',
    completedCount: 5,
    totalCount: 7,
    percentage: 71,
    isConfigurationComplete: false,
    isReadyForReservations: false,
    milestones: [
      { key: 'ORGANIZATION', completed: true, details: {} },
      { key: 'LOCATION', completed: true, details: {} },
      { key: 'PRIMARY_PRODUCT', completed: true, details: {} },
      { key: 'PHOTOS', completed: true, details: {} },
      { key: 'PRICING', completed: true, details: {} },
      { key: 'INVENTORY', completed: false, details: {} },
      { key: 'PAYMENTS', completed: false, details: {} },
    ],
  };

  it('affiche le pourcentage et le nombre d’étapes terminées', () => {
    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={sampleReadiness}
      />,
    );

    expect(html).toContain('Votre boutique est prête à 71 %');
    expect(html).toContain('5 sur 7 étapes terminées');
  });

  it('affiche les CTA pour les étapes non complétées avec bouton prioritaire pour la prochaine', () => {
    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={sampleReadiness}
      />,
    );

    expect(html).toContain('Ajouter mes vélos →');
    expect(html).toContain('Activer mes virements →');
  });

  it('affiche le bandeau de célébration quand la configuration 6/7 est terminée', () => {
    const configCompleteReadiness: OrganizationOnboardingReadiness = {
      ...sampleReadiness,
      completedCount: 6,
      percentage: 86,
      isConfigurationComplete: true,
      isReadyForReservations: false,
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        { key: 'PRIMARY_PRODUCT', completed: true, details: {} },
        { key: 'PHOTOS', completed: true, details: {} },
        { key: 'PRICING', completed: true, details: {} },
        { key: 'INVENTORY', completed: true, details: {} },
        { key: 'PAYMENTS', completed: false, details: {} },
      ],
    };

    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={configCompleteReadiness}
      />,
    );

    expect(html).toContain('🎉 Votre configuration est terminée !');
    expect(html).toContain('Activez vos versements pour recevoir');
    expect(html).toContain('Dernière étape requise');
  });

  it('affiche la barre de santé opérationnelle quand la boutique est à 100 %', () => {
    const allDoneReadiness: OrganizationOnboardingReadiness = {
      ...sampleReadiness,
      completedCount: 7,
      percentage: 100,
      isConfigurationComplete: true,
      isReadyForReservations: true,
      milestones: sampleReadiness.milestones.map((m) => ({ ...m, completed: true })),
    };

    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={allDoneReadiness}
      />,
    );

    expect(html).toContain('Votre boutique est en ligne et opérationnelle');
    expect(html).toContain('Boutique active');
    expect(html).toContain('Versements bancaires activés');
  });
});
