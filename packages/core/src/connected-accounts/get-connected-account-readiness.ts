/**
 * @uttily/core — Read model getConnectedAccountReadiness
 * (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Retourne l'état de readiness du compte connecté pour une organisation et un
 * environnement donnés.
 *
 * Contraintes critiques (ADR-010 §3.3) :
 * - `organizationId` et `environment` proviennent du contexte serveur.
 * - `ready = onboarding ENABLED && chargesEnabled && payoutsEnabled &&
 *   transfersCapabilityStatus === 'ACTIVE'`.
 * - Si aucun compte n'existe, retourne un read model avec `notConfigured: true`.
 */

import { and, eq } from 'drizzle-orm';
import { organizationPaymentAccounts } from '@uttily/database';
import type { ConnectedAccountDependencies } from './types';
import type { ConnectedAccountReadiness } from './types';
import type { StripeEnvironment } from '../payments/types';

/** Valide le format canonique d'un UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(organizationId: string, environment: StripeEnvironment): void {
  if (!UUID_RE.test(organizationId)) {
    throw new Error('organizationId doit être un UUID valide.');
  }
  if (environment !== 'TEST' && environment !== 'LIVE') {
    throw new Error(`Environnement invalide (reçu : ${environment}).`);
  }
}

/**
 * Retourne l'état de readiness du compte connecté.
 *
 * Orchestration :
 * 1. Valider l'entrée.
 * 2. Lire le compte depuis `organization_payment_accounts` par
 *    (organizationId, 'STRIPE', environment).
 * 3. Si non trouvé, retourner `{ notConfigured: true, ready: false, ... }`.
 * 4. Sinon, calculer `ready = onboarding ENABLED && chargesEnabled &&
 *    payoutsEnabled && transfersCapabilityStatus === 'ACTIVE'`.
 * 5. Retourner le read model.
 */
export async function getConnectedAccountReadiness(
  deps: Pick<ConnectedAccountDependencies, 'db'>,
  organizationId: string,
  environment: StripeEnvironment,
): Promise<ConnectedAccountReadiness> {
  // 1. Valider l'entrée.
  validateInput(organizationId, environment);

  const { db } = deps;

  // 2. Lire le compte connecté.
  const rows = await db
    .select()
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, organizationId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.environment, environment),
      ),
    )
    .limit(1);

  // 3. Compte non configuré.
  if (rows.length === 0) {
    return {
      organizationPaymentAccountId: null,
      providerAccountId: null,
      environment,
      onboardingStatus: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      transfersCapabilityStatus: null,
      ready: false,
      notConfigured: true,
    };
  }

  const account = rows[0]!;

  // 4. Calculer readiness.
  const ready =
    account.onboardingStatus === 'ENABLED' &&
    account.chargesEnabled &&
    account.payoutsEnabled &&
    account.transfersCapabilityStatus === 'ACTIVE';

  // 5. Retourner le read model.
  return {
    organizationPaymentAccountId: account.id,
    providerAccountId: account.providerAccountId,
    environment: account.environment,
    onboardingStatus: account.onboardingStatus,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    transfersCapabilityStatus: account.transfersCapabilityStatus,
    ready,
    notConfigured: false,
  };
}
