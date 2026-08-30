/**
 * @uttily/core — Types du module Payment Reconciliation (Phase 7A, ADR-010 §12).
 */

import type { DatabaseClient } from '@uttily/database';
import type { PaymentProviderAdapter, StripeEnvironment } from '../payments/types';
import type { MarketplaceFeeSnapshot } from '../marketplace-fees';

/** Dépendances injectées pour le moteur de réconciliation. */
export interface ReconciliationDependencies {
  db: DatabaseClient;
  provider: PaymentProviderAdapter;
}

/** Options du moteur de réconciliation. */
export interface ReconciliationOptions {
  batchLimit?: number;
  environment: StripeEnvironment;
}

/** Tentative revendiquée pour réconciliation (snapshot complet). */
export interface ClaimedAttempt {
  attemptId: string;
  paymentId: string;
  draftId: string;
  organizationId: string;
  attemptNumber: number;
  attemptStatus: string;
  providerPaymentIntentId: string | null;
  providerIdempotencyKey: string;
  amountMinor: number;
  currency: string;
  connectedAccountId: string;
  commissionAmountMinor: number;
  marketplaceFeeSnapshot?: MarketplaceFeeSnapshot | null;
  onBehalfOfAccountId: string | null;
  processingDeadlineAt: Date;
  leaseUntil: Date;
  /** Environnement Stripe du paiement (P1-3). */
  environment: StripeEnvironment;
  /** Token UUID de lease pour fencing atomique (P1-2, P1-4). */
  leaseToken: string;
  /** Date de création de l'attempt — contrôle de l'âge de la clé (P1-5). */
  createdAt: Date;
  /**
   * True si la clé d'idempotency est expirée (âge > 23h), calculé côté
   * PostgreSQL avec `transaction_timestamp()` dans la transaction de claim
   * (P1-4). Conservative : 23h au lieu de 24h pour une marge de sécurité.
   */
  isKeyExpired: boolean;
}

/** Résultat d'une réconciliation individuelle. */
export type ReconciliationOutcome =
  | { kind: 'confirmed'; bookingId: string }
  | { kind: 'cancelled' }
  | { kind: 'rescheduled' }
  | { kind: 'compensated' }
  | { kind: 'needs_cancellation' };

/** Résultat agrégé d'un batch de réconciliation. */
export interface ReconciliationBatchResult {
  claimedCount: number;
  reconciledCount: number;
  confirmedCount: number;
  cancelledCount: number;
  rescheduledCount: number;
  compensationRequestedCount: number;
  anomalyCount: number;
  anomalies: Array<{ attemptId: string; code: string }>;
}
