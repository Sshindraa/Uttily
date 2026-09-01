import type { StripeEnvironment } from '../payments/types';

export const PROFESSIONAL_VERIFICATION_ALGORITHM_VERSION = 'professional-verification-v1' as const;

export const PROFESSIONAL_VERIFICATION_STATUSES = ['eligible', 'ineligible', 'pending'] as const;
export type ProfessionalVerificationStatus = (typeof PROFESSIONAL_VERIFICATION_STATUSES)[number];

export const PROFESSIONAL_VERIFICATION_CRITERIA = [
  'PROFESSIONAL_PROFILE',
  'PUBLIC_LOCATION',
  'STRIPE_ACCOUNT',
] as const;
export type ProfessionalVerificationCriterion = (typeof PROFESSIONAL_VERIFICATION_CRITERIA)[number];

export interface ProfessionalVerificationCriteria {
  professionalProfile: boolean;
  publicLocation: boolean;
  stripeAccount: boolean;
}

export interface ProfessionalVerificationResult {
  status: ProfessionalVerificationStatus;
  environment: StripeEnvironment;
  algorithmVersion: typeof PROFESSIONAL_VERIFICATION_ALGORITHM_VERSION;
  evaluatedAt: Date;
  criteria: ProfessionalVerificationCriteria;
  missingCriteria: ProfessionalVerificationCriterion[];
}

export interface ProfessionalVerificationFacts {
  organizationExists: boolean;
  organizationActive: boolean;
  organizationDeleted: boolean;
  isProfessional: boolean;
  legalNamePresent: boolean;
  publicLocation: boolean;
  stripeAccountConfigured: boolean;
  stripeOnboardingEnabled: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersActive: boolean;
  requirementsClear: boolean;
}
