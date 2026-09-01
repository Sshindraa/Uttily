import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfessionalVerificationCard } from '@/features/dashboard/components/professional-verification-card';
import type { ProfessionalVerificationResult } from '@uttily/core';

const baseVerification: ProfessionalVerificationResult = {
  status: 'pending',
  environment: 'LIVE',
  algorithmVersion: 'professional-verification-v1',
  evaluatedAt: new Date('2026-08-31T10:00:00.000Z'),
  criteria: {
    professionalProfile: true,
    publicLocation: true,
    stripeAccount: false,
  },
  missingCriteria: ['STRIPE_ACCOUNT'],
};

describe('ProfessionalVerificationCard', () => {
  it('explique les critères manquants sans présenter un badge actif', () => {
    const html = renderToStaticMarkup(
      <ProfessionalVerificationCard verification={baseVerification} />,
    );

    expect(html).toContain('Vérification professionnelle en attente');
    expect(html).toContain('Compte de paiement opérationnel');
    expect(html).not.toContain('Loueur professionnel vérifié</h2>');
  });

  it('présente le statut actif uniquement pour une vérification éligible', () => {
    const html = renderToStaticMarkup(
      <ProfessionalVerificationCard
        verification={{
          ...baseVerification,
          status: 'eligible',
          criteria: {
            professionalProfile: true,
            publicLocation: true,
            stripeAccount: true,
          },
          missingCriteria: [],
        }}
      />,
    );

    expect(html).toContain('Loueur professionnel vérifié');
    expect(html).toContain('Actif');
  });
});
