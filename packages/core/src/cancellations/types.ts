export type CancellationActorReason =
  | 'CUSTOMER_CANCELLATION'
  | 'MERCHANT_CANCELLATION'
  | 'PLATFORM_CANCELLATION'
  | 'PAYMENT_COMPENSATION';

export type CancellationPolicyCode = 'FLEXIBLE' | 'MODERATE' | 'FIRM';

export interface CancellationPolicySnapshot {
  policy_code: CancellationPolicyCode | string;
  policy_version: string;
  timezone?: string | undefined;
}

export interface CancellationPreviewResult {
  allowed: boolean;
  reasonDisallowed?: string | undefined;
  bookingId: string;
  paidAmountMinor: number;
  refundAmountMinor: number;
  retainedAmountMinor: number;
  originalCommissionMinor: number;
  commissionRefundedMinor: number;
  finalCommissionMinor: number;
  finalMerchantRevenueMinor: number;
  currency: 'EUR';
  policyCode: string;
  explanationCode: string;
  explanationLabel: string;
  inventoryWillBeReleased: boolean;
  customerStartAt: Date;
  locationTimeZone: string;
  previewFingerprint: string;
}

export interface CancelConfirmedBookingInput {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  actorReason: CancellationActorReason;
  idempotencyKey: string;
  previewFingerprint?: string | undefined;
  now?: Date | undefined;
}

export interface CancelConfirmedBookingResult {
  cancellationId: string;
  bookingId: string;
  status: 'CANCELLED';
  refundId: string | null;
  refundAmountMinor: number;
  retainedAmountMinor: number;
  finalMerchantRevenueMinor: number;
  inventoryReleased: boolean;
}
