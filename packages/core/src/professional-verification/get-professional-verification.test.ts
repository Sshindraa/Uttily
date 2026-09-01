import { describe, expect, it, vi } from 'vitest';
import {
  getProfessionalVerification,
  resolveProfessionalVerification,
} from './get-professional-verification';
import type { ProfessionalVerificationFacts } from './types';
import type { DatabaseClient } from '@uttily/database';

const completeFacts: ProfessionalVerificationFacts = {
  organizationExists: true,
  organizationActive: true,
  organizationDeleted: false,
  isProfessional: true,
  legalNamePresent: true,
  publicLocation: true,
  stripeAccountConfigured: true,
  stripeOnboardingEnabled: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  transfersActive: true,
  requirementsClear: true,
};

describe('resolveProfessionalVerification', () => {
  it('éligible uniquement lorsque tous les critères sont satisfaits', () => {
    const evaluatedAt = new Date('2026-08-31T10:00:00.000Z');
    const result = resolveProfessionalVerification(completeFacts, 'LIVE', evaluatedAt);

    expect(result).toEqual({
      status: 'eligible',
      environment: 'LIVE',
      algorithmVersion: 'professional-verification-v1',
      evaluatedAt,
      criteria: {
        professionalProfile: true,
        publicLocation: true,
        stripeAccount: true,
      },
      missingCriteria: [],
    });
  });

  it('reste pending pour une organisation active dont un fait opérationnel manque', () => {
    const result = resolveProfessionalVerification(
      { ...completeFacts, payoutsEnabled: false },
      'LIVE',
    );

    expect(result.status).toBe('pending');
    expect(result.criteria.stripeAccount).toBe(false);
    expect(result.missingCriteria).toEqual(['STRIPE_ACCOUNT']);
  });

  it('est ineligible pour une organisation supprimée ou suspendue', () => {
    expect(
      resolveProfessionalVerification({ ...completeFacts, organizationActive: false }, 'LIVE')
        .status,
    ).toBe('ineligible');
    expect(
      resolveProfessionalVerification({ ...completeFacts, organizationDeleted: true }, 'LIVE')
        .status,
    ).toBe('ineligible');
  });

  it('ne mélange jamais TEST et LIVE', () => {
    const result = resolveProfessionalVerification(completeFacts, 'TEST');
    expect(result.environment).toBe('TEST');
    expect(result.status).toBe('eligible');
  });

  it('mappe les faits SQL et force le statut ineligible si l’organisation est absente', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([]),
    } as unknown as DatabaseClient;

    const result = await getProfessionalVerification(
      db,
      '00000000-0000-0000-0000-000000000001',
      'LIVE',
    );

    expect(result.status).toBe('ineligible');
    expect(result.missingCriteria).toEqual([
      'PROFESSIONAL_PROFILE',
      'PUBLIC_LOCATION',
      'STRIPE_ACCOUNT',
    ]);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('reste fail-closed si les prédicats SQL ne sont pas strictement booléens vrais', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          organization_active: true,
          organization_deleted: false,
          is_professional: true,
          legal_name_present: true,
          public_location: true,
          stripe_account_configured: 1,
          stripe_onboarding_enabled: true,
          charges_enabled: true,
          payouts_enabled: true,
          transfers_active: true,
          requirements_clear: true,
        },
      ]),
    } as unknown as DatabaseClient;

    const result = await getProfessionalVerification(
      db,
      '00000000-0000-0000-0000-000000000001',
      'LIVE',
    );

    expect(result.status).toBe('pending');
    expect(result.missingCriteria).toContain('STRIPE_ACCOUNT');
  });
});
