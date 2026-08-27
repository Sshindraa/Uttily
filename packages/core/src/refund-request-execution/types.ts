import type { DatabaseClient } from '@uttily/database';
import type { PaymentProviderAdapter, StripeEnvironment } from '../payments/types';

export interface RefundRequestDependencies {
  readonly db: DatabaseClient;
  readonly provider: PaymentProviderAdapter;
}

export interface RefundRequestOptions {
  readonly batchLimit?: number;
  readonly environment: StripeEnvironment;
}

export interface ClaimedRefundRequest {
  readonly outboxEventId: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly payload: unknown;
  readonly payloadValid: boolean;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly attemptCount: number;
}

export interface RefundRequestBatchResult {
  claimedCount: number;
  submittedCount: number;
  alreadyResolvedCount: number;
  failedCount: number;
  rescheduledCount: number;
  leaseLostCount: number;
  anomalies: Array<{ outboxEventId: string; code: string }>;
}

export interface RefundRequestVerification {
  readonly refundId: string;
  readonly paymentIntentId: string;
  readonly amountMinor: number;
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly reverseTransfer: boolean;
  readonly refundApplicationFee: boolean;
}

export interface RefundRequestExecutionResult {
  readonly outcome: 'submitted' | 'already_resolved';
}
