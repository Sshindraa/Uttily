/**
 * @uttily/core — Module Connected Accounts (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Use cases d'onboarding Stripe Connect (Stripe-hosted) et projection de
 * readiness du compte connecté.
 */

export * from './types';
export {
  ConnectedAccountError,
  toActionErrorCode as toConnectedAccountActionErrorCode,
} from './errors';
export { createConnectedAccount } from './create-connected-account';
export { createOnboardingLink } from './create-onboarding-link';
export { createAccountSession } from './create-account-session';
export { getConnectedAccountReadiness } from './get-connected-account-readiness';
export * from './payout-status';
