import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnboardingReadinessCard } from './onboarding-readiness-card';
import type { OrganizationOnboardingReadiness } from '@uttily/core';

describe('OnboardingReadinessCard Component (Chantier 6 - 4 Étapes Unifiées)', () => {
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
      {
        key: 'PRIMARY_PRODUCT',
        completed: true,
        details: { productId: 'bike-1', info: 'Canyon Roadlite' },
      },
      { key: 'PHOTOS', completed: true, details: { count: 3 } },
      { key: 'PRICING', completed: true, details: {} },
      { key: 'INVENTORY', completed: false, details: {} },
      { key: 'PAYMENTS', completed: false, details: {} },
    ],
  };

  it('affiche les 4 grandes étapes produit (Activité, Boutique, 1er Vélo, Virements)', () => {
    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={sampleReadiness}
      />,
    );

    expect(html).toContain('Créer ma boutique Uttily');
    expect(html).toContain('① Mon activité');
    expect(html).toContain('② Ma boutique');
    expect(html).toContain('③ Mon premier vélo');
    expect(html).toContain('④ Mes virements');
    expect(html).toContain('2 sur 4 étapes complétées');
  });

  it('affiche le premier vélo en cours de configuration et le CTA vers le setup', () => {
    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={sampleReadiness}
      />,
    );

    expect(html).toContain('Canyon Roadlite');
    expect(html).toContain('Continuer le vélo →');
  });

  it('affiche le bandeau de célébration quand le 1er vélo est prêt et que seuls les virements restent', () => {
    const configCompleteReadiness: OrganizationOnboardingReadiness = {
      ...sampleReadiness,
      completedCount: 6,
      percentage: 86,
      isConfigurationComplete: true,
      isReadyForReservations: false,
      milestones: [
        { key: 'ORGANIZATION', completed: true, details: {} },
        { key: 'LOCATION', completed: true, details: {} },
        {
          key: 'PRIMARY_PRODUCT',
          completed: true,
          details: { productId: 'bike-1', info: 'Canyon Roadlite' },
        },
        { key: 'PHOTOS', completed: true, details: { count: 3 } },
        { key: 'PRICING', completed: true, details: {} },
        { key: 'INVENTORY', completed: true, details: { count: 3 } },
        { key: 'PAYMENTS', completed: false, details: {} },
      ],
    };

    const html = renderToStaticMarkup(
      <OnboardingReadinessCard
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        readiness={configCompleteReadiness}
      />,
    );

    expect(html).toContain('🎉 Votre premier vélo est prêt !');
    expect(html).toContain('3/3 photos ✓ • Tarif configuré ✓ • 3 vélo(s) en flotte ✓');
    expect(html).toContain('Activer mes virements →');
  });

  it('affiche l’état opérationnel quand la boutique est à 100 %', () => {
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

    expect(html).toContain('Votre boutique est active &amp; en ligne');
    expect(html).toContain('Boutique active');
    expect(html).toContain('Versements bancaires activés');
    expect(html).toContain('Voir mes vélos en ligne →');
  });
});
