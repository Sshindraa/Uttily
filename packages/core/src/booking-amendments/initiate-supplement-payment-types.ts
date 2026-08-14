import type { DatabaseClient } from '@uttily/database';
import type {
  PaymentIntentStatus,
  PaymentProviderAdapter,
  StripeEnvironment,
} from '../payments/types';

export interface InitiateSupplementPaymentInput {
  /** Organisation injectée depuis le contexte serveur. */
  readonly organizationId: string;
  /** Amendement injecté depuis la route authentifiée. */
  readonly amendmentId: string;
  /** Client authentifié injecté depuis le contexte serveur. */
  readonly customerUserId: string;
  /** Environnement attendu, jamais déduit d'une donnée client. */
  readonly environment: StripeEnvironment;
}

export interface InitiateSupplementPaymentOptions {
  /** Horloge applicative injectable pour les tests. */
  readonly now?: Date;
  /** Instant de projection capturé après l'appel provider, injectable pour les tests. */
  readonly afterProviderNow?: Date | (() => Date);
}

export interface InitiateSupplementPaymentSuccess {
  readonly kind: 'SUCCESS';
  readonly amendmentId: string;
  readonly amendmentPaymentId: string;
  readonly amendmentPaymentAttemptId: string;
  readonly providerPaymentIntentId: string;
  readonly providerStatus: PaymentIntentStatus;
  /** Éphémère : jamais persisté, loggé ou inclus dans une erreur. */
  readonly clientSecret: string;
}

export type InitiateSupplementPaymentResult =
  | InitiateSupplementPaymentSuccess
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'INVALID_INPUT' }
  | { readonly kind: 'HOLD_EXPIRED' }
  | { readonly kind: 'INVALID_STATE' }
  | { readonly kind: 'ENVIRONMENT_MISMATCH' }
  | { readonly kind: 'IN_PROGRESS' }
  | { readonly kind: 'PROVIDER_ERROR' }
  | { readonly kind: 'PROVIDER_STATE_INCONSISTENT' };

export interface InitiateSupplementPaymentDependencies {
  readonly db: DatabaseClient;
  readonly provider: PaymentProviderAdapter;
}
