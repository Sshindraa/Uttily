/**
 * @uttily/core — Types du module Compensation Execution (Phase 8, ADR-010 §13).
 *
 * Le worker d'exécution consomme les événements `PAYMENT_COMPENSATION_REQUESTED`
 * de l'outbox, appelle Stripe `createRefund` hors transaction, et persiste le
 * résultat (`SUBMITTED` + `provider_refund_id`). Le statut `SUCCEEDED` n'est
 * jamais déclaré par le worker — c'est le webhook qui le projette.
 */

import type { DatabaseClient } from '@uttily/database';
import type { PaymentProviderAdapter, StripeEnvironment } from '../payments/types';

/** Dépendances injectées pour le moteur d'exécution des compensations. */
export interface CompensationDependencies {
  db: DatabaseClient;
  provider: PaymentProviderAdapter;
}

/** Options du moteur d'exécution des compensations. */
export interface CompensationOptions {
  batchLimit?: number;
  environment: StripeEnvironment;
}

/** Événement de compensation revendiqué pour exécution (snapshot complet). */
export interface ClaimedCompensation {
  outboxEventId: string;
  organizationId: string;
  paymentId: string;
  refundIdempotencyKey: string;
  amountMinor: number;
  currency: string;
  reason: string;
  /** P1-4 : aggregate_type de l'événement outbox (autorité à recouper). */
  aggregateType: string;
  /** P1-4 : aggregate_id de l'événement outbox (autorité à recouper). */
  aggregateId: string;
  /** P1-4 : event_version de l'événement outbox (autorité à recouper). */
  eventVersion: string;
  /** Token UUID de lease pour fencing atomique. */
  leaseToken: string;
  /** Expiration de la lease. */
  leaseUntil: Date;
  /** Nombre de tentatives déjà effectuées (pour le backoff). */
  attemptCount: number;
}

/** Résultat agrégé d'un batch d'exécution de compensations. */
export interface CompensationBatchResult {
  claimedCount: number;
  submittedCount: number;
  failedCount: number;
  rescheduledCount: number;
  anomalies: Array<{ outboxEventId: string; code: string }>;
}
