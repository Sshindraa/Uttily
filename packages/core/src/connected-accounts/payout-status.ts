import type { ConnectedAccountDependencies, ConnectedAccountReadiness } from './types';
import type { StripeEnvironment } from '../payments/types';
import { getConnectedAccountReadiness } from './get-connected-account-readiness';

export type PayoutReadiness =
  'NOT_STARTED' | 'ACTION_REQUIRED' | 'PENDING_VERIFICATION' | 'ENABLED' | 'RESTRICTED';

export interface PayoutAccountStatus {
  readiness: PayoutReadiness;
  isReady: boolean;
  label: string;
  description: string;
  actionLabel: string | null;
  providerAccountId: string | null;
}

/**
 * Traduit l'état technique du compte bancaire connecté en un statut en français humain
 * pour le loueur (sans jargon technique Stripe).
 */
export function resolvePayoutAccountStatus(
  readiness: ConnectedAccountReadiness,
): PayoutAccountStatus {
  // 1. Compte non configuré ou onboarding non démarré
  if (readiness.notConfigured || readiness.onboardingStatus === null) {
    return {
      readiness: 'NOT_STARTED',
      isReady: false,
      label: 'Versements non configurés',
      description:
        'Activez vos versements pour recevoir les revenus de vos locations directement sur votre compte bancaire.',
      actionLabel: 'Activer mes versements',
      providerAccountId: null,
    };
  }

  // 2. Compte pleinement opérationnel (charges_enabled && payouts_enabled && transfers actifs)
  if (readiness.ready) {
    return {
      readiness: 'ENABLED',
      isReady: true,
      label: 'Versements opérationnels',
      description:
        'Votre compte bancaire est vérifié et actif. Vous recevez vos revenus automatiquement après chaque location.',
      actionLabel: null,
      providerAccountId: readiness.providerAccountId,
    };
  }

  // 3. En attente de validation bancaire
  if (readiness.onboardingStatus === 'ENABLED' && !readiness.chargesEnabled) {
    return {
      readiness: 'PENDING_VERIFICATION',
      isReady: false,
      label: 'Vérification en cours',
      description:
        'Vos informations sont en cours de validation par nos services bancaires. Vos versements seront activés sous peu.',
      actionLabel: null,
      providerAccountId: readiness.providerAccountId,
    };
  }

  // 4. Action requise / formulaire d'information incomplet
  if (readiness.onboardingStatus === 'PENDING' || !readiness.chargesEnabled) {
    return {
      readiness: 'ACTION_REQUIRED',
      isReady: false,
      label: 'Informations requises',
      description:
        'Des informations complémentaires sur votre entreprise ou votre compte bancaire sont nécessaires pour activer vos versements.',
      actionLabel: 'Compléter mes informations',
      providerAccountId: readiness.providerAccountId,
    };
  }

  // 5. Restreint
  return {
    readiness: 'RESTRICTED',
    isReady: false,
    label: 'Versements restreints',
    description:
      'Une action de vérification est nécessaire pour réactiver vos virements bancaires.',
    actionLabel: 'Mettre à jour mon compte',
    providerAccountId: readiness.providerAccountId,
  };
}

/**
 * Récupère le statut de versement humain pour une organisation donnée.
 */
export async function getOrganizationPayoutStatus(
  deps: Pick<ConnectedAccountDependencies, 'db'>,
  organizationId: string,
  environment: StripeEnvironment,
): Promise<PayoutAccountStatus> {
  const readiness = await getConnectedAccountReadiness(deps, organizationId, environment);
  return resolvePayoutAccountStatus(readiness);
}
