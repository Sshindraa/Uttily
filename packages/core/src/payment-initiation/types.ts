import type { DatabaseClient } from '@uttily/database';
import type { FinancialTermsConfig, TermsAcceptanceProof } from '../financial-terms/types';
import type {
  PaymentIntentStatus,
  PaymentProviderAdapter,
  StripeEnvironment,
} from '../payments/types';

// StripeEnvironment est réexporté depuis payments/types — pas de redéfinition ici
// pour éviter une collision d'export dans le barrel principal.

/** Version du protocole d'initiation de paiement. */
export const PAYMENT_PROTOCOL_VERSION = 'v1';

/** Nom de l'opération idempotente. */
export const INITIATE_PAYMENT_OPERATION = 'initiate_payment';

/** Entrée du use case d'initiation de paiement. */
export interface InitiatePaymentInput {
  /** ID du brouillon à convertir. */
  draftId: string;
  /** Clé d'idempotence fournie par le client. */
  idempotencyKey: string;
  /** Organisation injectée côté serveur. */
  organizationId: string;
  /** Utilisateur client injecté côté serveur. */
  customerUserId: string;
  /** Environnement Stripe injecté côté serveur. */
  environment: StripeEnvironment;
  /** Configuration financière serveur de confiance. */
  financialTermsConfig: FinancialTermsConfig;
  /** Preuve d'acceptation des termes. */
  termsAcceptance: TermsAcceptanceProof;
}

/** Dépendances injectées. */
export interface InitiatePaymentDependencies {
  db: DatabaseClient;
  provider: PaymentProviderAdapter;
}

/** Résultat de succès — le clientSecret existe uniquement en mémoire. */
export interface InitiatePaymentSuccess {
  kind: 'SUCCESS';
  statusCode: 200;
  paymentId: string;
  paymentAttemptId: string;
  providerPaymentIntentId: string;
  providerStatus: PaymentIntentStatus;
  /** Éphémère — jamais persisté, jamais loggé. */
  clientSecret: string;
  processingDeadlineAt: Date;
}

/** Replay d'une clé COMPLETED — retrieve, pas create. */
export interface InitiatePaymentReplay {
  kind: 'REPLAY';
  statusCode: 200;
  paymentId: string;
  paymentAttemptId: string;
  providerPaymentIntentId: string;
  providerStatus: PaymentIntentStatus;
  clientSecret: string;
  processingDeadlineAt: Date;
}

/** Échec métier (draft expiré, termes non résolus, compte non prêt, etc.). */
export interface InitiatePaymentFailure {
  kind: 'FAILURE';
  statusCode: number;
  error: string;
  message: string;
}

export type InitiatePaymentResult =
  InitiatePaymentSuccess | InitiatePaymentReplay | InitiatePaymentFailure;

/** Réponse persistée dans idempotency_records (SANS clientSecret). */
export interface PersistedPaymentResponse {
  paymentId: string;
  paymentAttemptId: string;
  providerPaymentIntentId: string;
  providerStatus: PaymentIntentStatus;
  processingDeadlineAt: string; // ISO 8601
}
