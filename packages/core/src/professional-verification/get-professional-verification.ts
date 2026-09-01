import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import type { StripeEnvironment } from '../payments/types';
import {
  PROFESSIONAL_VERIFICATION_ALGORITHM_VERSION,
  type ProfessionalVerificationCriterion,
  type ProfessionalVerificationFacts,
  type ProfessionalVerificationResult,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(organizationId: string, environment: StripeEnvironment): void {
  if (!UUID_RE.test(organizationId)) {
    throw new Error('organizationId doit être un UUID valide.');
  }
  if (environment !== 'TEST' && environment !== 'LIVE') {
    throw new Error(`Environnement invalide (reçu : ${environment}).`);
  }
}

function criterionValues(facts: ProfessionalVerificationFacts) {
  return {
    professionalProfile:
      facts.organizationExists &&
      facts.organizationActive &&
      !facts.organizationDeleted &&
      facts.isProfessional &&
      facts.legalNamePresent,
    publicLocation: facts.publicLocation,
    stripeAccount:
      facts.stripeAccountConfigured &&
      facts.stripeOnboardingEnabled &&
      facts.chargesEnabled &&
      facts.payoutsEnabled &&
      facts.transfersActive &&
      facts.requirementsClear,
  };
}

export function resolveProfessionalVerification(
  facts: ProfessionalVerificationFacts,
  environment: StripeEnvironment,
  evaluatedAt = new Date(),
): ProfessionalVerificationResult {
  const criteria = criterionValues(facts);
  const missingCriteria: ProfessionalVerificationCriterion[] = [];
  if (!criteria.professionalProfile) missingCriteria.push('PROFESSIONAL_PROFILE');
  if (!criteria.publicLocation) missingCriteria.push('PUBLIC_LOCATION');
  if (!criteria.stripeAccount) missingCriteria.push('STRIPE_ACCOUNT');

  const permanentlyIneligible =
    !facts.organizationExists ||
    facts.organizationDeleted ||
    !facts.organizationActive ||
    !facts.isProfessional;
  const status = permanentlyIneligible
    ? 'ineligible'
    : missingCriteria.length === 0
      ? 'eligible'
      : 'pending';

  return {
    status,
    environment,
    algorithmVersion: PROFESSIONAL_VERIFICATION_ALGORITHM_VERSION,
    evaluatedAt,
    criteria,
    missingCriteria,
  };
}

type ProfessionalVerificationRow = {
  organization_exists: boolean;
  organization_active: boolean;
  organization_deleted: boolean;
  is_professional: boolean;
  legal_name_present: boolean;
  public_location: boolean;
  stripe_account_configured: boolean;
  stripe_onboarding_enabled: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  transfers_active: boolean;
  requirements_clear: boolean;
};

function toBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Read model public/organisation du badge professionnel.
 *
 * L'environnement est toujours fourni par le serveur. Une page publique doit
 * demander LIVE ; TEST est réservé au diagnostic du dashboard et des tests.
 */
export async function getProfessionalVerification(
  db: DatabaseClient,
  organizationId: string,
  environment: StripeEnvironment,
): Promise<ProfessionalVerificationResult> {
  validateInput(organizationId, environment);

  const rows = await db.execute<ProfessionalVerificationRow>(sql`
    SELECT
      true AS organization_exists,
      (o.status = 'ACTIVE') AS organization_active,
      (o.deleted_at IS NOT NULL) AS organization_deleted,
      o.is_professional AS is_professional,
      (length(btrim(o.legal_name)) >= 2) AS legal_name_present,
      EXISTS (
        SELECT 1
        FROM locations l
        INNER JOIN countries c ON c.country_code = l.country_code
        WHERE l.organization_id = o.id
          AND l.deleted_at IS NULL
          AND l.is_publicly_listed = true
          AND l.pickup_enabled = true
          AND l.address_line1 IS NOT NULL AND length(btrim(l.address_line1)) > 0
          AND l.city IS NOT NULL AND length(btrim(l.city)) > 0
          AND l.postal_code IS NOT NULL AND length(btrim(l.postal_code)) > 0
          AND l.country_code IS NOT NULL
          AND l.geo_point IS NOT NULL
          AND c.is_active = true
          AND EXISTS (SELECT 1 FROM location_opening_hours h WHERE h.location_id = l.id)
      ) AS public_location,
      EXISTS (
        SELECT 1
        FROM organization_payment_accounts a
        WHERE a.organization_id = o.id
          AND a.provider = 'STRIPE'
          AND a.environment = ${environment}
      ) AS stripe_account_configured,
      COALESCE((
        SELECT a.onboarding_status = 'ENABLED'
          FROM organization_payment_accounts a
         WHERE a.organization_id = o.id
           AND a.provider = 'STRIPE'
           AND a.environment = ${environment}
         LIMIT 1
      ), false) AS stripe_onboarding_enabled,
      COALESCE((
        SELECT a.charges_enabled
          FROM organization_payment_accounts a
         WHERE a.organization_id = o.id
           AND a.provider = 'STRIPE'
           AND a.environment = ${environment}
         LIMIT 1
      ), false) AS charges_enabled,
      COALESCE((
        SELECT a.payouts_enabled
          FROM organization_payment_accounts a
         WHERE a.organization_id = o.id
           AND a.provider = 'STRIPE'
           AND a.environment = ${environment}
         LIMIT 1
      ), false) AS payouts_enabled,
      COALESCE((
        SELECT a.transfers_capability_status = 'ACTIVE'
          FROM organization_payment_accounts a
         WHERE a.organization_id = o.id
           AND a.provider = 'STRIPE'
           AND a.environment = ${environment}
         LIMIT 1
      ), false) AS transfers_active,
      COALESCE((
        SELECT (
          CASE
            WHEN jsonb_typeof(a.requirements_snapshot->'currently_due') = 'array'
              THEN jsonb_array_length(a.requirements_snapshot->'currently_due') = 0
            WHEN a.requirements_snapshot->'currently_due' IS NULL THEN true
            ELSE false
          END
          AND CASE
            WHEN jsonb_typeof(a.requirements_snapshot->'past_due') = 'array'
              THEN jsonb_array_length(a.requirements_snapshot->'past_due') = 0
            WHEN a.requirements_snapshot->'past_due' IS NULL THEN true
            ELSE false
          END
        )
          FROM organization_payment_accounts a
         WHERE a.organization_id = o.id
           AND a.provider = 'STRIPE'
           AND a.environment = ${environment}
         LIMIT 1
      ), false) AS requirements_clear
    FROM organizations o
    WHERE o.id = ${organizationId}
    LIMIT 1
  `);

  const row = rows[0];
  const facts: ProfessionalVerificationFacts = row
    ? {
        organizationExists: true,
        organizationActive: toBoolean(row.organization_active),
        organizationDeleted: toBoolean(row.organization_deleted),
        isProfessional: toBoolean(row.is_professional),
        legalNamePresent: toBoolean(row.legal_name_present),
        publicLocation: toBoolean(row.public_location),
        stripeAccountConfigured: toBoolean(row.stripe_account_configured),
        stripeOnboardingEnabled: toBoolean(row.stripe_onboarding_enabled),
        chargesEnabled: toBoolean(row.charges_enabled),
        payoutsEnabled: toBoolean(row.payouts_enabled),
        transfersActive: toBoolean(row.transfers_active),
        requirementsClear: toBoolean(row.requirements_clear),
      }
    : {
        organizationExists: false,
        organizationActive: false,
        organizationDeleted: false,
        isProfessional: false,
        legalNamePresent: false,
        publicLocation: false,
        stripeAccountConfigured: false,
        stripeOnboardingEnabled: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersActive: false,
        requirementsClear: false,
      };

  return resolveProfessionalVerification(facts, environment);
}
