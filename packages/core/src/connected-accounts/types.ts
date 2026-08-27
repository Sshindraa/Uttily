/**
 * @uttily/core — Module Connected Accounts (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Use cases d'onboarding Stripe Connect (Stripe-hosted) et projection de
 * readiness du compte connecté.
 *
 * Contraintes critiques (ADR-010 §1, §3.3) :
 * - Aucun appel provider à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - `organizationId` et `environment` proviennent du contexte serveur, jamais
 *   du navigateur.
 * - Le controller config par défaut du parcours France suit ADR-024 : PLATFORM
 *   paie les frais et porte les pertes, Dashboard Express, Stripe collecte les
 *   exigences (onboarding Express hébergé).
 */

import type { DatabaseClient } from '@uttily/database';
import type {
  ConnectedAccountControllerConfig,
  PaymentProviderAdapter,
  StripeEnvironment,
} from '../payments/types';

/**
 * Configuration controller par défaut pour l'onboarding France du MVP
 * (ADR-024, qui supersède uniquement le défaut d'onboarding d'ADR-010 §3.2).
 *
 * PLATFORM paie les frais Stripe et porte les pertes, le compte dispose du
 * Dashboard Express et Stripe collecte les exigences (onboarding Express hébergé).
 */
export const DEFAULT_CONTROLLER_CONFIG: ConnectedAccountControllerConfig = {
  feesPayer: 'PLATFORM',
  lossesCollector: 'PLATFORM',
  stripeDashboard: 'EXPRESS',
  requirementCollection: 'STRIPE',
};

/** Entrée du use case createConnectedAccount. */
export interface CreateConnectedAccountInput {
  /** Organisation injectée côté serveur (jamais depuis le navigateur). */
  organizationId: string;
  /** Environnement Stripe injecté côté serveur (STRIPE_ENVIRONMENT). */
  environment: StripeEnvironment;
  /** Pays du compte (ISO 3166-1 alpha-2). */
  country: string;
  /** Configuration explicite du controller (défaut : DEFAULT_CONTROLLER_CONFIG). */
  controller?: ConnectedAccountControllerConfig;
  /** Clé d'idempotence Stripe stable. */
  idempotencyKey: string;
}

/** Dépendances injectées. */
export interface ConnectedAccountDependencies {
  db: DatabaseClient;
  provider: PaymentProviderAdapter;
}

/** Résultat de création de compte connecté. */
export interface CreateConnectedAccountResult {
  organizationPaymentAccountId: string;
  providerAccountId: string;
  onboardingStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

/** Entrée du use case createOnboardingLink. */
export interface CreateOnboardingLinkInput {
  /** Organisation injectée côté serveur (jamais depuis le navigateur). */
  organizationId: string;
  /** Environnement Stripe injecté côté serveur (STRIPE_ENVIRONMENT). */
  environment: StripeEnvironment;
  /** URL de retour après onboarding Stripe-hosted. */
  returnUrl: string;
  /** URL de rafraîchissement si la session expire. */
  refreshUrl: string;
  /** Clé d'idempotence Stripe stable. */
  idempotencyKey: string;
}

/** Résultat de création de lien d'onboarding. */
export interface CreateOnboardingLinkResult {
  url: string;
  expiresAt: number;
}

/** Entrée du use case createAccountSession. */
export interface CreateAccountSessionInput {
  organizationId: string;
  environment: StripeEnvironment;
}

/** Read model : état de readiness du compte connecté. */
export interface ConnectedAccountReadiness {
  organizationPaymentAccountId: string | null;
  providerAccountId: string | null;
  environment: StripeEnvironment;
  onboardingStatus: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: string | null;
  /** true si le compte peut accepter des destination charges (charges_enabled ET transfers actifs). */
  ready: boolean;
  /** true si aucun compte n'existe pour cette org+environment. */
  notConfigured: boolean;
}

/** Codes d'erreur fermés du module connected-accounts. */
export type ConnectedAccountErrorCode =
  | 'VALIDATION'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'ONBOARDING_NOT_STARTED'
  | 'PROVIDER_CALL_FAILED'
  | 'ENVIRONMENT_MISMATCH'
  | 'UNKNOWN';
