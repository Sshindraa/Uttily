import type { ConnectedAccountControllerConfig } from './types';
import { PaymentProviderError } from './errors';

/**
 * Valide une configuration controller contre la matrice d'exclusion Stripe v1.
 * Source : https://docs.stripe.com/connect/migrate-to-controller-properties
 * Section « Configurations non prises en charge ».
 *
 * Stripe ne restreint pas les configurations à trois presets ; les controller
 * properties autorisent des configurations hybrides. Seules les combinaisons
 * explicitement incompatibles sont rejetées.
 */
export function validateControllerConfiguration(
  controller: ConnectedAccountControllerConfig,
): void {
  const { feesPayer, lossesCollector, stripeDashboard, requirementCollection } = controller;

  // Règle 1 : requirementCollection = PLATFORM (application) est incompatible avec :
  // - lossesCollector = STRIPE
  // - feesPayer = CONNECTED_ACCOUNT
  // - stripeDashboard = EXPRESS
  // - stripeDashboard = FULL
  if (requirementCollection === 'PLATFORM') {
    if (lossesCollector === 'STRIPE') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'requirementCollection=PLATFORM est incompatible avec lossesCollector=STRIPE',
        'configuration_unresolved',
      );
    }
    if (feesPayer === 'CONNECTED_ACCOUNT') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'requirementCollection=PLATFORM est incompatible avec feesPayer=CONNECTED_ACCOUNT',
        'configuration_unresolved',
      );
    }
    if (stripeDashboard === 'EXPRESS' || stripeDashboard === 'FULL') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        `requirementCollection=PLATFORM est incompatible avec stripeDashboard=${stripeDashboard}`,
        'configuration_unresolved',
      );
    }
  }

  // Règle 2 : stripeDashboard = EXPRESS est incompatible avec requirementCollection = PLATFORM
  // (déjà couvert par la règle 1, mais Stripe le documente séparément — redondance intentionnelle)

  // Règle 3 : stripeDashboard = FULL est incompatible avec :
  // - lossesCollector = PLATFORM
  // - feesPayer = PLATFORM
  // - requirementCollection = PLATFORM
  if (stripeDashboard === 'FULL') {
    if (lossesCollector === 'PLATFORM') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'stripeDashboard=FULL est incompatible avec lossesCollector=PLATFORM',
        'configuration_unresolved',
      );
    }
    if (feesPayer === 'PLATFORM') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'stripeDashboard=FULL est incompatible avec feesPayer=PLATFORM',
        'configuration_unresolved',
      );
    }
    if (requirementCollection === 'PLATFORM') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'stripeDashboard=FULL est incompatible avec requirementCollection=PLATFORM',
        'configuration_unresolved',
      );
    }
  }

  // Règle 4 : stripeDashboard = NONE n'est pas supporté quand requirementCollection = STRIPE
  // ET lossesCollector = PLATFORM simultanément (supporté si une seule des deux)
  if (
    stripeDashboard === 'NONE' &&
    requirementCollection === 'STRIPE' &&
    lossesCollector === 'PLATFORM'
  ) {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'stripeDashboard=NONE est incompatible avec requirementCollection=STRIPE + lossesCollector=PLATFORM',
      'configuration_unresolved',
    );
  }
}
