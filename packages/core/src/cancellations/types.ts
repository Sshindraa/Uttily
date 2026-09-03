import type { MarketplaceFeeDeltaSnapshot } from '../marketplace-fees/types';

export type CancellationActorReason =
  | 'CUSTOMER_CANCELLATION'
  | 'MERCHANT_CANCELLATION'
  | 'PLATFORM_CANCELLATION'
  | 'PAYMENT_COMPENSATION';

export type CancellationPolicyCode = 'FLEXIBLE' | 'MODERATE' | 'FIRM';

export interface CancellationPolicyDescription {
  readonly code: CancellationPolicyCode;
  readonly title: string;
  readonly summary: string;
  readonly rules: readonly string[];
}

export function getCancellationPolicyDefinitions(): readonly CancellationPolicyDescription[] {
  return [
    {
      code: 'FLEXIBLE',
      title: 'Flexible',
      summary: 'Plus rassurante pour vos clients.',
      rules: [
        'Remboursement à 100 % jusqu’à 24 heures avant le début de la location.',
        'Aucun remboursement à moins de 24 heures.',
        'Fenêtre de grâce de 24h si la réservation a été effectuée au moins 7 jours à l’avance.',
      ],
    },
    {
      code: 'MODERATE',
      title: 'Modérée',
      summary: 'Équilibre flexibilité pour le client et protection pour le loueur.',
      rules: [
        'Remboursement à 100 % jusqu’à 5 jours avant le début de la location.',
        'Remboursement à 50 % entre 24 heures et 5 jours.',
        'Aucun remboursement à moins de 24 heures.',
        'Fenêtre de grâce de 24h si la réservation a été effectuée au moins 7 jours à l’avance.',
      ],
    },
    {
      code: 'FIRM',
      title: 'Ferme',
      summary: 'Protection renforcée contre les annulations tardives.',
      rules: [
        'Remboursement à 100 % jusqu’à 14 jours avant le début de la location.',
        'Remboursement à 50 % entre 7 et 14 jours.',
        'Aucun remboursement à moins de 7 jours.',
        'Fenêtre de grâce de 24h si la réservation a été effectuée au moins 7 jours à l’avance.',
      ],
    },
  ];
}

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
  marketplaceFeeDelta?: MarketplaceFeeDeltaSnapshot | undefined;
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
