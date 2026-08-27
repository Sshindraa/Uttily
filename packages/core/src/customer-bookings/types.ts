/**
 * @uttily/core — Types du domaine Customer Booking (Chantier 14 / 14.1).
 *
 * Représente la projection orientée locataire des réservations.
 * Contrairement aux vues opérationnelles loueur, ce read-model est strictement
 * scopé par `customerUserId` et ne divulgue aucun détail interne (SKU, ID Stripe,
 * inventoryItemId, etc.).
 */

export type CustomerBookingStatus =
  | 'CONFIRMED'
  | 'READY_FOR_PICKUP'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED_REFUND_PENDING'
  | 'CANCELLED_REFUNDED'
  | 'CANCELLED_NO_REFUND'
  | 'CANCELLED_ACTION_REQUIRED';

export interface CustomerBookingSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly status: CustomerBookingStatus;
  readonly rawStatus: string;
  readonly productName: string;
  readonly heroPhotoUrl: string | null;
  readonly categoryName: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly timeZone: string;
  readonly locationName: string;
  readonly locationAddress: string;
  readonly totalAmountMinor: number;
  readonly currency: string;
  readonly confirmedAt: Date;
}

export interface CustomerBookingItemDetail {
  readonly productName: string;
  readonly variantName: string | null;
  readonly size: string | null;
  readonly quantity: number;
  readonly lineTotalAmountMinor: number;
}

export interface CustomerBookingDocumentDetail {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly createdAt: Date;
}

export interface CustomerBookingCancellationRecord {
  readonly cancelledAt: Date;
  readonly actorReason: string;
  readonly refundAmountMinor: number;
  readonly retainedAmountMinor: number;
  readonly explanationCode: string | null;
  readonly policyCode: string;
}

export interface CustomerBookingRefundDetail {
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'REQUESTED' | 'PROCESSING' | 'REFUNDED' | 'ACTION_REQUIRED';
}

export interface CustomerBookingPaymentDetail {
  readonly amountPaidMinor: number;
  readonly currency: string;
  readonly status: 'PAID' | 'PENDING' | 'FAILED' | 'UNAVAILABLE';
  readonly paidAt: Date | null;
}

export interface CustomerBookingDetail extends CustomerBookingSummary {
  readonly locationInstructions: string | null;
  readonly locationPhone: string | null;
  readonly locationCity: string | null;
  readonly locationPostalCode: string | null;
  readonly locationCoordinates: { readonly latitude: number; readonly longitude: number } | null;
  readonly items: readonly CustomerBookingItemDetail[];
  readonly payment: CustomerBookingPaymentDetail | null;
  readonly cancellation: {
    readonly allowed: boolean;
    readonly policyCode: string;
  };
  readonly cancellationRecord: CustomerBookingCancellationRecord | null;
  readonly refund: CustomerBookingRefundDetail | null;
  readonly documents: readonly CustomerBookingDocumentDetail[];
}

export interface GroupedCustomerBookings {
  readonly upcoming: readonly CustomerBookingSummary[];
  readonly active: readonly CustomerBookingSummary[];
  readonly past: readonly CustomerBookingSummary[];
}
